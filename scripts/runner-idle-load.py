#!/usr/bin/env python3
import argparse
import grp
import json
import math
import os
import pwd
import signal
import subprocess
import sys
import time
from pathlib import Path

RUNNER_LOCK = "/opt/gitedge/work/actions/active.lock"
STATE_DIR = "/var/lib/gitedge-idle"
LOCK_GRACE_SECONDS = 5
RUNNER_PROCESS_NAMES = {"Runner.Listener", "Runner.Client", "Runner.Server", "Runner.Worker"}
stop_requested = False


class CpuBudget:
    def __init__(self, proc_root, target_percent, quota_cap_percent):
        self.proc_root = proc_root
        self.target_percent = target_percent
        self.quota_cap_percent = quota_cap_percent
        self.cpu_count = os.cpu_count() or 1
        group = next(
            line.split(":", 2)[2]
            for line in (proc_root / "self/cgroup").read_text().splitlines()
            if line.startswith("0::")
        )
        self.cgroup = Path("/sys/fs/cgroup") / group.lstrip("/")
        self.unit = self.cgroup.name
        if not self.unit.endswith(".service"):
            raise ValueError("CPU budgeting must run inside its own systemd service")
        self.status_file = Path("/run/gitedge-idle/cpu-budget.json")
        self.status_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.previous = self.snapshot()
        self.budget_percent = 0.0
        self.quota_percent = None
        self.last_report = 0.0
        self.apply_quota(5.0)

    def snapshot(self):
        cpu = [int(value) for value in (self.proc_root / "stat").read_text().splitlines()[0].split()[1:9]]
        service = dict(line.split() for line in (self.cgroup / "cpu.stat").read_text().splitlines())
        return time.monotonic(), cpu, int(service["usage_usec"])

    def sample(self):
        current = self.snapshot()
        before = self.previous
        self.previous = current
        elapsed = current[0] - before[0]
        delta = [after - prior for after, prior in zip(current[1], before[1])]
        total = sum(delta)
        if elapsed <= 0 or total <= 0 or min(delta) < 0 or current[2] < before[2]:
            raise ValueError("CPU counters did not advance consistently")
        busy = 100 * (sum(delta[:3]) + delta[5] + delta[6]) / total
        service = 100 * (current[2] - before[2]) / (elapsed * 1_000_000 * self.cpu_count)
        return {"total_percent": busy, "service_percent": service,
                "other_percent": max(0.0, busy - service), "steal_percent": 100 * delta[7] / total}

    def apply_quota(self, quota_percent):
        quota_percent = min(self.quota_cap_percent, max(5.0, quota_percent))
        if self.quota_percent is not None and abs(quota_percent - self.quota_percent) < 1.0:
            return
        subprocess.run(
            ["systemctl", "set-property", "--runtime", self.unit, f"CPUQuota={quota_percent:.2f}%"],
            check=True, capture_output=True, text=True, timeout=5,
        )
        self.quota_percent = quota_percent

    def update(self, sample, allowed, task_active, reason):
        desired = max(0.0, self.target_percent - sample["other_percent"]) if allowed else 0.0
        desired = min(desired, self.quota_cap_percent / self.cpu_count)
        if desired < 0.5:
            desired = 0.0
        self.budget_percent = min(desired, self.budget_percent + 2.0)
        self.apply_quota(self.budget_percent * self.cpu_count)
        now = time.monotonic()
        if now - self.last_report >= 5:
            status = {"event": "idle-cpu-budget", "target_percent": self.target_percent,
                      **{key: round(value, 3) for key, value in sample.items()},
                      "budget_percent": round(self.budget_percent, 3),
                      "quota_percent": round(self.quota_percent, 3),
                      "research_active": task_active, "gate": reason,
                      "observed_at_unix": time.time()}
            temporary = self.status_file.with_suffix(".tmp")
            temporary.write_text(json.dumps(status) + "\n")
            temporary.replace(self.status_file)
            print(json.dumps(status), flush=True)
            self.last_report = now
        return desired > 0


def request_stop(_signum, _frame):
    global stop_requested
    stop_requested = True


def pressure_over(path, kind, threshold):
    try:
        for line in path.read_text().splitlines():
            fields = line.split()
            if fields and fields[0] == kind:
                values = dict(field.split("=", 1) for field in fields[1:] if "=" in field)
                if float(values.get("avg10", 0)) >= threshold:
                    return True
    except (OSError, ValueError):
        pass
    return False


