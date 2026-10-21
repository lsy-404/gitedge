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
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { parseJobClaim, matchesLabels } from "../packages/contracts/runner-scheduling.mjs";
import { createGitEdgeExecutionArgs } from "./runner-broker-execution.mjs";
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
let activeServeSignal;
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

function githubHost(value) {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (url.protocol !== "https:") throw new Error("--host must use HTTPS.");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("--host must be a GitHub API hostname, without a URL path or credentials.");
  return url.host;
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

async function writePrivate(file, content) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
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

async function apiRequest(origin, token, route, options = {}) {
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
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(20_000)].filter(Boolean)),
  }).catch((error) => {
    const code = error.cause?.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,64}$/.test(code))
      throw new Error(`GitEdge API request failed (${code}).`, { cause: error });
    throw error;
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitEdge API returned HTTP ${response.status}.`);
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
  const runnerPath = values["runner-path"] ? path.resolve(values["runner-path"]) : "";
  if (!runnerPath)
    throw new Error(
      "register-gitedge requires --runner-path to an installed official runner directory."
    );
  await import("node:fs/promises").then(({ access }) =>
    access(path.join(runnerPath, "bin", executable("Runner.Listener")), constants.X_OK)
  );
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
      `Registered GitEdge profile ${id} (${owner}${repository ? `/${repository}` : " organization scope"}).`
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

async function addGitHub(state, values) {
  const host = values.host ? githubHost(values.host) : undefined;
  const owner = values.owner;
  const scope = values.scope ?? "repo";
  const repository = values.repository;
  const labels = parseList(values.label);
  const allow = parseList(values["allow-repository"]);
  if (!host || !owner || !["repo", "org"].includes(scope) || labels.length === 0)
    throw new Error(
      "register-github requires --host, --owner, --scope repo|org, and at least one --label."
    );
  repositorySegment(owner, "--owner");
  if (repository) repositorySegment(repository, "--repository");
  validateLabels(labels);
  if ((scope === "repo") !== Boolean(repository))
    throw new Error("Repository profiles require --repository; org profiles must omit it.");
  if (scope === "org" && allow.length === 0)
    throw new Error(
      "Organization profiles require one or more --allow-repository owner/name entries."
    );
  if (scope === "org" && allow.length > 50)
    throw new Error("Organization profiles are limited to 50 explicitly allowed repositories.");
  if (
    scope === "org" &&
    allow.some(
      (item) =>
        !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(item) ||
        item.split("/")[0].toLowerCase() !== owner.toLowerCase() ||
        item.split("/").some((part) => part === "." || part === "..")
    )
  )
    throw new Error(
      "Every organization allowlist entry must be owner/name within the configured organization."
    );
  if (scope === "repo" && (values["group-id"] || values["group-name"]))
    throw new Error("Runner groups apply only to organization profiles.");
  if (values["group-id"] && values["group-name"])
    throw new Error("Choose either --group-id or --group-name.");
  const runnerPath = path.resolve(values["runner-path"] ?? "");
  if (!values["runner-path"])
    throw new Error(
      "register-github requires --runner-path to an installed official runner directory."
    );
  await import("node:fs/promises").then(({ access }) =>
    access(path.join(runnerPath, "bin", executable("Runner.Listener")), constants.X_OK)
  );
  validateProfileHostLabels(labels);
  const id = validateProfileId(values.name ?? defaultProfileId("github", host, owner, repository));
  const directory = path.join(state, "profiles", id);
  try {
    await access(directory);
    throw new Error(`Profile ${id} already exists.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(path.join(state, "profiles", `.adding-${id}-`));
  await chmod(staging, 0o700);
  const profile = {
    id,
    kind: "github",
    host,
    owner,
    scope,
    ...(repository ? { repository } : {}),
    labels,
    allowRepositories: allow,
    runnerPath,
    ...(values["group-id"] ? { groupId: Number(values["group-id"]) } : {}),
    ...(values["group-name"] ? { groupName: values["group-name"] } : {}),
    ...(values["poll-seconds"] ? { pollSeconds: Number(values["poll-seconds"]) } : {}),
  };
  const minimumPoll = scope === "org" ? 30 : 15;
  if (
    profile.pollSeconds !== undefined &&
    (!Number.isInteger(profile.pollSeconds) ||
      profile.pollSeconds < minimumPoll ||
      profile.pollSeconds > 120)
  ) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(`--poll-seconds must be between ${minimumPoll} and 120.`);
  }
  if (
    profile.groupId !== undefined &&
    (!Number.isInteger(profile.groupId) || profile.groupId < 1)
  ) {
    await rm(staging, { recursive: true, force: true });
    throw new Error("--group-id must be a positive integer.");
  }
  try {
    await writePrivate(path.join(staging, "profile.json"), JSON.stringify(profile, null, 2) + "\n");
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  console.log(
    `Registered GitHub ${scope} profile ${id} for ${host}. gh CLI credentials for that host are used at run time.`
  );
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
    console.log(
      `${profile.id}\t${profile.kind}\t${profile.kind === "github" ? profile.host : profile.origin}\t${profile.scope === "repo" ? `${profile.owner}/${profile.repository}` : profile.owner}\t${profile.labels.join(",")}`
    );
  }
}

