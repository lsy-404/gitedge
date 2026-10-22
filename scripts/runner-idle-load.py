#!/usr/bin/env python3
import argparse
import grp
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


def resource_pressure(proc_root):
    try:
        load = float((proc_root / "loadavg").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        load = 0
    if load / max(os.cpu_count() or 1, 1) >= 0.75:
        return True

    pressure = proc_root / "pressure"
    if (
        pressure_over(pressure / "cpu", "some", 80)
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
        return available < 131072 or available / total < 0.20
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
    }
    if task_user:
        user = pwd.getpwnam(task_user)
        group = grp.getgrnam(task_user)
        options.update(user=user.pw_uid, group=group.gr_gid, extra_groups=[])
    return subprocess.Popen(command, **options)


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
    parser = argparse.ArgumentParser(description="Run a checkpoint-capable task only while the host is idle.")
    parser.add_argument("--lock-file", type=Path, default=Path(RUNNER_LOCK))
    parser.add_argument("--proc-root", type=Path, default=Path("/proc"))
    parser.add_argument("--resume-after", type=int, default=45)
    parser.add_argument("--run-for", type=int, default=0)
    parser.add_argument("--state-dir", type=Path, default=Path(STATE_DIR))
    parser.add_argument("--max-disk-mib", type=int, default=512)
    parser.add_argument("--disk-check-interval", type=int, default=10)
    parser.add_argument("--task-user")
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
            elif resource_pressure(args.proc_root):
                busy_reason = "host resource pressure"
            elif not disk_allowed:
                busy_reason = "disk budget unavailable"
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
