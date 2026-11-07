import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnvironment } from "./signing/windows-process.mjs";
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { eligibilityReasons, parseJobClaim } from "../packages/contracts/runner-scheduling.mjs";
import {
  createGitEdgeExecutionArgs,
  runnerJobMatches,
  runnerProfileForClaim,
} from "./runner-broker-execution.mjs";
import {
  createSigningWorkflow,
  normalizeSigningWorkflowTimeout,
  readSigningReceipt,
} from "./runner-broker-signing-workflow.mjs";
import {
  SupersededError,
  createDispatchSession,
  runDispatchSocket,
} from "./runner-broker-socket.mjs";
import { superviseBroker } from "./runner-broker-supervisor.mjs";
import { createSlotPool } from "./runner-slot-pool.mjs";
import {
  loadVmPools,
  recoverJobVms,
  verifyVmImage,
  createJobVm,
  getVmCapacity,
  guestEnvironment,
  guestPaths,
  vmSlot,
} from "./runner-vm.mjs";
import { createRunDirectory } from "./runner-run-root.mjs";
import { loadRunnerCache, patchRunnerCacheEnvironment, cacheEnvironment } from "./runner-cache.mjs";
import { createRunnerCacheProxy } from "./runner-cache-protocol.mjs";
import { pruneRunArtifacts, runArtifactRoots } from "./runner-retention.mjs";
import {
  getRunnerCapacity,
  localExecutionMinutes,
  parseRunnerBudget,
  validateCapacityClaim,
  validateLocalJobClaim,
} from "./runner-capacity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = (name) => `${name}${process.platform === "win32" ? ".exe" : ""}`;
const stateDefault = path.join(root, "work", "runner-broker");
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

function originValue(value) {
  const url = new URL(value);
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.hostname.endsWith(".localhost");
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("The origin must be HTTPS, or HTTP on loopback.");
  return url.origin;
}

function repositorySegment(value, label) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9._-]+$/.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new Error(`${label} must be a single repository path segment.`);
  return value;
}

function validateLabels(labels) {
  if (labels.some((label) => label.length > 100 || /[\r\n\0]/.test(label)))
    throw new Error("Runner labels must be at most 100 characters and contain no line breaks.");
}

function profileState(profile) {
  return path.resolve(profile.directory, "..", "..");
}

function safeRunId(value) {
  if (!(
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  ))
    throw new Error("The queued run has an invalid identifier.");
  const id = String(value);
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(id) || id === "." || id === "..")
    throw new Error("The queued run has an invalid identifier.");
  return id;
}

