import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  executableName,
  macosGrantSchema,
  macosManifestSchema as manifestSchema,
  sourceMetadataSchema,
  macosVerificationSchema as verificationSchema,
} from "./contract.mjs";
import { AppleRemoteError, rcodesignSign, submitNotarization } from "./apple-remote.mjs";
import { parseGrant } from "./remote.mjs";

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

delete process.env.DEBUG;
const require = createRequire(import.meta.url);
const { getRawHeader } = require("@electron/asar");
const { FuseState, FuseVersion, FuseV1Options, flipFuses, getCurrentFuseWire } =
  await import("@electron/fuses");

class RunnerFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
class CommandFailure extends Error {
  constructor(exitCode, transient = false) {
    super("native signing command failed");
    this.exitCode = exitCode;
    this.transient = transient;
  }
}
function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function fileSha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function snapshotArchive(source, destination, maxBytes, expectedDigest) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const metadata = await input.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) throw new Error("input archive rejected");
    output = await open(destination, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      if (position > maxBytes) throw new Error("input archive rejected");
      const block = buffer.subarray(0, bytesRead);
      hash.update(block);
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await output.write(
          block,
          offset,
          bytesRead - offset,
          position - bytesRead + offset
        );
        if (!bytesWritten) throw new Error("input archive rejected");
        offset += bytesWritten;
      }
    }
    if (position !== metadata.size || `sha256:${hash.digest("hex")}` !== expectedDigest)
      throw new Error("input archive digest mismatch");
    return destination;
  } finally {
    await input.close();
    if (output) await output.close();
  }
}

const DIAGNOSTIC_TOOLS = new Set([
  "codesign",
  "ditto",
  "hdiutil",
  "lipo",
  "plutil",
  "spctl",
  "stapler",
  "tar",
]);

// Only tools whose arguments never carry credentials may echo their own error text.
function reportCommandFailure(file, args, code, signal, stderr) {
  const base = path.basename(file);
  const tool = base === "xcrun" ? String(args[0]) : base;
  const detail = DIAGNOSTIC_TOOLS.has(tool)
    ? stderr
        .replace(/[A-Za-z0-9+=_-]{24,}/g, "[redacted]")
        .trim()
        .split("\n")
        .slice(-6)
        .join(" | ")
        .slice(-600)
    : "";
  process.stderr.write(
    `signing command failed: ${tool} exit=${code} signal=${signal}${detail ? ` detail: ${detail}` : ""}\n`
  );
}

