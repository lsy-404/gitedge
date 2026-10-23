import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, writeSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  credentialsSchema,
  iosCredentialsSchema,
  manifestSchema,
  verificationSchema,
  windowsCredentialsSchema,
} from "./contract.mjs";
import {
  parseSigningContext,
  readSigningContext,
  removeSigningContext,
  SigningContextError,
} from "./context.mjs";

export { readSigningContext } from "./context.mjs";

const execFileAsync = promisify(execFile);
const MAX_JSON_BYTES = 1_000_000;
const MAX_ARCHIVE_BYTES = 2_000_000_000;
const PART_BYTES = 8 * 1024 * 1024;
const MAX_PARTS = 10_000;
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [500, 1_000, 2_000, 4_000];
const REQUEST_TIMEOUT_MS = 300_000;
const MACOS_FAILURE_PHASES = new Set([
  "input_archive",
  "archive_validation",
  "source_binding",
  "static_verification",
  "credential_release",
  "keychain_import",
  "codesign",
  "codesign_identity",
  "codesign_chain",
  "codesign_acl",
  "codesign_resources",
  "codesign_unsigned_child",
  "codesign_timestamp",
  "signature_chain",
  "signature_team",
  "signature_timestamp",
  "codesign_options",
  "codesign_failed",
  "signature_verification",
  "notarization",
  "artifact_packaging",
  "stapling",
  "gatekeeper_verification",
  "keychain_cleanup",
]);
const DMG_FAILURE_PHASES = new Set([
  "input",
  "app-verification",
  "image-layout",
  "image-capacity",
  "image-copy",
  "credentials",
  "image-signing",
  "notarization-submit",
  "image-verification",
  "stapling",
  "image-staple-validation",
  "image-signature-verification",
  "image-gatekeeper",
  "image-mount",
  "app-staple-validation",
  "app-gatekeeper",
  "image-detach",
  "output",
]);
const WINDOWS_FAILURE_PHASES = new Set([
  "input_archive",
  "archive_validation",
  "static_verification",
  "authorization",
  "codesign",
  "packaging",
  "signature_verification",
]);
const WINDOWS_SIGNING_SCOPES = new Set(["app", "nsis", "squirrel"]);
const WINDOWS_SIGNING_MODES = new Set(["Inspect", "Sign", "SignFolder", "Verify"]);
const WINDOWS_SIGNING_DIAGNOSTICS = new Set([
  "ps_product_version_missing",
  "ps_authenticode_invalid",
  "ps_signer_missing",
  "ps_subject_unexpected",
  "ps_timestamp_missing",
  "ps_path_outside_root",
  "ps_inspection_outside_app",
  "ps_directory_outside_app",
  "ps_directory_missing",
  "ps_file_missing",
  "ps_file_type_unsupported",
  "ps_module_missing",
  "ps_command_missing",
  "ps_no_files_to_sign",
  "ps_dotnet8_missing",
  "nsis_configuration",
  "nsis_dependency_missing",
  "nsis_access_denied",
  "nsis_builder",
  "nsis_output_verify",
  "nsis_output_copy",
  "nsis_app_verify",
  "squirrel_vendor_prepare",
  "squirrel_vendor_sign",
  "squirrel_temp_validate",
  "squirrel_setup_verify",
  "squirrel_output_copy",
  "nsis_tool_makensis_failed",
  "nsis_tool_makensis_status_0x00000000",
  "nsis_tool_execution",
  "process_unavailable",
  "output_limit",
  "response_invalid",
  "powershell_failed",
]);
const SAFE_OUTPUTS = new Set([
  "signed.tar.gz",
  "product.zip",
  "signed.dmg",
  "product.dmg",
  "signed.ipa",
  "product.exe",
  "product-portable.exe",
  "RELEASES",
]);
const safeOutput = (name) =>
  SAFE_OUTPUTS.has(name) || /^[A-Za-z0-9][A-Za-z0-9_.-]*-full\.nupkg$/.test(name);

export class ClientError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const transientStatus = (status) => status >= 500 || status === 408 || status === 429;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requestPath = (context, suffix) =>
  `${context.baseUrl}/runner/signing/requests/${encodeURIComponent(context.requestId)}/${suffix}`;

async function readJson(response) {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_JSON_BYTES || !response.body) throw new ClientError("INVALID_RESPONSE");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_JSON_BYTES) throw new ClientError("INVALID_RESPONSE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))
    );
  } catch {
    throw new ClientError("INVALID_RESPONSE");
  }
}