function parseList(values = []) {
  return [
    ...new Set(
      values
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

function mergeLabels(...groups) {
  const labels = new Map();
  for (const label of groups.flat()) {
    const key = label.toLowerCase();
    if (!labels.has(key)) labels.set(key, label);
  }
  return [...labels.values()];
}

function validateProfileId(id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id))
    throw new Error("Profile names must use 1–64 letters, numbers, dots, underscores, or dashes.");
  return id;
}

function defaultProfileId(kind, endpoint, owner, repository) {
  const suffix = createHash("sha256")
    .update(`${endpoint}/${owner}/${repository ?? ""}`)
    .digest("hex")
    .slice(0, 8);
  return `${`${kind}-${owner}-${repository ?? "org"}`.slice(0, 54)}-${suffix}`;
}

function validateProfileHostLabels(labels, guest) {
  const actual = hostLabels(guest);
  for (const label of labels.map((value) => value.toLowerCase())) {
    if (["linux", "windows", "macos", "x64", "arm64"].includes(label) && !actual.has(label))
      throw new Error(`Profile label ${label} does not match this host.`);
    if (
      (label === "ubuntu" && !actual.has("linux")) ||
      /^(?:ubuntu|windows|macos)-(?:latest|[0-9]+(?:\.[0-9]+)*)(?:-(?:arm|arm64|intel|large|xlarge))*$/.test(
        label
      )
    )
      throw new Error(`GitHub-hosted runner label ${label} cannot be assigned to a local runner.`);
  }
}

async function ensureState(state) {
  await mkdir(path.join(state, "profiles"), { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  await chmod(path.join(state, "profiles"), 0o700);
}

async function acquireStateLock(state, action) {
  const lockPath = path.join(state, "active.lock");
  return lockfile
    .lock(state, {
      lockfilePath: lockPath,
      stale: 60_000,
      update: 10_000,
      retries: 0,
      onCompromised() {
        console.error("Broker state lock was lost; stopping execution.");
        process.kill(process.pid, "SIGTERM");
      },
    })
    .catch((error) => {
      if (error.code === "ELOCKED")
        throw new Error(
          `Runner broker state is busy; ${action} cannot start while another process holds ${lockPath}.`
        );
      throw error;
    });
}

async function withStateLock(state, action, operation) {
  const release = await acquireStateLock(state, action);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function writePrivate(file, content, { secure = false } = {}) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    if (secure) await secureSigningPath(temporary);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function loadProfile(state, id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new Error("Invalid profile name.");
  const directory = path.join(state, "profiles", id);
  const profile = JSON.parse(await readFile(path.join(directory, "profile.json"), "utf8"));
  if (profile.execution !== undefined && profile.execution !== "hyperv")
    throw new Error("Unsupported profile execution mode.");
  let credential;
  try {
    credential = await readFile(path.join(directory, "credential"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { ...profile, directory, credential };
}

async function apiRequest(origin, token, route, options = {}, timeoutMs = 20_000) {
  const target = new URL(route, origin);
  if (target.origin !== origin || !route.startsWith("/"))
    throw new Error("GitEdge API requests must stay on the configured origin.");
  const response = await fetch(target, {
    ...options,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
  }).catch((error) => {
    const code = error.cause?.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,64}$/.test(code))
      throw new Error(`GitEdge API request failed (${code}).`, { cause: error });
    throw error;
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitEdge API returned HTTP ${response.status}.`, {
      cause: { status: response.status },
    });
  }
  if (response.status === 204) return undefined;
  if (new URL(response.url).origin !== origin) {
    await response.body?.cancel();
    throw new Error("GitEdge API response origin did not match the configured origin.");
  }
  if (!response.body) throw new Error("GitEdge API returned an empty response.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("GitEdge API response exceeds 8 MiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("GitEdge API returned invalid JSON.");
  }
}

async function leaseRequest(origin, token, route, options, expiresAt, runId) {
  for (let attempt = 0; ; attempt++) {
    const remaining = expiresAt - Date.now() - 1_000;
    if (remaining <= 0) throw new Error("The runner lease expired before completing the request.");
    try {
      return await apiRequest(
        origin,
        token,
        route,
        {
          ...options,
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(remaining)].filter(Boolean)),
        },
        Math.min(15_000, remaining)
      );
    } catch (error) {
      const status = error.cause?.status;
      const transient =
        error.name === "TimeoutError" ||
        error.name === "TypeError" ||
        error.cause?.name === "TypeError" ||
        status === 429 ||
        (status >= 500 && status <= 599);
      const delay = Math.min(10_000, 2_000 * 2 ** attempt);
      if (!transient || options.signal?.aborted || expiresAt - Date.now() <= delay + 1_000)
        throw error;
      console.error(
        JSON.stringify({
          event: "runner-transport-retry",
          time: new Date().toISOString(),
          runId,
          operation: route.split("/").at(-1),
          attempt: attempt + 1,
          leaseRemainingMs: expiresAt - Date.now(),
          errorType: error.name,
        })
      );
      await sleep(delay, options.signal);
    }
  }
}

async function addGitEdge(state, values) {
  const origin = originValue(values.origin ?? "");
  const owner = values.owner;
  const repository = values.repository;
  const labels = parseList(values.label);
  const id = validateProfileId(
    values.name ?? defaultProfileId("gitedge", origin, owner, repository)
  );
  const pools = await loadVmPools(state);
  const vm = pools?.configs.get(id);
  if (pools && !vm) throw new Error("The profile name must match a configured VM pool.");
  if (!owner || labels.length === 0)
    throw new Error(
      "register-gitedge requires --owner, optional --repository, and at least one --label."
    );
  repositorySegment(owner, "--owner");
  if (repository) repositorySegment(repository, "--repository");
  validateLabels(labels);
  validateProfileHostLabels(labels, vm?.guest);
  const budget = parseRunnerBudget(values);
  const slots = vm?.slots ?? (values.slots === undefined ? 1 : parseSlots(values.slots));
  if (vm && values.slots !== undefined && parseSlots(values.slots) !== slots)
    throw new Error("VM slot counts must match vm.json.");
  const runnerLabels = mergeLabels([...hostLabels(vm?.guest)], labels);
  const adminToken = process.env.GITEDGE_TOKEN;
  if (!adminToken) throw new Error("Set GITEDGE_TOKEN to an admin-scoped GitEdge access token.");
  if (/\s/.test(adminToken)) throw new Error("GITEDGE_TOKEN must not contain whitespace.");
  const runnerPath = vm?.guest.runnerPath ?? path.resolve(values["runner-path"] ?? "");
  if (!vm && !values["runner-path"])
    throw new Error(
      "register-gitedge requires --runner-path to an installed official runner directory."
    );
  if (!vm)
    await access(path.join(runnerPath, "bin", executable("Runner.Listener")), constants.X_OK);
  const directory = path.join(state, "profiles", id);
  try {
    await access(directory);
    throw new Error(`Profile ${id} already exists.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(path.join(state, "profiles", `.adding-${id}-`));
  await chmod(staging, 0o700);
  let runnerId;
  try {
    const data = await apiRequest(origin, adminToken, "/api/actions/runners", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `broker-${id.slice(0, 45)}-${randomUUID().slice(0, 8)}`,
        scope: { owner, ...(repository ? { repository } : {}) },
        labels: runnerLabels,
      }),
    });
    const runner = data?.data?.runner;
    const runnerToken = data?.data?.token;
    const validRunnerId =
      (typeof runner?.id === "number" && Number.isSafeInteger(runner.id) && runner.id > 0) ||
      (typeof runner?.id === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(runner.id));
    if (validRunnerId) runnerId = runner.id;
    if (!validRunnerId || typeof runnerToken !== "string" || !runnerToken)
      throw new Error("GitEdge returned an invalid runner registration response.");
    await writePrivate(
      path.join(staging, "profile.json"),
      JSON.stringify(
        {
          id,
          kind: "gitedge",
          ...(vm ? { execution: "hyperv" } : {}),
          origin,
          owner,
          repository,
          labels: runnerLabels,
          ...(budget ? { budget } : {}),
          ...(slots > 1 ? { slots } : {}),
          runnerPath,
          runnerId: runner.id,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n"
    );
    await writePrivate(path.join(staging, "credential"), runnerToken);
    await rename(staging, directory);
    console.log(
      `Registered GitEdge runner profile ${id} (${owner}${repository ? `/${repository}` : " organization scope"}). Matched signing tasks receive protected secrets for that task.`
    );
  } catch (error) {
    if (runnerId)
      await apiRequest(origin, adminToken, `/api/actions/runners/${encodeURIComponent(runnerId)}`, {
        method: "DELETE",
      }).catch(() => {});
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function setSlots(state, id, value) {
  const slots = parseSlots(value);
  const profile = await loadProfile(state, id);
  const vm = (await loadVmPools(state))?.configs.get(id);
  if (profile.execution === "hyperv" && !vm)
    throw new Error("The VM profile requires a matching pool in vm.json.");
  if (vm && vm.slots !== slots)
    throw new Error("Configure VM addresses and slot counts together in vm.json.");
  const file = path.join(state, "profiles", id, "profile.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  if (slots > 1) saved.slots = slots;
  else delete saved.slots;
  await writePrivate(file, JSON.stringify(saved, null, 2) + "\n");
  console.log(`Profile ${id} now uses up to ${slots} execution ${slots === 1 ? "slot" : "slots"}.`);
}

async function listProfiles(state) {
  const entries = (await readdir(path.join(state, "profiles"), { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith(".")
  );
  if (entries.length === 0) return console.log("No runner profiles registered.");
  for (const entry of entries) {
    const profile = JSON.parse(
      await readFile(path.join(state, "profiles", entry.name, "profile.json"), "utf8")
    );
    assertGitEdgeProfile(profile);
    console.log(
      `${profile.id}\t${profile.origin}\t${profile.repository ? `${profile.owner}/${profile.repository}` : profile.owner}\t${profile.labels.join(",")}`
    );
  }
}

function hostLabels(guest) {
  const platform = guest ? { windows: "win32", linux: "linux" }[guest.platform] : process.platform;
  const arch = guest?.arch ?? process.arch;
  if (!["darwin", "win32", "linux"].includes(platform))
    throw new Error("The runner broker supports Linux, macOS, and Windows hosts.");
  if (!["x64", "arm64"].includes(arch))
    throw new Error("The runner broker supports x64 and ARM64 hosts.");
  const osLabel = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";
  const archLabel = arch === "arm64" ? "ARM64" : "X64";
  return new Set([
    "self-hosted",
    osLabel,
    archLabel,
    ...osLabel.split(" ").map((part) => part.toLowerCase()),
    archLabel.toLowerCase(),
  ]);
}

function eligible(labels, profile) {
  return runnerJobMatches(labels, profile.labels, hostLabels());
}

const actionsState = path.join(root, "work", "actions");

const actionsLockName = (index) => (index === 0 ? "active.lock" : `active-${index}.lock`);

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function lockOwner(lockPath) {
  try {
    const { pid } = JSON.parse(await readFile(lockPath, "utf8"));
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

// Drops a slot lock whose owning process no longer exists.
async function removeStaleLock(lockPath) {
  const pid = await lockOwner(lockPath);
  if (pid === undefined || pid === process.pid || processAlive(pid)) return false;
  await rm(lockPath, { force: true });
  return true;
}

// Called by the supervisor after a worker dies, so its slot locks never outlive it.
async function removeLocksOfProcess(pid) {
  const names = await readdir(actionsState).catch(() => []);
  await Promise.all(
    names
      .filter((name) => /^active(?:-\d+)?\.lock$/.test(name))
      .map(async (name) => {
        const lockPath = path.join(actionsState, name);
        if ((await lockOwner(lockPath)) === pid) await rm(lockPath, { force: true });
      })
  );
}

async function acquireActionsSlot(index) {
  await mkdir(actionsState, { recursive: true, mode: 0o700 });
  const lockPath = path.join(actionsState, actionsLockName(index));
  for (let attempt = 0; attempt < 2; attempt++) {
    const lock = await open(lockPath, "wx", 0o600).catch((error) => {
      if (error.code === "EEXIST") return undefined;
      throw error;
    });
    if (lock) {
      try {
        await lock.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
        );
      } catch (error) {
        await lock.close();
        await rm(lockPath, { force: true });
        throw error;
      }
      return async () => {
        await lock.close();
        await rm(lockPath, { force: true });
      };
    }
    if (!(await removeStaleLock(lockPath))) return undefined;
  }
  return undefined;
}

async function runClaimedGitHub(profile, claim, signal) {
  profile = runnerProfileForClaim(profile, claim);
  validateProfileHostLabels(profile.labels);
  const { run, leaseToken } = claim;
  if (
    typeof run.id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(run.id) ||
    typeof run.owner !== "string" ||
    typeof run.repository !== "string" ||
    !/^[a-zA-Z0-9._-]+$/.test(run.owner) ||
    !/^[a-zA-Z0-9._-]+$/.test(run.repository) ||
    !Number.isSafeInteger(run.jobId) ||
    run.jobId < 1 ||
    !Number.isSafeInteger(run.runId) ||
    run.runId < 1 ||
    !Array.isArray(run.labels) ||
    run.labels.some(
      (label) => typeof label !== "string" || label.length > 100 || /[\r\n\0]/.test(label)
    ) ||
    typeof run.encodedJitConfig !== "string" ||
    !run.encodedJitConfig ||
    Buffer.byteLength(run.encodedJitConfig) > 1024 * 1024 ||
    !Number.isSafeInteger(run.githubRunnerId) ||
    run.githubRunnerId < 1 ||
    !Number.isInteger(run.timeoutMinutes) ||
    run.timeoutMinutes < 1 ||
    run.timeoutMinutes > 360 ||
    typeof leaseToken !== "string" ||
    !leaseToken ||
    !Number.isFinite(claim.leaseExpiresAt) ||
    claim.leaseExpiresAt <= Date.now()
  )
    throw new Error("GitEdge returned invalid GitHub runner execution metadata.");
  if (
    run.scope?.owner?.toLowerCase() !== profile.owner.toLowerCase() ||
    (profile.repository &&
      run.scope?.repository?.toLowerCase() !== profile.repository.toLowerCase())
  )
    throw new Error("GitEdge returned a GitHub repository outside this runner profile.");
  const jobClaim = parseJobClaim(run.labels);
  if (!eligible(run.labels, profile))
    throw new Error("GitHub job labels do not match this runner host.");
  const capacity = await getRunnerCapacity({
    workDirectories: [profile.directory, path.join(root, "work", "actions")],
  });
  validateLocalJobClaim(run.labels, capacity, 360);
  const runId = run.id;
  const execution = AbortSignal.any([
    signal,
    AbortSignal.timeout(localExecutionMinutes(jobClaim, run.timeoutMinutes) * 60_000),
  ]);
  const runDir = await createRunDirectory(profileState(profile), "run");
  const runner = path.join(runDir, "runner");
  let child;
  let output = "";
  let conclusion = "failure";
  let executionError;
  let cacheProxy;
  const logTail = () => {
    const bytes = Buffer.from(
      output.replaceAll(run.encodedJitConfig, "[REDACTED]").replaceAll(leaseToken, "[REDACTED]")
    );
    let start = Math.max(0, bytes.length - 16_384);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString("utf8");
  };
  const complete = async () => {
    await leaseRequest(
      profile.origin,
      profile.credential,
      "/api/actions/runner/github/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, leaseToken, conclusion, log: logTail() }),
      },
      leaseExpiresAt,
      runId
    );
  };
  const heartbeatController = new AbortController();
  const heartbeatSignal = AbortSignal.any([execution, heartbeatController.signal]);
  const startedAt = Date.now();
  let leaseExpiresAt = claim.leaseExpiresAt;
  let heartbeatFailure;
  const heartbeat = (async () => {
    while (!heartbeatSignal.aborted) {
      await sleep(
        Math.min(30_000, Math.max(0, leaseExpiresAt - Date.now() - 50_000)),
        heartbeatSignal
      );
      if (child && child.exitCode !== null) return;
      const response = await leaseRequest(
        profile.origin,
        profile.credential,
        "/api/actions/runner/github/heartbeat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId, leaseToken }),
          signal: heartbeatSignal,
        },
        leaseExpiresAt,
        runId
      );
      if (
        typeof response?.data?.cancelled !== "boolean" ||
        typeof response.data.assigned !== "boolean" ||
        !Number.isFinite(response.data.leaseExpiresAt) ||
        (!response.data.cancelled && response.data.leaseExpiresAt <= Date.now())
      )
        throw new Error("GitEdge returned an invalid GitHub runner heartbeat.");
      if (response.data.cancelled) throw new Error("GitEdge requested cancellation.");
      leaseExpiresAt = response.data.leaseExpiresAt;
      if (!response.data.assigned && Date.now() - startedAt >= 120_000)
        throw new Error("GitHub job was not assigned within 120 seconds.");
    }
  })();
  void heartbeat.catch((error) => {
    if (!heartbeatController.signal.aborted) {
      heartbeatFailure = error;
      if (child && child.exitCode === null) void killChild(child);
    }
  });
  try {
    await mkdir(runner);
    await cp(path.join(profile.runnerPath, "bin"), path.join(runner, "bin"), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
    await cp(path.join(profile.runnerPath, "externals"), path.join(runner, "externals"), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
    await patchRunnerCacheEnvironment(runner);
    cacheProxy = await createRunnerCacheProxy({ endpoint: profile.cacheEndpoint });
    if (heartbeatFailure) throw heartbeatFailure;
    if (execution.aborted) throw execution.reason;
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        /^(?:GH_|GITHUB_|GITEDGE_|ACTIONS_RUNNER_INPUT_|RUNNER_TOKEN$|ACTIONS_RUNTIME_TOKEN$|ACTIONS_RESULTS_|ACTIONS_CACHE_)/i.test(
          key
        )
      )
        delete env[key];
    env.ACTIONS_RUNNER_INPUT_JITCONFIG = run.encodedJitConfig;
    env.RUNNER_ALLOW_RUNASROOT = "1";
    env.GH_CONFIG_DIR = path.join(runDir, "gh-config");
    Object.assign(env, cacheEnvironment(cacheProxy.url, profile.cacheEndpoint));
    await mkdir(env.GH_CONFIG_DIR, { mode: 0o700 });
    child = spawn(path.join(runner, "bin", executable("Runner.Listener")), ["run"], {
      cwd: runner,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    for (const stream of [child.stdout, child.stderr])
      stream.setEncoding("utf8").on("data", (chunk) => {
        output = (output + chunk).slice(-32_768);
      });
    await waitChild(child, execution);
    if (heartbeatFailure) throw heartbeatFailure;
    conclusion = "success";
  } catch (error) {
    error = heartbeatFailure ?? error;
    executionError = error;
    if (
      signal.aborted ||
      error.message === "GitEdge requested cancellation." ||
      heartbeatFailure?.message === "GitEdge requested cancellation."
    )
      conclusion = "cancelled";
    output = `${output}\n${error instanceof Error ? error.message : "Runner failed."}`.slice(
      -32_768
    );
  } finally {
    heartbeatController.abort();
    if (child && child.exitCode === null) await killChild(child);
    await heartbeat.catch(() => {});
    await cacheProxy?.close();
    await rm(runner, { recursive: true, force: true });
    await complete().catch((error) => {
      console.error(`Could not report GitHub run ${runId}: ${error.message}`);
    });
    await rm(runDir, { recursive: true, force: true });
    if (conclusion !== "success") {
      const logs = path.join(profile.directory, "logs");
      await mkdir(logs, { recursive: true, mode: 0o700 });
      await chmod(logs, 0o700);
      const logFile = path.join(logs, `${runId}.log`);
      await writePrivate(logFile, logTail());
      console.error(`GitHub run ${runId}: ${conclusion}. Log: ${logFile}`);
    }
    console.log(`GitHub run ${runId}: ${conclusion}.`);
  }
  if (executionError && conclusion === "failure" && !signal.aborted) throw executionError;
}

async function secureSigningPath(target, directory = false) {
  if (process.platform !== "win32") {
    await chmod(target, directory ? 0o700 : 0o600);
    return;
  }
  const helper = path.join(root, "scripts", "secure-runner-context.ps1");
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      helper,
      "-Path",
      target,
      ...(directory ? ["-Directory"] : []),
    ],
    { stdio: "inherit", env: windowsPowerShellEnvironment() }
  );
  await waitChild(child, new AbortController().signal);
}

async function runClaimedSigning(profile, claim, signal) {
  profile = runnerProfileForClaim(profile, claim);
  validateProfileHostLabels(profile.labels);
  const { run } = claim;
  if (
    typeof run.id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(run.id) ||
    typeof run.requestId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(run.requestId) ||
    typeof run.ownerId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(run.ownerId) ||
    typeof run.repositoryId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(run.repositoryId) ||
    typeof run.workflowOid !== "string" ||
    !/^[0-9a-f]{40}$/.test(run.workflowOid) ||
    typeof run.profileRevision !== "string" ||
    !/^[0-9a-f]{40}$/.test(run.profileRevision) ||
    typeof run.stage !== "string" ||
    !["sign", "finalize", "dmg_sign", "dmg_finalize", "windows_sign", "ios_sign"].includes(
      run.stage
    ) ||
    typeof run.inputDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(run.inputDigest) ||
    typeof run.generation !== "number" ||
    !Number.isSafeInteger(run.generation) ||
    run.generation < 1 ||
    typeof run.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(run.nonce) ||
    !["windows", "macos", "ios"].includes(run.platform) ||
    (run.platform === "macos" &&
      !["sign", "finalize", "dmg_sign", "dmg_finalize"].includes(run.stage)) ||
    (run.platform === "windows" && run.stage !== "windows_sign") ||
    (run.platform === "ios" && run.stage !== "ios_sign") ||
    !Number.isSafeInteger(run.timeoutMinutes) ||
    run.timeoutMinutes < 1 ||
    run.timeoutMinutes > 360 ||
    typeof claim.runnerId !== "string" ||
    String(claim.runnerId) !== String(profile.runnerId) ||
    typeof claim.leaseToken !== "string" ||
    typeof claim.leaseExpiresAt !== "number"
  )
    throw new Error(
      "Signing lease identity is incomplete or does not match the registered runner."
    );
  const secret = await readFile(path.join(profile.directory, "credential"), "utf8");
  const context = {
    schemaVersion: 1,
    baseUrl: new URL("/api/actions", profile.origin).toString().replace(/\/$/, ""),
    ownerId: run.ownerId,
    repositoryId: run.repositoryId,
    runnerId: String(claim.runnerId),
    runId: run.id,
    requestId: run.requestId,
    platform: run.platform,
    workflowOid: run.workflowOid,
    profileRevision: run.profileRevision,
    generation: run.generation,
    nonce: run.nonce,
    leaseToken: claim.leaseToken,
    leaseExpiresAt: claim.leaseExpiresAt,
    jobToken: run.token,
  };
  const runDirectory = await createRunDirectory(profileState(profile), "signing");
  const contextFile = path.join(runDirectory, "context.json");
  const receiptFile = path.join(runDirectory, "sdk-receipt.json");
  const workflowFile = path.join(runDirectory, "workflow.yml");
  const eventPayloadFile = path.join(runDirectory, "event.json");
  const heartbeatController = new AbortController();
  const runSignal = AbortSignal.any([signal, heartbeatController.signal]);
  let heartbeatFailure;
  let renew;
  let child;
  try {
    try {
      const capacity = await getRunnerCapacity({
        workDirectories: [profile.directory, path.join(root, "work", "actions")],
      });
      if (
        typeof run.workflowSource !== "string" ||
        typeof run.workflowPath !== "string" ||
        !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.(?:yml|yaml)$/.test(run.workflowPath) ||
        typeof run.repository !== "string" ||
        !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(run.repository) ||
        !Array.isArray(run.labels) ||
        typeof run.token !== "string" ||
        !/^ge_job_[0-9a-f]{64}$/.test(run.token) ||
        typeof run.sha !== "string" ||
        !/^[0-9a-f]{40}$/i.test(run.sha) ||
        typeof run.ref !== "string" ||
        !/^refs\/(?:heads|tags)\/.+/.test(run.ref) ||
        typeof run.event !== "string" ||
        !["push", "workflow_dispatch", "schedule"].includes(run.event) ||
        !["read", "write"].includes(run.permission)
      )
        throw new Error("Signing workflow metadata is incomplete.");
      const budgetedWorkflowSource = normalizeSigningWorkflowTimeout(
        run.workflowSource,
        run.timeoutMinutes
      );
      const workflowDemand = validateGitEdgeWorkflow(budgetedWorkflowSource, profile);
      const requiredLabels = [
        ...new Set([
          ...signingLabelsForTimeout(run.labels, run.timeoutMinutes),
          ...workflowDemand.labels,
        ]),
      ];
      const jobClaim = parseJobClaim(requiredLabels, run.timeoutMinutes);
      if (!workflowDemand.claim.valid || !jobClaim.valid)
        throw new Error("Signing workflow has invalid host requirements.");
      validateLocalJobClaim(requiredLabels, capacity, run.timeoutMinutes);
      await secureSigningPath(runDirectory, true);
      await writePrivate(contextFile, JSON.stringify(context), { secure: true });
      const source = createSigningWorkflow(budgetedWorkflowSource, {
        platform: run.platform,
        clientPath: path.join(root, "scripts", "signing", "client.mjs"),
        contextFile,
        outputParent: runDirectory,
        receiptFile,
        timeoutMinutes: run.timeoutMinutes,
      });
      await writeFile(workflowFile, source, { mode: 0o600 });
      await writeFile(eventPayloadFile, JSON.stringify(run.eventPayload ?? {}), { mode: 0o600 });
      const args = createGitEdgeExecutionArgs({
        runnerScript: runnerScript(),
        profile,
        run,
        workflowFile,
        actionsState: path.join(root, "work", "actions"),
        jobClaim,
        demandLabels: requiredLabels,
        eventPayloadFile,
      });
      const childEnvironment = { ...process.env };
      for (const key of Object.keys(childEnvironment)) {
        if (
          /^(?:gitedge_token|gh_token|gh_enterprise_token|github_token|github_enterprise_token)$/i.test(
            key
          )
        )
          delete childEnvironment[key];
      }
      child = spawn(process.execPath, args, {
        cwd: runDirectory,
        env: {
          ...childEnvironment,
          GITEDGE_TOKEN: run.token,
          GITEDGE_BROKER_SLOT_HELD: "1",
        },
        detached: process.platform !== "win32",
        stdio: "inherit",
        windowsHide: true,
      });
      const heartbeat = async () => {
        let lastHeartbeat = Date.now();
        let leaseExpiresAt = claim.leaseExpiresAt;
        while (!runSignal.aborted && childRunning(child)) {
          await sleep(1_000, runSignal);
          if (!childRunning(child)) return;
          try {
            await access(receiptFile);
            return;
          } catch {}
          if (Date.now() - lastHeartbeat < 30_000) continue;
          let result;
          for (let attempt = 0; ; attempt++) {
            const remaining = leaseExpiresAt - Date.now() - 1_000;
            if (remaining <= 0) throw new Error("Signing lease expired before renewal.");
            try {
              result = await apiRequest(
                profile.origin,
                secret.trim(),
                `/api/actions/runner/signing/requests/${encodeURIComponent(run.requestId)}/heartbeat`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-Runner-Run-Id": run.id,
                    "X-Runner-Lease-Token": claim.leaseToken,
                  },
                  signal: runSignal,
                },
                Math.min(20_000, remaining)
              );
              break;
            } catch (error) {
              try {
                await access(receiptFile);
                return;
              } catch {}
              const status = error.cause?.status;
              const transient =
                error.name === "TimeoutError" ||
                error.name === "TypeError" ||
                error.cause?.name === "TypeError" ||
                status === 429 ||
                (status >= 500 && status <= 599);
              if (!childRunning(child)) return;
              if (!transient || runSignal.aborted) throw error;
              console.error(
                "Signing heartbeat transport failed; retrying within the current lease."
              );
              await sleep(
                Math.min(
                  10_000,
                  2_000 * 2 ** Math.min(attempt, 3),
                  Math.max(0, leaseExpiresAt - Date.now() - 1_000)
                ),
                runSignal
              );
            }
          }
          if (result?.data?.completed === true) return;
          if (
            !Number.isFinite(result?.data?.leaseExpiresAt) ||
            result.data.leaseExpiresAt <= Date.now()
          )
            throw new Error("GitEdge returned an invalid signing lease heartbeat response.");
          leaseExpiresAt = result.data.leaseExpiresAt;
          context.leaseExpiresAt = leaseExpiresAt;
          await writePrivate(contextFile, JSON.stringify(context), { secure: true });
          lastHeartbeat = Date.now();
        }
      };
      renew = heartbeat().catch((error) => {
        if (heartbeatController.signal.aborted || signal.aborted || !childRunning(child)) return;
        heartbeatFailure = error;
        heartbeatController.abort(error);
      });
      await waitChild(child, runSignal);
      if (heartbeatFailure) throw heartbeatFailure;
      await readSigningReceipt(receiptFile, run.requestId);
    } catch (error) {
      if (child && childRunning(child)) await killChild(child);
      if (!signal.aborted) {
        await apiRequest(
          profile.origin,
          secret.trim(),
          `/api/actions/runner/signing/requests/${encodeURIComponent(run.requestId)}/fail`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Runner-Run-Id": run.id,
              "X-Runner-Lease-Token": claim.leaseToken,
            },
            body: JSON.stringify({ code: "execution_failed" }),
          }
        ).catch((reportError) => {
          console.error(`Could not report failed signing stage ${run.id}: ${reportError.message}`);
        });
      }
      throw error;
    }
  } finally {
    heartbeatController.abort();
    await renew?.catch(() => {});
    if (child?.exitCode === null) await killChild(child);
    await rm(runDirectory, { recursive: true, force: true });
  }
}

function validateGitEdgeWorkflow(source, profile) {
  const document = parseDocument(source, { schema: "core", uniqueKeys: true });
  if (document.errors.length) throw new Error("The queued workflow is invalid YAML.");
  const workflow = document.toJS({ maxAliasCount: 100 });
  if (!workflow?.jobs || typeof workflow.jobs !== "object")
    throw new Error("The queued workflow has no jobs.");
  const workflowMaximum = Math.min(
    360,
    Object.values(workflow.jobs).reduce(
      (total, job) => total + (job?.["timeout-minutes"] ?? 360),
      0
    )
  );
  if (!Number.isInteger(workflowMaximum) || workflowMaximum < 1)
    throw new Error("The queued workflow has an invalid total timeout.");
  const labelsUnion = [];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const labels = typeof job?.["runs-on"] === "string" ? [job["runs-on"]] : job?.["runs-on"];
    if (
      !Array.isArray(labels) ||
      labels.some((label) => typeof label !== "string") ||
      !eligible(labels, profile)
    )
      throw new Error(
        `Job ${name} does not target this host's self-hosted operating system, architecture, and labels.`
      );
    const timeout = job?.["timeout-minutes"] ?? 360;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 360)
      throw new Error(`Job ${name} has an invalid timeout-minutes value.`);
    labelsUnion.push(...labels);
  }
  const claim = parseJobClaim(labelsUnion, workflowMaximum);
  if (!claim.valid) throw new Error("The workflow has an invalid runner resource requirement.");
  return { claim, labels: labelsUnion };
}

function signingLabelsForTimeout(labels, timeoutMinutes) {
  const retained = labels.filter((label) => {
    const match = /^need-time-(\d+)m$/i.exec(label);
    if (!match) return true;
    const minutes = Number(match[1]);
    return !Number.isInteger(minutes) || minutes < 1 || minutes > 360;
  });
  retained.push(`need-time-${timeoutMinutes}m`);
  return [...new Set(retained.map((label) => label.toLowerCase()))];
}

function waitChild(child, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      void killChild(child);
      reject(signal.reason);
    };
    if (signal.aborted) {
      void killChild(child);
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code, sig) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve(0);
      else reject(new Error(`Runner.Listener exited with status ${code ?? sig ?? 1}.`));
    });
  });
}

