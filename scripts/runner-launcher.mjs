import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// Bump only when the contract between launcher and kit changes; VM images must carry this version.
export const LAUNCHER_VERSION = 1;
// A kit exits with this status after draining, once the launcher has installed its successor.
export const KIT_UPDATE_EXIT_STATUS = 75;
export const KIT_DIGEST_ENV = "GITEDGE_RUNNER_KIT_DIGEST";
export const KIT_SIZE_ENV = "GITEDGE_RUNNER_KIT_SIZE";
export const KIT_DIRECTORY = "runner-kit";
export const KIT_STATUS_FILE = "status.json";

const MAX_KIT_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_GUEST_PAYLOAD_BYTES = 1_400_000;
const KEPT_KITS = 3;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const INSTALL_LOCK_WAIT_MS = 20 * 60_000;
const RETRY_FAILED_KIT_MS = 15 * 60_000;
const UNAVAILABLE_RETRY_MS = 60_000;
const START_FAILURE_WINDOW_MS = 60_000;
const GUEST_HEARTBEAT_MS = 15_000;
const SUPERSEDED_EXIT_STATUS = 78;
const COLAB_PROFILE = "colab";
// The job must be offered to a fresh Colab runner within this window or the runtime is released.
const COLAB_ASSIGN_WINDOW_MS = 15 * 60_000;
const REQUIRED_FILES = ["package.json", "pnpm-lock.yaml", "scripts/runner-broker.mjs"];
const ROOT_FILES = new Set(["package.json", "pnpm-lock.yaml"]);
const ALLOWED_PREFIXES = ["scripts/", "packages/contracts/"];
const digestPattern = /^sha256:([0-9a-f]{64})$/;

const log = (message) => console.error(`[runner-launcher] ${message}`);

export class KitError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
    if (detail) this.detail = String(detail).slice(0, 300);
  }
}

export function kitHex(kit) {
  const match = digestPattern.exec(kit?.digest ?? "");
  if (!match || !Number.isSafeInteger(kit.size) || kit.size < 1 || kit.size > MAX_KIT_BYTES)
    throw new KitError("kit_invalid", "descriptor");
  return match[1];
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

function networkDetail(error) {
  const code = error.cause?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,64}$/.test(code)) return `network_${code}`;
  return error.name === "TimeoutError" ? "timeout" : "network";
}

function originOf(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("The runner origin must be HTTP(S).");
  return url.origin;
}

export async function fetchCurrentKit({ origin, credential, signal }) {
  let response;
  try {
    response = await fetch(new URL("/api/actions/runner/kit", origin), {
      redirect: "error",
      headers: { Authorization: `Bearer ${credential}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)].filter(Boolean)),
    });
  } catch (error) {
    throw new KitError("kit_unavailable", networkDetail(error));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new KitError("kit_unavailable", `http_${response.status}`);
  }
  const kit = (await response.json().catch(() => null))?.data;
  kitHex(kit);
  return { digest: kit.digest, size: kit.size };
}

async function download({ origin, credential, kit, signal }) {
  const hex = kitHex(kit);
  let response;
  try {
    response = await fetch(new URL(`/api/actions/runner/kit/${hex}`, origin), {
      redirect: "error",
      headers: { Authorization: `Bearer ${credential}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)].filter(Boolean)),
    });
  } catch (error) {
    throw new KitError("kit_download_failed", networkDetail(error));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new KitError("kit_download_failed", `http_${response.status}`);
  }
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > kit.size) throw new KitError("kit_digest_mismatch", "size");
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof KitError) throw error;
    throw new KitError("kit_download_failed", "interrupted");
  }
  const body = Buffer.concat(chunks);
  if (body.length !== kit.size) throw new KitError("kit_digest_mismatch", "size");
  if (createHash("sha256").update(body).digest("hex") !== hex)
    throw new KitError("kit_digest_mismatch", "sha256");
  return body;
}

