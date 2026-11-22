import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  androidCredentialsSchema,
  androidManifestSchema,
  androidSourceMetadataSchema,
  androidVerificationSchema,
} from "./contract.mjs";
import { findAndroidBuildTools, javaCommand } from "./android-tools.mjs";

let signingAbortSignal;

export function setSigningAbortSignal(signal) {
  signingAbortSignal = signal;
  signal?.addEventListener(
    "abort",
    () => {
      if (signingAbortSignal === signal) signingAbortSignal = undefined;
    },
    { once: true }
  );
}

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");

class RunnerFailure extends Error {
  constructor(code) {
    super(`Android signing operation failed: ${code}`);
    this.code = code;
  }
}

const androidFailurePhases = new Set([
  "input",
  "source",
  "tools",
  "apk_metadata",
  "credentials",
  "align",
  "sign",
  "signature_verification",
  "output",
  "cleanup",
]);
const androidFailureCodes = new Set([
  "host_unsupported",
  "output_not_empty",
  "input_digest",
  "archive_layout",
  "archive_validation",
  "archive_too_large",
  "source_binding",
  "build_tools_unavailable",
  "apk_metadata",
  "apk_package",
  "apk_version",
  "apk_debuggable",
  "native_command",
  "native_timeout",
  "signature_verification",
  "signature_schemes",
  "signature_signers",
  "certificate_mismatch",
  "signed_metadata",
  "output_archive",
  "keystore_cleanup",
]);

export function safeAndroidFailure(phase, code) {
  if (!androidFailurePhases.has(phase) || !androidFailureCodes.has(code))
    return new RunnerFailure("android_sign_failed");
  const safeCode = `android_${phase}_${code}`;
  return safeCode.length <= 64
    ? new RunnerFailure(safeCode)
    : new RunnerFailure("android_sign_failed");
}

function command(file, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      signal: signingAbortSignal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [],
      stderr = [];
    let total = 0,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    for (const [stream, target] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ])
      stream.on("data", (chunk) => {
        total += chunk.length;
        if (total > 4 * 1024 * 1024) child.kill();
        else target.push(chunk);
      });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new RunnerFailure("native_command"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new RunnerFailure("native_timeout"));
      else if (code === 0)
        resolve({
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
      else reject(new RunnerFailure("native_command"));
    });
  });
}

async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const OUTER_FILES = ["unsigned.apk", "source.json"];

// The outer archive must hold exactly the unsigned APK and its source metadata, both at the root.
export async function extractAndroidSourceArchive(file, destination, maxBytes) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(
      file,
      { lazyEntries: true, strictFileNames: true, decodeStrings: true, autoClose: false },
      (error, value) => (error ? reject(error) : resolve(value))
    )
  );
  try {
    const entries = await new Promise((resolve, reject) => {
      const list = [];
      zip.on("error", reject);
      zip.on("entry", (entry) => {
        list.push(entry);
        if (list.length > OUTER_FILES.length) reject(new RunnerFailure("archive_layout"));
        else zip.readEntry();
      });
      zip.on("end", () => resolve(list));
      zip.readEntry();
    });
    const names = entries.map((entry) => entry.fileName);
    if (
      entries.length !== OUTER_FILES.length ||
      new Set(names).size !== names.length ||
      !OUTER_FILES.every((name) => names.includes(name))
    )
      throw new RunnerFailure("archive_layout");
    let total = 0;
    for (const entry of entries) {
      const type = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (
        entry.generalPurposeBitFlag & 1 ||
        (type !== 0 && type !== 0x8000) ||
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 1 ||
        (entry.fileName === "source.json" && entry.uncompressedSize > 16_384)
      )
        throw new RunnerFailure("archive_validation");
      total += entry.uncompressedSize;
      if (total > maxBytes) throw new RunnerFailure("archive_too_large");
    }
    for (const entry of entries) {
      let written = 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          written += chunk.length;
          if (written > entry.uncompressedSize) callback(new RunnerFailure("archive_too_large"));
          else callback(null, chunk);
        },
      });
      const stream = await new Promise((resolve, reject) =>
        zip.openReadStream(entry, (error, value) => (error ? reject(error) : resolve(value)))
      );
      await pipeline(
        stream,
        limiter,
        createWriteStream(path.join(destination, entry.fileName), { flags: "wx", mode: 0o600 })
      );
      if (written !== entry.uncompressedSize) throw new RunnerFailure("archive_validation");
    }
  } catch (error) {
    throw error instanceof RunnerFailure ? error : new RunnerFailure("archive_validation");
  } finally {
    zip.close();
  }
}

