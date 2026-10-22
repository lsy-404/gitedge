import { execFile, spawn } from "node:child_process";
import os from "node:os";
import { readFile, statfs } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { matchesCapacity, parseJobClaim } from "../packages/contracts/runner-scheduling.mjs";

const megabyte = 1024 * 1024;
const toolCacheMs = 10 * 60_000;
const toolTimeoutMs = 3_000;
const execFileAsync = promisify(execFile);

export function parseRunnerBudget(values) {
  const budget = {};
  for (const [flag, key, minimum, maximum] of [
    ["max-job-minutes", "maxJobMinutes", 1, 360],
    ["daily-minutes", "dailyMinutes", 1, 1440],
    ["cost", "cost", 0, 100],
  ]) {
    const raw = values[flag];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new Error(`--${flag} must be an integer between ${minimum} and ${maximum}.`);
    budget[key] = value;
  }
  return Object.keys(budget).length ? budget : undefined;
}

export function validateLocalJobClaim(labels, capacity, defaultMinutes) {
  const claim = parseJobClaim(labels, defaultMinutes);
  return validateCapacityClaim(claim, capacity);
}

export function validateCapacityClaim(claim, capacity) {
  if (!claim.valid || !matchesCapacity(capacity, claim))
    throw new Error("Job resource requirements do not match this runner capacity.");
  return claim;
}

export function localExecutionMinutes(claim, workflowMaximum) {
  if (!Number.isInteger(workflowMaximum) || workflowMaximum < 1 || workflowMaximum > 360)
    throw new Error("Workflow timeout must be between 1 and 360 minutes.");
  return Math.min(claim.minutes, workflowMaximum);
}

const toolCommands = () => [
  ["node", process.execPath, ["--version"]],
  ["pnpm", "pnpm", ["--version"]],
  ["git", "git", ["--version"]],
  ["docker", "docker", ["info", "--format", "{{.ServerVersion}}"]],
  ["python", process.platform === "win32" ? "python" : "python3", ["--version"]],
  ["go", "go", ["version"]],
  ["rust", "rustc", ["--version"]],
];

function runProbe(command, args, timeoutMs, spawnChild = spawn) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(available);
    };
    const timer = setTimeout(() => {
      child?.kill();
      finish(false);
    }, timeoutMs);
    try {
      child = spawnChild(command, args, { stdio: "ignore", windowsHide: true });
      child.once("error", () => finish(false));
      child.once("close", (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

export function createToolProbeCache({ now = Date.now, probe = runProbe } = {}) {
  let expiresAt = 0;
  let cachedTools;
  let pending;

  return async function getTools() {
    if (cachedTools && now() < expiresAt) return [...cachedTools];
    if (pending) return [...(await pending)];
    pending = Promise.all(
      toolCommands().map(async ([name, command, args]) =>
        (await probe(command, args, toolTimeoutMs)) ? name : null
      )
    ).then((results) => results.filter(Boolean));
    try {
      cachedTools = await pending;
      expiresAt = now() + toolCacheMs;
      return [...cachedTools];
    } finally {
      pending = undefined;
    }
  };
}

const getTools = createToolProbeCache();

async function linuxAvailableMemoryMb(read = readFile) {
  const info = await read("/proc/meminfo", "utf8");
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(info);
  if (!match) throw new Error("Could not read MemAvailable from /proc/meminfo.");
  const hostAvailable = Math.floor(Number(match[1]) / 1024);
  try {
    const groups = await read("/proc/self/cgroup", "utf8");
    const unified = /^0::(\/[^\n]*)$/m.exec(groups);
    if (!unified) return hostAvailable;
    const cgroup = path.posix.join("/sys/fs/cgroup", unified[1]);
    const [maximum, current] = await Promise.all([
      read(path.posix.join(cgroup, "memory.max"), "utf8"),
      read(path.posix.join(cgroup, "memory.current"), "utf8"),
    ]);
    if (maximum.trim() === "max" || !/^\d+$/.test(maximum.trim()) || !/^\d+$/.test(current.trim()))
      return hostAvailable;
    const cgroupAvailable = Math.floor(
      Math.max(0, Number(BigInt(maximum.trim()) - BigInt(current.trim())) / megabyte)
    );
    return Math.min(hostAvailable, cgroupAvailable);
  } catch {
    return hostAvailable;
  }
}

async function macosAvailableMemoryMb() {
  const { stdout } = await execFileAsync("/usr/bin/vm_stat", [], {
    encoding: "utf8",
    timeout: toolTimeoutMs,
    maxBuffer: 16 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]);
  const pages = ["free", "inactive", "speculative"].map((name) =>
    Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.\\s*$`, "m").exec(stdout)?.[1])
  );
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    pages.some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw new Error("Could not read available memory from vm_stat.");
  return Math.floor((pages.reduce((total, value) => total + value, 0) * pageSize) / megabyte);
}

async function freeDiskMb(directory, getStatfs = statfs) {
  const info = await getStatfs(directory, { bigint: true });
  const availableBlocks = info.bavail ?? info.bfree;
  if (availableBlocks === undefined || info.bsize === undefined)
    throw new Error("Could not read available disk space for the runner work directory.");
  return Number((BigInt(availableBlocks) * BigInt(info.bsize)) / BigInt(megabyte));
}

export async function getRunnerCapacity({ workDirectories, busy = 0 } = {}) {
  const directories = [...new Set(workDirectories ?? [])].map((directory) =>
    path.resolve(directory)
  );
  if (!directories.length) throw new Error("At least one runner work directory is required.");
  const platform = os.platform();
  const [diskFreeMb, tools] = await Promise.all([
    Promise.all(directories.map((directory) => freeDiskMb(directory))).then((values) =>
      Math.min(...values)
    ),
    getTools(),
  ]);
  const memFreeMb =
    platform === "linux"
      ? await linuxAvailableMemoryMb()
      : platform === "darwin"
        ? await macosAvailableMemoryMb()
        : Math.floor(os.freemem() / megabyte);
  return {
    os: platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform,
    arch: os.arch(),
    cpus: os.cpus().length,
    load1: platform === "win32" ? null : (os.loadavg()[0] ?? null),
    memTotalMb: Math.floor(os.totalmem() / megabyte),
    memFreeMb,
    diskFreeMb,
    tools,
    slots: 1,
    busy,
  };
}

export const runnerCapacityInternals = {
  freeDiskMb,
  linuxAvailableMemoryMb,
  runProbe,
  toolTimeoutMs,
};
