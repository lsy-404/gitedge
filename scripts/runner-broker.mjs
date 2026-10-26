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
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnvironment } from "./signing/windows-process.mjs";
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { parseJobClaim } from "../packages/contracts/runner-scheduling.mjs";
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
import { createRunDirectory } from "./runner-run-root.mjs";
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

function validateProfileHostLabels(labels) {
  const actual = hostLabels();
  for (const label of labels.map((value) => value.toLowerCase())) {
    if (["linux", "windows", "macos", "x64", "arm64"].includes(label) && !actual.has(label))
      throw new Error(`Profile label ${label} does not match this host.`);
    if (
      (label === "ubuntu" && process.platform !== "linux") ||
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
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST")
      throw new Error(
        `Runner broker state is busy; inspect ${lockPath} before removing a stale lock.`
      );
    throw error;
  });
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, action, startedAt: new Date().toISOString() })
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

async function addGitEdge(state, values) {
  const origin = originValue(values.origin ?? "");
  const owner = values.owner;
  const repository = values.repository;
  const labels = parseList(values.label);
  if (!owner || labels.length === 0)
    throw new Error(
      "register-gitedge requires --owner, optional --repository, and at least one --label."
    );
  repositorySegment(owner, "--owner");
  if (repository) repositorySegment(repository, "--repository");
  validateLabels(labels);
  validateProfileHostLabels(labels);
  const budget = parseRunnerBudget(values);
  const runnerLabels = mergeLabels([...hostLabels()], labels);
  const adminToken = process.env.GITEDGE_TOKEN;
  if (!adminToken) throw new Error("Set GITEDGE_TOKEN to an admin-scoped GitEdge access token.");
  if (/\s/.test(adminToken)) throw new Error("GITEDGE_TOKEN must not contain whitespace.");
  const id = validateProfileId(
    values.name ?? defaultProfileId("gitedge", origin, owner, repository)
  );
  const runnerPath = path.resolve(values["runner-path"] ?? "");
  if (!values["runner-path"])
    throw new Error(
      "register-gitedge requires --runner-path to an installed official runner directory."
    );
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
          origin,
          owner,
          repository,
          labels: runnerLabels,
          ...(budget ? { budget } : {}),
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

function hostLabels() {
  if (!["darwin", "win32", "linux"].includes(process.platform))
    throw new Error("The runner broker supports Linux, macOS, and Windows hosts.");
  if (!["x64", "arm64"].includes(process.arch))
    throw new Error("The runner broker supports x64 and ARM64 hosts.");
  const osLabel =
    process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  const archLabel =
    process.arch === "arm64" ? "ARM64" : process.arch === "x64" ? "X64" : process.arch;
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

async function acquireActionsSlot() {
  const state = actionsState;
  await mkdir(state, { recursive: true, mode: 0o700 });
  const lockPath = path.join(state, "active.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") return undefined;
    throw error;
  });
  if (!lock) return undefined;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
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
  const logTail = () => {
    const bytes = Buffer.from(
      output.replaceAll(run.encodedJitConfig, "[REDACTED]").replaceAll(leaseToken, "[REDACTED]")
    );
    let start = Math.max(0, bytes.length - 16_384);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString("utf8");
  };
  const complete = async () => {
    await apiRequest(profile.origin, profile.credential, "/api/actions/runner/github/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        leaseToken,
        conclusion,
        log: logTail(),
      }),
    });
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
      let response;
      for (let attempt = 0; ; attempt++) {
        const remaining = leaseExpiresAt - Date.now() - 1_000;
        if (remaining <= 0) throw new Error("GitHub runner lease expired before renewal.");
        try {
          response = await apiRequest(
            profile.origin,
            profile.credential,
            "/api/actions/runner/github/heartbeat",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ runId, leaseToken }),
              signal: AbortSignal.any([heartbeatSignal, AbortSignal.timeout(remaining)]),
            },
            Math.min(15_000, remaining)
          );
          break;
        } catch (error) {
          const status = error.cause?.status;
          const transient =
            error.name === "TimeoutError" ||
            error.name === "TypeError" ||
            error.cause?.name === "TypeError" ||
            status === 429 ||
            (status >= 500 && status <= 599);
          const delay = Math.min(10_000, 2_000 * 2 ** attempt);
          if (!transient || heartbeatSignal.aborted || leaseExpiresAt - Date.now() <= delay + 1_000)
            throw error;
          console.error(
            JSON.stringify({
              event: "github-heartbeat-transport-retry",
              time: new Date().toISOString(),
              runId,
              attempt: attempt + 1,
              leaseRemainingMs: leaseExpiresAt - Date.now(),
              errorType: error.name,
            })
          );
          await sleep(delay, heartbeatSignal);
        }
      }
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
    if (heartbeatFailure) throw heartbeatFailure;
    if (execution.aborted) throw execution.reason;
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        /^(?:GH_|GITHUB_|GITEDGE_|ACTIONS_RUNNER_INPUT_|RUNNER_TOKEN$|ACTIONS_RUNTIME_TOKEN$)/i.test(
          key
        )
      )
        delete env[key];
    env.ACTIONS_RUNNER_INPUT_JITCONFIG = run.encodedJitConfig;
    env.RUNNER_ALLOW_RUNASROOT = "1";
    env.GH_CONFIG_DIR = path.join(runDir, "gh-config");
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

