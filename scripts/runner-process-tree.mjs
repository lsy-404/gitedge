import { spawn } from "node:child_process";

// Kills a child and its descendants. `group` also signals the child's own process group on POSIX.
export function killProcessTree(child, { group = false } = {}) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      killer.once("error", () => {});
      killer.unref();
    } else if (group) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

// Runs a command and resolves with its stdout. The timer is independent of pipe closure, so a
// descendant that keeps the pipes open cannot stall the caller.
export function captureOutput(command, args, { timeout, maxBuffer, env, windowsHide = true }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    let child;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(new Error("Probe timed out."));
    }, timeout);
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide, env });
    } catch (error) {
      return finish(error);
    }
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      if (output.length > maxBuffer) {
        killProcessTree(child);
        finish(new Error("Probe output is too large."));
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) =>
      code === 0 ? finish(undefined, { stdout: output }) : finish(new Error("Probe failed."))
    );
  });
}
