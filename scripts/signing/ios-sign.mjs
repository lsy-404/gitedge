import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  iosCredentialsSchema,
  iosManifestSchema,
  iosSourceMetadataSchema,
  iosVerificationSchema,
} from "./contract.mjs";
import { validateIosProfile, validateSignedEntitlements } from "./ios-policy.mjs";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");
class RunnerFailure extends Error {
  constructor(code) {
    super(`iOS signing operation failed: ${code}`);
    this.code = code;
  }
}

const iosFailurePhases = new Set([
  "input",
  "source",
  "archive_metadata",
  "profile",
  "profile_cms",
  "profile_signer",
  "profile_trust",
  "identity",
  "identity_search",
  "identity_create",
  "identity_unlock",
  "identity_import",
  "identity_partition",
  "identity_verify",
  "profile_install",
  "export",
  "signature_verification",
  "cleanup",
]);
const iosFailureCodes = new Set([
  "macos_host_required",
  "output_not_empty",
  "input_digest",
  "archive_layout",
  "archive_validation",
  "archive_too_large",
  "source_binding",
  "archive_app_path",
  "nested_bundle",
  "archive_metadata",
  "archive_executable",
  "archive_architecture",
  "archive_platform",
  "profile_signer",
  "signature_entitlements",
  "profile_certificate",
  "profile_invalid",
  "profile_team",
  "profile_uuid",
  "profile_expired",
  "profile_not_development",
  "profile_devices",
  "profile_app_prefix",
  "profile_bundle",
  "certificate_identity",
  "certificate_expired",
  "development_identity_unavailable",
  "profile_collision",
  "native_command",
  "native_timeout",
  "python_runtime",
  "export_output",
  "output_archive",
  "export_bundle",
  "signature_bundle",
  "signature_verification",
  "signature_identity",
  "signature_profile",
  "keychain_cleanup",
  "p12_integrity",
  "p12_format",
  "keychain_not_found",
  "interaction_not_allowed",
]);
const identityImportFailureCodes = new Set([
  "p12_integrity",
  "p12_format",
  "keychain_not_found",
  "interaction_not_allowed",
]);

export function safeIosFailure(phase, code) {
  if (!iosFailurePhases.has(phase) || !iosFailureCodes.has(code)) {
    return new RunnerFailure("ios_sign_failed");
  }
  const safeCode = `ios_${phase}_${code}`;
  return safeCode.length <= 64 ? new RunnerFailure(safeCode) : new RunnerFailure("ios_sign_failed");
}

export function classifyIdentityImportFailure(stderr) {
  if (typeof stderr !== "string") return null;
  if (/\bMAC verification failed\b|\bMac verify error\b/i.test(stderr)) return "p12_integrity";
  if (
    /\b(?:unknown|unsupported|invalid) format\b|\bnot (?:a|an) (?:PKCS ?#?12|PFX)(?: file| data)?\b/i.test(
      stderr
    )
  )
    return "p12_format";
  if (/\b(?:user )?interaction (?:is )?not allowed\b|\berrSecInteractionNotAllowed\b/i.test(stderr))
    return "interaction_not_allowed";
  if (
    /\bkeychain[^\r\n.]{0,100}(?:not found|could not be found|does not exist|no such file)\b|\b(?:not found|could not be found|does not exist|no such file)[^\r\n.]{0,100}keychain\b/i.test(
      stderr
    )
  ) {
    return "keychain_not_found";
  }
  return null;
}

function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeout = 120_000, failureClass, ...spawnOptions } = options;
    const child = spawn(file, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
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
      else {
        const diagnostic =
          failureClass === "identity_import"
            ? Buffer.concat(stderr).subarray(0, 16_384).toString()
            : "";
        const classified =
          failureClass === "identity_import" ? classifyIdentityImportFailure(diagnostic) : null;
        reject(
          new RunnerFailure(
            identityImportFailureCodes.has(classified) ? classified : "native_command"
          )
        );
      }
    });
  });
}

