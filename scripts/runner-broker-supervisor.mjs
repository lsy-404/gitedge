import { fork } from "node:child_process";
import { killProcessTree } from "./runner-process-tree.mjs";
import { KIT_UPDATE_EXIT_STATUS } from "./runner-launcher.mjs";

const heartbeatTimeoutMs = 90_000;
const reportTimeoutMs = 180_000;
const checkIntervalMs = 5_000;
const initialBackoffMs = 1_000;
const maxBackoffMs = 60_000;
const stableRunMs = 10 * 60_000;

const log = (message) => console.error(`[broker-supervisor] ${message}`);

// Runs the broker worker as a child process and restarts it when it exits unexpectedly or stops
// proving liveness. Resolves with the exit status the supervisor itself should use. Under the
// runner launcher it relays kit announcements up and kit drain requests down.
export function superviseBroker({ script, args, supersedeExitStatus, onWorkerGone }) {
  return new Promise((resolve) => {
    let child;
    let stopping = false;
    let draining = false;
    let backoff = initialBackoffMs;
    let restartTimer;
    const posix = process.platform !== "win32";

    const start = () => {
      const startedAt = Date.now();
      let lastHeartbeatAt = startedAt;
      let lastReportAt = startedAt;
      let killedFor;
      child = fork(script, args, {
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        detached: posix,
      });
      const worker = child;
      log(`started worker ${worker.pid}.`);
      worker.on("message", (message) => {
        if (message?.type === "kit-available") {
          if (process.connected) process.send(message);
          return;
        }
        if (message?.type !== "heartbeat") return;
        lastHeartbeatAt = Date.now();
        // Without an open dispatcher socket no report can flow, so only a connected worker is held to the report deadline.
        if (!message.connected) lastReportAt = Math.max(lastReportAt, lastHeartbeatAt);
        else if (Number.isFinite(message.lastReportAt))
          lastReportAt = Math.max(lastReportAt, message.lastReportAt);
      });
      const watchdog = setInterval(() => {
        if (killedFor) return;
        const now = Date.now();
        if (now - lastHeartbeatAt > heartbeatTimeoutMs) killedFor = "no heartbeat for 90 seconds";
        else if (!stopping && now - lastReportAt > reportTimeoutMs)
          killedFor = "no report sent for 180 seconds";
        if (killedFor) {
          log(`${killedFor}; killing worker ${worker.pid}.`);
          killProcessTree(worker, { group: posix });
        }
      }, checkIntervalMs);
      worker.once("error", (error) => log(`worker error: ${error.message}`));
      worker.once("exit", (code, signal) => {
        clearInterval(watchdog);
        child = undefined;
        void onWorkerGone?.(worker.pid).catch(() => {});
        if (stopping) return resolve(code ?? 0);
        if (draining) {
          log(`worker drained for a runner kit update (${code ?? signal}); stopping.`);
          return resolve(KIT_UPDATE_EXIT_STATUS);
        }
        if (code === supersedeExitStatus && !killedFor) {
          log(`worker exited with status ${code}; stopping.`);
          return resolve(code);
        }
        if (Date.now() - startedAt >= stableRunMs) backoff = initialBackoffMs;
        log(
          `worker exited (${code ?? signal}); restarting in ${Math.round(backoff / 1000)} seconds.`
        );
        restartTimer = setTimeout(start, backoff);
        backoff = Math.min(maxBackoffMs, backoff * 2);
      });
    };

    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(restartTimer);
      if (!child) return resolve(0);
      log("stopping worker.");
      if (child.connected) child.send({ type: "stop" });
      else child.kill("SIGTERM");
    };
    const drain = () => {
      if (stopping || draining) return;
      draining = true;
      clearTimeout(restartTimer);
      if (!child) return resolve(KIT_UPDATE_EXIT_STATUS);
      log("draining worker for a runner kit update.");
      if (child.connected) child.send({ type: "kit-drain" });
    };
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
    if (process.connected) {
      process.on("message", (message) => {
        if (message?.type === "stop") stop();
        else if (message?.type === "kit-drain") drain();
      });
      // The launcher owns this process; without it nothing would restart or update the broker.
      process.once("disconnect", stop);
    }
    start();
  });
}