async function apiFailure(response) {
  const detail = await readJson(response).catch(() => null);
  const code = detail?.error?.code ?? detail?.error ?? detail?.code;
  return new ClientError(
    typeof code === "string" && /^[a-z0-9_-]{1,64}$/i.test(code)
      ? `API_${code.toUpperCase()}`
      : "API_REQUEST_FAILED",
    response.status
  );
}

function resultPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ClientError("INVALID_RESPONSE");
  const result = value.data ?? value;
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new ClientError("INVALID_RESPONSE");
  return result;
}

function identityHeaders(context) {
  return {
    authorization: `Bearer ${context.jobToken}`,
    accept: "application/json",
    "x-runner-run-id": context.runId,
    "x-runner-lease-token": context.leaseToken,
  };
}

async function readAction(response, expectedStatus = 200) {
  if (response.status !== expectedStatus) throw await apiFailure(response);
  return resultPayload(await readJson(response));
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function requestJson(
  context,
  action,
  fields,
  {
    fetchImpl,
    method = "POST",
    expectedStatus = 200,
    sleep = defaultSleep,
    retry = false,
    signal,
  } = {}
) {
  const send = async () => {
    const response = await fetchImpl(requestPath(context, action), {
      method,
      redirect: "error",
      headers: { ...identityHeaders(context), "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(fields ?? {}),
      signal: requestSignal(signal),
    });
    return readAction(response, expectedStatus);
  };
  if (!retry) return send();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (error instanceof ClientError && (!error.status || !transientStatus(error.status)))
        throw error;
      if (attempt >= MAX_ATTEMPTS)
        throw error instanceof ClientError ? error : new ClientError("API_REQUEST_FAILED");
      await sleep(BACKOFF_MS[attempt - 1]);
    }
  }
}