function safeRelativePath(file) {
  if (
    typeof file !== "string" ||
    file.includes("\\") ||
    file.includes(":") ||
    file.includes("\0") ||
    file.startsWith("/") ||
    !(ROOT_FILES.has(file) || ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix)))
  )
    return false;
  return file.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function parseKit(body) {
  let bundle;
  try {
    bundle = JSON.parse(gunzipSync(body, { maxOutputLength: MAX_UNPACKED_BYTES }).toString("utf8"));
  } catch {
    throw new KitError("kit_invalid", "unreadable");
  }
  if (bundle?.format !== 1 || !Array.isArray(bundle.files) || bundle.files.length === 0)
    throw new KitError("kit_invalid", "format");
  const seen = new Set();
  const files = bundle.files.map((entry) => {
    if (
      !entry ||
      typeof entry.data !== "string" ||
      !Number.isInteger(entry.mode) ||
      !safeRelativePath(entry.path)
    )
      throw new KitError("kit_invalid", "entry");
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw new KitError("kit_invalid", "duplicate_path");
    seen.add(key);
    return { path: entry.path, mode: entry.mode & 0o777, data: Buffer.from(entry.data, "base64") };
  });
  for (const required of REQUIRED_FILES)
    if (!seen.has(required)) throw new KitError("kit_invalid", "missing_file");
  return files;
}

function pnpmInstall(cwd, signal) {
  const command = process.platform === "win32" ? "cmd.exe" : "pnpm";
  const args = ["install", "--frozen-lockfile", "--prod", "--prefer-offline"];
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      process.platform === "win32" ? ["/d", "/c", "pnpm.cmd", ...args] : args,
      {
        cwd,
        // Install output goes to stderr so a guest job's stdout stays the broker's own.
        stdio: ["ignore", process.stderr, "inherit"],
        windowsHide: true,
        signal: AbortSignal.any([signal, AbortSignal.timeout(INSTALL_TIMEOUT_MS)].filter(Boolean)),
      }
    );
    child.once("error", (error) =>
      reject(
        new KitError(
          "kit_install_failed",
          error.name === "AbortError"
            ? signal?.aborted
              ? "pnpm_aborted"
              : "pnpm_timeout"
            : "pnpm_unavailable"
        )
      )
    );
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new KitError("kit_install_failed", `pnpm_exit_${code}`))
    );
  });
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// One install per digest at a time; a lock whose owner has exited is reclaimed.
async function acquireInstallLock(file, signal) {
  const deadline = Date.now() + INSTALL_LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return () => rm(file, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const owner = Number((await readFile(file, "utf8").catch(() => "")).trim());
    const age = Date.now() - ((await stat(file).catch(() => null))?.mtimeMs ?? 0);
    if (!processAlive(owner) && age > 5_000) {
      await rm(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline || signal?.aborted)
      throw new KitError("kit_install_failed", "lock_timeout");
    await sleep(1_000, signal);
  }
}

async function readyKit(directory) {
  try {
    const kit = JSON.parse(await readFile(path.join(directory, ".ready"), "utf8"));
    kitHex(kit);
    return kit;
  } catch {
    return null;
  }
}

export async function installedKits(cacheRoot) {
  const kits = [];
  for (const entry of await readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
    const directory = path.join(cacheRoot, entry.name);
    const kit = await readyKit(directory);
    if (!kit || kitHex(kit) !== entry.name) continue;
    const marker = await stat(path.join(directory, ".ready"));
    kits.push({ kit, directory, used: marker.mtimeMs });
  }
  return kits.sort((a, b) => b.used - a.used);
}

async function pruneKits(cacheRoot, keep) {
  const kits = await installedKits(cacheRoot);
  for (const stale of kits.slice(KEPT_KITS))
    if (!keep.includes(stale.kit.digest)) {
      if (await exists(`${stale.directory}.lock`)) continue;
      await rm(stale.directory, { recursive: true, force: true });
    }
}

export async function installKit({ cacheRoot, origin, credential, kit, signal }) {
  const hex = kitHex(kit);
  const directory = path.join(cacheRoot, hex);
  const marker = path.join(directory, ".ready");
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  let release;
  try {
    release = await acquireInstallLock(`${directory}.lock`, signal);
    if (!(await readyKit(directory))) {
      const files = parseKit(await download({ origin, credential, kit, signal }));
      await rm(directory, { recursive: true, force: true });
      for (const file of files) {
        const target = path.join(directory, ...file.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, file.data, { flag: "wx", mode: file.mode | 0o600 });
      }
      await pnpmInstall(directory, signal);
      await writeFile(marker, JSON.stringify({ digest: kit.digest, size: kit.size }), {
        mode: 0o600,
      });
    } else {
      const now = new Date();
      await utimes(marker, now, now);
    }
  } catch (error) {
    if (error instanceof KitError || signal?.aborted) throw error;
    throw new KitError("kit_install_failed", error.code ?? error.name);
  } finally {
    await release?.();
  }
  return directory;
}

async function writeStatus(cacheRoot, status) {
  const file = path.join(cacheRoot, KIT_STATUS_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(status), { mode: 0o600 });
  await rename(temporary, file);
}

async function readStatus(cacheRoot) {
  try {
    const status = JSON.parse(await readFile(path.join(cacheRoot, KIT_STATUS_FILE), "utf8"));
    return status && typeof status === "object" ? status : {};
  } catch {
    return {};
  }
}

const failureOf = (kit, error) => ({
  digest: kit.digest,
  reason: error instanceof KitError ? error.reason : "kit_install_failed",
  ...(error instanceof KitError && error.detail ? { detail: error.detail } : {}),
  at: Date.now(),
});

async function profileAccess(state) {
  const root = path.join(state, "profiles");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const name of entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()) {
    try {
      const profile = JSON.parse(await readFile(path.join(root, name, "profile.json"), "utf8"));
      const credential = (await readFile(path.join(root, name, "credential"), "utf8")).trim();
      if (profile.kind === "gitedge" && credential && !/\s/.test(credential))
        return { origin: originOf(profile.origin), credential };
    } catch {
      // Skip unreadable or incomplete profiles; the broker reports them itself.
    }
  }
  throw new Error(`Register a GitEdge profile in ${state} before serving.`);
}