const childStops = new WeakMap();

function childRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function killChild(child) {
  if (!child.pid || !childRunning(child)) return;
  if (childStops.has(child)) return childStops.get(child);
  const stopping = (async () => {
    const killTree = async () => {
      if (process.platform === "win32") {
        await new Promise((resolve) => {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
          });
          killer.once("error", resolve);
          killer.once("close", resolve);
        });
      } else process.kill(-child.pid, "SIGKILL");
    };
    try {
      if (process.platform === "win32") await killTree();
      else process.kill(-child.pid, "SIGTERM");
    } catch {}
    if (childRunning(child)) {
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 15_000)),
      ]);
    }
    if (childRunning(child)) {
      try {
        await killTree();
      } catch {}
      if (childRunning(child)) await new Promise((resolve) => child.once("close", resolve));
    }
  })();
  childStops.set(child, stopping);
  return stopping;
}

function runnerScript() {
  return path.join(root, "scripts", "actions-runner.mjs");
}

async function runGitEdge(profile, run, leaseToken, signal, leaseExpiresAt) {
  let eventPayload = run.eventPayload;
  let eventPayloadSource;
  let jobClaim;
  let workflowDemandLabels;
  try {
    if (
      typeof run.workflowSource !== "string" ||
      typeof run.token !== "string" ||
      !/^ge_job_[0-9a-f]{64}$/.test(run.token) ||
      typeof leaseToken !== "string" ||
      !/^[0-9a-f]{64}$/.test(leaseToken) ||
      !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(run.repository) ||
      run.repository.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("GitEdge returned incomplete execution metadata.");
    safeRunId(run.id);
    if (Buffer.byteLength(run.token) > 4096 || Buffer.byteLength(run.workflowSource) > 1024 * 1024)
      throw new Error("GitEdge execution metadata exceeds its size limit.");
    if (
      typeof run.sha !== "string" ||
      !/^[0-9a-f]{40}$/i.test(run.sha) ||
      typeof run.ref !== "string" ||
      !/^refs\/(?:heads|tags)\/.+/.test(run.ref) ||
      typeof run.event !== "string" ||
      !Number.isInteger(run.timeoutMinutes) ||
      run.timeoutMinutes < 1 ||
      run.timeoutMinutes > 360
    )
      throw new Error("GitEdge returned invalid workflow execution metadata.");
    if (
      typeof run.workflowPath !== "string" ||
      !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.(?:yml|yaml)$/.test(run.workflowPath)
    )
      throw new Error("Only .github/workflows files can run on the local GitEdge broker.");
    if (
      !profile.repository &&
      run.repository.split("/")[0].toLowerCase() !== profile.owner.toLowerCase()
    )
      throw new Error("The claimed repository is outside this GitEdge organization profile.");
    if (
      profile.repository &&
      run.repository.toLowerCase() !== `${profile.owner}/${profile.repository}`.toLowerCase()
    )
      throw new Error("The claimed repository is outside this GitEdge repository profile.");
    if (!["push", "workflow_dispatch", "schedule"].includes(run.event))
      throw new Error(`GitEdge event ${run.event} is not supported by the local broker.`);
    validateProfileHostLabels(profile.labels);
    const workflowDemand = validateGitEdgeWorkflow(run.workflowSource, profile);
    jobClaim = workflowDemand.claim;
    workflowDemandLabels = workflowDemand.labels;
    const capacity = await getRunnerCapacity({
      workDirectories: [profile.directory, path.join(root, "work", "actions")],
    });
    validateCapacityClaim(jobClaim, capacity);
    if (typeof eventPayload === "string") {
      if (Buffer.byteLength(eventPayload) > 1024 * 1024)
        throw new Error("GitEdge event payload exceeds 1 MiB.");
      try {
        eventPayload = JSON.parse(eventPayload);
      } catch {
        throw new Error("GitEdge event payload is invalid JSON.");
      }
    }
    if (eventPayload && (typeof eventPayload !== "object" || Array.isArray(eventPayload)))
      throw new Error("GitEdge event payload must be a JSON object.");
    if (eventPayload) {
      eventPayloadSource = JSON.stringify(eventPayload);
      if (Buffer.byteLength(eventPayloadSource) > 1024 * 1024)
        throw new Error("GitEdge event payload exceeds 1 MiB.");
    }
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "The claimed workflow failed local validation.";
    const log = Buffer.from(reason).subarray(-16_384).toString("utf8");
    await apiRequest(profile.origin, profile.credential, "/api/actions/runner/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: run.id, leaseToken, conclusion: "failure", log }),
    }).catch(() => {});
    console.error(`GitEdge run ${run.id} was rejected: ${reason}`);
    return;
  }
  const runDir = await createRunDirectory(profileState(profile), "run");
  const workflowFile = path.join(runDir, run.workflowPath);
  const logFile = path.join(runDir, "runner.log");
  const eventPayloadFile = eventPayload ? path.join(runDir, "event.json") : undefined;
  await mkdir(path.dirname(workflowFile), { recursive: true, mode: 0o700 });
  if (eventPayload) await writeFile(eventPayloadFile, eventPayloadSource, { mode: 0o600 });
  await writeFile(workflowFile, run.workflowSource, { mode: 0o600 });
  const log = createWriteStream(logFile, { mode: 0o600 });
  const actionsState = path.join(root, "work", "actions");
  const args = createGitEdgeExecutionArgs({
    runnerScript: runnerScript(),
    profile,
    run,
    workflowFile,
    actionsState,
    jobClaim,
    demandLabels: workflowDemandLabels,
    eventPayloadFile,
  });
  const childEnvironment = { ...process.env };
  for (const key of Object.keys(childEnvironment)) {
    if (
      /^(?:gitedge_token|gh_token|gh_enterprise_token|github_token|github_enterprise_token)$/i.test(
        key
      )
    )
      delete childEnvironment[key];
  }
  const child = spawn(process.execPath, args, {
    cwd: runDir,
    env: {
      ...childEnvironment,
      GITEDGE_TOKEN: run.token,
      GITEDGE_BROKER_SLOT_HELD: "1",
      ...(profile.cacheEndpoint ? { GITEDGE_CACHE_ENDPOINT: profile.cacheEndpoint } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let output = "";
  const collect = (stream) =>
    stream.setEncoding("utf8").on("data", (chunk) => {
      log.write(chunk);
      output = (output + chunk).slice(-32_768);
    });
  collect(child.stdout);
  collect(child.stderr);
  const heartbeatController = new AbortController();
  const heartbeatSignal = AbortSignal.any([signal, heartbeatController.signal]);
  const heartbeat = async () => {
    while (!heartbeatSignal.aborted && child.exitCode === null) {
      await sleep(
        Math.min(30_000, Math.max(0, leaseExpiresAt - Date.now() - 50_000)),
        heartbeatSignal
      );
      if (child.exitCode !== null) return;
      const response = await leaseRequest(
        profile.origin,
        profile.credential,
        "/api/actions/runner/heartbeat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: run.id, leaseToken }),
          signal: heartbeatSignal,
        },
        leaseExpiresAt,
        run.id
      );
      if (
        typeof response?.data?.cancelRequested !== "boolean" ||
        !Number.isFinite(response.data.leaseExpiresAt) ||
        (!response.data.cancelRequested && response.data.leaseExpiresAt <= Date.now())
      )
        throw new Error("GitEdge returned an invalid lease heartbeat response.");
      if (response.data.cancelRequested) throw new Error("GitEdge requested cancellation.");
      leaseExpiresAt = response.data.leaseExpiresAt;
    }
  };
  let failure;
  const renew = heartbeat().catch((error) => {
    if ((heartbeatController.signal.aborted || child.exitCode !== null) && !signal.aborted) return;
    failure = error;
    void killChild(child);
  });
  let code;
  let conclusion = "failure";
  let executionError;
  try {
    code = await waitChild(child, signal);
    if (failure) throw failure;
    conclusion = code === 0 ? "success" : "failure";
  } catch (error) {
    executionError = error;
    if (failure?.message === "GitEdge requested cancellation." || signal.aborted)
      conclusion = "cancelled";
  } finally {
    heartbeatController.abort();
    if (child.exitCode === null) await killChild(child);
    await new Promise((resolve) => log.end(resolve));
    await renew.catch(() => {});
    const redacted = output.replaceAll(run.token, "[REDACTED]");
    const bytes = Buffer.from(redacted);
    let start = Math.max(0, bytes.length - 16_384);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    const tail = bytes.subarray(start).toString("utf8");
    const completed = await leaseRequest(
      profile.origin,
      profile.credential,
      "/api/actions/runner/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.id, leaseToken, conclusion, log: tail }),
      },
      leaseExpiresAt,
      run.id
    ).catch((error) => {
      console.error(`Could not report GitEdge run ${run.id}: ${error.message}`);
    });
    if (completed?.data?.completed !== true) {
      console.error(`GitEdge did not confirm completion for run ${run.id}.`);
      process.stdout.write(tail + "\n");
    } else console.log(`GitEdge run ${run.id}: ${conclusion}. Log: ${logFile}`);
  }
  if (failure && failure.message !== "GitEdge requested cancellation." && !signal.aborted)
    throw failure;
  if (executionError && !signal.aborted)
    console.error(`GitEdge run ${run.id} ended with ${conclusion}.`);
}

async function runAssignedClaim(profile, claim, signal) {
  if (claim.run.kind === "github") {
    console.log(`GitEdge profile ${profile.id}: running GitHub job ${claim.run.jobId}.`);
    await runClaimedGitHub(profile, claim, signal);
  } else if (claim.run.kind === "signing") {
    console.log(
      `GitEdge profile ${profile.id}: running protected signing stage ${claim.run.stage}.`
    );
    await runClaimedSigning(profile, claim, signal);
  } else {
    console.log(`GitEdge profile ${profile.id}: running ${claim.run.id}.`);
    await runGitEdge(
      runnerProfileForClaim(profile, claim),
      claim.run,
      claim.leaseToken,
      signal,
      claim.leaseExpiresAt
    );
  }
}

async function renewIsolatedLease(profile, claim, signal, expiresAt = claim.leaseExpiresAt) {
  const signing = claim.run.kind === "signing";
  const endpoint = signing
    ? `/api/actions/runner/signing/requests/${claim.run.requestId}/heartbeat`
    : claim.run.kind === "github"
      ? "/api/actions/runner/github/heartbeat"
      : "/api/actions/runner/heartbeat";
  const response = await leaseRequest(
    profile.origin,
    profile.credential,
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(signing
          ? { "X-Runner-Run-Id": claim.run.id, "X-Runner-Lease-Token": claim.leaseToken }
          : {}),
      },
      ...(!signing
        ? { body: JSON.stringify({ runId: claim.run.id, leaseToken: claim.leaseToken }) }
        : {}),
      signal,
    },
    expiresAt,
    claim.run.id
  );
  const data = response?.data;
  if (data?.cancelled || data?.cancelRequested || data?.completed)
    throw new Error("GitEdge requested cancellation.");
  if (!Number.isFinite(data?.leaseExpiresAt) || data.leaseExpiresAt <= Date.now())
    throw new Error("Invalid VM startup lease renewal.");
  return data.leaseExpiresAt;
}