export function createSigningClient({
  context,
  fetchImpl = fetch,
  sleep = defaultSleep,
  signal,
} = {}) {
  const identity = parseSigningContext(context);
  let currentLeaseExpiresAt = identity.leaseExpiresAt;
  const request = (action, fields, options) =>
    requestJson(identity, action, fields, { fetchImpl, sleep, signal, ...options });

  const start = async () => {
    const result = await request("start", {});
    const manifest = result.manifest ?? result.request?.manifest;
    if (!manifest) throw new ClientError("INVALID_RESPONSE");
    const parsed = manifestSchema.parse(manifest);
    if (parsed.request_id !== identity.requestId || parsed.generation !== identity.generation)
      throw new ClientError("INVALID_MANIFEST");
    if (
      (parsed.stage === "ios_sign"
        ? "ios"
        : parsed.stage === "windows_sign"
          ? "windows"
          : "macos") !== identity.platform
    )
      throw new ClientError("PLATFORM_MISMATCH");
    return { ...result, manifest: parsed };
  };

  const heartbeat = async () => {
    const result = await request("heartbeat", {}, { retry: true });
    if (!Number.isSafeInteger(result.leaseExpiresAt) || result.leaseExpiresAt <= Date.now())
      throw new ClientError("INVALID_RESPONSE");
    currentLeaseExpiresAt = Math.max(currentLeaseExpiresAt, result.leaseExpiresAt);
    return result;
  };
  const authorizeSign = async (operation) => {
    if (typeof operation !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(operation))
      throw new ClientError("INVALID_OPERATION");
    const authorization = await request("authorize-sign", { operation });
    const now = Date.now();
    if (
      !Number.isSafeInteger(authorization.expiresAt) ||
      authorization.expiresAt <= now ||
      !Number.isSafeInteger(authorization.leaseExpiresAt) ||
      authorization.leaseExpiresAt <= now ||
      authorization.expiresAt > authorization.leaseExpiresAt
    )
      throw new ClientError("INVALID_RESPONSE");
    currentLeaseExpiresAt = Math.max(currentLeaseExpiresAt, authorization.leaseExpiresAt);
    return authorization;
  };

  const download = async (object, destination, { digest, maxBytes }) => {
    if (object !== "input" && object !== "template") throw new ClientError("INVALID_INPUT");
    if (
      !/^sha256:[a-f0-9]{64}$/.test(digest ?? "") ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_ARCHIVE_BYTES
    )
      throw new ClientError("INVALID_DOWNLOAD_METADATA");
    const url = `${requestPath(identity, "download")}?object=${object}`;
    const file = await open(destination, "wx", 0o600);
    let hasher = createHash("sha256");
    let written = 0;
    let total = 0;
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const headers = { ...identityHeaders(identity), "x-signing-digest": digest };
          if (written) headers.range = `bytes=${written}-`;
          const response = await fetchImpl(url, {
            method: "GET",
            redirect: "error",
            headers,
            signal: requestSignal(signal),
          });
          if (!response.ok) {
            if (transientStatus(response.status)) throw new Error("transient");
            throw await apiFailure(response);
          }
          if (!response.body) throw new Error("transient");
          const reportedDigest = response.headers.get("x-signing-digest");
          if (reportedDigest && reportedDigest !== digest)
            throw new ClientError("DOWNLOAD_DIGEST_MISMATCH");
          const contentLength = Number(response.headers.get("content-length") ?? NaN);
          if (response.status === 206) {
            const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
              response.headers.get("content-range") ?? ""
            );
            if (!match || Number(match[1]) !== written || !written)
              throw new ClientError("DOWNLOAD_RANGE_INVALID");
            if (
              Number.isSafeInteger(contentLength) &&
              contentLength !== Number(match[2]) - Number(match[1]) + 1
            )
              throw new ClientError("DOWNLOAD_LENGTH_INVALID");
            total = Number(match[3]);
          } else if (response.status === 200) {
            if (!Number.isSafeInteger(contentLength))
              throw new ClientError("DOWNLOAD_LENGTH_INVALID");
            if (written) {
              await file.truncate(0);
              hasher = createHash("sha256");
              written = 0;
            }
            total = contentLength;
          } else throw new ClientError("DOWNLOAD_STATUS_INVALID");
          if (total < 1 || total > maxBytes) throw new ClientError("DOWNLOAD_TOO_LARGE");
          for await (const chunk of response.body) {
            if (written + chunk.length > total) throw new ClientError("DOWNLOAD_TOO_LARGE");
            await file.write(chunk, 0, chunk.length, written);
            hasher.update(chunk);
            written += chunk.length;
          }
          if (written !== total) throw new Error("transient");
          break;
        } catch (error) {
          if (error instanceof ClientError && (!error.status || !transientStatus(error.status)))
            throw error;
          if (attempt >= MAX_ATTEMPTS)
            throw error instanceof ClientError ? error : new ClientError("DOWNLOAD_FAILED");
          await sleep(BACKOFF_MS[attempt - 1]);
        }
      }
      if (`sha256:${hasher.digest("hex")}` !== digest)
        throw new ClientError("DOWNLOAD_DIGEST_MISMATCH");
      return { size: written };
    } catch (error) {
      await file.close();
      await rm(destination, { force: true });
      throw error instanceof ClientError ? error : new ClientError("DOWNLOAD_FAILED");
    } finally {
      await file.close().catch(() => {});
    }
  };

  const beginOutput = async (bundle) => {
    const result = await request(
      "output",
      { digest: bundle.digest, size: bundle.size },
      { retry: true }
    );
    const partSize = result.partSize ?? result.part_size;
    const partCount = result.partCount ?? result.part_count;
    const receivedParts = result.receivedParts ?? result.received_parts;
    if (
      partSize !== PART_BYTES ||
      !Number.isSafeInteger(partCount) ||
      partCount < 1 ||
      partCount > MAX_PARTS ||
      partCount !== Math.ceil(bundle.size / partSize) ||
      !Array.isArray(receivedParts) ||
      receivedParts.some((part) => !Number.isSafeInteger(part) || part < 1 || part > partCount)
    )
      throw new ClientError("INVALID_RESPONSE");
    return { partSize, partCount, receivedParts };
  };

  const uploadOutput = async (bundle) => {
    if (
      !/^sha256:[a-f0-9]{64}$/.test(bundle.digest) ||
      !Number.isSafeInteger(bundle.size) ||
      bundle.size < 1 ||
      bundle.size > MAX_ARCHIVE_BYTES
    )
      throw new ClientError("INVALID_OUTPUT");
    let session = await beginOutput(bundle);
    for (let part = 1; part <= session.partCount; part += 1) {
      if (session.receivedParts.includes(part)) continue;
      const start = (part - 1) * session.partSize;
      const end = Math.min(bundle.size, start + session.partSize) - 1;
      const partDigest = createHash("sha256");
      for await (const chunk of createReadStream(bundle.path, { start, end }))
        partDigest.update(chunk);
      const digestHeader = `sha256:${partDigest.digest("hex")}`;
      for (let attempt = 1; ; attempt += 1) {
        try {
          const response = await fetchImpl(`${requestPath(identity, `output/parts/${part}`)}`, {
            method: "PUT",
            redirect: "error",
            duplex: "half",
            signal: requestSignal(signal),
            headers: {
              ...identityHeaders(identity),
              "content-type": "application/octet-stream",
              "content-length": String(end - start + 1),
              "content-range": `bytes ${start}-${end}/${bundle.size}`,
              "x-part-digest": digestHeader,
            },
            body: createReadStream(bundle.path, { start, end }),
          });
          if (!response.ok) throw await apiFailure(response);
          await response.body?.cancel();
          break;
        } catch (error) {
          if (error instanceof ClientError && (!error.status || !transientStatus(error.status)))
            throw error;
          if (attempt >= MAX_ATTEMPTS)
            throw error instanceof ClientError ? error : new ClientError("UPLOAD_FAILED");
          await sleep(BACKOFF_MS[attempt - 1]);
          session = await beginOutput(bundle);
          if (session.receivedParts.includes(part)) break;
        }
      }
    }
    await request("output/complete", {}, { retry: true });
  };

  const complete = async (bundle, verificationReport) =>
    request(
      "complete",
      {
        digest: bundle.digest,
        size: bundle.size,
        verificationReport,
      },
      { expectedStatus: 202, retry: true }
    );

  return Object.freeze({
    start,
    heartbeat,
    download,
    authorizeSign,
    getLeaseExpiresAt: () => currentLeaseExpiresAt,
    beginOutput,
    uploadOutput,
    complete,
  });
}