async function command(file, args, options = {}) {
  try {
    const {
      timeout = 1_800_000,
      maxOutput = 8 * 1024 * 1024,
      transientOutput,
      ...spawnOptions
    } = options;
    return await new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        ...spawnOptions,
        signal: spawnOptions.signal ?? signingAbortSignal,
        timeout,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      let bytes = 0;
      let failed = false;
      const collect = (target) => (chunk) => {
        bytes += chunk.length;
        if (bytes > maxOutput) {
          failed = true;
          child.kill();
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.once("error", () => reject(new CommandFailure(null)));
      child.once("close", (code, signal) => {
        if (failed || code !== 0)
          reportCommandFailure(file, args, code, signal, Buffer.concat(stderr).toString("utf8"));
        if (failed || code !== 0)
          return reject(
            new CommandFailure(
              code,
              !failed &&
                (signal === "SIGTERM" ||
                  Boolean(
                    transientOutput?.test(Buffer.concat([...stdout, ...stderr]).toString("utf8"))
                  ))
            )
          );
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  } catch (error) {
    throw error instanceof CommandFailure ? error : new CommandFailure(null);
  }
}

async function staple(target) {
  const backoff = [5_000, 15_000, 45_000];
  for (let attempt = 0; ; attempt++) {
    try {
      await command("/usr/bin/xcrun", ["stapler", "staple", target], {
        timeout: 600_000,
        transientOutput:
          /Record not found|timed? out|network connection|Could not connect|HTTP (?:429|5\d\d)/i,
      });
      return;
    } catch (error) {
      const transient =
        error instanceof CommandFailure &&
        (error.transient || [68, 69, 75].includes(error.exitCode));
      if (!transient || attempt === backoff.length) {
        throw new RunnerFailure(
          Number.isInteger(error.exitCode)
            ? `stapling_exit_${error.exitCode}`
            : "stapling_command_failed"
        );
      }
      await new Promise((resolve) => setTimeout(resolve, backoff[attempt]));
    }
  }
}

async function ensureEmptyDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("invalid output directory");
  const entries = await readdir(directory);
  if (entries.length) throw new Error("output directory must be empty");
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

async function readPlist(appPath, temporary) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  const plistStat = await lstat(plist);
  if (!plistStat.isFile() || plistStat.isSymbolicLink() || plistStat.size > 1024 * 1024)
    throw new Error("invalid application metadata");
  const { stdout } = await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]);
  const jsonPath = path.join(temporary, "Info.json");
  await writeFile(jsonPath, stdout, { mode: 0o600 });
  return JSON.parse(await readFile(jsonPath, "utf8"));
}

async function inspectBundle(appPath, manifest, temporary, requireSignatures, requireFuses = true) {
  const info = await readPlist(appPath, temporary);
  if (
    info.CFBundleIdentifier !== manifest.bundle_id ||
    info.CFBundleShortVersionString !== manifest.version
  ) {
    throw new Error("application identity mismatch");
  }
  if (!executableName.safeParse(info.CFBundleExecutable).success) {
    throw new Error("invalid application executable");
  }
  const executable = path.join(appPath, "Contents", "MacOS", info.CFBundleExecutable);
  const executableStat = await lstat(executable);
  if (
    !executableStat.isFile() ||
    executableStat.isSymbolicLink() ||
    !contained(path.resolve(appPath), path.resolve(executable))
  ) {
    throw new Error("invalid application executable");
  }
  const { stdout: archOutput } = await command("/usr/bin/lipo", ["-archs", executable]);
  const architectures = new Set(archOutput.trim().split(/\s+/));
  const wanted =
    manifest.architecture === "x64"
      ? ["x86_64"]
      : manifest.architecture === "arm64"
        ? ["arm64"]
        : ["arm64", "x86_64"];
  if (
    wanted.some((arch) => !architectures.has(arch)) ||
    (manifest.architecture !== "universal" && architectures.size !== 1)
  ) {
    throw new Error("application architecture mismatch");
  }

  let asarVerified = false;
  if (manifest.profile === "electron") {
    const fuseFiles = [];
    if (manifest.architecture === "universal") {
      const framework = path.join(
        appPath,
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Electron Framework"
      );
      for (const arch of wanted) {
        const slice = path.join(temporary, `electron-${arch}`);
        await command("/usr/bin/lipo", [framework, "-thin", arch, "-output", slice]);
        fuseFiles.push(slice);
      }
    } else fuseFiles.push(executable);
    const required = [
      [FuseV1Options.RunAsNode, FuseState.DISABLE],
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
      [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
      [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    ];
    try {
      for (const file of fuseFiles) {
        const fuse = await getCurrentFuseWire(file);
        if (
          requireFuses &&
          (fuse.version !== FuseVersion.V1 ||
            required.some(([index, state]) => fuse[index] !== state))
        )
          throw new Error("application security policy mismatch");
      }
    } finally {
      if (manifest.architecture === "universal")
        await Promise.all(fuseFiles.map((file) => rm(file, { force: true })));
    }
    const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
    const asarStat = await lstat(asarPath);
    if (
      !asarStat.isFile() ||
      asarStat.isSymbolicLink() ||
      asarStat.size > manifest.max_unpacked_bytes
    )
      throw new Error("invalid application archive");
    const header = getRawHeader(asarPath);
    const expected = info.ElectronAsarIntegrity?.["Resources/app.asar"];
    if (
      !expected ||
      expected.algorithm !== "SHA256" ||
      expected.hash !== sha256(Buffer.from(header.headerString, "utf8"))
    ) {
      throw new Error("application archive integrity mismatch");
    }
    asarVerified = true;
  }

  if (requireSignatures) {
    await verifySignature(appPath, manifest);
  }
  return { asarVerified, info, executable };
}

async function createTar(archivePath, bundleName, baseDir) {
  await command("/usr/bin/tar", ["-czf", archivePath, "-C", baseDir, bundleName], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

// Entitlements Electron's signing tool applies by default, per helper role.
const DEFAULT_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.device.audio-input",
  "com.apple.security.device.bluetooth",
  "com.apple.security.device.camera",
  "com.apple.security.device.print",
  "com.apple.security.device.usb",
  "com.apple.security.personal-information.location",
  "com.apple.security.personal-information.photos-library",
];
const HELPER_ENTITLEMENTS = [
  [
    "(Plugin).app",
    [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
    ],
  ],
  ["(GPU).app", ["com.apple.security.cs.allow-jit"]],
  ["(Renderer).app", ["com.apple.security.cs.allow-jit"]],
];

async function nestedBundles(appPath, directory = path.join(appPath, "Contents")) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(directory, entry.name);
    if (entry.name.endsWith(".app"))
      found.push(path.relative(appPath, child).split(path.sep).join("/"));
    found.push(...(await nestedBundles(appPath, child)));
  }
  return found;
}

/** rcodesign arguments that give the bundle and each nested app the default entitlements. */
async function entitlementArguments(appPath, work) {
  const files = new Map();
  const file = async (keys) => {
    const name = keys.join(",");
    if (!files.has(name)) {
      const target = path.join(work, `entitlements-${files.size}.plist`);
      await writeFile(
        target,
        `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${keys.map((key) => `<key>${key}</key><true/>`).join("")}</dict></plist>\n`,
        { mode: 0o600, flag: "wx" }
      );
      files.set(name, target);
    }
    return files.get(name);
  };
  const args = ["--entitlements-xml-file", await file(DEFAULT_ENTITLEMENTS)];
  for (const bundle of await nestedBundles(appPath)) {
    // rcodesign scopes a setting with `<path>:<value>`, so a colon in the path cannot be scoped.
    if (bundle.includes(":")) throw new RunnerFailure("codesign_options");
    const keys =
      HELPER_ENTITLEMENTS.find(([suffix]) => bundle.endsWith(suffix))?.[1] ?? DEFAULT_ENTITLEMENTS;
    args.push("--entitlements-xml-file", `${bundle}:${await file(keys)}`);
  }
  return args;
}

function signingRequirement(teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("invalid signing team");
  return `=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`;
}

async function verifySignature(appPath, manifest) {
  try {
    await command("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "-R",
      signingRequirement(manifest.team_id),
      "--verbose=2",
      appPath,
    ]);
  } catch {
    throw new RunnerFailure("signature_chain");
  }
  const { stderr, stdout } = await command("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
  const details = `${stderr}\n${stdout}`;
  const team = details.match(/^TeamIdentifier=(.+)$/m)?.[1];
  const timestamp = details.match(/^Timestamp=(.+)$/m)?.[1];
  if (team !== manifest.team_id) throw new RunnerFailure("signature_team");
  if (!timestamp || timestamp === "none") throw new RunnerFailure("signature_timestamp");
  return true;
}

async function outputFile(directory, name, content) {
  const target = path.join(directory, name);
  await writeFile(target, content, { mode: 0o600, flag: "wx" });
  return { path: name, size: (await lstat(target)).size, sha256: await fileSha256(target) };
}

async function outputArchive(directory, name, source, maxBytes) {
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.size > maxBytes)
    throw new Error("output archive exceeds approved limit");
  const target = path.join(directory, name);
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, 0o600);
  return { path: name, size: sourceStat.size, sha256: await fileSha256(target) };
}

