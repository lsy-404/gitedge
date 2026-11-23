import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AwsV4Signer } from "aws4fetch";
import { z } from "zod";
import { remoteHeaders } from "./remote.mjs";

const RCODESIGN_VERSION = "0.29.0";
// sha256 of the release archives published at github.com/indygreg/apple-platform-rs.
const RCODESIGN_RELEASES = {
  "darwin-arm64": {
    target: "aarch64-apple-darwin",
    sha256: "d1a532150adaf90048260d76359261aa716abafc45c53c5dc18845029184334a",
  },
  "darwin-x64": {
    target: "x86_64-apple-darwin",
    sha256: "14ef11bedd51a8d95eafd767939ae96d5900e5a61511bef75bb21db6e7c74140",
  },
  "linux-x64": {
    target: "x86_64-unknown-linux-musl",
    sha256: "dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002",
  },
};
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 3_600_000;
const UPLOAD_BACKOFF_MS = [5_000, 15_000, 45_000];
const SESSION_JOIN = /rcodesign remote-sign ([A-Za-z0-9_-]{16,8192})/;

export class AppleRemoteError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    if (detail) this.detail = detail;
  }
}

const sessionSchema = z
  .object({
    url: z.string().regex(/^wss?:\/\/[^\s]+$/),
    publicKeyPem: z
      .string()
      .max(4096)
      .regex(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/),
  })
  .strict();
const submissionSchema = z
  .object({
    id: z.uuid(),
    region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    object: z.string().min(1).max(1024),
    awsAccessKeyId: z.string().min(1),
    awsSecretAccessKey: z.string().min(1),
    awsSessionToken: z.string().min(1),
  })
  .strict();

function toolCache() {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "gitedge");
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "gitedge");
}

function redact(text) {
  return text
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, "[redacted]")
    .trim()
    .split("\n")
    .slice(-6)
    .join(" | ")
    .slice(-600);
}

/** Returns the pinned rcodesign binary, downloading and verifying it into the user cache once. */
export async function rcodesignPath({ fetchImpl = fetch, signal } = {}) {
  const release = RCODESIGN_RELEASES[`${process.platform}-${process.arch}`];
  if (!release) throw new AppleRemoteError("rcodesign_unsupported_host");
  const cache = toolCache();
  const name = `apple-codesign-${RCODESIGN_VERSION}-${release.target}`;
  const directory = path.join(cache, name);
  const binary = path.join(directory, "rcodesign");
  try {
    const info = await lstat(binary);
    if (info.isFile() && !info.isSymbolicLink()) return binary;
  } catch {}
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(cache, ".rcodesign-"));
  try {
    const archive = path.join(staging, `${name}.tar.gz`);
    const response = await fetchImpl(
      `https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_VERSION}/${name}.tar.gz`,
      { signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok || !response.body) throw new AppleRemoteError("rcodesign_download");
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > MAX_ARCHIVE_BYTES) throw new AppleRemoteError("rcodesign_download");
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(archive, { flags: "wx", mode: 0o600 })
    );
    if (hash.digest("hex") !== release.sha256) throw new AppleRemoteError("rcodesign_digest");
    await run("tar", ["-xzf", archive, "-C", staging, `${name}/rcodesign`], { signal });
    await chmod(path.join(staging, name, "rcodesign"), 0o755);
    try {
      await rename(path.join(staging, name), directory);
    } catch (error) {
      // Another job installed the same release first.
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    }
    return binary;
  } catch (error) {
    throw error instanceof AppleRemoteError ? error : new AppleRemoteError("rcodesign_install");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function run(file, args, { signal, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { signal, timeout, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    child.once("error", () => reject(new AppleRemoteError("command_failed")));
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new AppleRemoteError("command_failed", redact(stderr)))
    );
  });
}