function githubEnvironment(profile) {
  const env = { ...process.env, GH_HOST: profile.host };
  for (const key of Object.keys(env))
    if (
      /^(?:gh_token|github_token|gh_enterprise_token|github_enterprise_token|gitedge_token)$/i.test(
        key
      )
    )
      delete env[key];
  return env;
}

async function gh(profile, args, { json = true, serveSignal = true } = {}) {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.any(
      [serveSignal ? activeServeSignal : undefined, AbortSignal.timeout(30_000)].filter(Boolean)
    );
    const child = spawn("gh", ["api", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: githubEnvironment(profile),
      signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 8 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.once("error", (error) =>
      reject(activeServeSignal?.aborted ? activeServeSignal.reason : error)
    );
    child.once("close", (code) => {
      if (code !== 0)
        return reject(new Error(`gh api failed for ${profile.host}: ${stderr.trim().slice(-500)}`));
      try {
        resolve(json ? JSON.parse(stdout) : stdout);
      } catch {
        reject(new Error("gh api returned invalid JSON."));
      }
    });
  });
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

const orgPollOffsets = new Map();
const githubRunPages = new Map();

function eligible(labels, profile) {
  const claim = parseJobClaim(labels);
  const available = hostLabels();
  for (const label of profile.labels) available.add(label.toLowerCase());
  return (
    claim.valid &&
    claim.labels.includes("self-hosted") &&
    matchesLabels(claim.labels, [...available])
  );
}

async function queuedGitHubJob(profile, fullScan = false) {
  if (!profile.pollPagesLoaded) {
    try {
      const saved = JSON.parse(
        await readFile(path.join(profile.directory, "poll-state.json"), "utf8")
      );
      if (!saved || typeof saved !== "object" || Array.isArray(saved))
        throw new Error("Invalid GitHub polling state.");
      for (const [key, page] of Object.entries(saved)) {
        if (!Number.isInteger(page) || page < 1 || page > 10)
          throw new Error("Invalid GitHub polling cursor.");
        githubRunPages.set(`${profile.id}:${key}`, page);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    profile.pollPagesLoaded = true;
  }
  const allRepositories =
    profile.scope === "repo"
      ? [`${profile.owner}/${profile.repository}`]
      : profile.allowRepositories;
  const offset = orgPollOffsets.get(profile.id) ?? 0;
  const repositories =
    profile.scope === "repo" || fullScan
      ? allRepositories
      : allRepositories
          .slice(offset, offset + 3)
          .concat(allRepositories.slice(0, Math.max(0, offset + 3 - allRepositories.length)));
  if (profile.scope === "org" && !fullScan)
    orgPollOffsets.set(profile.id, (offset + 3) % allRepositories.length);
  for (const repository of repositories) {
    for (const status of ["queued", "in_progress"]) {
      const cursorKey = `${repository}:${status}`;
      const pageKey = `${profile.id}:${cursorKey}`;
      const page = githubRunPages.get(pageKey) ?? 1;
      const runs = await gh(profile, [
        `repos/${repository}/actions/runs?status=${status}&per_page=3&page=${page}`,
      ]);
      if (!Array.isArray(runs.workflow_runs))
        throw new Error("GitHub returned invalid queued runs.");
      githubRunPages.set(pageKey, runs.workflow_runs.length < 3 || page >= 10 ? 1 : page + 1);
      if (runs.total_count > 30 && page === 1)
        console.error(
          `GitHub profile ${profile.id} inspects only the first 30 ${status} runs in ${repository}.`
        );
      const saved = Object.fromEntries(
        [...githubRunPages.entries()]
          .filter(([key]) => key.startsWith(`${profile.id}:`))
          .map(([key, value]) => [key.slice(profile.id.length + 1), value])
      );
      await writePrivate(path.join(profile.directory, "poll-state.json"), JSON.stringify(saved));
      for (const run of (runs.workflow_runs ?? []).slice(0, 3)) {
        const runId = safeRunId(run.id);
        const jobs = await gh(profile, [
          `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
        ]);
        if (jobs.total_count > 100)
          console.error(`GitHub run ${runId} exceeds the 100-job inspection bound.`);
        const job = (jobs.jobs ?? []).find(
          (candidate) => candidate.status === "queued" && eligible(candidate.labels ?? [], profile)
        );
        if (job) return { run, job, repository };
      }
    }
  }
}

async function generateJit(profile) {
  const route =
    profile.scope === "repo"
      ? `repos/${profile.owner}/${profile.repository}/actions/runners/generate-jitconfig`
      : `orgs/${profile.owner}/actions/runners/generate-jitconfig`;
  const groupId = profile.scope === "repo" ? 1 : await resolveOrgRunnerGroup(profile);
  const runnerName = `broker-${profile.id.slice(0, 45)}-${randomUUID().slice(0, 8)}`;
  const params = ["--method", "POST", "-f", `name=${runnerName}`, "-F", "work_folder=_work"];
  for (const label of mergeLabels([...hostLabels()], profile.labels))
    params.push("-f", `labels[]=${label}`);
  params.push("-F", `runner_group_id=${groupId}`);
  let response = await gh(profile, [route, ...params]);
  if (!response || typeof response !== "object" || Array.isArray(response))
    throw new Error("GitHub returned an invalid JIT runner response.");
  let hasRunnerId = false;
  try {
    safeRunId(response.runner?.id);
    hasRunnerId = true;
  } catch {}
  if (!hasRunnerId) {
    const scope =
      profile.scope === "repo"
        ? `repos/${profile.owner}/${profile.repository}`
        : `orgs/${profile.owner}`;
    const listed = await gh(profile, [`${scope}/actions/runners?per_page=100`]).catch(
      () => undefined
    );
    response = {
      ...response,
      runner: listed?.runners?.find((runner) => runner.name === runnerName),
    };
    try {
      safeRunId(response.runner?.id);
      hasRunnerId = true;
    } catch {}
  }
  if (typeof response.encoded_jit_config !== "string" || !hasRunnerId) {
    if (hasRunnerId) await deleteGitHubRunner(profile, response.runner.id);
    throw new Error("GitHub did not return a JIT runner configuration.");
  }
  return response;
}

async function deleteGitHubRunner(profile, id) {
  let runnerId;
  try {
    runnerId = safeRunId(id);
  } catch {
    console.error("Could not identify the GitHub JIT runner for cleanup.");
    return;
  }
  const scope =
    profile.scope === "repo"
      ? `repos/${profile.owner}/${profile.repository}`
      : `orgs/${profile.owner}`;
  await gh(profile, [`${scope}/actions/runners/${runnerId}`, "--method", "DELETE"], {
    json: false,
    serveSignal: false,
  }).catch((error) => {
    if (!String(error.message).includes("404"))
      console.error(`Could not remove GitHub JIT runner ${id}: ${error.message}`);
  });
}

async function resolveOrgRunnerGroup(profile) {
  const prefix = `orgs/${profile.owner}/actions/runner-groups`;
  let group;
  if (profile.groupName || profile.groupId === undefined) {
    const groups = await gh(profile, [`${prefix}?per_page=100`]);
    if (
      !Array.isArray(groups.runner_groups) ||
      !Number.isInteger(groups.total_count) ||
      groups.total_count !== groups.runner_groups.length ||
      groups.total_count > 100
    )
      throw new Error(`Runner groups for ${profile.owner} exceed the broker's lookup bound.`);
    group = profile.groupName
      ? groups.runner_groups.find((candidate) => candidate.name === profile.groupName)
      : groups.runner_groups.find((candidate) => candidate.default);
  } else {
    group = await gh(profile, [`${prefix}/${profile.groupId}`]);
  }
  if (!group?.id)
    throw new Error(`Could not resolve the selected runner group for ${profile.owner}.`);
  if (profile.groupId !== undefined && group.id !== profile.groupId)
    throw new Error(`Runner group ${profile.groupId} was not returned by GitHub.`);
  const details = await gh(profile, [`${prefix}/${group.id}`]);
  if (details.visibility !== "selected")
    throw new Error(`Runner group ${details.name} must use selected-repository visibility.`);
  const selection = await gh(profile, [`${prefix}/${group.id}/repositories?per_page=100`]);
  const repositories = selection.repositories;
  if (
    !Array.isArray(repositories) ||
    !Number.isInteger(selection.total_count) ||
    selection.total_count !== repositories.length ||
    selection.total_count > 100
  )
    throw new Error(
      `Could not verify the complete repository visibility for runner group ${details.name}.`
    );
  const allowed = new Set(profile.allowRepositories.map((repository) => repository.toLowerCase()));
  if (
    repositories.length === 0 ||
    repositories.length !== allowed.size ||
    repositories.some((repository) => !allowed.has(repository.full_name?.toLowerCase()))
  )
    throw new Error(
      `Runner group ${details.name} must select exactly the repositories in this profile's allowlist.`
    );
  return details.id;
}

async function acquireActionsSlot() {
  const state = path.join(root, "work", "actions");
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

async function runGitHub(profile, queued, signal) {
  const capacity = await getRunnerCapacity({
    workDirectories: [profile.directory, path.join(root, "work", "actions")],
  });
  const jobClaim = validateLocalJobClaim(queued.labels, capacity, 360);
  const executionSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(localExecutionMinutes(jobClaim, 360) * 60_000),
  ]);
  const releaseSlot = await acquireActionsSlot();
  if (!releaseSlot) return false;
  let jit;
  const runRoot = path.join(profile.directory, "runs");
  let runDir;
  let runner;
  let child;
  try {
    jit = await generateJit(profile);
    console.log(
      `GitHub profile ${profile.id}: starting a temporary runner for ${queued.repository}.`
    );
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    await chmod(runRoot, 0o700);
    runDir = await mkdtemp(path.join(runRoot, `${safeRunId(queued.run.id)}-`));
    runner = path.join(runDir, "runner");
    await mkdir(runner);
    await cp(path.join(profile.runnerPath, "bin"), path.join(runner, "bin"), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
    await cp(path.join(profile.runnerPath, "externals"), path.join(runner, "externals"), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (
        /^(?:gh_token|github_token|gh_enterprise_token|github_enterprise_token|gitedge_token|runner_token|actions_runtime_token)$/i.test(
          key
        ) ||
        /^(?:actions_runner_input_|gitedge_broker_slot_held)/i.test(key)
      )
        delete env[key];
    }
    Object.assign(env, {
      ACTIONS_RUNNER_INPUT_JITCONFIG: jit.encoded_jit_config,
      RUNNER_ALLOW_RUNASROOT: "1",
    });
    const ghConfig = path.join(runDir, "gh-config");
    await mkdir(ghConfig, { mode: 0o700 });
    env.GH_CONFIG_DIR = ghConfig;
    delete env.GH_HOST;
    child = spawn(path.join(runner, "bin", executable("Runner.Listener")), ["run"], {
      cwd: runner,
      env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    const startupController = new AbortController();
    const startupSignal = AbortSignal.any([executionSignal, startupController.signal]);
    const listener = waitChild(child, executionSignal);
    try {
      const assigned = await Promise.race([
        listener.then(() => false),
        monitorJitAssignment(profile, queued, jit, startupSignal).then(() => true),
      ]);
      startupController.abort();
      if (assigned) await listener;
    } finally {
      startupController.abort();
    }
  } finally {
    if (child?.exitCode === null) await killChild(child);
    if (runner) {
      const diagnostics = path.join(runner, "_diag");
      try {
        await cp(diagnostics, path.join(runDir, "_diag"), { recursive: true });
      } catch {}
      await rm(runner, { recursive: true, force: true });
    }
    if (jit?.runner?.id) await deleteGitHubRunner(profile, jit.runner.id);
    await releaseSlot();
  }
  return true;
}

async function runClaimedGitHub(profile, claim, signal) {
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
    !leaseToken
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
  const runRoot = path.join(profile.directory, "runs");
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700);
  const runDir = await mkdtemp(path.join(runRoot, `${runId}-`));
  await chmod(runDir, 0o700);
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
  let heartbeatFailure;
  const heartbeat = (async () => {
    while (!heartbeatSignal.aborted) {
      await sleep(30_000, heartbeatSignal);
      if (child && child.exitCode !== null) return;
      const response = await apiRequest(
        profile.origin,
        profile.credential,
        "/api/actions/runner/github/heartbeat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId, leaseToken }),
          signal: heartbeatSignal,
        }
      );
      if (
        typeof response?.data?.cancelled !== "boolean" ||
        typeof response.data.assigned !== "boolean" ||
        !Number.isFinite(response.data.leaseExpiresAt)
      )
        throw new Error("GitEdge returned an invalid GitHub runner heartbeat.");
      if (response.data.cancelled) throw new Error("GitEdge requested cancellation.");
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

async function monitorJitAssignment(profile, queued, jit, signal) {
  const runnerId = safeRunId(jit.runner?.id);
  const runnerPath =
    profile.scope === "repo"
      ? `repos/${profile.owner}/${profile.repository}/actions/runners/${runnerId}`
      : `orgs/${profile.owner}/actions/runners/${runnerId}`;
  const jobsPath = `repos/${queued.repository}/actions/runs/${safeRunId(queued.run.id)}/jobs?per_page=100`;
  const jobId = String(queued.job.id);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(10_000, signal);
    const runner = await gh(profile, [runnerPath]);
    if (runner.busy === true) return;
    const jobs = await gh(profile, [jobsPath]);
    const job = (jobs.jobs ?? []).find((candidate) => String(candidate.id) === jobId);
    if (String(job?.runner_id) === String(jit.runner.id)) return;
  }
  throw new Error("GitHub JIT runner was not assigned a job within 120 seconds.");
}

function validateGitEdgeWorkflow(source, profile) {
  const document = parseDocument(source, { schema: "core", uniqueKeys: true });
  if (document.errors.length) throw new Error("The queued workflow is invalid YAML.");
  const workflow = document.toJS({ maxAliasCount: 100 });
  if (!workflow?.jobs || typeof workflow.jobs !== "object")
    throw new Error("The queued workflow has no jobs.");
  const workflowMaximum = Math.min(
    360,
    Object.values(workflow.jobs).reduce((total, job) => total + (job?.["timeout-minutes"] ?? 60), 0)
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
    const timeout = job?.["timeout-minutes"] ?? 60;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 360)
      throw new Error(`Job ${name} has an invalid timeout-minutes value.`);
    labelsUnion.push(...labels);
  }
  const claim = parseJobClaim(labelsUnion, workflowMaximum);
  if (!claim.valid) throw new Error("The workflow has an invalid runner resource requirement.");
  return { claim, labels: labelsUnion };
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
    if (!["push", "workflow_dispatch"].includes(run.event))
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
  const state = path.resolve(profile.directory, "..", "..");
  const runRoot = path.join(state, "runs");
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700);
  const runDir = await mkdtemp(path.join(runRoot, `${profile.id}-${run.id}-`));
  await chmod(runDir, 0o700);
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

async function claimGitEdge(profile, signal) {
  const capacity = await getRunnerCapacity({
    workDirectories: [profile.directory, path.join(root, "work", "actions")],
  });
  const response = await apiRequest(
    profile.origin,
    profile.credential,
    "/api/actions/runner/claim",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capacity,
        ...(profile.budget ? { budget: profile.budget } : {}),
      }),
      signal,
    }
  );
  const claim = response?.data;
  if (!claim || typeof claim !== "object" || Array.isArray(claim) || !("run" in claim))
    throw new Error("GitEdge returned an invalid runner claim response.");
  if (claim.run === null) {
    const delay = Number(claim.pollAfterSeconds);
    if (!Number.isFinite(delay) || delay < 1 || delay > 120)
      throw new Error("GitEdge returned an invalid runner poll interval.");
    return claim;
  }
  if (claim.run?.kind === "github") {
    if (
      typeof claim.leaseToken !== "string" ||
      !claim.leaseToken ||
      !Number.isFinite(claim.leaseExpiresAt)
    )
      throw new Error("GitEdge returned an incomplete GitHub runner lease.");
    return claim;
  }
  if (
    !claim.run ||
    typeof claim.run !== "object" ||
    typeof claim.leaseToken !== "string" ||
    !claim.leaseToken ||
    !Number.isFinite(claim.leaseExpiresAt)
  )
    throw new Error("GitEdge returned an incomplete runner lease.");
  return claim;
}

async function serve(state, { once, pollSeconds }) {
  const controller = new AbortController();
  activeServeSignal = controller.signal;
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
    if (profile.kind === "github" || profile.kind === "gitedge")
      validateProfileHostLabels(profile.labels);
    if (profile.kind === "github") {
      if (
        profile.pollSeconds !== undefined &&
        (profile.pollSeconds < (profile.scope === "org" ? 30 : 15) || profile.pollSeconds > 120)
      )
        throw new Error(`Invalid poll interval in profile ${profile.id}.`);
      const auth = await new Promise((resolve, reject) => {
        const child = spawn("gh", ["auth", "status", "--hostname", profile.host], {
          stdio: "ignore",
          env: githubEnvironment(profile),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        });
        child.once("error", (error) =>
          reject(controller.signal.aborted ? controller.signal.reason : error)
        );
        child.once("close", (code) => resolve(code === 0));
      });
      if (!auth)
        throw new Error(
          `Authenticate gh for ${profile.host} before serving profile ${profile.id}.`
        );
      if (profile.scope === "org") await resolveOrgRunnerGroup(profile);
    }
  }
  const minPoll = pollSeconds ?? 15;
  console.log(`Runner broker serving ${profiles.length} profiles with one execution slot.`);
  let processed = false;
  while (!controller.signal.aborted) {
    for (const profile of profiles) {
      if (controller.signal.aborted) break;
      try {
        if (profile.kind === "gitedge") {
          const releaseSlot = await acquireActionsSlot();
          if (!releaseSlot) {
            if (!once) await sleep(minPoll * 1000, controller.signal);
            continue;
          }
          let claim;
          try {
            claim = await claimGitEdge(profile, controller.signal);
            if (claim?.run) {
              processed = true;
              if (claim.run.kind === "github") {
                console.log(
                  `GitEdge profile ${profile.id}: running GitHub job ${claim.run.jobId}.`
                );
                await runClaimedGitHub(profile, claim, controller.signal);
              } else {
                console.log(`GitEdge profile ${profile.id}: running ${claim.run.id}.`);
                await runGitEdge(profile, claim.run, claim.leaseToken, controller.signal);
              }
            }
          } finally {
            await releaseSlot();
          }
          if (claim?.run) {
            if (once) return;
          } else {
            if (!once) {
              const requestedDelay = Number(claim?.pollAfterSeconds ?? minPoll);
              const delay =
                Math.min(
                  120,
                  Math.max(minPoll, Number.isFinite(requestedDelay) ? requestedDelay : minPoll)
                ) * 1000;
              await sleep(delay, controller.signal);
            }
          }
        } else {
          const queued = await queuedGitHubJob(profile, once);
          if (queued) {
            let didRun;
            try {
              didRun = await runGitHub(profile, queued, controller.signal);
            } catch (error) {
              if (controller.signal.aborted) throw error;
              processed = true;
              const message = error instanceof Error ? error.message : "Unknown error.";
              console.error(
                `GitHub profile ${profile.id} could not start its queued job: ${message}`
              );
              if (once) throw error;
              await sleep(
                Math.max(
                  pollSeconds ?? profile.pollSeconds ?? 30,
                  profile.scope === "org" ? 30 : 15
                ) * 1000,
                controller.signal
              );
              continue;
            }
            if (didRun) {
              processed = true;
              if (once) return;
            } else await sleep(minPoll * 1000, controller.signal);
          } else if (!once) {
            const interval = pollSeconds ?? profile.pollSeconds ?? 30;
            await sleep(
              Math.max(interval, profile.scope === "org" ? 30 : 15) * 1000,
              controller.signal
            );
          }
        }
      } catch (error) {
        if (controller.signal.aborted || once) throw error;
        console.error(
          `Runner profile ${profile.id}: ${error instanceof Error ? error.message : "Request failed."}`
        );
        await sleep(
          Math.max(pollSeconds ?? profile.pollSeconds ?? 30, 15) * 1000,
          controller.signal
        );
      }
    }
    if (once && !processed) {
      console.log("No eligible job found in this polling pass.");
      return;
    }
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
      host: { type: "string" },
      owner: { type: "string" },
      repository: { type: "string" },
      scope: { type: "string" },
      label: { type: "string", multiple: true },
      "allow-repository": { type: "string", multiple: true },
      "runner-path": { type: "string" },
      "install-dir": { type: "string" },
      "group-id": { type: "string" },
      "group-name": { type: "string" },
      "poll-seconds": { type: "string" },
      "max-job-minutes": { type: "string" },
      "daily-minutes": { type: "string" },
      cost: { type: "string" },
      "run-as-user": { type: "string" },
      once: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [action, profileId] = positionals;
  const state = path.resolve(values["state-dir"] ?? stateDefault);
  if (!action || values.help) {
    console.log(
      "Usage: pnpm run runner-broker -- init|register-gitedge|register-github|list|remove|serve|service [options]\n\nGitEdge: register-gitedge --origin URL --owner OWNER [--repository REPO] --label LABEL --runner-path DIR [--max-job-minutes N] [--daily-minutes N] [--cost N]\nGitHub: register-github --host HOST --owner OWNER --scope repo|org [--repository REPO] --label LABEL --runner-path DIR [--allow-repository OWNER/REPO] [--group-id ID|--group-name NAME]\nServe: serve [--once] [--poll-seconds 30]\nService: service install|start|stop|status --install-dir DIR [--state-dir DIR] [--run-as-user USER]\nAll commands accept --state-dir DIR. GitEdge registration reads GITEDGE_TOKEN; standalone GitHub profiles use gh CLI authentication."
    );
    return;
  }
  await ensureState(state);
  if (action === "init") {
    console.log(`Runner broker state initialized at ${state}.`);
    return;
  }
  if (["register-gitedge", "register-github"].includes(action)) {
    if (positionals.length !== 1) throw new Error(`${action} does not accept a profile argument.`);
    return withStateLock(state, action, () =>
      action === "register-gitedge" ? addGitEdge(state, values) : addGitHub(state, values)
    );
  }
  if (action === "list") return listProfiles(state);
  if (action === "remove" && profileId)
    return withStateLock(state, `remove:${profileId}`, () => removeProfile(state, profileId));
  if (action === "serve") {
    const poll = values["poll-seconds"] === undefined ? undefined : Number(values["poll-seconds"]);
    if (poll !== undefined && (!Number.isInteger(poll) || poll < 15 || poll > 120))
      throw new Error("--poll-seconds must be between 15 and 120.");
    const release = await acquireStateLock(state, "serve");
    try {
      await serve(state, { once: values.once, pollSeconds: poll });
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
  throw new Error(
    "Expected init, register-gitedge, register-github, list, remove <profile>, or serve."
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Runner broker failed.");
  process.exitCode = 1;
});