async function bundleOutput(outputDir, verification, work, maxBytes) {
  const bundle = path.join(work, "output.zip");
  const payloads = verification.files.map((file) => path.join(outputDir, file.path));
  if (process.platform === "win32") {
    const { createWriteStream } = await import("node:fs");
    const { ZipArchive } = await import("archiver");
    await new Promise((resolve, reject) => {
      const target = createWriteStream(bundle, { flags: "wx" });
      const zip = new ZipArchive({ store: true });
      target.on("close", resolve);
      target.on("error", reject);
      zip.on("error", reject);
      zip.pipe(target);
      for (const file of [
        ...verification.files.map((entry) => path.join(outputDir, entry.path)),
        path.join(outputDir, "verification.json"),
      ])
        zip.file(file, { name: path.basename(file) });
      void zip.finalize().catch(reject);
    });
  } else {
    await execFileAsync("/usr/bin/zip", [
      "-q",
      "-X",
      "-j",
      "-0",
      bundle,
      ...payloads,
      path.join(outputDir, "verification.json"),
    ]);
  }
  const info = await stat(bundle);
  if (!info.isFile() || info.size < 1 || info.size > maxBytes)
    throw new ClientError("INVALID_OUTPUT");
  const hasher = createHash("sha256");
  for await (const chunk of createReadStream(bundle)) hasher.update(chunk);
  return { path: bundle, size: info.size, digest: `sha256:${hasher.digest("hex")}` };
}

function stageFamily(stage) {
  if (!["sign", "finalize", "dmg_sign", "dmg_finalize", "windows_sign", "ios_sign"].includes(stage))
    throw new ClientError("INVALID_MANIFEST");
  return {
    windows: stage === "windows_sign",
    ios: stage === "ios_sign",
    dmg: stage.startsWith("dmg_"),
  };
}

