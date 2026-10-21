import { SigningProfileSchema, type SigningMachineContext, type SigningProfile, type SigningSubmission } from "../../../../packages/contracts/src/signing";
import type { TrustedUser } from "../../../../packages/contracts/src/index";
import { trustedHeaders } from "../../../../packages/contracts/src/index";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { SigningEnv, SigningExecutionHooks } from "./types";

const sha = /^[a-f0-9]{40}$/;
const digest = (bytes: Uint8Array) => crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer).then(value => `sha256:${Array.from(new Uint8Array(value), b => b.toString(16).padStart(2,"0")).join("")}`);

async function readProfile(env: SigningEnv, ownerId: string, repositoryId: string, name: string): Promise<SigningProfile | null> {
  const row = await env.DB.prepare(`SELECT profile_json,approved_by,approved_at FROM actions_signing_profiles WHERE owner_id=? AND repository_id=? AND name=? AND revoked_at IS NULL`)
    .bind(ownerId, repositoryId, name).first<{ profile_json: string; approved_by: string; approved_at: number }>();
  if (!row || row.approved_by !== ownerId || !Number.isSafeInteger(row.approved_at)) return null;
  try {
    const profile = SigningProfileSchema.parse(JSON.parse(row.profile_json));
    const { revision, ...immutable } = profile;
    if (!profile.enabled || await digest(new TextEncoder().encode(JSON.stringify(profile.policy))) !== profile.policyDigest
      || (await digest(new TextEncoder().encode(JSON.stringify(immutable)))).slice(7, 47) !== revision) return null;
    return profile;
  } catch { return null; }
}