async function runIsolatedClaim(profile, claim, signal, cache) {
  if (!/^[0-9a-f-]{36}$/i.test(claim.run.id) || !/^[0-9a-f]{64}$/i.test(claim.leaseToken))
    throw new Error("Invalid isolated job lease identity.");
  const stop = new AbortController();
  const bootstrapStop = new AbortController();
  const maximum = localExecutionMinutes(
    parseJobClaim(claim.run.labels ?? profile.labels),
    claim.run.timeoutMinutes
  );
  const executionSignal = AbortSignal.any([
    signal,
    stop.signal,
    AbortSignal.timeout(maximum * 60_000),
  ]);
  const bootSignal = AbortSignal.any([executionSignal, bootstrapStop.signal]);
  const kind = claim.run.kind;
  const signing = kind === "signing";
  let leaseExpiresAt = claim.leaseExpiresAt;
  let bootstrapFailure;
  const renew = (async () => {
    while (!bootSignal.aborted) {
      await sleep(15_000, bootSignal);
      leaseExpiresAt = await renewIsolatedLease(profile, claim, bootSignal, leaseExpiresAt);
    }
  })().catch((error) => {
    if (!bootstrapStop.signal.aborted && !executionSignal.aborted) {
      bootstrapFailure = error;
      stop.abort(error);
    }
  });
  let vm;
  let cacheSession;
  try {
    const capacity = await getVmCapacity(profile.vm, profile.vmSlot);
    validateLocalJobClaim(claim.run.labels ?? profile.labels, capacity, claim.run.timeoutMinutes);
    const address = profile.vmSlot.claimAddress();
    vm = await createJobVm(profile.vm, executionSignal, address);
    cacheSession = cache?.createSession(profile, claim, address);
    console.log(
      `${new Date().toISOString()} VM ${vm.name} started for ${profile.id} run ${claim.run.id}.`
    );
    if (bootstrapFailure) throw bootstrapFailure;
    const guestState = guestPaths(profile.vm).join(profile.vm.guest.root, "state");
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        state: guestState,
        profile: {
          id: profile.id,
          kind: "gitedge",
          runnerId: profile.runnerId,
          origin: profile.origin,
          owner: profile.owner,
          repository: profile.repository,
          labels: profile.labels,
          runnerPath: profile.vm.guest.runnerPath,
          budget: profile.budget,
          cacheEndpoint: cacheSession?.url,
        },
        claim: { ...claim, leaseExpiresAt },
      })
    );
    if (payload.length > 1_400_000)
      throw new Error("The isolated job payload exceeds its transport limit.");
    const task = await vm.start({
      command:
        profile.vm.guest.platform === "windows"
          ? "C:\\Windows\\System32\\cmd.exe"
          : profile.vm.guest.node,
      args:
        profile.vm.guest.platform === "windows"
          ? ["/d", "/c", profile.vm.guest.entrypoint]
          : [
              guestPaths(profile.vm).join(
                profile.vm.guest.runtimeRoot,
                "scripts",
                "runner-broker.mjs"
              ),
              "execute-vm-job",
            ],
      cwd: profile.vm.guest.root,
      env: guestEnvironment(profile.vm, { GITEDGE_VM_JOB: "1", GITEDGE_VM_INSTANCE_ID: vm.name }),
      input: payload,
    });
    payload.fill(0);
    bootstrapStop.abort();
    await renew;
    const result = await task.done;
    const redacted = (data) =>
      Buffer.from(data)
        .toString("utf8")
        .replaceAll(claim.leaseToken, "[REDACTED]")
        .replaceAll(claim.run.token ?? "\0", "[REDACTED]")
        .replaceAll(claim.run.encodedJitConfig ?? "\0", "[REDACTED]");
    process.stdout.write(redacted(result.stdout));
    process.stderr.write(redacted(result.stderr));
    if (result.code !== 0) throw new Error(`The isolated job exited with status ${result.code}.`);
  } catch (error) {
    const cancelled =
      signal.aborted || bootstrapFailure?.message === "GitEdge requested cancellation.";
    const completeEndpoint = signing
      ? `/api/actions/runner/signing/requests/${claim.run.requestId}/fail`
      : kind === "github"
        ? "/api/actions/runner/github/complete"
        : "/api/actions/runner/complete";
    await apiRequest(profile.origin, profile.credential, completeEndpoint, {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/json",
        ...(signing
          ? {
              "X-Runner-Run-Id": claim.run.id,
              "X-Runner-Lease-Token": claim.leaseToken,
            }
          : {}),
      },
      body: JSON.stringify(
        signing
          ? { code: "execution_failed" }
          : {
              runId: claim.run.id,
              leaseToken: claim.leaseToken,
              conclusion: cancelled ? "cancelled" : "failure",
              log: "The isolated execution did not complete.",
            }
      ),
    }).catch(() => {});
    throw error;
  } finally {
    bootstrapStop.abort();
    await renew;
    if (vm) {
      await vm.dispose();
      console.log(`${new Date().toISOString()} VM ${vm.name} reclaimed after run ${claim.run.id}.`);
    }
    await cacheSession?.close();
  }
}

