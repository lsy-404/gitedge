import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import lockfile from "proper-lockfile";

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const KEPT_VERSIONS = 3;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const ALLOWED_PREFIXES = ["scripts/signing/", "packages/contracts/"];
const REQUIRED_FILES = [
  "scripts/signing/client.mjs",
  "scripts/signing/package.json",
  "scripts/signing/pnpm-lock.yaml",
];

export class SigningRuntimeError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
    if (detail) this.detail = detail.slice(0, 300);
  }
}

export function signingRuntimeHex(runtime) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(runtime?.digest ?? "");
  if (!match || !Number.isSafeInteger(runtime.size) || runtime.size < 1)
    throw new SigningRuntimeError("runtime_unspecified");
  return match[1];
}

async function download(origin, credential, hex, size, signal) {
  if (size > MAX_BUNDLE_BYTES) throw new SigningRuntimeError("runtime_invalid", "bundle_too_large");
  let response;
  try {
    response = await fetch(new URL(`/api/actions/runner/signing/runtime/${hex}`, origin), {
      redirect: "error",
      headers: { Authorization: `Bearer ${credential}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)].filter(Boolean)),
    });
  } catch (error) {
    const code = error.cause?.code;
    throw new SigningRuntimeError(
      "runtime_download_failed",
      typeof code === "string" && /^[A-Z][A-Z0-9_]{1,64}$/.test(code)
        ? `network_${code}`
        : error.name === "TimeoutError"
          ? "timeout"
          : "network"
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SigningRuntimeError("runtime_download_failed", `http_${response.status}`);
  }
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > size) {
        throw new SigningRuntimeError("runtime_digest_mismatch", "size");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof SigningRuntimeError) throw error;
    throw new SigningRuntimeError("runtime_download_failed", "interrupted");
  }
  const body = Buffer.concat(chunks);
  if (body.length !== size) throw new SigningRuntimeError("runtime_digest_mismatch", "size");
  if (createHash("sha256").update(body).digest("hex") !== hex)
    throw new SigningRuntimeError("runtime_digest_mismatch", "sha256");
  return body;
}

function safeRelativePath(file) {
  if (
    typeof file !== "string" ||
    file.includes("\\") ||
    file.includes(":") ||
    file.includes("\0") ||
    file.startsWith("/") ||
    !ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix))
  )
    return false;
  return file.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function parseBundle(body) {
  let bundle;
  try {
    bundle = JSON.parse(gunzipSync(body, { maxOutputLength: MAX_UNPACKED_BYTES }).toString("utf8"));
  } catch {
    throw new SigningRuntimeError("runtime_invalid", "unreadable");
  }
  if (bundle?.format !== 1 || !Array.isArray(bundle.files) || bundle.files.length === 0)
    throw new SigningRuntimeError("runtime_invalid", "format");
  const seen = new Set();
  const files = bundle.files.map((entry) => {
    if (
      !entry ||
      typeof entry.data !== "string" ||
      !Number.isInteger(entry.mode) ||
      !safeRelativePath(entry.path)
    )
      throw new SigningRuntimeError("runtime_invalid", "entry");
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw new SigningRuntimeError("runtime_invalid", "duplicate_path");
    seen.add(key);
    return { path: entry.path, mode: entry.mode & 0o777, data: Buffer.from(entry.data, "base64") };
  });
  for (const required of REQUIRED_FILES)
    if (!seen.has(required)) throw new SigningRuntimeError("runtime_invalid", "missing_file");
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
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
        signal: AbortSignal.any([signal, AbortSignal.timeout(INSTALL_TIMEOUT_MS)].filter(Boolean)),
      }
    );
    child.once("error", (error) =>
      reject(
        new SigningRuntimeError(
          "runtime_install_failed",
          error.name === "AbortError"
            ? signal?.aborted
              ? "pnpm_aborted"
              : "pnpm_timeout"
            : "pnpm_unavailable"
        )
      )
    );
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new SigningRuntimeError("runtime_install_failed", `pnpm_exit_${code}`))
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

async function install(directory, files, signal) {
  await rm(directory, { recursive: true, force: true });
  for (const file of files) {
    const target = path.join(directory, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.data, { flag: "wx", mode: file.mode | 0o600 });
  }
  await pnpmInstall(path.join(directory, "scripts", "signing"), signal);
  // contracts import zod from packages/contracts, which only resolves through the root.
  await symlink(
    process.platform === "win32"
      ? path.join(directory, "scripts", "signing", "node_modules")
      : path.join("scripts", "signing", "node_modules"),
    path.join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await writeFile(path.join(directory, ".ready"), "");
}

async function pruneOldVersions(cacheRoot, keep) {
  const versions = [];
  for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
    const marker = await stat(path.join(cacheRoot, entry.name, ".ready")).catch(() => null);
    if (!marker || (await exists(path.join(cacheRoot, `${entry.name}.lock`)))) continue;
    versions.push({ name: entry.name, used: marker.mtimeMs });
  }
  versions.sort((a, b) => b.used - a.used);
  for (const stale of versions.slice(KEPT_VERSIONS))
    if (stale.name !== keep)
      await rm(path.join(cacheRoot, stale.name), { recursive: true, force: true });
}

export async function prepareSigningRuntime({ origin, credential, runtime, cacheRoot, signal }) {
  const hex = signingRuntimeHex(runtime);
  const directory = path.join(cacheRoot, hex);
  const client = path.join(directory, "scripts", "signing", "client.mjs");
  let release;
  try {
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    // proper-lockfile keys held locks by this path, so each version needs its own.
    release = await lockfile.lock(directory, {
      realpath: false,
      lockfilePath: path.join(cacheRoot, `${hex}.lock`),
      stale: 60_000,
      update: 10_000,
      retries: { retries: 900, factor: 1, minTimeout: 1_000, maxTimeout: 1_000 },
    });
    const marker = path.join(directory, ".ready");
    if (await exists(marker)) {
      const now = new Date();
      await utimes(marker, now, now);
    } else {
      const body = await download(origin, credential, hex, runtime.size, signal);
      await install(directory, parseBundle(body), signal);
    }
    await pruneOldVersions(cacheRoot, hex);
  } catch (error) {
    if (error instanceof SigningRuntimeError) throw error;
    if (signal?.aborted) throw error;
    throw new SigningRuntimeError("runtime_install_failed", error.code ?? error.name);
  } finally {
    await release?.();
  }
  return client;
}