async function validateOutput(outputDir, manifest) {
  const entries = await readdir(outputDir, { withFileTypes: true });
  if (
    !entries.some((entry) => entry.name === "verification.json" && entry.isFile()) ||
    entries.some(
      (entry) => !entry.isFile() || (entry.name !== "verification.json" && !safeOutput(entry.name))
    )
  )
    throw new ClientError("INVALID_OUTPUT");
  const verification = verificationSchema.parse(
    JSON.parse(await readFile(path.join(outputDir, "verification.json"), "utf8"))
  );
  if (
    verification.request_id !== manifest.request_id ||
    verification.generation !== manifest.generation ||
    verification.stage !== manifest.stage ||
    verification.input_digest !== manifest.input_digest ||
    verification.recipe_sha !== manifest.recipe_sha ||
    verification.policy_digest !== manifest.policy_digest ||
    (manifest.stage === "windows_sign"
      ? verification.subject !== manifest.azure.subject
      : verification.team_id !== manifest.team_id)
  )
    throw new ClientError("INVALID_OUTPUT");
  if (
    stageFamily(manifest.stage).windows &&
    (verification.bundle_id !== manifest.bundle_id ||
      verification.version !== manifest.version ||
      verification.architecture !== manifest.architecture)
  )
    throw new ClientError("INVALID_OUTPUT");
  if (
    !stageFamily(manifest.stage).windows &&
    !stageFamily(manifest.stage).ios &&
    (verification.team_id !== manifest.team_id ||
      verification.bundle_id !== manifest.bundle_id ||
      verification.version !== manifest.version ||
      verification.architecture !== manifest.architecture ||
      ((manifest.stage === "finalize" || manifest.stage === "dmg_finalize") &&
        (verification.notarization_id !== manifest.notarization_id ||
          verification.notary_archive_sha256 !== manifest.notary_archive_sha256)))
  )
    throw new ClientError("INVALID_OUTPUT");
  const expectedOutput = {
    sign: "signed.tar.gz",
    finalize: "product.zip",
    dmg_sign: "signed.dmg",
    dmg_finalize: "product.dmg",
    ios_sign: "signed.ipa",
  }[manifest.stage];
  if (
    manifest.stage !== "windows_sign" &&
    (verification.files.length !== 1 || verification.files[0].path !== expectedOutput)
  )
    throw new ClientError("INVALID_OUTPUT");
  if (
    stageFamily(manifest.stage).ios &&
    (verification.bundle_id !== manifest.bundle_id ||
      verification.identity_class !== "Apple Development" ||
      verification.profile_type !== "development" ||
      verification.source_sha !== manifest.source_sha ||
      verification.version !== manifest.version ||
      verification.architecture !== manifest.architecture)
  )
    throw new ClientError("INVALID_OUTPUT");
  for (const item of verification.files) {
    if (!safeOutput(item.path) || !entries.some((entry) => entry.name === item.path))
      throw new ClientError("INVALID_OUTPUT");
    const info = await stat(path.join(outputDir, item.path));
    if (!info.isFile() || info.size !== item.size || info.size > manifest.max_artifact_bytes)
      throw new ClientError("INVALID_OUTPUT");
    const hasher = createHash("sha256");
    for await (const chunk of createReadStream(path.join(outputDir, item.path)))
      hasher.update(chunk);
    if (hasher.digest("hex") !== item.sha256) throw new ClientError("INVALID_OUTPUT");
  }
  return verification;
}

async function executePlatform(
  manifest,
  inputFile,
  outputDir,
  credentialsProvider,
  templateFile,
  signal
) {
  const family = stageFamily(manifest.stage);
  const credentials = manifest.stage.endsWith("finalize") ? undefined : credentialsProvider;
  if (family.windows) {
    if (process.platform !== "win32") throw new ClientError("NATIVE_HOST_REQUIRED");
    const executor = await import("./windows.mjs");
    executor.setSigningAbortSignal(signal);
    try {
      return await executor.executeWindows(manifest, inputFile, outputDir, credentials, signal);
    } finally {
      executor.setSigningAbortSignal(undefined);
    }
  }
  if (process.platform !== "darwin") throw new ClientError("NATIVE_HOST_REQUIRED");
  if (family.ios) {
    const executor = await import("./ios-sign.mjs");
    executor.setSigningAbortSignal(signal);
    try {
      return await executor.executeIos(manifest, inputFile, outputDir, credentials, signal);
    } finally {
      executor.setSigningAbortSignal(undefined);
    }
  }
  if (family.dmg) {
    const executor = await import("./dmg.mjs");
    const macos = await import("./macos-sign.mjs");
    macos.setSigningAbortSignal(signal);
    try {
      return await executor.executeDmg(
        manifest,
        inputFile,
        outputDir,
        credentials,
        templateFile,
        signal
      );
    } finally {
      macos.setSigningAbortSignal(undefined);
    }
  }
  const executor = await import("./macos-sign.mjs");
  executor.setSigningAbortSignal(signal);
  try {
    return await executor.executeMacos(manifest, inputFile, outputDir, credentials, signal);
  } finally {
    executor.setSigningAbortSignal(undefined);
  }
}