async function githubJson(env: SigningEnv, path: string): Promise<Record<string, unknown> | null> {
  if (!env.SIGNING_GITHUB_TOKEN) return null;
  const response = await fetch(`https://api.github.com${path}`, { headers: {
    Authorization: `Bearer ${env.SIGNING_GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "gitedge-actions-signing",
  }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) { await response.body?.cancel(); return null; }
  return await response.json() as Record<string, unknown>;
}

async function verifySource(env: SigningEnv, input: SigningSubmission, profile: SigningProfile): Promise<{ body: ReadableStream<Uint8Array> } | null> {
  if (!env.SIGNING_GITHUB_TOKEN) return null;
  const policy = profile?.policy as Record<string, unknown> | undefined;
  const repos = Array.isArray(policy?.sourceRepositories) ? policy.sourceRepositories : [];
  const repo = repos.find((item): item is { id: string; fullName: string; workflowPath: string; artifactName: string; actorIds: number[]; events: string[]; refs: string[] } =>
    !!item && typeof item === "object" && (item as { id?: unknown }).id === input.sourceRepositoryId) as { id: string; fullName: string; workflowPath: string; artifactName: string; actorIds: number[]; events: string[]; refs: string[] } | undefined;
  if (!repo || !/^[1-9]\d*$/.test(repo.id) || !/^[\w.-]+\/[\w.-]+$/.test(repo.fullName)
    || !Array.isArray(repo.actorIds) || !Array.isArray(repo.events) || !Array.isArray(repo.refs)) return null;
  const run = await githubJson(env, `/repos/${repo.fullName}/actions/runs/${encodeURIComponent(input.sourceRunId)}`);
  const runRepository = run?.repository as Record<string, unknown> | undefined;
  if (!run || String(runRepository?.id) !== repo.id || run.head_sha !== input.sourceCommitOid || run.status !== "completed" || run.conclusion !== "success"
    || String(run.path).split("@")[0] !== repo.workflowPath || !repo.events.includes(String(run.event)) || !repo.refs.includes(String(run.head_branch))
    || !repo.actorIds.includes(Number((run.actor as Record<string, unknown> | undefined)?.id))) return null;
  const artifact = await githubJson(env, `/repos/${repo.fullName}/actions/artifacts/${encodeURIComponent(input.sourceArtifactId)}`);
  const workflow = artifact?.workflow_run as Record<string, unknown> | undefined;
  if (!artifact || artifact.name !== repo.artifactName || artifact.expired !== false || String(workflow?.id) !== input.sourceRunId
    || String(artifact.size_in_bytes) !== String(input.sourceSize) || String(workflow?.head_sha) !== input.sourceCommitOid) return null;
  const url = `https://api.github.com/repos/${repo.fullName}/actions/artifacts/${encodeURIComponent(input.sourceArtifactId)}/zip`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${env.SIGNING_GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "gitedge-actions-signing" }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  if (response.status !== 302) { await response.body?.cancel(); return null; }
  const location = response.headers.get("Location");
  if (!location) return null;
  const target = new URL(location);
  if (target.protocol !== "https:" || target.port || target.username || target.password
    || !(/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(target.hostname)
      || target.hostname === "pipelines.actions.githubusercontent.com" || target.hostname === "results-receiver.actions.githubusercontent.com")) return null;
  const download = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  return download.ok && download.body ? { body: download.body } : null;
}

function keyBytes(secret: string): Uint8Array<ArrayBuffer> {
  const value = Uint8Array.from(atob(secret.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  if (value.length !== 32) throw new Error("signing_encryption_key_invalid");
  return value;
}
async function credentialKey(secret: string) { return crypto.subtle.importKey("raw", keyBytes(secret), "AES-GCM", false, ["encrypt", "decrypt"]); }
function credentialSchema(platform: string) {
  // Validation is intentionally delegated to strict platform-specific shapes at installation time.
  return platform === "ios"
    ? (value: unknown) => { if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "certificate_password,certificate_p12,provisioning_profile") throw new Error(); return value; }
    : (value: unknown) => { if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "certificate_password,certificate_p12,notarization") throw new Error(); return value; };
}

export async function installSigningCredentials(env: SigningEnv, ownerId: string, repositoryId: string, profileName: string, platform: string, value: unknown): Promise<void> {
  const profile = await readProfile(env, ownerId, repositoryId, profileName);
  if (!profile || profile.platform !== platform) throw new Error("signing_profile_not_approved");
  const safeValue = credentialSchema(platform)(value);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`${ownerId}:${repositoryId}:${profile.revision}:${platform}`);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, await credentialKey(env.SIGNING_ENCRYPTION_KEY), new TextEncoder().encode(JSON.stringify(safeValue)));
  const envelope = `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(ciphertext)))}`;
  await env.DB.prepare(`INSERT INTO actions_signing_credentials(owner_id,repository_id,profile_revision,platform,ciphertext,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,repository_id,profile_revision,platform) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`)
    .bind(ownerId, repositoryId, profile.revision, platform, envelope, Date.now()).run();
}

export async function saveApprovedProfile(env: SigningEnv, user: TrustedUser, repositoryId: string, name: string): Promise<SigningProfile> {
  if (!user.recentAuthAt || user.recentAuthAt > Date.now() || Date.now() - user.recentAuthAt > 10 * 60_000) throw new Error("recent_auth_required");
  const { SigningProfileSchema } = await import("../../../../packages/contracts/src/signing");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error("signing_profile_name_invalid");
  const fileUrl = new URL(`/repositories/${encodeURIComponent(repositoryId)}/file`, "https://forge.internal");
  fileUrl.searchParams.set("ref", "main");
  fileUrl.searchParams.set("path", `.gitedge/signing/${name}.yml`);
  const fileResponse = await env.FORGE.fetch(new Request(fileUrl, { headers: trustedHeaders(user) }));
  if (!fileResponse.ok) { await fileResponse.body?.cancel(); throw new Error("signing_profile_file_unavailable"); }
  const fileValue = await fileResponse.json() as { data?: { content?: unknown; oid?: unknown; path?: unknown } };
  const content = fileValue.data?.content;
  if (typeof content !== "string" || content.length > 100_000 || fileValue.data?.path !== `.gitedge/signing/${name}.yml`) throw new Error("signing_profile_file_invalid");
  const document = parseDocument(content, { schema: "core", uniqueKeys: true, strict: true });
  if (document.errors.length) throw new Error("signing_profile_file_invalid");
  const raw = document.toJS();
  const parsed = SigningProfileSchema.omit({ revision: true, policyDigest: true }).parse(raw);
  const stage = parsed.policy.stage;
  if (parsed.platform === "macos" && !["sign","finalize","dmg_sign","dmg_finalize"].includes(String(stage))
    || parsed.platform === "windows" && stage !== "windows_sign" || parsed.platform === "ios" && stage !== "ios_sign")
    throw new Error("signing_profile_stage_mismatch");
  if (parsed.name !== name) throw new Error("signing_profile_name_mismatch");
  if (parsed.platform === "windows" && !["azure-managed-identity", "azure-workload-identity"].includes(String(parsed.policy.windowsIdentity)))
    throw new Error("signing_windows_identity_required");
  const repository = await env.DB.prepare(`SELECT r.id,n.created_by FROM repositories r JOIN namespaces n ON n.id=r.namespace_id WHERE r.id=? AND r.system_kind='account_runner' AND r.visibility='private' AND r.created_by=? AND n.kind='personal' AND n.created_by=? AND r.archived=0 AND r.deleted_at IS NULL`)
    .bind(repositoryId, user.id, user.id).first<{ id: string; created_by: string }>();
  if (!repository || !env.SIGNING_GITHUB_TOKEN) throw new Error("signing_runner_or_github_unavailable");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.workflowSource)) throw new Error("signing_workflow_source_invalid");
  const target = await fetch(`https://api.github.com/repos/${parsed.workflowSource}/contents/${parsed.workflowPath}?ref=${parsed.workflowOid}`, { headers: { Authorization: `Bearer ${env.SIGNING_GITHUB_TOKEN}`, Accept:"application/vnd.github+json", "User-Agent":"gitedge-actions-signing" }, redirect:"error", signal:AbortSignal.timeout(15_000) });
  if (!target.ok) throw new Error("signing_workflow_not_found");
  const file = await target.json() as { sha?: string; path?: string; encoding?: string; content?: string };
  if (file.path !== parsed.workflowPath || !file.sha || !/^[a-f0-9]{40}$/.test(parsed.workflowOid)) throw new Error("signing_workflow_invalid");
  const policyDigest = await digest(new TextEncoder().encode(JSON.stringify(parsed.policy)));
  const profile = SigningProfileSchema.parse({ ...parsed, policyDigest, revision: "0".repeat(40) });
  const { revision: _revision, ...immutable } = profile;
  const revision = (await digest(new TextEncoder().encode(JSON.stringify(immutable)))).slice(7, 47);
  const approved = SigningProfileSchema.parse({ ...parsed, revision });
  const approvedAt = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE actions_signing_profiles SET revoked_at=? WHERE owner_id=? AND repository_id=? AND name=? AND revoked_at IS NULL`)
      .bind(approvedAt, user.id, repositoryId, approved.name),
    env.DB.prepare(`INSERT INTO actions_signing_profiles(owner_id,repository_id,name,revision,profile_json,approved_by,approved_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,repository_id,name,revision) DO UPDATE SET profile_json=excluded.profile_json,approved_by=excluded.approved_by,approved_at=excluded.approved_at,revoked_at=NULL`)
      .bind(user.id, repositoryId, approved.name, approved.revision, JSON.stringify(approved), user.id, approvedAt),
  ]);
  return approved;
}

async function grantCredentials(env: SigningEnv, context: SigningMachineContext, profile: SigningProfile) {
  if (profile.platform === "macos" && (context.stage === "finalize" || context.stage === "dmg_finalize"))
    return { credentials: {}, expiresAt: Math.min(context.leaseExpiresAt, Date.now() + 5 * 60_000) };
  if (profile.platform === "windows") {
    const identityMode = (profile.policy as Record<string, unknown>).windowsIdentity;
    if (identityMode !== "azure-managed-identity" && identityMode !== "azure-workload-identity") return null;
    return { credentials: { identityMode }, expiresAt: Math.min(context.leaseExpiresAt, Date.now() + 5 * 60_000) };
  }
  const credentials = await storedCredentials(env, context, profile);
  return credentials ? { credentials, expiresAt: Math.min(context.leaseExpiresAt, Date.now() + 5 * 60_000) } : null;
}

async function storedCredentials(env: SigningEnv, context: SigningMachineContext, profile: SigningProfile): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(`SELECT ciphertext FROM actions_signing_credentials WHERE owner_id=? AND repository_id=? AND profile_revision=? AND platform=?`)
    .bind(context.ownerId, context.repositoryId, profile.revision, profile.platform).first<{ ciphertext: string }>();
  if (!row) return null;
  try {
    const [ivText, cipherText, extra] = row.ciphertext.split("."); if (!ivText || !cipherText || extra) return null;
    const iv = Uint8Array.from(atob(ivText), c => c.charCodeAt(0));
    const cipher = Uint8Array.from(atob(cipherText), c => c.charCodeAt(0));
    const aad = new TextEncoder().encode(`${context.ownerId}:${context.repositoryId}:${profile.revision}:${profile.platform}`);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, await credentialKey(env.SIGNING_ENCRYPTION_KEY), cipher);
    return credentialSchema(profile.platform)(JSON.parse(new TextDecoder().decode(plaintext))) as Record<string, unknown>;
  } catch { return null; }
}

function b64url(value: Uint8Array): string {
  let binary = ""; for (let i = 0; i < value.length; i += 0x8000) binary += String.fromCharCode(...value.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("notary_service_unavailable"); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > limit) throw new Error("notary_response_too_large"); chunks.push(next.value); } }
  finally { await reader.cancel(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
async function appleNotarizationStatus(credentials: Record<string, unknown>, id: string, expectedSha: string): Promise<string> {
  const value = credentials.notarization as { key_id?: string; issuer_id?: string; private_key?: string } | undefined;
  if (!value || typeof value.key_id !== "string" || typeof value.issuer_id !== "string" || typeof value.private_key !== "string") throw new Error("notary_credentials_missing");
  const pem = value.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const pkcs8 = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: value.key_id, typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ iss: value.issuer_id, aud: "appstoreconnect-v1", iat: now, exp: now + 300 })));
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput)));
  const token = `${signingInput}.${b64url(signature)}`;
  const getJson = async (suffix = "") => {
    const response = await fetch(`https://appstoreconnect.apple.com/notary/v2/submissions/${encodeURIComponent(id)}${suffix}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
    return boundedJson(response, suffix ? 2_097_152 : 262_144);
  };
  const status = z.object({ data: z.object({ id: z.uuid(), attributes: z.object({ status: z.enum(["Accepted", "Invalid", "Rejected", "In Progress"]) }) }) }).parse(await getJson());
  if (status.data.id.toLowerCase() !== id.toLowerCase()) throw new Error("notary_id_mismatch");
  if (["In Progress", "Invalid", "Rejected"].includes(status.data.attributes.status)) return status.data.attributes.status;
  const logs = z.object({ data: z.object({ attributes: z.object({ developerLogUrl: z.url() }) }) }).parse(await getJson("/logs"));
  const logUrl = new URL(logs.data.attributes.developerLogUrl);
  if (logUrl.protocol !== "https:" || logUrl.port || logUrl.username || logUrl.password
    || !/(?:^|\.)(?:apple\.com|amazonaws\.com)$/.test(logUrl.hostname)) throw new Error("notary_log_url_invalid");
  const logResponse = await fetch(logUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const log = z.object({ jobId: z.uuid().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).passthrough().parse(await boundedJson(logResponse, 2_097_152));
  if (log.jobId && log.jobId.toLowerCase() !== id.toLowerCase() || log.sha256?.toLowerCase() !== expectedSha.toLowerCase()) throw new Error("notary_log_mismatch");
  return status.data.attributes.status;
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const archiveDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const fileReportSchema = z.object({ path: z.string().min(1).max(512), size: z.number().int().positive(), sha256: digestSchema }).strict();
const macReportSchema = z.object({ schema_version:z.literal(1),request_id:z.uuid(),generation:z.number().int().positive(),
  stage:z.enum(["sign","finalize","dmg_sign","dmg_finalize"]),input_digest:archiveDigestSchema,recipe_sha:z.string().regex(/^[a-f0-9]{40}$/),
  policy_digest:archiveDigestSchema,team_id:z.string().regex(/^[A-Z0-9]{10}$/),bundle_id:z.string().min(1).max(255),version:z.string().min(1).max(64),
  architecture:z.enum(["arm64","x64","universal"]),codesign_verified:z.literal(true),timestamp_verified:z.literal(true),asar_integrity_verified:z.boolean(),
  notarization_id:z.uuid(),notarization_status:z.enum(["Submitted","Accepted"]),notary_archive_sha256:digestSchema,
  gatekeeper_verified:z.boolean(),staple_verified:z.boolean(),files:z.array(fileReportSchema).length(1) }).strict();
const windowsReportSchema = z.object({ schema_version:z.literal(1),request_id:z.uuid(),generation:z.number().int().positive(),stage:z.literal("windows_sign"),
  input_digest:archiveDigestSchema,recipe_sha:z.string().regex(/^[a-f0-9]{40}$/),policy_digest:archiveDigestSchema,bundle_id:z.string(),version:z.string(),
  architecture:z.enum(["x64","arm64"]),subject:z.string(),authenticode_verified:z.literal(true),timestamp_verified:z.literal(true),nested_signatures_verified:z.literal(true),
  files:z.array(fileReportSchema).min(1).max(4) }).strict();
const iosReportSchema = z.object({ schema_version:z.literal(1),request_id:z.uuid(),generation:z.number().int().positive(),stage:z.literal("ios_sign"),
  input_digest:archiveDigestSchema,recipe_sha:z.string().regex(/^[a-f0-9]{40}$/),policy_digest:archiveDigestSchema,source_sha:z.string().regex(/^[a-f0-9]{40}$/),
  version:z.string(),architecture:z.literal("arm64"),team_id:z.string().regex(/^[A-Z0-9]{10}$/),bundle_id:z.string(),codesign_verified:z.literal(true),
  identity_class:z.literal("Apple Development"),certificate_expiration:z.string().datetime({offset:true}),profile_uuid:z.uuid(),profile_expiration:z.string().datetime({offset:true}),
  profile_type:z.literal("development"),authorized_device_count:z.number().int().positive(),files:z.array(fileReportSchema.extend({path:z.literal("signed.ipa")})).length(1) }).strict();

async function verifyOutput(env: SigningEnv, context: SigningMachineContext, profile: SigningProfile, platform: string, sourceDigest: string, sourceCommitOid: string, version: string, outputDigest: string, outputSize: number, raw: unknown): Promise<boolean> {
  if (profile.platform !== platform || outputSize < 1 || !sha.test(profile.workflowOid) || !archiveDigestSchema.safeParse(outputDigest).success) return false;
  const policy = profile.policy as Record<string, unknown>;
  const project = policy.project as Record<string, unknown> | undefined;
  const recipe = project?.[platform === "macos" ? "macos" : platform] as Record<string, unknown> | undefined;
  if (!project || !recipe) return false;
  const expectedDigest = archiveDigestSchema.safeParse(sourceDigest);
  if (!expectedDigest.success) return false;
  if (platform === "windows") {
    const parsed = windowsReportSchema.safeParse(raw); if (!parsed.success) return false;
    const report = parsed.data; const azure = policy.azure as Record<string, unknown> | undefined;
    const expectedFiles = recipe.installer === "squirrel" ? ["product.exe","RELEASES"] : recipe.portable ? ["product.exe","product-portable.exe"] : ["product.exe"];
    return report.request_id === context.requestId && report.generation === context.generation && report.input_digest === sourceDigest
      && report.recipe_sha === profile.workflowOid && report.policy_digest === profile.policyDigest && report.bundle_id === recipe.bundle_id
      && report.version === version && report.architecture === recipe.architecture && report.subject === azure?.subject
      && expectedFiles.every(path => report.files.some(file => file.path === path));
  }
  if (platform === "ios") {
    const parsed = iosReportSchema.safeParse(raw); if (!parsed.success) return false;
    const report = parsed.data;
    return report.request_id === context.requestId && report.generation === context.generation && report.input_digest === sourceDigest
      && report.recipe_sha === profile.workflowOid && report.policy_digest === profile.policyDigest && report.source_sha === sourceCommitOid
      && report.bundle_id === recipe.bundle_id && report.version === version && report.team_id === policy.teamId && Date.parse(report.certificate_expiration) > Date.now()
      && Date.parse(report.profile_expiration) > Date.now();
  }
  const parsed = macReportSchema.safeParse(raw); if (!parsed.success) return false;
  const report = parsed.data;
  const finalStage = report.stage === "finalize" || report.stage === "dmg_finalize";
  const expectedPath = ({ sign: "signed.tar.gz", finalize: "product.zip", dmg_sign: "signed.dmg", dmg_finalize: "product.dmg" } as const)[report.stage];
  const filesValid = report.files[0]?.path === expectedPath && report.files[0].size <= Number(project.max_artifact_bytes);
  if (!filesValid) return false;
  if (finalStage) {
    const credentials = await storedCredentials(env, context, profile);
    if (!credentials || await appleNotarizationStatus(credentials, report.notarization_id, report.notary_archive_sha256) !== "Accepted") return false;
  }
  return report.request_id === context.requestId && report.generation === context.generation && report.stage === context.stage
    && report.input_digest === sourceDigest && report.recipe_sha === profile.workflowOid && report.policy_digest === profile.policyDigest
    && report.version === version && report.team_id === policy.teamId && report.bundle_id === recipe.bundle_id && report.architecture === recipe.architecture
    && report.files[0]?.path === ({ sign: "signed.tar.gz", finalize: "product.zip", dmg_sign: "signed.dmg", dmg_finalize: "product.dmg" } as const)[report.stage]
    && (recipe.profile !== "electron" || report.asar_integrity_verified)
    && (finalStage ? report.notarization_status === "Accepted" && report.gatekeeper_verified && report.staple_verified
      : report.notarization_status === "Submitted" && !report.gatekeeper_verified && !report.staple_verified);
}

export function createSigningExecutionHooks(env: SigningEnv, deps: Pick<SigningExecutionHooks, "enqueue" | "verifySigningHost">): SigningExecutionHooks {
  return {
    ...deps,
    loadApprovedProfile: (user, repositoryId, name) => readProfile(env, user.id, repositoryId, name),
    verifySource: async (user, submission) => {
      const repositoryId = await env.DB.prepare(`SELECT id FROM repositories WHERE system_kind='account_runner' AND created_by=? AND id IN (SELECT repository_id FROM actions_signing_profiles WHERE owner_id=? AND name=? AND revoked_at IS NULL) LIMIT 1`)
        .bind(user.id, user.id, submission.profile).first<{ id: string }>();
      if (!repositoryId) return null;
      const profile = await readProfile(env, user.id, repositoryId.id, submission.profile);
      return profile ? verifySource(env, submission, profile) : null;
    },
    authorizeCredentials: (context, profile) => grantCredentials(env, context, profile),
    verifyOutput: ({ context, profile, platform, sourceDigest, sourceCommitOid, version, outputDigest, outputSize, report }) => verifyOutput(env, context, profile, platform, sourceDigest, sourceCommitOid, version, outputDigest, outputSize, report),
  };
}