function zipEntries(file) {
  const options = {
    lazyEntries: true,
    strictFileNames: true,
    decodeStrings: true,
    autoClose: false,
  };
  return new Promise((resolve, reject) =>
    Buffer.isBuffer(file)
      ? yauzl.fromBuffer(file, options, (error, zip) => finish(error, zip, resolve, reject))
      : yauzl.open(file, options, (error, zip) => finish(error, zip, resolve, reject))
  );

  function finish(error, zip, resolve, reject) {
    if (error) return reject(error);
    const entries = [];
    zip.on("error", reject);
    zip.on("entry", (entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on("end", () => resolve({ zip, entries }));
    zip.readEntry();
  }
}

function safeZipName(name) {
  return (
    typeof name === "string" &&
    name.length <= 1024 &&
    !/[\0-\x1f\x7f\\:]/.test(name) &&
    name === name.normalize("NFC") &&
    !name.startsWith("/") &&
    !/^[A-Za-z]:/.test(name) &&
    name
      .replace(/\/$/, "")
      .split("/")
      .every((part) => part && part !== "." && part !== "..")
  );
}

async function extractZip(
  file,
  destination,
  { maxBytes, exactFiles, exactRoot, allowedRoots, maxEntries = 100_000 }
) {
  const { zip, entries } = await zipEntries(file);
  try {
    if (!entries.length || entries.length > maxEntries) throw new RunnerFailure("archive_layout");
    let total = 0;
    const seen = new Set();
    const folded = new Set();
    const normalized = [];
    if (exactRoot && !entries.some((entry) => entry.fileName === `${exactRoot}/`))
      throw new RunnerFailure("archive_layout");
    for (const entry of entries) {
      const name = entry.fileName,
        directory = name.endsWith("/");
      const mode = entry.externalFileAttributes >>> 16;
      const type = mode & 0xf000;
      const normalizedName = name.normalize("NFC").toLocaleLowerCase("en-US");
      if (
        !safeZipName(name) ||
        seen.has(name) ||
        folded.has(normalizedName) ||
        entry.generalPurposeBitFlag & 1 ||
        (allowedRoots && !allowedRoots.includes(name.split("/")[0])) ||
        (type !== 0 && type !== 0x8000 && type !== 0x4000) ||
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0
      )
        throw new RunnerFailure("archive_validation");
      seen.add(name);
      folded.add(normalizedName);
      total += entry.uncompressedSize;
      if (!Number.isSafeInteger(total) || total > maxBytes)
        throw new RunnerFailure("archive_too_large");
      normalized.push({ entry, name, directory, mode });
    }
    if (
      (exactFiles &&
        (seen.size !== exactFiles.length || exactFiles.some((name) => !seen.has(name)))) ||
      (exactRoot && normalized.some(({ name }) => name.split("/")[0] !== exactRoot))
    )
      throw new RunnerFailure("archive_layout");
    for (const { entry, name, directory, mode } of normalized) {
      const target = path.resolve(destination, ...name.split("/"));
      const relative = path.relative(destination, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new RunnerFailure("archive_validation");
      if (directory) {
        await mkdir(target, { recursive: true, mode: 0o700 });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const outputMode = safeFileMode(mode);
      let written = 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          written += chunk.length;
          if (written > entry.uncompressedSize || written > maxBytes)
            callback(new RunnerFailure("archive_too_large"));
          else callback(null, chunk);
        },
      });
      await new Promise((resolve, reject) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          pipeline(stream, limiter, createWriteStream(target, { flags: "wx", mode: 0o600 })).then(
            resolve,
            reject
          );
        })
      );
      if (written !== entry.uncompressedSize) throw new RunnerFailure("archive_validation");
      await chmod(target, outputMode);
    }
    return total;
  } finally {
    zip.close();
  }
}

export async function extractIosArchiveZip(file, destination, maxBytes = 4_000_000_000) {
  return extractZip(file, destination, { maxBytes, exactRoot: "unsigned.xcarchive" });
}

export function safeFileMode(zipMode) {
  return 0o600 | (zipMode & 0o111 ? 0o100 : 0);
}