async function executeVmJob() {
  if (process.env.GITEDGE_VM_JOB !== "1")
    throw new Error("VM job execution requires the guest entry point.");
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 1_400_000) throw new Error("The guest job payload exceeds its limit.");
    chunks.push(chunk);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid guest job payload.");
  }
  const { profile, claim, state } = payload;
  if (
    payload.version !== 1 ||
    !profile ||
    !claim?.run ||
    !path.isAbsolute(state) ||
    !/^[0-9a-f-]{36}$/i.test(claim.run.id) ||
    !/^[0-9a-f]{64}$/i.test(claim.leaseToken) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(profile.id) ||
    profile.id === "." ||
    profile.id === ".."
  )
    throw new Error("Invalid guest job identity.");
  originValue(profile.origin);
  await ensureState(state);
  await mkdir(actionsState, { recursive: true, mode: 0o700 });
  profile.directory = path.join(state, "profiles", profile.id);
  await mkdir(profile.directory, { recursive: true, mode: 0o700 });
  profile.credential = `ge_exec_${claim.run.id}_${claim.leaseToken}`;
  await writePrivate(path.join(profile.directory, "credential"), profile.credential);
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => controller.abort(new Error("Stopped.")));
  const jobClaim = parseJobClaim(claim.run.labels ?? profile.labels, claim.run.timeoutMinutes);
  const readyDeadline = Date.now() + 120_000;
  let lastRenewedAt = 0;
  while (true) {
    if (Date.now() - lastRenewedAt >= 15_000) {
      claim.leaseExpiresAt = await renewIsolatedLease(profile, claim, controller.signal);
      lastRenewedAt = Date.now();
    }
    const capacity = await getRunnerCapacity({
      workDirectories: [profile.directory, actionsState],
    });
    const reasons = eligibilityReasons(capacity, undefined, 0, jobClaim);
    if (!reasons.length) break;
    if (reasons.some((reason) => reason !== "mem" && reason !== "load"))
      validateCapacityClaim(jobClaim, capacity);
    if (Date.now() >= readyDeadline)
      throw new Error(
        `Guest startup resources are unavailable (${reasons.join(", ")}); memory ${capacity.memFreeMb} MB, load ${capacity.load1} / ${capacity.cpus}.`
      );
    await sleep(5_000, controller.signal);
  }
  claim.leaseExpiresAt = await renewIsolatedLease(profile, claim, controller.signal);
  await runAssignedClaim(profile, claim, controller.signal);
}