const brokerScript = (directory) => path.join(directory, "scripts", "runner-broker.mjs");

const kitEnvironment = (kit) => ({
  ...process.env,
  [KIT_DIGEST_ENV]: kit.digest,
  [KIT_SIZE_ENV]: String(kit.size),
});

function exitStatus(value) {
  if (value === undefined) return SUPERSEDED_EXIT_STATUS;
  if (!/^\d{1,3}$/.test(value) || Number(value) > 255)
    throw new Error("--supersede-exit-status must be an exit status from 0 to 255.");
  return Number(value);
}

function slotsValue(value) {
  if (value !== undefined && !/^\d{1,2}$/.test(value))
    throw new Error("--slots must be an integer.");
  return value;
}

function parseServeArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (
      !["--state-dir", "--supersede-exit-status", "--slots"].includes(flag) ||
      value === undefined
    )
      throw new Error(
        "Usage: runner-launcher.mjs serve --state-dir DIR [--slots N] [--supersede-exit-status N]"
      );
    values[flag.slice(2)] = value;
  }
  if (!values["state-dir"]) throw new Error("serve requires --state-dir.");
  return values;
}

async function serve(args) {
  const values = parseServeArgs(args);
  const state = path.resolve(values["state-dir"]);
  const supersedeStatus = exitStatus(values["supersede-exit-status"]);
  const slots = slotsValue(values.slots);
  const cacheRoot = path.join(state, KIT_DIRECTORY);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const stopper = new AbortController();
  let child;
  for (const name of ["SIGINT", "SIGTERM"])
    process.once(name, () => {
      stopper.abort();
      if (child?.connected) child.send({ type: "stop" });
      else if (child && child.exitCode === null) child.kill("SIGTERM");
    });
  const registration = await profileAccess(state);

  let current;
  while (!current && !stopper.signal.aborted) {
    let kit;
    try {
      kit = await fetchCurrentKit({ ...registration, signal: stopper.signal });
      const directory = await installKit({
        ...registration,
        cacheRoot,
        kit,
        signal: stopper.signal,
      });
      await writeStatus(cacheRoot, {});
      current = { kit, directory };
    } catch (error) {
      if (stopper.signal.aborted) break;
      if (kit) await writeStatus(cacheRoot, { failed: failureOf(kit, error) });
      const [installed] = await installedKits(cacheRoot);
      if (installed) {
        log(`${error.message}; starting installed kit ${installed.kit.digest}.`);
        current = installed;
      } else {
        log(`${error.message}; no installed kit, retrying in 60 seconds.`);
        await sleep(UNAVAILABLE_RETRY_MS, stopper.signal);
      }
    }
  }
  if (!current) return 0;

  let previous;
  let pending;
  let installing = false;
  let retryTimer;
  const announce = async (kit) => {
    try {
      kitHex(kit);
    } catch {
      return;
    }
    if (
      installing ||
      stopper.signal.aborted ||
      kit.digest === current.kit.digest ||
      kit.digest === pending?.kit.digest
    )
      return;
    const { failed } = await readStatus(cacheRoot);
    const since = failed?.digest === kit.digest ? Date.now() - failed.at : Infinity;
    clearTimeout(retryTimer);
    if (since < RETRY_FAILED_KIT_MS) {
      retryTimer = setTimeout(() => void announce(kit), RETRY_FAILED_KIT_MS - since);
      retryTimer.unref();
      return;
    }
    installing = true;
    try {
      log(`installing runner kit ${kit.digest}.`);
      const directory = await installKit({
        ...registration,
        cacheRoot,
        kit,
        signal: stopper.signal,
      });
      await writeStatus(cacheRoot, {});
      pending = { kit, directory };
      log(`runner kit ${kit.digest} is ready; draining ${current.kit.digest}.`);
      if (child?.connected) child.send({ type: "kit-drain" });
    } catch (error) {
      if (stopper.signal.aborted) return;
      log(`runner kit ${kit.digest} failed: ${error.message}; keeping ${current.kit.digest}.`);
      await writeStatus(cacheRoot, { failed: failureOf(kit, error) }).catch(() => {});
      retryTimer = setTimeout(() => void announce(kit), RETRY_FAILED_KIT_MS);
      retryTimer.unref();
    } finally {
      installing = false;
    }
  };

  let backoff = 1_000;
  while (!stopper.signal.aborted) {
    await pruneKits(cacheRoot, [current.kit.digest, pending?.kit.digest].filter(Boolean));
    const startedAt = Date.now();
    log(`starting runner kit ${current.kit.digest}.`);
    child = fork(
      brokerScript(current.directory),
      [
        "serve",
        "--state-dir",
        state,
        "--supersede-exit-status",
        String(supersedeStatus),
        ...(slots ? ["--slots", slots] : []),
      ],
      { env: kitEnvironment(current.kit), stdio: ["inherit", "inherit", "inherit", "ipc"] }
    );
    child.on("message", (message) => {
      if (message?.type === "kit-available") void announce(message.kit);
    });
    if (pending) child.send({ type: "kit-drain" });
    const code = await new Promise((resolve) => {
      child.once("error", (error) => log(`runner kit process error: ${error.message}`));
      child.once("exit", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
    });
    if (stopper.signal.aborted) return code;
    if (pending && code !== supersedeStatus) {
      previous = current;
      current = pending;
      pending = undefined;
      backoff = 1_000;
      continue;
    }
    if (code === supersedeStatus || code === 0) return code;
    if (code === KIT_UPDATE_EXIT_STATUS) continue;
    if (previous && Date.now() - startedAt < START_FAILURE_WINDOW_MS) {
      log(`runner kit ${current.kit.digest} failed to start; returning to ${previous.kit.digest}.`);
      await writeStatus(cacheRoot, {
        failed: { digest: current.kit.digest, reason: "kit_start_failed", at: Date.now() },
      });
      current = previous;
      previous = undefined;
      continue;
    }
    log(`runner kit exited with status ${code}; restarting in ${backoff / 1000} seconds.`);
    await sleep(backoff, stopper.signal);
    backoff = Math.min(60_000, backoff * 2);
  }
  return 0;
}

function parseFlags(args, allowed, usage) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (!allowed.includes(flag) || value === undefined) throw new Error(usage);
    values[flag.slice(2)] = value;
  }
  if (!values["state-dir"]) throw new Error(usage);
  return values;
}