async function remoteCall(
  remote,
  action,
  body,
  { method = "POST", fetchImpl = fetch, signal } = {}
) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(`${remote.endpoint}/${action}`, {
    method,
    redirect: "error",
    headers: { ...remoteHeaders(remote), "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const code = value?.error?.code;
    throw new AppleRemoteError(
      typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : "remote_request_failed"
    );
  }
  return value?.data ?? value;
}

/**
 * Runs `rcodesign sign` with its private key operations delegated to the GitEdge relay session
 * bound to this signing lease, joining the session from the join string rcodesign prints.
 */
export async function rcodesignSign(
  remote,
  args,
  { work, fetchImpl = fetch, signal, timeout = 1_800_000 } = {}
) {
  const binary = await rcodesignPath({ fetchImpl, signal });
  const session = sessionSchema.parse(
    await remoteCall(remote, "apple-remote", {}, { fetchImpl, signal })
  );
  const keyFile = path.join(work, `remote-${randomBytes(8).toString("hex")}.pem`);
  await writeFile(keyFile, session.publicKeyPem, { mode: 0o600, flag: "wx" });
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(
        binary,
        [
          "sign",
          "--remote-public-key-pem-file",
          keyFile,
          "--remote-signing-url",
          session.url,
          ...args,
        ],
        { signal, timeout, stdio: ["ignore", "pipe", "pipe"] }
      );
      let stderr = "";
      let joining;
      let failure;
      child.stdout.resume();
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-65_536);
        const found = !joining && SESSION_JOIN.exec(stderr);
        if (!found) return;
        joining = remoteCall(
          remote,
          "apple-remote/join",
          { sessionJoinString: found[1] },
          { fetchImpl, signal }
        ).catch((error) => {
          failure = error instanceof AppleRemoteError ? error : new AppleRemoteError("remote_join");
          child.kill();
        });
      });
      child.once("error", () => reject(new AppleRemoteError("rcodesign_failed")));
      child.once("close", async (code, killSignal) => {
        await joining;
        if (failure) return reject(failure);
        if (code === 0) return resolve();
        const detail = redact(stderr);
        process.stderr.write(
          `signing command failed: rcodesign exit=${code} signal=${killSignal}${detail ? ` detail: ${detail}` : ""}\n`
        );
        const error = new AppleRemoteError(joining ? "rcodesign_failed" : "remote_session", detail);
        // Raw output stays on the error for failure classification and is never printed.
        Object.defineProperty(error, "output", { value: stderr });
        reject(error);
      });
    });
  } finally {
    await rm(keyFile, { force: true });
  }
}

/**
 * Submits a notarization archive through the GitEdge notary endpoint and uploads it to the
 * submission's S3 object; returns the Apple submission id.
 */
export async function submitNotarization(
  remote,
  file,
  {
    sha256,
    submissionName,
    fetchImpl = fetch,
    signal,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  }
) {
  const submission = submissionSchema.parse(
    await remoteCall(remote, "notary", { sha256, submissionName }, { fetchImpl, signal })
  );
  const size = (await lstat(file)).size;
  const url = `https://${submission.bucket}.s3.${submission.region}.amazonaws.com/${submission.object
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  for (let attempt = 0; ; attempt += 1) {
    const signed = await new AwsV4Signer({
      method: "PUT",
      url,
      headers: { "x-amz-content-sha256": sha256 },
      accessKeyId: submission.awsAccessKeyId,
      secretAccessKey: submission.awsSecretAccessKey,
      sessionToken: submission.awsSessionToken,
      service: "s3",
      region: submission.region,
    }).sign();
    const headers = new Headers(signed.headers);
    headers.set("content-length", String(size));
    let status;
    try {
      const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
      const response = await fetchImpl(url, {
        method: "PUT",
        redirect: "error",
        duplex: "half",
        headers,
        body: createReadStream(file),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      await response.body?.cancel();
      if (response.ok) return submission.id;
      status = response.status;
    } catch {
      if (signal?.aborted) throw new AppleRemoteError("notarization_upload");
    }
    if ((status && status < 500 && status !== 429) || attempt === UPLOAD_BACKOFF_MS.length)
      throw new AppleRemoteError("notarization_upload");
    await sleep(UPLOAD_BACKOFF_MS[attempt]);
  }
}