async function execute(manifestInput, inputArchivePath, outputDir, credentialsInput) {
  const manifest = manifestSchema.parse(manifestInput);
  if (!["sign", "finalize"].includes(manifest.stage))
    throw new Error("invalid application signing stage");
  if (manifest.stage === "finalize" && credentialsInput !== undefined)
    throw new Error("credentials are not accepted during finalization");
  if (
    manifest.stage === "sign" &&
    typeof credentialsInput !== "function" &&
    (credentialsInput === null || typeof credentialsInput !== "object")
  ) {
    throw new Error("credentials provider required");
  }
  if (process.platform !== "darwin") throw new Error("macOS native signing host required");
  const output = path.resolve(outputDir);
  await ensureEmptyDirectory(output);
  const work = await mkdtemp(path.join(os.tmpdir(), "macos-sign-"));
  await chmod(work, 0o700);
  const extract = path.join(work, "extract");
  const unpacker = path.join(path.dirname(fileURLToPath(import.meta.url)), "unpack.py");
  const python = process.env.PYTHON || "python3";
  let failureCode = "input_archive";
  try {
    const archiveSnapshot = await snapshotArchive(
      path.resolve(inputArchivePath),
      path.join(work, "input.zip"),
      manifest.max_artifact_bytes,
      manifest.input_digest
    );
    await mkdir(extract, { mode: 0o700 });
    const config = JSON.stringify({
      stage: manifest.stage,
      bundle_name: manifest.bundle_name,
      max_artifact_bytes: manifest.max_artifact_bytes,
      max_unpacked_bytes: manifest.max_unpacked_bytes,
      destination: extract,
    });
    failureCode = "archive_validation";
    await command(python, [unpacker, config, archiveSnapshot, work]);
    failureCode = "source_binding";
    if (manifest.stage === "sign") {
      const source = sourceMetadataSchema.parse(
        JSON.parse(await readFile(path.join(work, "source.json"), "utf8"))
      );
      if (
        source.source_sha !== manifest.source_sha ||
        source.version !== manifest.version ||
        source.bundle_id !== manifest.bundle_id ||
        source.architecture !== manifest.architecture
      ) {
        throw new Error("source metadata does not match manifest");
      }
    }
    const appPath = path.join(extract, manifest.bundle_name);
    const appStat = await lstat(appPath);
    if (!appStat.isDirectory() || appStat.isSymbolicLink())
      throw new Error("approved application bundle missing");
    failureCode = "static_verification";
    let inspected = await inspectBundle(
      appPath,
      manifest,
      work,
      manifest.stage === "finalize",
      !(manifest.stage === "sign" && manifest.harden_electron_fuses)
    );
    if (
      manifest.stage === "sign" &&
      manifest.profile === "electron" &&
      manifest.harden_electron_fuses
    ) {
      await flipFuses(inspected.executable, {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
      });
      inspected = await inspectBundle(appPath, manifest, work, false);
    }

    if (manifest.stage === "sign") {
      failureCode = "credential_release";
      const { remote } = parseGrant(
        macosGrantSchema,
        typeof credentialsInput === "function" ? await credentialsInput() : credentialsInput
      );
      failureCode = "codesign";
      const signArgs = [
        "--for-notarization",
        ...(await entitlementArguments(appPath, work)),
        appPath,
      ];
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rcodesignSign(remote, signArgs, { work, signal: signingAbortSignal });
          break;
        } catch (error) {
          const detail = [...(error?.output ?? "").matchAll(/^Error: (.*)$/gm)].at(-1)?.[1] ?? "";
          const categories = [
            ["timestamp", /time-?stamp/i],
            ["remote", /relay server|websocket|cryptography error|bad client state/i],
            ["identity", /Developer ID|signing certificate/i],
            ["resources", /resource fork|Finder information|unsealed contents/i],
            ["options", /invalid value|unexpected argument|entitlements/i],
          ];
          const category =
            error instanceof AppleRemoteError && !error.output
              ? "remote"
              : (categories.find(([, pattern]) => pattern.test(detail))?.[0] ?? "failed");
          // Apple's timestamp service drops requests under bursts, and signing again replaces the earlier signatures.
          if (category === "timestamp" && attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 30_000 * (attempt + 1)));
            continue;
          }
          failureCode = "codesign_" + category;
          throw new Error("application signing failed");
        }
      }
      failureCode = "signature_verification";
      await verifySignature(appPath, manifest);
      failureCode = "notarization";
      const notarizeZip = path.join(work, "notarize.zip");
      await command("/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, notarizeZip]);
      if ((await lstat(notarizeZip)).size > manifest.max_artifact_bytes)
        throw new Error("notarization archive exceeds approved limit");
      const notaryHash = await fileSha256(notarizeZip);
      let notarizationId;
      try {
        notarizationId = await submitNotarization(remote, notarizeZip, {
          sha256: notaryHash,
          submissionName: `${manifest.bundle_id}-${manifest.version}.zip`.slice(0, 128),
          signal: signingAbortSignal,
        });
      } catch (error) {
        if (error?.code === "notarization_upload") failureCode = "notarization_upload";
        throw new Error("Apple notarization submission failed");
      }
      failureCode = "artifact_packaging";
      const signedTar = path.join(work, "signed.tar.gz");
      await createTar(signedTar, manifest.bundle_name, extract);
      const files = [
        await outputArchive(output, "signed.tar.gz", signedTar, manifest.max_artifact_bytes),
      ];
      const report = verificationSchema.parse({
        schema_version: 1,
        request_id: manifest.request_id,
        generation: manifest.generation,
        stage: "sign",
        input_digest: manifest.input_digest,
        recipe_sha: manifest.recipe_sha,
        policy_digest: manifest.policy_digest,
        team_id: manifest.team_id,
        bundle_id: manifest.bundle_id,
        version: manifest.version,
        architecture: manifest.architecture,
        codesign_verified: true,
        timestamp_verified: true,
        asar_integrity_verified: inspected.asarVerified,
        notarization_id: notarizationId,
        notarization_status: "Submitted",
        notary_archive_sha256: notaryHash,
        gatekeeper_verified: false,
        staple_verified: false,
        files,
      });
      await outputFile(output, "verification.json", Buffer.from(JSON.stringify(report)));
      return report;
    }

    failureCode = "stapling";
    await staple(appPath);
    failureCode = "gatekeeper_verification";
    await command("/usr/bin/xcrun", ["stapler", "validate", appPath], { timeout: 600_000 });
    await command("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
    await verifySignature(appPath, manifest);
    failureCode = "artifact_packaging";
    const productZip = path.join(work, "product.zip");
    await command("/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, productZip]);
    const files = [
      await outputArchive(output, "product.zip", productZip, manifest.max_artifact_bytes),
    ];
    const report = verificationSchema.parse({
      schema_version: 1,
      request_id: manifest.request_id,
      generation: manifest.generation,
      stage: "finalize",
      input_digest: manifest.input_digest,
      recipe_sha: manifest.recipe_sha,
      policy_digest: manifest.policy_digest,
      team_id: manifest.team_id,
      bundle_id: manifest.bundle_id,
      version: manifest.version,
      architecture: manifest.architecture,
      codesign_verified: true,
      timestamp_verified: true,
      asar_integrity_verified: inspected.asarVerified,
      notarization_id: manifest.notarization_id,
      notarization_status: "Accepted",
      notary_archive_sha256: manifest.notary_archive_sha256,
      gatekeeper_verified: true,
      staple_verified: true,
      files,
    });
    await outputFile(output, "verification.json", Buffer.from(JSON.stringify(report)));
    return report;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true, mode: 0o700 });
    throw error instanceof RunnerFailure ? error : new RunnerFailure(failureCode);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function executeMacos(manifest, inputArchivePath, outputDir, credentials) {
  try {
    return verificationSchema.parse(
      await execute(manifest, inputArchivePath, outputDir, credentials)
    );
  } catch (error) {
    if (error instanceof RunnerFailure)
      throw new Error(`macOS signing operation failed: ${error.code}`);
    throw new Error("macOS signing operation failed");
  }
}

export {
  command,
  createTar,
  fileSha256,
  inspectBundle,
  signingRequirement,
  snapshotArchive,
  staple,
};