export async function runSigning({
  contextFile,
  outputParent,
  fetchImpl = fetch,
  sleep = defaultSleep,
  platformExecutor,
  bundleBuilder = bundleOutput,
  contextReader = readSigningContext,
  heartbeatIntervalMs = 30_000,
} = {}) {
  if (
    typeof contextFile !== "string" ||
    !path.isAbsolute(contextFile) ||
    typeof outputParent !== "string" ||
    !path.isAbsolute(outputParent)
  )
    throw new ClientError("INVALID_INPUT");
  let context;
  let timer;
  let heartbeatBusy = false;
  let heartbeatPromise;
  let heartbeatError;
  let work;
  const abortController = new AbortController();
  try {
    context = await contextReader(contextFile);
    const client = createSigningClient({
      context,
      fetchImpl,
      sleep,
      signal: abortController.signal,
    });
    await mkdir(outputParent, { recursive: true, mode: 0o700 });
    work = await mkdtemp(path.join(outputParent, "gitedge-signing-"));
    await chmod(work, 0o700);
    const outputDir = path.join(work, "output");
    await mkdir(outputDir, { mode: 0o700 });
    const started = await client.start();
    const manifest = started.manifest;
    const pulse = async () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      heartbeatPromise = client
        .heartbeat()
        .catch((error) => {
          if (!heartbeatError) {
            heartbeatError = error;
            abortController.abort(error);
          }
        })
        .finally(() => {
          heartbeatBusy = false;
        });
      await heartbeatPromise;
    };
    timer = setInterval(() => {
      void pulse();
    }, heartbeatIntervalMs);
    timer.unref?.();
    const inputFile = path.join(work, "input.zip");
    await client.download("input", inputFile, {
      digest: manifest.input_digest,
      maxBytes: manifest.max_artifact_bytes,
    });
    let templateFile;
    if (manifest.stage === "dmg_sign") {
      templateFile = path.join(work, "template.zip");
      await client.download("template", templateFile, {
        digest: manifest.template_digest,
        maxBytes: manifest.max_artifact_bytes,
      });
    }
    const family = stageFamily(manifest.stage);
    let credentialsProvided = false;
    const credentialsProvider = async () => {
      if (credentialsProvided) throw new ClientError("CREDENTIALS_ALREADY_REQUESTED");
      credentialsProvided = true;
      if (heartbeatError) throw new ClientError("HEARTBEAT_FAILED");
      const authorization = await client.authorizeSign(manifest.stage);
      if (family.windows) {
        return windowsCredentialsSchema.parse(authorization.credentials);
      }
      if (manifest.stage.endsWith("finalize")) {
        return;
      }
      return family.ios
        ? iosCredentialsSchema.parse(authorization.credentials)
        : credentialsSchema.parse(authorization.credentials);
    };
    if (manifest.stage.endsWith("finalize")) await credentialsProvider();
    if (heartbeatError) throw new ClientError("HEARTBEAT_FAILED");
    if (platformExecutor)
      await platformExecutor(
        manifest,
        inputFile,
        outputDir,
        manifest.stage.endsWith("finalize") ? undefined : credentialsProvider,
        templateFile,
        abortController.signal
      );
    else
      await executePlatform(
        manifest,
        inputFile,
        outputDir,
        credentialsProvider,
        templateFile,
        abortController.signal
      );
    if (heartbeatError) throw new ClientError("HEARTBEAT_FAILED");
    const verification = await validateOutput(outputDir, manifest);
    const bundle = await bundleBuilder(outputDir, verification, work, manifest.max_artifact_bytes);
    await client.uploadOutput(bundle);
    if (heartbeatError) throw new ClientError("HEARTBEAT_FAILED");
    await client.complete(bundle, verification);
    return { requestId: context.requestId, outputDigest: bundle.digest, outputSize: bundle.size };
  } catch (error) {
    if (heartbeatError) throw new ClientError("HEARTBEAT_FAILED");
    if (error instanceof ClientError || error instanceof SigningContextError) throw error;
    const failure = new ClientError("SIGNING_FAILED");
    failure.cause = error;
    throw failure;
  } finally {
    if (timer) clearInterval(timer);
    if (heartbeatBusy && heartbeatPromise) await heartbeatPromise;
    if (work) await rm(work, { recursive: true, force: true });
    await removeSigningContext(contextFile).catch(() => {});
  }
}