async function plist(file) {
  const python = process.env.PYTHON;
  if (typeof python !== "string" || !python.trim()) throw new RunnerFailure("python_runtime");
  const parser = [
    "import base64, datetime, json, plistlib, sys",
    "def encode(value):",
    '    if isinstance(value, bytes): return base64.b64encode(value).decode("ascii")',
    "    if isinstance(value, (datetime.datetime, datetime.date)): return value.isoformat()",
    "    if isinstance(value, dict): return {key: encode(item) for key, item in value.items()}",
    "    if isinstance(value, list): return [encode(item) for item in value]",
    "    return value",
    'with open(sys.argv[1], "rb") as source: print(json.dumps(encode(plistlib.load(source, aware_datetime=True)), separators=(",", ":")))',
  ].join("\n");
  const { stdout } = await command(python, ["-c", parser, file]);
  return JSON.parse(stdout);
}

async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function archiveMetadata(root, manifest, source, temp) {
  const rootEntries = await readdir(root, { withFileTypes: true });
  if (
    !rootEntries.some((entry) => entry.isFile() && entry.name === "Info.plist") ||
    !rootEntries.some((entry) => entry.isDirectory() && entry.name === "Products") ||
    rootEntries.some(
      (entry) =>
        !["Info.plist", "Products", "dSYMs", "BCSymbolMaps", "SwiftSupport"].includes(entry.name)
    )
  ) {
    throw new RunnerFailure("archive_layout");
  }
  const archiveInfo = await plist(path.join(root, "Info.plist"), temp);
  const relative = archiveInfo.ApplicationProperties?.ApplicationPath;
  if (typeof relative !== "string" || !/^Applications\/[^/]+\.app$/.test(relative))
    throw new RunnerFailure("archive_app_path");
  const products = await readdir(path.join(root, "Products"), { withFileTypes: true });
  if (products.length !== 1 || !products[0].isDirectory() || products[0].name !== "Applications")
    throw new RunnerFailure("archive_layout");
  const applications = await readdir(path.join(root, "Products", "Applications"), {
    withFileTypes: true,
  });
  if (
    applications.length !== 1 ||
    !applications[0].isDirectory() ||
    applications[0].name !== path.basename(relative)
  )
    throw new RunnerFailure("archive_app_path");
  const app = path.join(root, "Products", relative);
  async function rejectNestedBundles(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (entry.name.endsWith(".app") ||
          entry.name.endsWith(".appex") ||
          entry.name.endsWith(".xpc"))
      )
        throw new RunnerFailure("nested_bundle");
      if (entry.isDirectory()) await rejectNestedBundles(path.join(directory, entry.name));
    }
  }
  await rejectNestedBundles(app);
  const appInfo = await plist(path.join(app, "Info.plist"), temp);
  const build = appInfo.CFBundleVersion;
  if (
    archiveInfo.ApplicationProperties?.CFBundleIdentifier !== manifest.bundle_id ||
    archiveInfo.ApplicationProperties?.CFBundleShortVersionString !== manifest.version ||
    appInfo.CFBundleIdentifier !== manifest.bundle_id ||
    appInfo.CFBundleShortVersionString !== manifest.version ||
    typeof build !== "string" ||
    !/^\d+(?:\.\d+){0,2}$/.test(build) ||
    (archiveInfo.ApplicationProperties?.SigningIdentity &&
      archiveInfo.ApplicationProperties.SigningIdentity.includes("Developer ID"))
  ) {
    throw new RunnerFailure("archive_metadata");
  }
  if (
    source.version !== appInfo.CFBundleShortVersionString ||
    source.bundle_id !== appInfo.CFBundleIdentifier
  )
    throw new RunnerFailure("source_binding");
  const executable = path.join(app, appInfo.CFBundleExecutable ?? "");
  if (!appInfo.CFBundleExecutable || path.basename(executable) !== appInfo.CFBundleExecutable)
    throw new RunnerFailure("archive_executable");
  const info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink()) throw new RunnerFailure("archive_executable");
  const lipo = await command("/usr/bin/lipo", ["-archs", executable]);
  if (lipo.stdout.trim().split(/\s+/).join(",") !== "arm64")
    throw new RunnerFailure("archive_architecture");
  const buildInfo = await command("/usr/bin/xcrun", ["vtool", "-show-build", executable]);
  if (
    !/platform\s+IOS(?:\s|$)/m.test(buildInfo.stdout) ||
    /platform\s+IOSSIMULATOR(?:\s|$)/m.test(buildInfo.stdout)
  )
    throw new RunnerFailure("archive_platform");
  return { app, archiveInfo, appInfo, build };
}