function assertGitEdgeProfile(profile) {
  if (profile.kind !== "gitedge")
    throw new Error(
      `Profile ${profile.id} is a standalone GitHub polling profile, which is no longer supported. Run \`remove ${profile.id}\` and register a generic profile with register-gitedge.`
    );
}

const supersededExitStatus = 78;

const maxSlots = 16;

function parseSlots(value) {
  const slots = Number(value);
  if (!/^\d+$/.test(String(value)) || slots < 1 || slots > maxSlots)
    throw new Error(`--slots must be an integer between 1 and ${maxSlots}.`);
  return slots;
}

async function serve(state, exitStatusOnSupersede, { slots, supervised, once, expiresAt }) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Stopped."));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  if (supervised) {
    process.on("message", (message) => {
      if (message?.type === "stop") stop();
    });
    process.once("disconnect", stop);
  }
  const entries = await readdir(path.join(state, "profiles"), { withFileTypes: true });
  const profiles = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => loadProfile(state, entry.name))
  );
  if (!profiles.length) throw new Error("Register at least one profile before serving.");
  const bootstrapHeartbeat = supervised
    ? setInterval(
        () => process.send({ type: "heartbeat", lastReportAt: 0, connected: false }),
        10_000
      )
    : undefined;
  let vmPools;
  try {
    vmPools = await loadVmPools(state, profiles);
    if (vmPools) {
      if (slots !== undefined) throw new Error("Configure VM slot counts in vm.json.");
      await recoverJobVms(vmPools);
    }
    for (const profile of profiles) {
      assertGitEdgeProfile(profile);
      profile.vm = vmPools?.configs.get(profile.id);
      validateProfileHostLabels(profile.labels, profile.vm?.guest);
      if (profile.vm) await verifyVmImage(profile.vm, controller.signal);
    }
  } catch (error) {
    clearInterval(bootstrapHeartbeat);
    throw error;
  }
  clearInterval(bootstrapHeartbeat);
  await mkdir(actionsState, { recursive: true, mode: 0o700 });
  const poolSize = vmPools
    ? [...vmPools.configs.values()].reduce((sum, config) => sum + config.slots, 0)
    : (slots ?? Math.max(...profiles.map((profile) => profile.slots ?? 1)));
  const slot = createSlotPool({ size: poolSize, acquireLock: acquireActionsSlot });
  const ledger = { memory: 0, cpus: 0 };
  for (const profile of profiles)
    if (profile.vm) profile.vmSlot = vmSlot(vmPools, profile.vm, slot, ledger);
  const cache = await loadRunnerCache(state, profiles);
  let reservedMemMb = 0; // memory claimed by jobs running on this broker
  const localCapacity = async (profile) => ({
    ...(await (profile.vm
      ? getVmCapacity(profile.vm, profile.vmSlot)
      : getRunnerCapacity({
          workDirectories: [profile.directory, actionsState],
          busy: slot.busy(),
          slots: slot.size,
          reservedMemMb,
        }))),
    cache: cache?.capacity(profile) ?? { supported: false },
  });
  const runJob = async (profile, claim, signal) => {
    if (profile.vm) return runIsolatedClaim(profile, claim, signal, cache);
    const cacheSession = cache?.createSession(profile, claim);
    const memMb = parseJobClaim(claim.run.labels ?? []).memMb;
    reservedMemMb += memMb;
    try {
      await runAssignedClaim({ ...profile, cacheEndpoint: cacheSession?.url }, claim, signal);
    } finally {
      reservedMemMb -= memMb;
      await cacheSession?.close();
    }
  };
  const liveness = { lastReportAt: 0, open: 0 };
  let superseded = false;
  let assigned = false;
  let hostedError;
  const expiry = expiresAt
    ? setTimeout(
        () => {
          if (!assigned) controller.abort(new Error("Hosted runner registration expired."));
        },
        Math.max(0, expiresAt - Date.now())
      )
    : undefined;
  const clients = profiles.map((profile) => {
    const label = `GitEdge profile ${profile.id}`;
    const session = createDispatchSession({
      label,
      slot: profile.vmSlot ?? slot,
      getCapacity: () => localCapacity(profile),
      validateOffer: (labels, capacity) => validateLocalJobClaim(labels, capacity, 360),
      runJob: async (claim, signal) => {
        if (once) {
          assigned = true;
          reconnect.abort();
        }
        try {
          await runJob(profile, claim, signal);
        } catch (error) {
          if (once) hostedError = error;
          throw error;
        } finally {
          if (once) controller.abort(new Error("Hosted runner completed its job."));
        }
      },
      signal: controller.signal,
    });
    const unsubscribe = slot.subscribe(() => session.onSlotChange());
    const reconnect = new AbortController();
    const done = runDispatchSocket({
      label,
      origin: profile.origin,
      credential: profile.credential,
      signal: AbortSignal.any([controller.signal, reconnect.signal]),
      buildReport: async () => ({
        type: "report",
        capacity: await localCapacity(profile),
        ...(profile.budget ? { budget: profile.budget } : {}),
      }),
      onOpen: (control) => {
        liveness.open++;
        session.onOpen(control);
      },
      onClose: () => {
        liveness.open--;
        session.onClose();
      },
      onReportSent: (at) => {
        liveness.lastReportAt = Math.max(liveness.lastReportAt, at);
      },
      onFrame: (frame) => session.onFrame(frame),
    })
      .catch((error) => {
        if (!(error instanceof SupersededError)) throw error;
        superseded = true;
        reconnect.abort();
        console.error(
          `${error.message} Running jobs will finish; this broker then exits with status ${exitStatusOnSupersede}.`
        );
      })
      .finally(unsubscribe);
    return { session, done };
  });
  console.log(
    `Runner broker serving ${profiles.length} profiles with ${slot.size} execution ${slot.size === 1 ? "slot" : "slots"}.`
  );
  const heartbeat = supervised
    ? setInterval(() => {
        process.send({
          type: "heartbeat",
          lastReportAt: liveness.lastReportAt,
          connected: liveness.open > 0,
        });
      }, 10_000)
    : undefined;
  if (supervised) process.send({ type: "heartbeat", lastReportAt: 0, connected: false });
  let lastRetentionAt = 0;
  const retention = setInterval(async () => {
    if (Date.now() - lastRetentionAt < 60 * 60 * 1000) return;
    try {
      const release = await slot.tryAcquire({ exclusive: true });
      if (!release) return;
      try {
        await pruneRunArtifacts(runArtifactRoots(state, profiles, actionsState));
        lastRetentionAt = Date.now();
      } finally {
        await release();
      }
    } catch (error) {
      console.error(
        `Retention failed: ${error instanceof Error ? error.message : "Unknown error."}`
      );
    }
  }, 60_000);
  try {
    await Promise.all(clients.map((client) => client.done));
    await Promise.all(clients.map((client) => client.session.drain()));
  } finally {
    clearInterval(retention);
    clearInterval(heartbeat);
    clearTimeout(expiry);
    controller.abort();
    await Promise.allSettled(clients.map((client) => client.done));
    await Promise.allSettled(clients.map((client) => client.session.drain()));
    await cache?.close();
  }
  if (superseded) process.exitCode = exitStatusOnSupersede;
  if (hostedError) throw hostedError;
  return assigned;
}