function launcherHostLabels() {
  const os = { linux: "Linux", darwin: "macOS", win32: "Windows" }[process.platform];
  const arch = { x64: "X64", arm64: "ARM64" }[process.arch];
  if (!os || !arch) throw new Error("This host platform cannot run GitEdge jobs.");
  return ["self-hosted", os, arch, os.toLowerCase(), arch.toLowerCase()];
}

async function writePrivateFile(file, content) {
  await writeFile(file, content, { flag: "wx", mode: 0o600 });
}

async function runKitCommand(directory, kit, args, stopper) {
  const child = spawn(process.execPath, [brokerScript(directory), ...args], {
    env: kitEnvironment(kit),
    stdio: "inherit",
  });
  stopper.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
  });
}

// Single-job runner inside a Colab runtime: exchanges the one-time token, installs the kit and serves one job.
async function colab(args) {
  const values = parseFlags(
    args,
    ["--state-dir", "--origin", "--runner-path"],
    "Usage: runner-launcher.mjs colab --origin URL --runner-path DIR --state-dir DIR"
  );
  if (!values.origin || !values["runner-path"])
    throw new Error("colab requires --origin and --runner-path.");
  const origin = originOf(values.origin);
  const bootstrapToken = process.env.GITEDGE_COLAB_BOOTSTRAP_TOKEN ?? "";
  delete process.env.GITEDGE_COLAB_BOOTSTRAP_TOKEN;
  if (!/^[a-f0-9]{64}$/.test(bootstrapToken))
    throw new Error("Set GITEDGE_COLAB_BOOTSTRAP_TOKEN to the one-time Colab bootstrap token.");
  const state = path.resolve(values["state-dir"]);
  const profiles = path.join(state, "profiles");
  await mkdir(profiles, { recursive: true, mode: 0o700 });
  if ((await readdir(profiles)).length)
    throw new Error("The Colab runner state must not contain existing profiles.");
  const response = await fetch(new URL("/api/actions/colab-runners/bootstrap", origin), {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ bootstrapToken, labels: launcherHostLabels() }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => null))?.data;
  if (!response.ok) throw new Error(`The Colab bootstrap was refused (HTTP ${response.status}).`);
  const runner = data?.runner;
  const credential = data?.token;
  if (
    typeof runner?.id !== "string" ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(runner.id) ||
    typeof runner.scope?.owner !== "string" ||
    typeof runner.scope?.repository !== "string" ||
    !Array.isArray(runner.labels) ||
    typeof credential !== "string" ||
    !/^ge_runner_[0-9a-f]{64}$/.test(credential) ||
    !Number.isFinite(runner.expiresAt)
  )
    throw new Error("GitEdge returned invalid Colab runner registration metadata.");
  const directory = path.join(profiles, COLAB_PROFILE);
  await mkdir(directory, { mode: 0o700 });
  const stopper = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => stopper.abort());
  try {
    await writePrivateFile(
      path.join(directory, "profile.json"),
      JSON.stringify({
        id: COLAB_PROFILE,
        kind: "gitedge",
        origin,
        owner: runner.scope.owner,
        repository: runner.scope.repository,
        labels: runner.labels,
        runnerPath: path.resolve(values["runner-path"]),
        runnerId: runner.id,
      })
    );
    await writePrivateFile(path.join(directory, "credential"), credential);
    const kit = await fetchCurrentKit({ origin, credential, signal: stopper.signal });
    const kitDirectory = await installKit({
      cacheRoot: path.join(state, KIT_DIRECTORY),
      origin,
      credential,
      kit,
      signal: stopper.signal,
    });
    log(`serving one job with runner kit ${kit.digest}.`);
    return await runKitCommand(
      kitDirectory,
      kit,
      ["once", "--state-dir", state, "--assign-by", String(Date.now() + COLAB_ASSIGN_WINDOW_MS)],
      stopper
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Long-running Colab waker on a desktop host; restarts from each newly published kit while idle.
async function colabWaker(args) {
  const usage =
    "Usage: runner-launcher.mjs colab-waker --state-dir DIR [--uvx PATH] [--colab-mcp SPEC]";
  const values = parseFlags(args, ["--state-dir", "--uvx", "--colab-mcp"], usage);
  const state = path.resolve(values["state-dir"]);
  const cacheRoot = path.join(state, KIT_DIRECTORY);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const stopper = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => stopper.abort());
  const registration = await profileAccess(state);
  let backoff = 1_000;
  while (!stopper.signal.aborted) {
    let current;
    try {
      const kit = await fetchCurrentKit({ ...registration, signal: stopper.signal });
      current = {
        kit,
        directory: await installKit({ ...registration, cacheRoot, kit, signal: stopper.signal }),
      };
    } catch (error) {
      if (stopper.signal.aborted) break;
      [current] = await installedKits(cacheRoot);
      if (!current) {
        log(`${error.message}; no installed kit, retrying in 60 seconds.`);
        await sleep(UNAVAILABLE_RETRY_MS, stopper.signal);
        continue;
      }
      log(`${error.message}; starting installed kit ${current.kit.digest}.`);
    }
    log(`starting Colab waker from runner kit ${current.kit.digest}.`);
    const code = await runKitCommand(
      current.directory,
      current.kit,
      [
        "colab-waker",
        "--state-dir",
        state,
        ...(values.uvx ? ["--uvx", values.uvx] : []),
        ...(values["colab-mcp"] ? ["--colab-mcp", values["colab-mcp"]] : []),
      ],
      stopper
    );
    if (stopper.signal.aborted || code === 0) return code;
    if (code === KIT_UPDATE_EXIT_STATUS) {
      backoff = 1_000;
      continue;
    }
    log(`Colab waker exited with status ${code}; restarting in ${backoff / 1000} seconds.`);
    await sleep(backoff, stopper.signal);
    backoff = Math.min(60_000, backoff * 2);
  }
  return 0;
}

async function readStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_GUEST_PAYLOAD_BYTES)
      throw new Error("The guest job payload exceeds its limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Keeps the job lease alive while the guest installs the kit; the host kit describes the call.
function guestHeartbeat({ origin, credential, heartbeat, signal }) {
  if (
    typeof heartbeat?.path !== "string" ||
    !heartbeat.path.startsWith("/api/actions/runner/") ||
    (heartbeat.body !== undefined && typeof heartbeat.body !== "string") ||
    Object.keys(heartbeat.headers ?? {}).some((name) => !/^X-Runner-[A-Za-z-]+$/.test(name))
  )
    throw new Error("Invalid guest heartbeat description.");
  return (async () => {
    while (!signal.aborted) {
      await sleep(GUEST_HEARTBEAT_MS, signal);
      if (signal.aborted) return;
      await fetch(new URL(heartbeat.path, origin), {
        method: "POST",
        redirect: "error",
        headers: {
          ...heartbeat.headers,
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        body: heartbeat.body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      })
        .then((response) => response.body?.cancel())
        .catch(() => log("lease heartbeat failed during kit installation; will retry."));
    }
  })();
}

async function executeVmJob() {
  const input = await readStdin();
  let payload;
  try {
    payload = JSON.parse(input.toString("utf8"));
  } catch {
    throw new Error("Invalid guest job payload.");
  }
  const { kit, state, profile, claim } = payload ?? {};
  if (
    typeof state !== "string" ||
    !path.isAbsolute(state) ||
    !/^[0-9a-f-]{36}$/i.test(claim?.run?.id ?? "") ||
    !/^[0-9a-f]{64}$/i.test(claim?.leaseToken ?? "")
  )
    throw new Error("Invalid guest job identity.");
  const origin = originOf(profile?.origin);
  const credential = `ge_exec_${claim.run.id}_${claim.leaseToken}`;
  const stopper = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => stopper.abort());
  const preparing = new AbortController();
  const signal = AbortSignal.any([stopper.signal, preparing.signal]);
  const keeper = guestHeartbeat({ origin, credential, heartbeat: kit?.heartbeat, signal });
  let directory;
  try {
    directory = await installKit({
      cacheRoot: path.join(state, KIT_DIRECTORY),
      origin,
      credential,
      kit,
      signal,
    });
  } finally {
    preparing.abort();
    await keeper;
  }
  if (stopper.signal.aborted) return 1;
  const child = spawn(process.execPath, [brokerScript(directory), "execute-vm-job"], {
    env: kitEnvironment(kit),
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  stopper.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  child.stdin.end(input, () => input.fill(0));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal_) => resolve(status ?? (signal_ ? 1 : 0)));
  });
}