async function profilePlist(file, temp, setPhase) {
  const signer = path.join(temp, `${randomBytes(8).toString("hex")}.pem`);
  const certificates = path.join(temp, `${randomBytes(8).toString("hex")}.certs.pem`);
  const intermediate = path.join(temp, `${randomBytes(8).toString("hex")}.intermediate.pem`);
  const payload = path.join(temp, `${randomBytes(8).toString("hex")}.payload`);
  setPhase?.("profile_cms");
  await command("/usr/bin/openssl", [
    "cms",
    "-verify",
    "-inform",
    "DER",
    "-in",
    file,
    "-noverify",
    "-certsout",
    certificates,
    "-signer",
    signer,
    "-out",
    payload,
  ]);
  setPhase?.("profile_signer");
  const signerPem = await readFile(signer, "utf8");
  if (!isExpectedProfileSignerCertificate(signerPem)) throw new RunnerFailure("profile_signer");
  setPhase?.("profile_trust");
  const intermediatePem = selectProfileSignerIntermediate(
    signerPem,
    await readFile(certificates, "utf8")
  );
  if (!intermediatePem) throw new RunnerFailure("profile_signer");
  await writeFile(intermediate, intermediatePem, { mode: 0o600, flag: "wx" });
  await command("/usr/bin/security", [
    "verify-cert",
    "-c",
    signer,
    "-c",
    intermediate,
    "-p",
    "basic",
  ]);
  setPhase?.("profile");
  return plist(payload);
}

async function signedEntitlements(app, temp) {
  const { stdout, stderr } = await command("/usr/bin/codesign", [
    "--display",
    "--entitlements",
    "-",
    "--xml",
    app,
  ]);
  const content = codesignEntitlementsXml(stdout, stderr);
  const output = path.join(temp, `${randomBytes(8).toString("hex")}.entitlements.plist`);
  await writeFile(output, content, { mode: 0o600, flag: "wx" });
  return plist(output);
}

export function codesignEntitlementsXml(stdout, stderr = "") {
  const start = stdout.indexOf("<?xml");
  const close = stdout.indexOf("</plist>", start);
  if (start < 0 || close < 0 || stdout.slice(close + "</plist>".length).trim())
    throw new RunnerFailure("signature_entitlements");
  void stderr;
  return stdout.slice(start, close + "</plist>".length);
}

function sameDistinguishedName(actual, expected) {
  return (
    actual &&
    typeof actual === "object" &&
    !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, value]) =>
        Object.hasOwn(actual, key) && typeof actual[key] === "string" && actual[key] === value
    )
  );
}

export function profileSignerNamesMatch(subject, issuer) {
  return (
    sameDistinguishedName(subject, {
      C: "US",
      O: "Apple Inc.",
      CN: "Apple iPhone OS Provisioning Profile Signing",
    }) &&
    sameDistinguishedName(issuer, {
      C: "US",
      O: "Apple Inc.",
      OU: "Certification Authority",
      CN: "Apple iPhone Certification Authority",
    })
  );
}

export function isExpectedProfileSignerCertificate(pem) {
  try {
    const { subject, issuer } = new X509Certificate(pem).toLegacyObject();
    return profileSignerNamesMatch(subject, issuer);
  } catch {
    return false;
  }
}

export function selectProfileSignerIntermediate(signerPem, certificateBundle) {
  try {
    const signer = new X509Certificate(signerPem);
    const certificatePattern = /-----BEGIN CERTIFICATE-----\s*[\s\S]*?-----END CERTIFICATE-----/g;
    const blocks = [...certificateBundle.matchAll(certificatePattern)].map((match) => match[0]);
    if (!blocks.length || certificateBundle.replace(certificatePattern, "").trim()) return null;
    const expectedSubject = {
      C: "US",
      O: "Apple Inc.",
      OU: "Certification Authority",
      CN: "Apple iPhone Certification Authority",
    };
    const intermediates = blocks
      .map((block) => new X509Certificate(block))
      .filter(
        (certificate) =>
          certificate.ca &&
          sameDistinguishedName(certificate.toLegacyObject().subject, expectedSubject)
      );
    if (intermediates.length !== 1) return null;
    const intermediate = intermediates[0];
    if (!signer.checkIssued(intermediate) || !signer.verify(intermediate.publicKey)) return null;
    return intermediate.toString();
  } catch {
    return null;
  }
}