export function formatClientErrorOutput(error) {
  const contextCode =
    error instanceof SigningContextError &&
    ["INSECURE_CONTEXT_FILE", "INVALID_CONTEXT", "INVALID_CONTEXT_FILE"].includes(error.code)
      ? error.code
      : undefined;
  const code = error instanceof ClientError ? error.code : contextCode ?? "SIGNING_FAILED";
  const lines = [code];
  const causeDescriptor =
    error instanceof ClientError ? Object.getOwnPropertyDescriptor(error, "cause") : undefined;
  const cause =
    error instanceof ClientError
      ? causeDescriptor?.value
      : error instanceof Error && !(error instanceof SigningContextError)
        ? error
        : undefined;
  if (cause instanceof Error) {
    const messageDescriptor = Object.getOwnPropertyDescriptor(cause, "message");
    const message = typeof messageDescriptor?.value === "string" ? messageDescriptor.value : "";
    const diagnostic = safeSigningDiagnostic(message);
    if (diagnostic) lines.push(`diagnostic: ${diagnostic}`);
    else lines.push(`cause: ${safeErrorClass(cause)}`);
  }
  return `${lines.join("\n")}\n`;
}

function safeSigningDiagnostic(message) {
  const macos = /^macOS signing operation failed: ([a-z_]+)$/.exec(message);
  if (macos && MACOS_FAILURE_PHASES.has(macos[1])) return `macos:${macos[1]}`;

  const dmg = /^disk image operation failed: ([a-z0-9_-]+)$/.exec(message);
  if (dmg) {
    if (DMG_FAILURE_PHASES.has(dmg[1])) return `dmg:${dmg[1]}`;
    if (/^stapling_(?:command_failed|exit_(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-5]))$/.test(dmg[1]))
      return `dmg:${dmg[1]}`;
  }

  const windows = /^Windows signing operation failed: ([a-z_]+)(?: \[([^\]\r\n]{0,160})\])?$/.exec(
    message
  );
  if (windows && WINDOWS_FAILURE_PHASES.has(windows[1])) {
    const detail = safeWindowsDiagnostic(windows[2]);
    return `windows:${windows[1]}${detail ? `:${detail}` : ""}`;
  }
  return undefined;
}

function safeWindowsDiagnostic(value) {
  if (typeof value !== "string") return undefined;
  const parts = value.split(":");
  if (parts.length !== 3) return undefined;
  const [scope, mode, diagnostic] = parts;
  if (!WINDOWS_SIGNING_SCOPES.has(scope) || !WINDOWS_SIGNING_MODES.has(mode)) return undefined;
  if (WINDOWS_SIGNING_DIAGNOSTICS.has(diagnostic)) return diagnostic;
  if (/^aadsts_\d{5,9}$/.test(diagnostic)) return diagnostic;
  if (/^hresult_0x[0-9a-f]{8}$/.test(diagnostic)) return diagnostic;
  if (/^http_status_[45]\d{2}$/.test(diagnostic)) return diagnostic;
  if (
    /^(?:signtool|signcli|powershell)_exit_(?:0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/.test(diagnostic)
  )
    return diagnostic;
  if (
    /^nsis_tool_(?:makensis|7z|rcedit|signtool)_(?:exit_(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])|status_0x[0-9a-f]{8})$/.test(
      diagnostic
    )
  )
    return diagnostic;
  return undefined;
}

function safeErrorClass(error) {
  if (error instanceof AggregateError) return "AggregateError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof URIError) return "URIError";
  if (error instanceof ReferenceError) return "ReferenceError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof EvalError) return "EvalError";
  return "Error";
}

export async function main(args = process.argv.slice(2)) {
  try {
    const [command, contextFlag, contextFile, outputFlag, outputParent, receiptFlag, receiptFile] =
      args;
    if (
      command !== "execute" ||
      contextFlag !== "--context-file" ||
      outputFlag !== "--output-parent" ||
      receiptFlag !== "--receipt-file" ||
      typeof receiptFile !== "string" ||
      !path.isAbsolute(receiptFile)
    )
      throw new ClientError("INVALID_COMMAND");
    const result = await runSigning({ contextFile, outputParent });
    await writeFile(receiptFile, JSON.stringify(result), { flag: "wx", mode: 0o600 });
  } catch (error) {
    writeSync(2, formatClientErrorOutput(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
  if (process.exitCode === 1) process.exit(1);
}