async function serveHosted(state, values) {
  const origin = originValue(values.origin ?? "");
  const bootstrapToken = process.env.GITEDGE_HOSTED_BOOTSTRAP_TOKEN;
  const oidcToken = process.env.GITEDGE_HOSTED_OIDC_TOKEN;
  delete process.env.GITEDGE_HOSTED_BOOTSTRAP_TOKEN;
  delete process.env.GITEDGE_HOSTED_OIDC_TOKEN;
  for (const key of [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_ENTERPRISE_TOKEN",
  ])
    delete process.env[key];
  if (!bootstrapToken || !oidcToken || /\s/.test(bootstrapToken) || /\s/.test(oidcToken))
    throw new Error("Hosted runner bootstrap and OIDC tokens are required.");
  if (!values["runner-path"]) throw new Error("Hosted runner requires --runner-path.");
  const runnerPath = path.resolve(values["runner-path"]);
  await access(path.join(runnerPath, "bin", executable("Runner.Listener")), constants.X_OK);
  if ((await readdir(path.join(state, "profiles"))).length)
    throw new Error("Hosted runner state must not contain existing profiles.");
  let response;
  const deadline = Date.now() + 60_000;
  while (!response) {
    try {
      response = await apiRequest(origin, bootstrapToken, "/api/actions/hosted-runners/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bootstrapToken, oidcToken, labels: [...hostLabels()] }),
      });
    } catch (error) {
      if (error.cause?.status !== 409 || Date.now() >= deadline) throw error;
      await sleep(2_000);
    }
  }
  const runner = response?.data?.runner;
  const credential = response?.data?.token;
  if (
    typeof runner?.id !== "string" ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(runner.id) ||
    !Array.isArray(runner.labels) ||
    typeof credential !== "string" ||
    !credential ||
    /\s/.test(credential) ||
    !Number.isFinite(runner.expiresAt) ||
    runner.expiresAt <= Date.now()
  )
    throw new Error("GitEdge returned invalid hosted runner registration metadata.");
  repositorySegment(runner.scope?.owner, "owner");
  repositorySegment(runner.scope?.repository, "repository");
  validateLabels(runner.labels);
  validateProfileHostLabels(runner.labels);
  const id = "hosted";
  const directory = path.join(state, "profiles", id);
  await mkdir(directory, { mode: 0o700 });
  try {
    await writePrivate(
      path.join(directory, "profile.json"),
      JSON.stringify({
        id,
        kind: "gitedge",
        origin,
        owner: runner.scope.owner,
        repository: runner.scope.repository,
        labels: runner.labels,
        runnerPath,
        runnerId: runner.id,
      })
    );
    await writePrivate(path.join(directory, "credential"), credential);
    const assigned = await serve(state, supersededExitStatus, {
      slots: 1,
      supervised: false,
      once: true,
      expiresAt: runner.expiresAt,
    });
    if (!assigned) throw new Error("Hosted runner stopped before receiving its job.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function removeProfile(state, id) {
  const profile = await loadProfile(state, id);
  if (profile.kind === "gitedge") {
    const adminToken = process.env.GITEDGE_TOKEN;
    if (!adminToken || /\s/.test(adminToken))
      throw new Error(
        "Set GITEDGE_TOKEN to an admin-scoped token to revoke this GitEdge registration."
      );
    await apiRequest(
      profile.origin,
      adminToken,
      `/api/actions/runners/${encodeURIComponent(profile.runnerId)}`,
      { method: "DELETE" }
    ).catch((error) => {
      if (!error.message.includes("HTTP 404")) throw error;
    });
  }
  await rm(profile.directory, { recursive: true, force: true });
  console.log(`Removed profile ${id}.`);
}

function supersedeExitStatus(value) {
  if (value === undefined) return supersededExitStatus;
  if (!/^\d{1,3}$/.test(value) || Number(value) > 255)
    throw new Error("--supersede-exit-status must be an exit status from 0 to 255.");
  return Number(value);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "state-dir": { type: "string" },
      name: { type: "string" },
      origin: { type: "string" },
      owner: { type: "string" },
      repository: { type: "string" },
      label: { type: "string", multiple: true },
      "runner-path": { type: "string" },
      "install-dir": { type: "string" },
      "max-job-minutes": { type: "string" },
      "daily-minutes": { type: "string" },
      cost: { type: "string" },
      "run-as-user": { type: "string" },
      "supersede-exit-status": { type: "string" },
      slots: { type: "string" },
      worker: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [action, profileId] = positionals;
  if (action === "execute-vm-job") return executeVmJob();
  const state = path.resolve(values["state-dir"] ?? stateDefault);
  if (!action || values.help) {
    console.log(
      "Usage: pnpm run runner-broker -- init|register-gitedge|list|remove|set-slots|verify-vm-images|serve|service [options]\n\nregister-gitedge --origin URL --owner OWNER [--repository REPO] --label LABEL --runner-path DIR [--max-job-minutes N] [--daily-minutes N] [--cost N] [--slots N]\nA generic GitEdge runner executes matched workflow, GitHub and native signing jobs with task-scoped secrets.\nset-slots PROFILE N: sets profile concurrency (1-16, default 1). VM profiles must match vm.json.\nverify-vm-images: recovers owned VM remnants, boots and checks every configured image, then removes the verification VMs.\nserve [--slots N] [--supersede-exit-status N]: starts a supervised broker with one outbound WebSocket per profile. Native profiles share the largest profile slot count and workflow/signing jobs run alone. With vm.json, each job uses a disposable VM and pool slots share the physical host budget; --slots is unavailable. Image verification must pass before connecting. The supervisor restarts an unresponsive worker. A superseded registration finishes running jobs and exits with status 78 (or N).\nservice install|start|stop|status --install-dir DIR [--state-dir DIR] [--run-as-user USER]\nAll commands accept --state-dir DIR. Registration reads GITEDGE_TOKEN."
    );
    console.log(
      "hosted --origin URL --runner-path DIR --state-dir DIR: exchanges the hosted bootstrap and OIDC tokens from the environment and serves one assigned job."
    );
    return;
  }
  await ensureState(state);
  if (action === "init") {
    console.log(`Runner broker state initialized at ${state}.`);
    return;
  }
  if (action === "hosted") {
    if (positionals.length !== 1) throw new Error("hosted does not accept a profile argument.");
    return withStateLock(state, action, () => serveHosted(state, values));
  }
  if (action === "register-gitedge") {
    if (positionals.length !== 1) throw new Error(`${action} does not accept a profile argument.`);
    return withStateLock(state, action, () => addGitEdge(state, values));
  }
  if (action === "list") return listProfiles(state);
  if (action === "verify-vm-images")
    return withStateLock(state, action, async () => {
      const pool = await loadVmPools(state);
      if (!pool) throw new Error("Configure VM pools in vm.json first.");
      await recoverJobVms(pool);
      for (const config of pool.configs.values()) {
        const report = await verifyVmImage(config, AbortSignal.timeout(10 * 60_000));
        console.log(JSON.stringify({ profile: config.id, ...report }));
      }
    });
  if (action === "remove" && profileId)
    return withStateLock(state, `remove:${profileId}`, () => removeProfile(state, profileId));
  if (action === "set-slots" && profileId && positionals.length === 3)
    return withStateLock(state, `set-slots:${profileId}`, () =>
      setSlots(state, profileId, positionals[2])
    );
  if (action === "serve") {
    const exitStatus = supersedeExitStatus(values["supersede-exit-status"]);
    const slots = values.slots === undefined ? undefined : parseSlots(values.slots);
    if (values.worker) {
      try {
        await serve(state, exitStatus, { slots, supervised: Boolean(process.send) });
      } catch (error) {
        if (error.message !== "Stopped.") throw error;
      }
      return;
    }
    const release = await acquireStateLock(state, "serve");
    try {
      process.exitCode = await superviseBroker({
        script: fileURLToPath(import.meta.url),
        args: [
          "serve",
          "--worker",
          "--state-dir",
          state,
          "--supersede-exit-status",
          String(exitStatus),
          ...(slots === undefined ? [] : ["--slots", String(slots)]),
        ],
        supersedeExitStatus: exitStatus,
        onWorkerGone: removeLocksOfProcess,
      });
    } finally {
      await release();
    }
    return;
  }
  if (action === "service") {
    const serviceAction = positionals[1];
    if (!serviceAction || positionals.length !== 2)
      throw new Error("service requires install, start, stop, or status.");
    if (!values["install-dir"]) throw new Error("service requires --install-dir.");
    const serviceScript = path.join(root, "scripts", "runner-broker-service.mjs");
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          serviceScript,
          serviceAction,
          "--install-dir",
          values["install-dir"],
          "--state-dir",
          state,
          ...(values["run-as-user"] ? ["--run-as-user", values["run-as-user"]] : []),
        ],
        { stdio: "inherit" }
      );
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`service ${serviceAction} failed with status ${code ?? 1}.`))
      );
    });
    return;
  }
  throw new Error(
    "Expected init, hosted, register-gitedge, list, remove <profile>, set-slots <profile> <n>, verify-vm-images, serve, or service."
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Runner broker failed.");
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