// Other broker commands run from the most recently used installed kit.
async function passThrough(args) {
  const index = args.indexOf("--state-dir");
  if (index < 0 || !args[index + 1])
    throw new Error("Pass --state-dir so the launcher can find the installed runner kit.");
  const [installed] = await installedKits(path.join(path.resolve(args[index + 1]), KIT_DIRECTORY));
  if (!installed)
    throw new Error("No runner kit is installed yet; run serve once or use a GitEdge checkout.");
  const child = spawn(process.execPath, [brokerScript(installed.directory), ...args], {
    env: kitEnvironment(installed.kit),
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "version") {
    console.log(String(LAUNCHER_VERSION));
    return 0;
  }
  if (command === "serve") return serve(args);
  if (command === "execute-vm-job") return executeVmJob();
  if (command === "colab") return colab(args);
  if (command === "colab-waker") return colabWaker(args);
  if (!command || command === "--help" || command === "-h") {
    console.log(
      "Usage: node runner-launcher.mjs serve --state-dir DIR [--slots N] [--supersede-exit-status N]\n" +
        "       node runner-launcher.mjs execute-vm-job   (VM guest entry point; reads the job from stdin)\n" +
        "       node runner-launcher.mjs colab-waker --state-dir DIR [--uvx PATH] [--colab-mcp SPEC]\n" +
        "       node runner-launcher.mjs colab --origin URL --runner-path DIR --state-dir DIR   (inside a Colab runtime)\n" +
        "       node runner-launcher.mjs version\n" +
        "       node runner-launcher.mjs <broker command> --state-dir DIR [options]\n" +
        "serve installs the published runner kit under DIR/runner-kit and runs its broker, switching to each newly published kit after running jobs finish."
    );
    return 0;
  }
  return passThrough([command, ...args]);
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (process.argv[1] && invokedDirectly()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      log(error instanceof Error ? error.message : "Runner launcher failed.");
      process.exitCode = 1;
    }
  );
}