def resource_pressure(proc_root, include_cpu=True):
    try:
        load = float((proc_root / "loadavg").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        load = 0
    if include_cpu and load / max(os.cpu_count() or 1, 1) >= 0.75:
        return True

    pressure = proc_root / "pressure"
    if (
        (include_cpu and pressure_over(pressure / "cpu", "some", 80))
        or pressure_over(pressure / "memory", "some", 5)
        or pressure_over(pressure / "memory", "full", 0.5)
        or pressure_over(pressure / "io", "some", 10)
    ):
        return True

    try:
        values = {}
        for line in (proc_root / "meminfo").read_text().splitlines():
            key, value = line.split(":", 1)
            values[key] = int(value.strip().split()[0])
        total = values["MemTotal"]
        available = values["MemAvailable"]
        return available < 524288 or available / total < 0.20
    except (OSError, ValueError, KeyError, IndexError, ZeroDivisionError):
        return False


def runner_process_active(proc_root):
    try:
        processes = proc_root.iterdir()
    except OSError:
        return False
    for process in processes:
        if not process.name.isdigit():
            continue
        try:
            arguments = [part for part in (process / "cmdline").read_bytes().split(b"\0") if part]
        except OSError:
            continue
        names = [argument.rsplit(b"/", 1)[-1].decode("utf-8", "ignore") for argument in arguments]
        if RUNNER_PROCESS_NAMES.intersection(names):
            return True
        for index, name in enumerate(names[:-1]):
            if name == "actions-runner.mjs" and names[index + 1] == "run":
                return True
    return False


def start_disk_probe(state_dir):
    return subprocess.Popen(
        ["du", "-s", "--bytes", "--one-file-system", "--", str(state_dir)],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        start_new_session=True,
    )


def start_task(command, task_user, state_dir):
    environment = {
        "HOME": str(state_dir),
        "LANG": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
    }
    options = {
        "cwd": state_dir,
        "env": environment,
        "start_new_session": True,
        "preexec_fn": lower_task_priority,
    }
    if task_user:
        user = pwd.getpwnam(task_user)
        group = grp.getgrnam(task_user)
        options.update(user=user.pw_uid, group=group.gr_gid, extra_groups=[])
    return subprocess.Popen(command, **options)


def lower_task_priority():
    os.setpriority(os.PRIO_PROCESS, 0, 19)
    os.sched_setscheduler(0, os.SCHED_IDLE, os.sched_param(0))


def stop_group(process, grace=2):
    if process is None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


def stop_task(task):
    stop_group(task)


def main():
    parser = argparse.ArgumentParser(description="Run a checkpoint-capable task with bounded background CPU.")
    parser.add_argument("--lock-file", type=Path, default=Path(RUNNER_LOCK))
    parser.add_argument("--proc-root", type=Path, default=Path("/proc"))
    parser.add_argument("--resume-after", type=int, default=45)
    parser.add_argument("--run-for", type=int, default=0)
    parser.add_argument("--state-dir", type=Path, default=Path(STATE_DIR))
    parser.add_argument("--max-disk-mib", type=int, default=512)
    parser.add_argument("--disk-check-interval", type=int, default=10)
    parser.add_argument("--task-user")
    parser.add_argument("--cpu-target-percent", type=float, help="Target total host CPU utilization.")
    parser.add_argument("--cpu-quota-cap-percent", type=float, default=50.0,
                        help="Maximum quota as a percent of one logical CPU.")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a resumable task command is required after --")
    if args.resume_after < 0 or args.run_for < 0 or args.max_disk_mib < 1 or args.disk_check_interval < 1:
        parser.error("time limits cannot be negative; disk budget and check interval must be positive")
    if not args.state_dir.is_dir():
        parser.error("state directory must exist")
    if args.task_user and os.geteuid() != 0:
        parser.error("--task-user requires root")
    if args.task_user:
        try:
            pwd.getpwnam(args.task_user)
            grp.getgrnam(args.task_user)
        except KeyError:
            parser.error("task user and primary group must exist")
    budget = None
    if args.cpu_target_percent is not None:
        if os.geteuid() != 0:
            parser.error("CPU budgeting requires root")
        if not math.isfinite(args.cpu_target_percent) or not 0 < args.cpu_target_percent <= 100:
            parser.error("CPU target must be between zero and 100 percent")
        if not math.isfinite(args.cpu_quota_cap_percent) or args.cpu_quota_cap_percent < 5:
            parser.error("CPU quota cap must be at least five percent of one logical CPU")
        budget = CpuBudget(args.proc_root, args.cpu_target_percent, args.cpu_quota_cap_percent)

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    task = None
    idle_since = None
    started_at = time.monotonic()
    next_disk_check = 0
    disk_allowed = False
    disk_state = None
    disk_limit = args.max_disk_mib * 1024 * 1024
    disk_probe = None
    disk_probe_started = 0
    lock_seen_since = None
    gate_state = None
    time.sleep(1 if budget else 0)

    def report_gate(state):
        nonlocal gate_state
        if gate_state != state:
            if state == "clear":
                print("Idle task gate is clear.", flush=True)
            elif state == "claim lock":
                print("Idle task gate is waiting on a short claim lock.", flush=True)
            else:
                print(f"Idle task gate is busy: {state}.", flush=True)
            gate_state = state

    try:
        while not stop_requested and (args.run_for == 0 or time.monotonic() - started_at < args.run_for):
            now = time.monotonic()
            cpu_sample = budget.sample() if budget else None
            if disk_probe is None and now >= next_disk_check:
                try:
                    disk_probe = start_disk_probe(args.state_dir)
                    disk_probe_started = now
                except OSError:
                    disk_allowed = False
                next_disk_check = now + args.disk_check_interval

            if disk_probe is not None and disk_probe.poll() is not None:
                output, _ = disk_probe.communicate()
                try:
                    disk_allowed = disk_probe.returncode == 0 and int(output.split()[0]) <= disk_limit
                except (ValueError, IndexError):
                    disk_allowed = False
                disk_probe = None
                if disk_state is not disk_allowed:
                    state = "within" if disk_allowed else "over or unable to verify"
                    print(f"Idle task state is {state} the {args.max_disk_mib} MiB budget.", flush=True)
                    disk_state = disk_allowed
            elif disk_probe is not None and now - disk_probe_started >= 10:
                try:
                    os.killpg(disk_probe.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    disk_probe.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(disk_probe.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    disk_probe.wait(timeout=2)
                disk_probe = None
                disk_allowed = False

            if task is not None and task.poll() is not None:
                status = task.wait()
                print(f"Idle task exited with status {status}; no automatic retry is scheduled.", flush=True)
                return status
            lock_present = args.lock_file.exists()
            if lock_present:
                if lock_seen_since is None:
                    lock_seen_since = now
            else:
                lock_seen_since = None
            runner_active = runner_process_active(args.proc_root)
            if runner_active:
                busy_reason = "runner execution process"
            elif lock_present and now - lock_seen_since >= LOCK_GRACE_SECONDS:
                busy_reason = "claim lock held over 5 seconds"
            elif resource_pressure(args.proc_root, include_cpu=budget is None):
                busy_reason = "host resource pressure"
            elif not disk_allowed:
                busy_reason = "disk budget unavailable"
            elif budget and cpu_sample["other_percent"] >= args.cpu_target_percent - 0.5:
                busy_reason = "CPU target supplied by other work"
            else:
                busy_reason = None

            if busy_reason:
                report_gate(busy_reason)
                if task is not None:
                    stop_task(task)
                    task = None
                idle_since = None
            else:
                report_gate("claim lock" if lock_present else "clear")
            if budget:
                permitted = budget.update(cpu_sample, not busy_reason,
                                          task is not None, busy_reason)
                if not permitted and task is not None:
                    stop_task(task)
                    task = None
                    idle_since = None
            if not busy_reason and not lock_present and task is None:
                now = time.monotonic()
                if idle_since is None:
                    idle_since = now
                elif now - idle_since >= args.resume_after:
                    task = start_task(command, args.task_user, args.state_dir)
                    idle_since = None
                    print("Idle task started.", flush=True)
            elif not busy_reason and lock_present and idle_since is None:
                idle_since = now
            time.sleep(1)
    finally:
        stop_task(task)
        if disk_probe is not None:
            stop_group(disk_probe)
        if budget:
            budget.apply_quota(5.0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