export function parseBadging(output) {
  if (typeof output !== "string") return null;
  const match = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/m.exec(output);
  if (!match) return null;
  return {
    packageName: match[1],
    versionCode: Number(match[2]),
    versionName: match[3],
    debuggable: /^application-debuggable\s*$/m.test(output),
  };
}

export function parseApksignerVerification(output) {
  if (typeof output !== "string") return null;
  const lines = output.split(/\r?\n/);
  const scheme = (name) =>
    lines.some((line) => new RegExp(`^Verified using ${name} scheme .*: true\\s*$`).test(line));
  return {
    verifies: lines.some((line) => line.trim() === "Verifies"),
    v1: scheme("v1"),
    v2: scheme("v2"),
    v3: scheme("v3"),
    signers: Number(/^Number of signers:\s*(\d+)\s*$/m.exec(output)?.[1] ?? Number.NaN),
    digests: [
      ...output.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([a-f0-9]{64})\s*$/gm),
    ].map((match) => match[1]),
  };
}

async function badging(tools, apk) {
  const { stdout } = await command(tools.aapt2, ["dump", "badging", apk]);
  const info = parseBadging(stdout);
  if (!info) throw new RunnerFailure("apk_metadata");
  return info;
}

async function runAndroid(manifestInput, artifactZip, outputDirectory, credentialInput) {
  const manifest = androidManifestSchema.parse(manifestInput);
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new RunnerFailure("host_unsupported");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  if ((await readdir(outputDirectory)).length) throw new RunnerFailure("output_not_empty");
  const work = await mkdtemp(path.join(os.tmpdir(), "android-sign-"));
  await chmod(work, 0o700);
  const keys = path.join(work, "keys");
  let phase = "input";
  try {
    const artifactStat = await lstat(artifactZip);
    if (
      !artifactStat.isFile() ||
      artifactStat.isSymbolicLink() ||
      artifactStat.size < 1 ||
      artifactStat.size > manifest.max_artifact_bytes ||
      `sha256:${await fileDigest(artifactZip)}` !== manifest.input_digest
    )
      throw new RunnerFailure("input_digest");
    const outer = path.join(work, "outer");
    await mkdir(outer, { mode: 0o700 });
    await extractAndroidSourceArchive(artifactZip, outer, manifest.max_artifact_bytes);

    phase = "source";
    let source;
    try {
      source = androidSourceMetadataSchema.parse(
        JSON.parse(await readFile(path.join(outer, "source.json"), "utf8"))
      );
    } catch {
      throw new RunnerFailure("source_binding");
    }
    if (
      source.package_name !== manifest.package_name ||
      source.version !== manifest.version ||
      source.source_sha !== manifest.source_sha
    )
      throw new RunnerFailure("source_binding");

    phase = "tools";
    const tools = await findAndroidBuildTools();
    if (!tools) throw new RunnerFailure("build_tools_unavailable");
    const java = javaCommand();

    phase = "apk_metadata";
    const unsigned = path.join(outer, "unsigned.apk");
    const info = await badging(tools, unsigned);
    if (info.packageName !== manifest.package_name) throw new RunnerFailure("apk_package");
    if (info.versionName !== manifest.version || info.versionCode !== source.version_code)
      throw new RunnerFailure("apk_version");
    if (info.debuggable) throw new RunnerFailure("apk_debuggable");

    phase = "align";
    const aligned = path.join(work, "aligned.apk");
    await command(tools.zipalign, ["-p", "-f", "4", unsigned, aligned]);
    await command(tools.zipalign, ["-c", "-p", "4", aligned]);

    phase = "credentials";
    const credentials = androidCredentialsSchema.parse(
      typeof credentialInput === "function" ? await credentialInput() : credentialInput
    );
    await mkdir(keys, { mode: 0o700 });
    const keystore = path.join(keys, "release.p12");
    const storePassword = path.join(keys, "store-password");
    const keyPassword = path.join(keys, "key-password");
    await writeFile(keystore, Buffer.from(credentials.keystore_p12, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(storePassword, `${credentials.store_password}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(keyPassword, `${credentials.key_password}\n`, { mode: 0o600, flag: "wx" });

    phase = "sign";
    const signed = path.join(work, "signed.apk");
    try {
      await command(
        java,
        [
          "-jar",
          tools.apksignerJar,
          "sign",
          "--ks",
          keystore,
          "--ks-type",
          "PKCS12",
          "--ks-key-alias",
          credentials.key_alias,
          "--ks-pass",
          `file:${storePassword}`,
          "--key-pass",
          `file:${keyPassword}`,
          "--v2-signing-enabled",
          "true",
          "--v3-signing-enabled",
          "true",
          "--v4-signing-enabled",
          "false",
          "--out",
          signed,
          aligned,
        ],
        { timeout: 10 * 60_000 }
      );
    } finally {
      await rm(keys, { recursive: true, force: true });
    }

    phase = "signature_verification";
    const { stdout } = await command(java, [
      "-jar",
      tools.apksignerJar,
      "verify",
      "--verbose",
      "--print-certs",
      signed,
    ]);
    const verification = parseApksignerVerification(stdout);
    if (!verification?.verifies) throw new RunnerFailure("signature_verification");
    if (!verification.v2 || !verification.v3) throw new RunnerFailure("signature_schemes");
    if (verification.signers !== 1 || verification.digests.length !== 1)
      throw new RunnerFailure("signature_signers");
    if (verification.digests[0] !== manifest.certificate_sha256)
      throw new RunnerFailure("certificate_mismatch");
    const signedInfo = await badging(tools, signed);
    if (
      signedInfo.packageName !== info.packageName ||
      signedInfo.versionCode !== info.versionCode ||
      signedInfo.versionName !== info.versionName
    )
      throw new RunnerFailure("signed_metadata");

    phase = "output";
    const stat = await lstat(signed);
    if (!stat.isFile() || stat.size > manifest.max_artifact_bytes)
      throw new RunnerFailure("output_archive");
    const output = path.join(outputDirectory, "signed.apk");
    await copyFile(signed, output);
    const report = androidVerificationSchema.parse({
      schema_version: 1,
      request_id: manifest.request_id,
      generation: manifest.generation,
      stage: "android_sign",
      input_digest: manifest.input_digest,
      recipe_sha: manifest.recipe_sha,
      policy_digest: manifest.policy_digest,
      source_sha: manifest.source_sha,
      version: manifest.version,
      version_code: info.versionCode,
      package_name: manifest.package_name,
      certificate_sha256: manifest.certificate_sha256,
      v1_verified: verification.v1,
      v2_verified: true,
      v3_verified: true,
      files: [{ path: "signed.apk", size: stat.size, sha256: await fileDigest(output) }],
    });
    await writeFile(
      path.join(outputDirectory, "verification.json"),
      `${JSON.stringify(report)}\n`,
      {
        mode: 0o600,
        flag: "wx",
      }
    );
    return report;
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    throw error instanceof RunnerFailure
      ? safeAndroidFailure(phase, error.code)
      : new RunnerFailure("android_sign_failed");
  } finally {
    try {
      await rm(keys, { recursive: true, force: true });
    } catch {
      throw safeAndroidFailure("cleanup", "keystore_cleanup");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}

export async function executeAndroid(...args) {
  try {
    return await runAndroid(...args);
  } catch (error) {
    if (
      error instanceof RunnerFailure &&
      /^Android signing operation failed: android_[a-z0-9_]+$/.test(error.message) &&
      error.code.length <= 64
    )
      throw error;
    if (error instanceof RunnerFailure) throw safeAndroidFailure("input", error.code);
    throw new RunnerFailure("android_sign_failed");
  }
}