export function identityOutputMatchesProfile(output, expectedSha1) {
  if (
    typeof output !== "string" ||
    typeof expectedSha1 !== "string" ||
    !/^[A-F0-9]{40}$/i.test(expectedSha1)
  )
    return false;
  return output.split(/\r?\n/).some((line) => {
    const match = line.match(/^\s*\d+\)\s+([A-F0-9]{40})\s+"(Apple Development:[^"\r\n]*)"\s*$/);
    return match && match[1] === expectedSha1.toUpperCase();
  });
}

export function codesignIdentityMatches(output, teamId) {
  if (typeof output !== "string" || typeof teamId !== "string") return false;
  const lines = output.split(/\r?\n/);
  return (
    lines.includes(`TeamIdentifier=${teamId}`) &&
    lines.some((line) => line.startsWith("Authority=Apple Development:"))
  );
}

function exportOptions(plistPath, { teamId, bundleId, profileUuid }) {
  const fields = {
    method: "debugging",
    signingStyle: "manual",
    signingCertificate: "Apple Development",
    teamID: teamId,
    provisioningProfiles: { [bundleId]: profileUuid },
    manageAppVersionAndBuildNumber: false,
  };
  return writeFile(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>method</key><string>${fields.method}</string><key>signingStyle</key><string>manual</string><key>signingCertificate</key><string>Apple Development</string><key>teamID</key><string>${teamId}</string><key>provisioningProfiles</key><dict><key>${bundleId}</key><string>${profileUuid}</string></dict><key>manageAppVersionAndBuildNumber</key><false/></dict></plist>`,
    { mode: 0o600, flag: "wx" }
  );
}

async function runIos(manifestInput, artifactZip, outputDirectory, credentialInput) {
  const manifest = iosManifestSchema.parse(manifestInput);
  if (process.platform !== "darwin") throw new RunnerFailure("macos_host_required");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  if ((await readdir(outputDirectory)).length) throw new RunnerFailure("output_not_empty");
  const work = await mkdtemp(path.join(os.tmpdir(), "ios-export-"));
  await chmod(work, 0o700);
  let keychain;
  let priorKeychains;
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
    await extractZip(artifactZip, outer, {
      maxBytes: manifest.max_artifact_bytes,
      exactFiles: ["unsigned.xcarchive.zip", "source.json"],
    });
    phase = "source";
    const source = iosSourceMetadataSchema.parse(
      JSON.parse(await readFile(path.join(outer, "source.json"), "utf8"))
    );
    if (
      source.platform !== "ios" ||
      source.architecture !== "arm64" ||
      source.bundle_id !== manifest.bundle_id ||
      source.version !== manifest.version ||
      source.source_sha !== manifest.source_sha
    )
      throw new RunnerFailure("source_binding");
    const archiveZip = path.join(outer, "unsigned.xcarchive.zip");
    const archive = path.join(work, "archive");
    await mkdir(archive, { mode: 0o700 });
    phase = "archive_metadata";
    const unpacked = await extractZip(archiveZip, archive, {
      maxBytes: manifest.max_unpacked_bytes,
      exactRoot: "unsigned.xcarchive",
    });
    if (unpacked > manifest.max_unpacked_bytes) throw new RunnerFailure("archive_too_large");
    const archiveRoot = path.join(archive, "unsigned.xcarchive");
    if (!(await lstat(archiveRoot)).isDirectory()) throw new RunnerFailure("archive_layout");
    const info = await archiveMetadata(archiveRoot, manifest, source, work);
    phase = "profile";
    const credentials = iosCredentialsSchema.parse(
      typeof credentialInput === "function" ? await credentialInput() : credentialInput
    );
    const p12 = path.join(work, "development.p12"),
      profileFile = path.join(work, "development.mobileprovision");
    await writeFile(p12, Buffer.from(credentials.certificate_p12, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(profileFile, Buffer.from(credentials.provisioning_profile, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    const profile = await profilePlist(profileFile, work, (nextPhase) => {
      phase = nextPhase;
    });
    // Validate the profile's public certificate before importing its matching private key.
    const expectedCertificate = profile.DeveloperCertificates?.[0];
    if (!expectedCertificate) throw new RunnerFailure("profile_certificate");
    const certBytes = Buffer.isBuffer(expectedCertificate)
      ? expectedCertificate
      : Buffer.from(expectedCertificate, "base64");
    const profileCertificateSha = createHash("sha1").update(certBytes).digest("hex").toUpperCase();
    const profileInfo = validateIosProfile(profile, {
      teamId: manifest.team_id,
      bundleId: manifest.bundle_id,
      certificateSha1: profileCertificateSha,
    });
    phase = "identity_search";
    const search = await command("/usr/bin/security", ["list-keychains", "-d", "user"]);
    priorKeychains = search.stdout;
    keychain = path.join(work, "ios.keychain-db");
    const password = randomBytes(32).toString("base64url");
    phase = "identity_create";
    await command("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
    await command("/usr/bin/security", ["set-keychain-settings", "-lut", "300", keychain]);
    phase = "identity_unlock";
    await command("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
    phase = "identity_import";
    await command(
      "/usr/bin/security",
      [
        "import",
        p12,
        "-k",
        keychain,
        "-P",
        credentials.certificate_password,
        "-T",
        "/usr/bin/codesign",
      ],
      {
        failureClass: "identity_import",
      }
    );
    phase = "identity_partition";
    await command("/usr/bin/security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      password,
      keychain,
    ]);
    const keychains = [...priorKeychains.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    phase = "identity_search";
    await command("/usr/bin/security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      keychain,
      ...keychains,
    ]);
    phase = "identity_verify";
    const identities = await command("/usr/bin/security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning",
      keychain,
    ]);
    if (!identityOutputMatchesProfile(identities.stdout, profileCertificateSha))
      throw new RunnerFailure("development_identity_unavailable");
    phase = "profile_install";
    const profileDir = path.join(
      os.homedir(),
      "Library",
      "Developer",
      "Xcode",
      "UserData",
      "Provisioning Profiles"
    );
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const installedProfile = path.join(profileDir, `${profileInfo.uuid}.mobileprovision`);
    try {
      await lstat(installedProfile);
      throw new RunnerFailure("profile_collision");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writeFile(installedProfile, await readFile(profileFile), { mode: 0o600 });
    try {
      phase = "export";
      const exportPath = path.join(work, "export");
      await mkdir(exportPath, { mode: 0o700 });
      const options = path.join(work, "ExportOptions.plist");
      await exportOptions(options, {
        teamId: manifest.team_id,
        bundleId: manifest.bundle_id,
        profileUuid: profileInfo.uuid,
      });
      await command(
        "/usr/bin/xcodebuild",
        [
          "-exportArchive",
          "-archivePath",
          archiveRoot,
          "-exportPath",
          exportPath,
          "-exportOptionsPlist",
          options,
        ],
        { timeout: 10 * 60_000 }
      );
      const entries = await readdir(exportPath);
      const ipaNames = entries.filter((name) => name.endsWith(".ipa"));
      if (ipaNames.length !== 1) throw new RunnerFailure("export_output");
      const ipa = path.join(exportPath, ipaNames[0]);
      const stat = await lstat(ipa);
      if (!stat.isFile() || stat.size > manifest.max_artifact_bytes)
        throw new RunnerFailure("output_archive");
      phase = "signature_verification";
      const signedExtract = path.join(work, "signed-ipa");
      await mkdir(signedExtract, { mode: 0o700 });
      await extractZip(ipa, signedExtract, {
        maxBytes: manifest.max_unpacked_bytes,
        allowedRoots: ["Payload", "SwiftSupport", "Symbols"],
        maxEntries: 100_000,
      });
      const payload = path.join(signedExtract, "Payload");
      const payloadEntries = await readdir(payload, { withFileTypes: true });
      const apps = payloadEntries.filter(
        (entry) => entry.isDirectory() && entry.name.endsWith(".app")
      );
      if (apps.length !== 1) throw new RunnerFailure("export_bundle");
      const signedApp = path.join(payload, apps[0].name);
      const signedInfo = await plist(path.join(signedApp, "Info.plist"), work);
      if (
        signedInfo.CFBundleIdentifier !== manifest.bundle_id ||
        signedInfo.CFBundleShortVersionString !== manifest.version
      )
        throw new RunnerFailure("signature_bundle");
      await command("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        signedApp,
      ]);
      const detail = await command("/usr/bin/codesign", ["-dv", "--verbose=4", signedApp]).catch(
        () => {
          throw new RunnerFailure("signature_verification");
        }
      );
      if (!codesignIdentityMatches(detail.stderr, manifest.team_id))
        throw new RunnerFailure("signature_identity");
      const embeddedProfile = await profilePlist(
        path.join(signedApp, "embedded.mobileprovision"),
        work
      );
      const signedProfileInfo = validateIosProfile(embeddedProfile, {
        teamId: manifest.team_id,
        bundleId: manifest.bundle_id,
        certificateSha1: profileCertificateSha,
      });
      if (
        signedProfileInfo.uuid !== profileInfo.uuid ||
        signedProfileInfo.expiration !== profileInfo.expiration
      )
        throw new RunnerFailure("signature_profile");
      const certDirectory = path.join(work, "signature-certs");
      await mkdir(certDirectory, { mode: 0o700 });
      await command("/usr/bin/codesign", ["-d", "--extract-certificates", signedApp], {
        cwd: certDirectory,
      });
      const leafSha1 = createHash("sha1")
        .update(await readFile(path.join(certDirectory, "codesign0")))
        .digest("hex")
        .toUpperCase();
      if (leafSha1 !== profileCertificateSha) throw new RunnerFailure("signature_identity");
      const entitlements = await signedEntitlements(signedApp, work);
      validateSignedEntitlements(entitlements, embeddedProfile, {
        teamId: manifest.team_id,
        bundleId: manifest.bundle_id,
      });
      await import("node:fs/promises").then((fs) =>
        fs.copyFile(ipa, path.join(outputDirectory, "signed.ipa"))
      );
      const report = iosVerificationSchema.parse({
        schema_version: 1,
        request_id: manifest.request_id,
        generation: manifest.generation,
        stage: "ios_sign",
        input_digest: manifest.input_digest,
        recipe_sha: manifest.recipe_sha,
        policy_digest: manifest.policy_digest,
        source_sha: manifest.source_sha,
        version: manifest.version,
        architecture: "arm64",
        team_id: manifest.team_id,
        bundle_id: manifest.bundle_id,
        codesign_verified: true,
        identity_class: "Apple Development",
        certificate_expiration: profileInfo.certificateExpiration,
        profile_uuid: profileInfo.uuid,
        profile_expiration: profileInfo.expiration,
        profile_type: "development",
        authorized_device_count: profileInfo.deviceCount,
        files: [
          {
            path: "signed.ipa",
            size: stat.size,
            sha256: await fileDigest(path.join(outputDirectory, "signed.ipa")),
          },
        ],
      });
      await writeFile(
        path.join(outputDirectory, "verification.json"),
        `${JSON.stringify(report)}\n`,
        { mode: 0o600, flag: "wx" }
      );
      return report;
    } finally {
      await rm(installedProfile, { force: true });
    }
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    throw error instanceof RunnerFailure
      ? safeIosFailure(phase, error.code)
      : new RunnerFailure("ios_sign_failed");
  } finally {
    try {
      if (keychain) {
        if (priorKeychains) {
          const keychains = [...priorKeychains.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
          await command("/usr/bin/security", [
            "list-keychains",
            "-d",
            "user",
            "-s",
            ...keychains,
          ]).catch(() => {});
        }
        await command("/usr/bin/security", ["delete-keychain", keychain]).catch(() => {
          throw safeIosFailure("cleanup", "keychain_cleanup");
        });
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}

export async function executeIos(...args) {
  try {
    return await runIos(...args);
  } catch (error) {
    if (
      error instanceof RunnerFailure &&
      /^iOS signing operation failed: ios_[a-z_]+$/.test(error.message) &&
      error.code.length <= 64
    )
      throw error;
    if (error instanceof RunnerFailure) throw safeIosFailure("input", error.code);
    throw new RunnerFailure("ios_sign_failed");
  }
}
export function iosArchivePathIsValid(name) {
  return safeZipName(name) && name.split("/")[0] === "unsigned.xcarchive";
}