async function runGitEdge(profile, run, leaseToken, signal) {
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
      await sleep(30_000, heartbeatSignal);
      if (child.exitCode !== null) return;
      const response = await apiRequest(
        profile.origin,
        profile.credential,
        "/api/actions/runner/heartbeat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: run.id, leaseToken }),
          signal: heartbeatSignal,
        }
      );
      if (
        typeof response?.data?.cancelRequested !== "boolean" ||
        !Number.isFinite(response.data.leaseExpiresAt)
      )
        throw new Error("GitEdge returned an invalid lease heartbeat response.");
      if (response.data.cancelRequested) throw new Error("GitEdge requested cancellation.");
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
    const completed = await apiRequest(
      profile.origin,
      profile.credential,
      "/api/actions/runner/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.id, leaseToken, conclusion, log: tail }),
      }
    ).catch((error) => {
      console.error(`Could not report GitEdge run ${run.id}: ${error.message}`);
    });
    if (completed?.data?.completed !== true)
      console.error(`GitEdge did not confirm completion for run ${run.id}.`);
    else console.log(`GitEdge run ${run.id}: ${conclusion}. Log: ${logFile}`);
  }
  if (failure && failure.message !== "GitEdge requested cancellation." && !signal.aborted)
    throw failure;
  if (executionError && !signal.aborted)
    console.error(`GitEdge run ${run.id} ended with ${conclusion}.`);
}

function createExecutionSlot() {
  const listeners = new Set();
  let held = false;
  const notify = () => listeners.forEach((listener) => listener());
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async tryAcquire() {
      if (held) return undefined;
      held = true;
      let release;
      try {
        release = await acquireActionsSlot();
      } catch (error) {
        held = false;
        throw error;
      }
      if (!release) {
        held = false;
        return undefined;
      }
      notify();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await release();
        } finally {
          held = false;
          notify();
        }
      };
    },
    async busy() {
      if (held) return true;
      return access(path.join(actionsState, "active.lock")).then(
        () => true,
        () => false
      );
    },
  };
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
    await runGitEdge(runnerProfileForClaim(profile, claim), claim.run, claim.leaseToken, signal);
  }
}

function assertGitEdgeProfile(profile) {
  if (profile.kind !== "gitedge")
    throw new Error(
      `Profile ${profile.id} is a standalone GitHub polling profile, which is no longer supported. Run \`remove ${profile.id}\` and register a generic profile with register-gitedge.`
    );
}

const supersededExitStatus = 78;

async function serve(state, exitStatusOnSupersede) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => controller.abort(new Error("Stopped.")));
  const entries = await readdir(path.join(state, "profiles"), { withFileTypes: true });
  const profiles = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => loadProfile(state, entry.name))
  );
  if (!profiles.length) throw new Error("Register at least one profile before serving.");
  for (const profile of profiles) {
    assertGitEdgeProfile(profile);
    validateProfileHostLabels(profile.labels);
  }
  await mkdir(actionsState, { recursive: true, mode: 0o700 });
  const slot = createExecutionSlot();
  let superseded = false;
  const clients = profiles.map((profile) => {
    const label = `GitEdge profile ${profile.id}`;
    const session = createDispatchSession({
      label,
      slot,
      getCapacity: () => getRunnerCapacity({ workDirectories: [profile.directory, actionsState] }),
      validateOffer: (labels, capacity) => validateLocalJobClaim(labels, capacity, 360),
      runJob: (claim, signal) => runAssignedClaim(profile, claim, signal),
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
        capacity: await getRunnerCapacity({
          workDirectories: [profile.directory, actionsState],
          busy: (await slot.busy()) ? 1 : 0,
        }),
        ...(profile.budget ? { budget: profile.budget } : {}),
      }),
      onOpen: (control) => session.onOpen(control),
      onClose: () => session.onClose(),
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
  console.log(`Runner broker serving ${profiles.length} profiles with one execution slot.`);
  let lastRetentionAt = 0;
  const retention = setInterval(async () => {
    if (Date.now() - lastRetentionAt < 60 * 60 * 1000) return;
    try {
      const release = await slot.tryAcquire();
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
  }
  if (superseded) process.exitCode = exitStatusOnSupersede;
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
      help: { type: "boolean", short: "h" },
    },
  });
  const [action, profileId] = positionals;
  const state = path.resolve(values["state-dir"] ?? stateDefault);
  if (!action || values.help) {
    console.log(
      "Usage: pnpm run runner-broker -- init|register-gitedge|list|remove|serve|service [options]\n\nregister-gitedge --origin URL --owner OWNER [--repository REPO] --label LABEL --runner-path DIR [--max-job-minutes N] [--daily-minutes N] [--cost N]\nA generic GitEdge runner executes matched workflow, GitHub and native signing jobs. Native signing uses the SDK and receives protected secrets for each task.\nserve [--supersede-exit-status N]: keeps one outbound WebSocket per profile to GitEdge and runs the jobs it assigns, one at a time. Run one broker per registration; a profile whose credential another broker took over stops reconnecting, lets running jobs finish, and the broker exits with status 78 (or N).\nservice install|start|stop|status --install-dir DIR [--state-dir DIR] [--run-as-user USER]\nAll commands accept --state-dir DIR. Registration reads GITEDGE_TOKEN."
    );
    return;
  }
  await ensureState(state);
  if (action === "init") {
    console.log(`Runner broker state initialized at ${state}.`);
    return;
  }
  if (action === "register-gitedge") {
    if (positionals.length !== 1) throw new Error(`${action} does not accept a profile argument.`);
    return withStateLock(state, action, () => addGitEdge(state, values));
  }
  if (action === "list") return listProfiles(state);
  if (action === "remove" && profileId)
    return withStateLock(state, `remove:${profileId}`, () => removeProfile(state, profileId));
  if (action === "serve") {
    const release = await acquireStateLock(state, "serve");
    try {
      await serve(state, supersedeExitStatus(values["supersede-exit-status"]));
    } catch (error) {
      if (error.message !== "Stopped.") throw error;
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
  throw new Error("Expected init, register-gitedge, list, remove <profile>, serve, or service.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Runner broker failed.");
  process.exitCode = 1;
});
