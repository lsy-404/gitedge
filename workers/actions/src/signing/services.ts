import { SigningProfileSchema, type SigningMachineContext, type SigningProfile, type SigningSubmission } from "../../../../packages/contracts/src/signing";
import type { TrustedUser } from "../../../../packages/contracts/src/index";
import { trustedHeaders } from "../../../../packages/contracts/src/index";
import { parseDocument } from "yaml";
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
    if (!profile.enabled || (await digest(new TextEncoder().encode(JSON.stringify(immutable)))).slice(7, 47) !== revision) return null;
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
  const parsed = SigningProfileSchema.omit({ revision: true }).parse(raw);
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
  const profile = SigningProfileSchema.parse({ ...parsed, revision: "0".repeat(40) });
  const { revision: _revision, ...immutable } = profile;
  const revision = (await digest(new TextEncoder().encode(JSON.stringify(immutable)))).slice(7, 47);
  const approved = SigningProfileSchema.parse({ ...parsed, revision });
  await env.DB.prepare(`INSERT INTO actions_signing_profiles(owner_id,repository_id,name,revision,profile_json,approved_by,approved_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,repository_id,name,revision) DO UPDATE SET profile_json=excluded.profile_json,approved_by=excluded.approved_by,approved_at=excluded.approved_at,revoked_at=NULL`)
    .bind(user.id, repositoryId, approved.name, approved.revision, JSON.stringify(approved), user.id, Date.now()).run();
  return approved;
}

async function grantCredentials(env: SigningEnv, context: SigningMachineContext, profile: SigningProfile) {
  if (profile.platform === "windows") {
    const identityMode = (profile.policy as Record<string, unknown>).windowsIdentity;
    if (identityMode !== "azure-managed-identity" && identityMode !== "azure-workload-identity") return null;
    return { credentials: { identityMode }, expiresAt: Math.min(context.leaseExpiresAt, Date.now() + 5 * 60_000) };
  }
  const row = await env.DB.prepare(`SELECT ciphertext FROM actions_signing_credentials WHERE owner_id=? AND repository_id=? AND profile_revision=? AND platform=?`)
    .bind(context.ownerId, context.repositoryId, profile.revision, profile.platform).first<{ ciphertext: string }>();
  if (!row) return null;
  try {
    const [ivText, cipherText, extra] = row.ciphertext.split("."); if (!ivText || !cipherText || extra) return null;
    const iv = Uint8Array.from(atob(ivText), c => c.charCodeAt(0));
    const cipher = Uint8Array.from(atob(cipherText), c => c.charCodeAt(0));
    const aad = new TextEncoder().encode(`${context.ownerId}:${context.repositoryId}:${profile.revision}:${profile.platform}`);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, await credentialKey(env.SIGNING_ENCRYPTION_KEY), cipher);
    const credentials = credentialSchema(profile.platform)(JSON.parse(new TextDecoder().decode(plaintext)));
    const expiry = Math.min(context.leaseExpiresAt, Date.now() + 5 * 60_000);
    return { credentials: credentials as Record<string, unknown>, expiresAt: expiry };
  } catch { return null; }
}

function verifyOutput(profile: SigningProfile, platform: string, sourceDigest: string, outputDigest: string, outputSize: number, report: unknown): boolean {
  if (profile.platform !== platform || !report || typeof report !== "object" || outputSize < 1 || !sha.test(profile.workflowOid)) return false;
  const value = report as Record<string, unknown>;
  const policy = profile.policy as Record<string, unknown>;
  if (value.schema_version !== 1 || value.input_digest !== sourceDigest || value.recipe_sha !== profile.workflowOid || value.source_digest !== sourceDigest
    || value.output_digest !== outputDigest || value.output_size !== outputSize || value.platform !== platform || value.workflow_oid !== profile.workflowOid) return false;
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.some(file => !file || typeof file !== "object" || typeof (file as Record<string, unknown>).path !== "string")) return false;
  if (platform === "windows") return value.authenticode_verified === true && value.timestamp_verified === true && value.nested_signatures_verified === true
    && value.subject === policy.subject;
  if (platform === "ios") return value.signature_verified === true && value.profile_valid === true && value.team_id === policy.teamId
    && typeof value.certificate_expiration === "string" && Date.parse(value.certificate_expiration) > Date.now();
  return value.codesign_verified === true && value.timestamp_verified === true && value.notarization_status === "Accepted"
    && value.gatekeeper_verified === true && value.staple_verified === true && typeof value.notarization_id === "string"
    && typeof value.notary_archive_sha256 === "string" && value.notary_archive_sha256 === policy.notaryArchiveSha256;
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
    verifyOutput: ({ profile, platform, sourceDigest, outputDigest, outputSize, report }) => Promise.resolve(verifyOutput(profile, platform, sourceDigest, outputDigest, outputSize, report)),
  };
}
