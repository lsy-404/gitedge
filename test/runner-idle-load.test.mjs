import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const controller = path.join(repository, "scripts", "runner-idle-load.py");

async function waitFor(predicate, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

test("idle task yields to the broker lock and PSI pressure, resumes, and cleans up", async (t) => {
  if (process.platform !== "linux") return t.skip("Requires Linux process groups and /proc.");

  const directory = await mkdtemp(path.join(os.tmpdir(), "gitedge-idle-load-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const procRoot = path.join(directory, "proc");
  const pressure = path.join(procRoot, "pressure");
  await mkdir(pressure, { recursive: true });
  await writeFile(path.join(procRoot, "loadavg"), "0 0 0 1/1 1\n");
  await writeFile(
    path.join(procRoot, "meminfo"),
    "MemTotal: 8388608 kB\nMemAvailable: 7340032 kB\n"
  );
  await writeFile(path.join(pressure, "cpu"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
  await writeFile(
    path.join(pressure, "memory"),
    "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"
  );
  await writeFile(path.join(pressure, "io"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");

  const lock = path.join(directory, "active.lock");
  const log = path.join(directory, "task.log");
  const task = path.join(directory, "resumable-task.py");
  await writeFile(
    task,
    "import signal, sys, time\nwith open(sys.argv[1], 'a') as log: log.write('start\\n')\ndef stop(_signum, _frame):\n    with open(sys.argv[1], 'a') as log: log.write('term\\n')\n    raise SystemExit(0)\nsignal.signal(signal.SIGTERM, stop)\nsignal.signal(signal.SIGINT, stop)\nwhile True: time.sleep(0.1)\n"
  );

  const child = spawn(
    "python3",
    [
      controller,
      "--lock-file",
      lock,
      "--proc-root",
      procRoot,
      "--state-dir",
      directory,
      "--resume-after",
      "2",
      "--run-for",
      "120",
      "--max-disk-mib",
      "1",
      "--disk-check-interval",
      "1",
      "--",
      "python3",
      task,
      log,
    ],
    { stdio: "ignore" }
  );
  t.after(() => child.kill("SIGTERM"));

  const lines = async () =>
    (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  await waitFor(
    async () => (await lines()).filter((line) => line === "start").length >= 1,
    "initial task start"
  );
  await writeFile(path.join(procRoot, "loadavg"), "0.90 0 0 1/1 1\n");
  await writeFile(path.join(pressure, "cpu"), "some avg10=49.00 avg60=0.00 avg300=0.00 total=0\n");
  await delay(1_200);
  assert.equal((await lines()).filter((line) => line === "term").length, 0);
  await writeFile(path.join(procRoot, "loadavg"), "0 0 0 1/1 1\n");
  await writeFile(path.join(pressure, "cpu"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
  await writeFile(lock, "busy\n");
  await delay(2_000);
  assert.equal((await lines()).filter((line) => line === "term").length, 0);
  await rm(lock);
  const bridgeProcess = path.join(procRoot, "12345");
  await mkdir(bridgeProcess);
  await writeFile(
    path.join(bridgeProcess, "cmdline"),
    Buffer.from("/opt/gitedge-runtime/bin/node\0/opt/gitedge/scripts/actions-runner.mjs\0run\0")
  );
  const bridgeDetectedAt = Date.now();
  await waitFor(
    async () => (await lines()).filter((line) => line === "term").length >= 1,
    "runner bridge preemption",
    2_000
  );
  assert.ok(Date.now() - bridgeDetectedAt < 2_000);
  await rm(bridgeProcess, { recursive: true });
  await waitFor(
    async () => (await lines()).filter((line) => line === "start").length >= 2,
    "resume after broker is idle"
  );

  await writeFile(lock, "busy\n");
  await waitFor(
    async () => (await lines()).filter((line) => line === "term").length >= 2,
    "persistent claim lock preemption"
  );
  await rm(lock);
  await waitFor(
    async () => (await lines()).filter((line) => line === "start").length >= 3,
    "resume after persistent lock clears"
  );

  await writeFile(path.join(pressure, "cpu"), "some avg10=80.00 avg60=0.00 avg300=0.00 total=0\n");
  await waitFor(
    async () => (await lines()).filter((line) => line === "term").length >= 3,
    "CPU PSI preemption"
  );
  await writeFile(path.join(pressure, "cpu"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
  await waitFor(
    async () => (await lines()).filter((line) => line === "start").length >= 4,
    "resume after CPU pressure clears"
  );

  await writeFile(
    path.join(pressure, "memory"),
    "some avg10=6.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"
  );
  await waitFor(
    async () => (await lines()).filter((line) => line === "term").length >= 4,
    "memory PSI preemption"
  );
  await writeFile(
    path.join(pressure, "memory"),
    "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"
  );
  await waitFor(
    async () => (await lines()).filter((line) => line === "start").length >= 5,
    "resume after memory pressure clears"
  );

  await writeFile(path.join(pressure, "io"), "some avg10=9.00 avg60=0.00 avg300=0.00 total=0\n");
  await delay(1_200);
  assert.equal((await lines()).filter((line) => line === "term").length, 4);
  await writeFile(path.join(pressure, "io"), "some avg10=10.00 avg60=0.00 avg300=0.00 total=0\n");
  await waitFor(
    async () => (await lines()).filter((line) => line === "term").length >= 5,
    "I/O PSI preemption"
  );
  await writeFile(path.join(pressure, "io"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
  await waitFor(
    async () => (await lines()).filter((line) => line === "start").length >= 6,
    "resume after I/O pressure clears"
  );

  await writeFile(
    path.join(procRoot, "meminfo"),
    "MemTotal: 8388608 kB\nMemAvailable: 1048576 kB\n"
  );
  await waitFor(
    async () => (await lines()).filter((line) => line === "term").length >= 6,
    "low available memory preemption"
  );
  await writeFile(
    path.join(procRoot, "meminfo"),
    "MemTotal: 8388608 kB\nMemAvailable: 7340032 kB\n"
  );
  await waitFor(
    async () => (await lines()).filter((line) => line === "start").length >= 7,
    "resume after available memory recovers"
  );

  const payload = path.join(directory, "large-data");
  await writeFile(payload, Buffer.alloc(2 * 1024 * 1024));
  await waitFor(
    async () => (await lines()).filter((line) => line === "term").length >= 7,
    "disk budget preemption"
  );
  await rm(payload);
  await waitFor(
    async () => (await lines()).filter((line) => line === "start").length >= 8,
    "resume below disk budget"
  );

  child.kill("SIGTERM");
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Controller did not stop.")), 5_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0);
  await waitFor(
    async () => (await lines()).filter((line) => line === "term").length >= 8,
    "task process group cleanup"
  );
  assert.equal((await lines()).filter((line) => line === "start").length, 8);
});

test("controller refuses to run without a task command", async (t) => {
  if (process.platform !== "linux") return t.skip("Requires Linux process groups and /proc.");
  const child = spawn("python3", [controller], { stdio: "ignore" });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 2);
});

test("short claim-lock flaps preserve the idle recovery grace", async (t) => {
  if (process.platform !== "linux") return t.skip("Requires Linux process groups and /proc.");

  const directory = await mkdtemp(path.join(os.tmpdir(), "gitedge-idle-lock-flap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const procRoot = path.join(directory, "proc");
  const pressure = path.join(procRoot, "pressure");
  await mkdir(pressure, { recursive: true });
  await writeFile(path.join(procRoot, "loadavg"), "0 0 0 1/1 1\n");
  await writeFile(
    path.join(procRoot, "meminfo"),
    "MemTotal: 8388608 kB\nMemAvailable: 7340032 kB\n"
  );
  await writeFile(path.join(pressure, "cpu"), "some avg10=0 avg60=0 avg300=0 total=0\n");
  await writeFile(
    path.join(pressure, "memory"),
    "some avg10=0 avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n"
  );
  await writeFile(path.join(pressure, "io"), "some avg10=0 avg60=0 avg300=0 total=0\n");
  const lock = path.join(directory, "active.lock");
  const log = path.join(directory, "task.log");
  const task = path.join(directory, "task.py");
  await writeFile(lock, "empty poll\n");
  await writeFile(
    task,
    "import signal, sys, time\nwith open(sys.argv[1], 'a') as log: log.write('start\\n')\ndef stop(_signum, _frame):\n    with open(sys.argv[1], 'a') as log: log.write('term\\n')\n    raise SystemExit(0)\nsignal.signal(signal.SIGTERM, stop)\nwhile True: time.sleep(0.1)\n"
  );
  const child = spawn(
    "python3",
    [
      controller,
      "--lock-file",
      lock,
      "--proc-root",
      procRoot,
      "--state-dir",
      directory,
      "--resume-after",
      "6",
      "--run-for",
      "30",
      "--max-disk-mib",
      "1",
      "--",
      "python3",
      task,
      log,
    ],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  await waitFor(
    () => output.includes("waiting on a short claim lock"),
    "short claim lock observation"
  );
  await delay(2_000);
  await rm(lock);
  const releasedAt = Date.now();
  await waitFor(
    async () => (await readFile(log, "utf8").catch(() => "")).includes("start\n"),
    "task start after lock flap",
    5_500
  );
  assert.ok(Date.now() - releasedAt < 5_500);
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Controller did not stop.")), 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  assert.match(await readFile(log, "utf8"), /term\n/);
});

test("task yields below twenty percent available memory and then resumes", async (t) => {
  if (process.platform !== "linux") return t.skip("Requires Linux process groups and /proc.");

  const directory = await mkdtemp(path.join(os.tmpdir(), "gitedge-idle-memory-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const procRoot = path.join(directory, "proc");
  const pressure = path.join(procRoot, "pressure");
  await mkdir(pressure, { recursive: true });
  await writeFile(path.join(procRoot, "loadavg"), "0 0 0 1/1 1\n");
  await writeFile(
    path.join(procRoot, "meminfo"),
    "MemTotal: 1048576 kB\nMemAvailable: 209716 kB\n"
  );
  await writeFile(path.join(pressure, "cpu"), "some avg10=0 avg60=0 avg300=0 total=0\n");
  await writeFile(
    path.join(pressure, "memory"),
    "some avg10=0 avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n"
  );
  await writeFile(path.join(pressure, "io"), "some avg10=0 avg60=0 avg300=0 total=0\n");
  const lock = path.join(directory, "active.lock");
  const log = path.join(directory, "task.log");
  const task = path.join(directory, "task.py");
  await writeFile(
    task,
    "import signal, sys, time\nwith open(sys.argv[1], 'a') as log: log.write('start\\n')\ndef stop(_signum, _frame):\n    with open(sys.argv[1], 'a') as log: log.write('term\\n')\n    raise SystemExit(0)\nsignal.signal(signal.SIGTERM, stop)\nwhile True: time.sleep(0.1)\n"
  );
  const child = spawn(
    "python3",
    [
      controller,
      "--lock-file",
      lock,
      "--proc-root",
      procRoot,
      "--state-dir",
      directory,
      "--resume-after",
      "2",
      "--run-for",
      "30",
      "--max-disk-mib",
      "1",
      "--",
      "python3",
      task,
      log,
    ],
    { stdio: "ignore" }
  );
  t.after(() => child.kill("SIGTERM"));
  const lines = async () =>
    (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  await waitFor(
    async () => (await lines()).filter((line) => line === "start").length === 1,
    "task start above twenty percent"
  );
  await writeFile(
    path.join(procRoot, "meminfo"),
    "MemTotal: 1048576 kB\nMemAvailable: 209715 kB\n"
  );
  await waitFor(
    async () => (await lines()).filter((line) => line === "term").length === 1,
    "preemption below twenty percent"
  );
  await writeFile(
    path.join(procRoot, "meminfo"),
    "MemTotal: 1048576 kB\nMemAvailable: 209716 kB\n"
  );
  await waitFor(
    async () => (await lines()).filter((line) => line === "start").length === 2,
    "resume above twenty percent"
  );
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Controller did not stop.")), 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  await waitFor(
    async () => (await lines()).filter((line) => line === "term").length === 2,
    "task cleanup"
  );
});

test("controller kills a TERM-ignoring descendant after its leader exits", async (t) => {
  if (process.platform !== "linux") return t.skip("Requires Linux process groups and /proc.");

  const directory = await mkdtemp(path.join(os.tmpdir(), "gitedge-idle-descendant-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const procRoot = path.join(directory, "proc");
  const pressure = path.join(procRoot, "pressure");
  await mkdir(pressure, { recursive: true });
  await writeFile(path.join(procRoot, "loadavg"), "0 0 0 1/1 1\n");
  await writeFile(
    path.join(procRoot, "meminfo"),
    "MemTotal: 8388608 kB\nMemAvailable: 7340032 kB\n"
  );
  await writeFile(path.join(pressure, "cpu"), "some avg10=0 avg60=0 avg300=0 total=0\n");
  await writeFile(
    path.join(pressure, "memory"),
    "some avg10=0 avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n"
  );
  await writeFile(path.join(pressure, "io"), "some avg10=0 avg60=0 avg300=0 total=0\n");
  const lock = path.join(directory, "active.lock");
  const childPidFile = path.join(directory, "child.pid");
  const task = path.join(directory, "parent.py");
  await writeFile(
    task,
    "import signal, subprocess, sys, time\nchild = subprocess.Popen([sys.executable, '-c', \"import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)\"])\nopen(sys.argv[1], 'w').write(str(child.pid))\ndef stop(_signum, _frame): raise SystemExit(0)\nsignal.signal(signal.SIGTERM, stop)\nwhile True: time.sleep(0.1)\n"
  );
  const controllerProcess = spawn(
    "python3",
    [
      controller,
      "--lock-file",
      lock,
      "--proc-root",
      procRoot,
      "--state-dir",
      directory,
      "--resume-after",
      "1",
      "--run-for",
      "30",
      "--max-disk-mib",
      "1",
      "--",
      "python3",
      task,
      childPidFile,
    ],
    { stdio: "ignore" }
  );
  t.after(() => controllerProcess.kill("SIGTERM"));
  await waitFor(
    async () => (await readFile(childPidFile, "utf8").catch(() => "")).length > 0,
    "descendant startup"
  );
  const childPid = Number(await readFile(childPidFile, "utf8"));
  await writeFile(lock, "busy\n");
  await waitFor(async () => {
    try {
      const stat = await readFile(`/proc/${childPid}/stat`, "utf8");
      return stat.split(" ")[2] === "Z";
    } catch {
      return true;
    }
  }, "TERM-ignoring descendant cleanup");
  assert.equal(controllerProcess.exitCode, null);
  controllerProcess.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Controller did not stop.")), 5_000);
    controllerProcess.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
});
