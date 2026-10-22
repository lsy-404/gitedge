import { GitFileSchema } from "../../../../packages/contracts/src/forge";
import {
  SigningPolicySchema,
  SigningProfileSchema,
  SigningProfileMetadataSchema,
  SigningCredentialStatusSchema,
  SigningSourceCredentialSchema,
  SigningCredentialPlatformSchema,
  type SigningMachineContext,
  type SigningPlatform,
  type SigningProfile,
  type SigningSubmission,
  type SigningCredentialPlatform,
} from "../../../../packages/contracts/src/signing";
import {
  archiveDigest,
  credentialsSchema as macosCredentialsSchema,
  windowsCredentialsSchema,
  iosCredentialsSchema,
  macosVerificationSchema,
  windowsVerificationSchema,
  iosVerificationSchema,
} from "../../../../packages/contracts/signing-native.mjs";
import type { TrustedUser } from "../../../../packages/contracts/src/index";
import { trustedHeaders } from "../../../../packages/contracts/src/index";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { SigningEnv, SigningExecutionHooks } from "./types";
import { parseRunnerWorkflow } from "../runner-workflow";
import { readJsonLimited } from "../../../../src/worker/common/readText";
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
} from "../../../../src/worker/common/encoding";
import { createRemoteJWKSet, jwtVerify } from "jose";

const sha = /^[a-f0-9]{40}$/;
const githubOidcIssuer = "https://token.actions.githubusercontent.com";
const githubOidcKeys = createRemoteJWKSet(new URL(`${githubOidcIssuer}/.well-known/jwks`), {
  timeoutDuration: 5000,
});
const digest = (bytes: Uint8Array) =>
  crypto.subtle
    .digest("SHA-256", new Uint8Array(bytes).buffer)
    .then(
      (value) =>
        `sha256:${Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("")}`
    );

async function readProfile(
  env: SigningEnv,
  ownerId: string,
  repositoryId: string,
  name: string
): Promise<SigningProfile | null> {
  const row = await env.DB.prepare(
    `SELECT profile_json,approved_by,approved_at FROM actions_signing_profiles WHERE owner_id=? AND repository_id=? AND name=? AND revoked_at IS NULL`
  )
    .bind(ownerId, repositoryId, name)
    .first<{ profile_json: string; approved_by: string; approved_at: number }>();
  if (!row || row.approved_by !== ownerId || !Number.isSafeInteger(row.approved_at)) return null;
  try {
    const profile = SigningProfileSchema.parse(JSON.parse(row.profile_json));
    const { revision, ...immutable } = profile;
    if (
      !profile.enabled ||
      (await digest(new TextEncoder().encode(JSON.stringify(profile.policy)))) !==
        profile.policyDigest ||
      (await digest(new TextEncoder().encode(JSON.stringify(immutable)))).slice(7, 47) !== revision
    )
      return null;
    return profile;
  } catch {
    return null;
  }
}

async function githubJson(token: string, path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gitedge-actions-signing",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  return readJsonLimited(response, 1_048_576);
}

const githubRunSchema = z
  .object({
    repository: z.object({ id: z.number().int().positive() }).passthrough(),
    head_sha: z.string().regex(/^[a-f0-9]{40}$/),
    status: z.enum(["queued", "in_progress", "completed"]),
    conclusion: z.string().nullable(),
    path: z.string(),
    event: z.string(),
    head_branch: z.string(),
    actor: z.object({ id: z.number().int().positive() }).passthrough(),
  })
  .passthrough();

const githubArtifactSchema = z
  .object({
    name: z.string(),
    expired: z.boolean(),
    size_in_bytes: z.number().int().positive(),
    workflow_run: z
      .object({ id: z.number().int().positive(), head_sha: z.string().regex(/^[a-f0-9]{40}$/) })
      .passthrough(),
  })
  .passthrough();

const githubRunIdentitySchema = z.object({
  repository_id: z.string(),
  run_id: z.string(),
  run_attempt: z.string(),
  actor_id: z.string(),
  ref: z.string(),
  event_name: z.string(),
  workflow_ref: z.string(),
  workflow_sha: z.string(),
});

async function verifyGitHubRunIdentity(
  token: string,
  audience: string,
  repo: SigningProfile["policy"]["sourceRepositories"][number],
  input: SigningSubmission,
  actorId: number,
  ref: string,
  eventName: string
): Promise<boolean> {
  try {
    const verified = await jwtVerify(token, githubOidcKeys, {
      issuer: githubOidcIssuer,
      audience,
      algorithms: ["RS256"],
      clockTolerance: 30,
    });
    const claims = githubRunIdentitySchema.parse(verified.payload);
    const workflowRef = `${repo.fullName}/${repo.workflowPath}@${ref}`;
    return (
      claims.repository_id === repo.id &&
      claims.run_id === input.sourceRunId &&
      claims.run_attempt === "1" &&
      claims.actor_id === String(actorId) &&
      claims.ref === ref &&
      claims.event_name === eventName &&
      claims.workflow_sha === input.sourceCommitOid &&
      claims.workflow_ref.toLowerCase() === workflowRef.toLowerCase()
    );
  } catch {
    return false;
  }
}

async function githubTagCommit(
  token: string,
  fullName: string,
  tag: string
): Promise<string | null> {
  const objectSchema = z.object({ type: z.enum(["commit", "tag"]), sha: z.string().regex(sha) });
  const reference = z.object({ object: objectSchema }).passthrough();
  const initial = reference.safeParse(
    await githubJson(token, `/repos/${fullName}/git/ref/tags/${encodeURIComponent(tag)}`)
  );
  if (!initial.success) return null;
  let object = initial.data.object;
  for (let depth = 0; object.type === "tag" && depth < 4; depth++) {
    const annotated = z
      .object({ object: objectSchema })
      .passthrough()
      .safeParse(await githubJson(token, `/repos/${fullName}/git/tags/${object.sha}`));
    if (!annotated.success) return null;
    object = annotated.data.object;
  }
  return object.type === "commit" ? object.sha : null;
}

async function githubCommitOnDefaultBranch(
  token: string,
  fullName: string,
  defaultBranch: string,
  shaValue: string
): Promise<boolean> {
  const comparison = z
    .object({
      status: z.enum(["ahead", "behind", "identical", "diverged"]),
      ahead_by: z.number().int().nonnegative(),
    })
    .passthrough()
    .safeParse(
      await githubJson(
        token,
        `/repos/${fullName}/compare/${encodeURIComponent(defaultBranch)}...${shaValue}`
      )
    );
  return (
    comparison.success &&
    (comparison.data.status === "identical" ||
      (comparison.data.status === "behind" && comparison.data.ahead_by === 0))
  );
}

async function verifySource(
  env: SigningEnv,
  ownerId: string,
  repositoryId: string,
  input: SigningSubmission,
  profile: SigningProfile,
  runIdentity: string | null = null,
  audience = ""
): Promise<{ body: ReadableStream<Uint8Array> } | null> {
  const token = await storedSourceCredential(env, ownerId, repositoryId, profile.revision);
  if (!token) return null;
  const repo = profile.policy.sourceRepositories.find(
    (item) => item.id === input.sourceRepositoryId
  );
  if (
    !repo ||
    !/^[1-9]\d*$/.test(repo.id) ||
    !/^[\w.-]+\/[\w.-]+$/.test(repo.fullName) ||
    !Array.isArray(repo.actorIds) ||
    !Array.isArray(repo.events) ||
    !Array.isArray(repo.refs)
  )
    return null;
  if (!/^[1-9]\d*$/.test(input.sourceRunId) || !/^[1-9]\d*$/.test(input.sourceArtifactId))
    return null;
  const run = githubRunSchema.safeParse(
    await githubJson(
      token,
      `/repos/${repo.fullName}/actions/runs/${encodeURIComponent(input.sourceRunId)}`
    )
  );
  if (
    !run.success ||
    String(run.data.repository.id) !== repo.id ||
    run.data.head_sha !== input.sourceCommitOid ||
    !(
      run.data.status === "in_progress" ||
      (run.data.status === "completed" && run.data.conclusion === "success")
    ) ||
    run.data.path.split("@")[0] !== repo.workflowPath ||
    !repo.actorIds.includes(run.data.actor.id)
  )
    return null;
  const repositoryInfo = z
    .object({ default_branch: z.string().min(1).max(256) })
    .passthrough()
    .safeParse(await githubJson(token, `/repos/${repo.fullName}`));
  if (!repositoryInfo.success) return null;
  const defaultBranch = repositoryInfo.data.default_branch;
  if (repo.releaseTagPattern) {
    const tag = `v${input.version}`;
    if (
      run.data.event !== "push" ||
      run.data.head_branch !== tag ||
      !new RegExp(repo.releaseTagPattern).test(tag) ||
      !repo.events.includes("push") ||
      run.data.status !== "in_progress" ||
      !runIdentity ||
      runIdentity.length > 16_384 ||
      !(await verifyGitHubRunIdentity(
        runIdentity,
        audience,
        repo,
        input,
        run.data.actor.id,
        `refs/tags/${tag}`,
        "push"
      ))
    )
      return null;
    const tagCommit = await githubTagCommit(token, repo.fullName, tag);
    if (
      tagCommit !== run.data.head_sha ||
      !(await githubCommitOnDefaultBranch(token, repo.fullName, defaultBranch, run.data.head_sha))
    )
      return null;
  } else {
    if (
      run.data.head_branch !== defaultBranch ||
      !repo.events.includes(run.data.event) ||
      !repo.refs.includes(run.data.head_branch)
    )
      return null;
    if (
      run.data.status === "in_progress" &&
      (!runIdentity ||
        runIdentity.length > 16_384 ||
        !(await verifyGitHubRunIdentity(
          runIdentity,
          audience,
          repo,
          input,
          run.data.actor.id,
          `refs/heads/${defaultBranch}`,
          run.data.event
        )))
    )
      return null;
  }
  const artifact = githubArtifactSchema.safeParse(
    await githubJson(
      token,
      `/repos/${repo.fullName}/actions/artifacts/${encodeURIComponent(input.sourceArtifactId)}`
    )
  );
  if (
    !artifact.success ||
    artifact.data.name !== repo.artifactName ||
    artifact.data.expired !== false ||
    String(artifact.data.workflow_run.id) !== input.sourceRunId ||
    artifact.data.size_in_bytes !== input.sourceSize ||
    artifact.data.workflow_run.head_sha !== input.sourceCommitOid
  )
    return null;
  const url = `https://api.github.com/repos/${repo.fullName}/actions/artifacts/${encodeURIComponent(input.sourceArtifactId)}/zip`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "gitedge-actions-signing",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 302) {
    await response.body?.cancel();
    return null;
  }
  const location = response.headers.get("Location");
  if (!location) {
    await response.body?.cancel();
    return null;
  }
  const target = new URL(location);
  if (
    target.protocol !== "https:" ||
    target.port ||
    target.username ||
    target.password ||
    !(
      /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(target.hostname) ||
      target.hostname === "pipelines.actions.githubusercontent.com" ||
      target.hostname === "results-receiver.actions.githubusercontent.com"
    )
  ) {
    await response.body?.cancel();
    return null;
  }
  await response.body?.cancel();
  const download = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!download.ok || !download.body) {
    await download.body?.cancel();
    return null;
  }
  return { body: download.body };
}

async function verifySourceCurrent(
  env: SigningEnv,
  ownerId: string,
  repositoryId: string,
  input: SigningSubmission,
  profile: SigningProfile
): Promise<boolean> {
  const token = await storedSourceCredential(env, ownerId, repositoryId, profile.revision);
  const repo = profile.policy.sourceRepositories.find(
    (item) => item.id === input.sourceRepositoryId
  );
  if (!token || !repo) return false;
  const run = githubRunSchema.safeParse(
    await githubJson(
      token,
      `/repos/${repo.fullName}/actions/runs/${encodeURIComponent(input.sourceRunId)}`
    )
  );
  if (
    !run.success ||
    String(run.data.repository.id) !== repo.id ||
    run.data.head_sha !== input.sourceCommitOid ||
    !(
      run.data.status === "in_progress" ||
      (run.data.status === "completed" && run.data.conclusion === "success")
    ) ||
    run.data.path.split("@")[0] !== repo.workflowPath ||
    !repo.actorIds.includes(run.data.actor.id)
  )
    return false;
  const repositoryInfo = z
    .object({ default_branch: z.string().min(1).max(256) })
    .passthrough()
    .safeParse(await githubJson(token, `/repos/${repo.fullName}`));
  if (!repositoryInfo.success) return false;
  if (repo.releaseTagPattern) {
    const tag = `v${input.version}`;
    if (
      run.data.head_branch !== tag ||
      run.data.event !== "push" ||
      !new RegExp(repo.releaseTagPattern).test(tag) ||
      !repo.events.includes("push")
    )
      return false;
    return (
      (await githubTagCommit(token, repo.fullName, tag)) === run.data.head_sha &&
      (await githubCommitOnDefaultBranch(
        token,
        repo.fullName,
        repositoryInfo.data.default_branch,
        run.data.head_sha
      ))
    );
  }
  return (
    run.data.head_branch === repositoryInfo.data.default_branch &&
    repo.events.includes(run.data.event) &&
    repo.refs.includes(run.data.head_branch)
  );
}

async function storedSourceCredential(
  env: SigningEnv,
  ownerId: string,
  repositoryId: string,
  revision: string
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT ciphertext FROM actions_signing_source_credentials WHERE owner_id=? AND repository_id=? AND profile_revision=?`
  )
    .bind(ownerId, repositoryId, revision)
    .first<{ ciphertext: string }>();
  if (!row) return null;
  try {
    const [ivText, cipherText, extra] = row.ciphertext.split(".");
    if (!ivText || !cipherText || extra) return null;
    const iv = base64ToBytes(ivText);
    const cipher = base64ToBytes(cipherText);
    const aad = new TextEncoder().encode(`${ownerId}:${repositoryId}:${revision}:github-source`);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      await credentialKey(env.SIGNING_ENCRYPTION_KEY),
      cipher
    );
    return SigningSourceCredentialSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)))
      .token;
  } catch {
    return null;
  }
}

function keyBytes(secret: string): Uint8Array<ArrayBuffer> {
  const value = base64UrlToBytes(secret);
  if (value.length !== 32) throw new Error("signing_encryption_key_invalid");
  return value;
}
async function credentialKey(secret: string) {
  return crypto.subtle.importKey("raw", keyBytes(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}
function credentialSchema(platform: string): (value: unknown) => Record<string, unknown> {
  if (platform === "ios")
    return (value) => {
      const parsed = iosCredentialsSchema.parse(value);
      return {
        certificate_p12: parsed.certificate_p12,
        certificate_password: parsed.certificate_password,
        provisioning_profile: parsed.provisioning_profile,
      };
    };
  if (platform === "macos")
    return (value) => {
      const parsed = macosCredentialsSchema.parse(value);
      return {
        certificate_p12: parsed.certificate_p12,
        certificate_password: parsed.certificate_password,
        notarization: parsed.notarization,
      };
    };
  return (value) => windowsCredentialsSchema.parse(value);
}

export async function installSigningCredentials(
  env: SigningEnv,
  ownerId: string,
  repositoryId: string,
  profileName: string,
  platform: string,
  value: unknown
): Promise<void> {
  const profile = await readProfile(env, ownerId, repositoryId, profileName);
  if (!profile) throw new Error("signing_profile_not_approved");
  if (platform === "github-source") {
    const sourceToken = SigningSourceCredentialSchema.parse(value).token;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(
      `${ownerId}:${repositoryId}:${profile.revision}:github-source`
    );
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      await credentialKey(env.SIGNING_ENCRYPTION_KEY),
      new TextEncoder().encode(JSON.stringify({ token: sourceToken }))
    );
    const envelope = `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
    await env.DB.prepare(
      `INSERT INTO actions_signing_source_credentials(owner_id,repository_id,profile_revision,ciphertext,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,repository_id,profile_revision) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`
    )
      .bind(ownerId, repositoryId, profile.revision, envelope, Date.now())
      .run();
    return;
  }
  if (profile.platform !== platform) throw new Error("signing_profile_not_approved");
  const safeValue = credentialSchema(platform)(value);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(
    `${ownerId}:${repositoryId}:${profile.revision}:${platform}`
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    await credentialKey(env.SIGNING_ENCRYPTION_KEY),
    new TextEncoder().encode(JSON.stringify(safeValue))
  );
  const envelope = `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
  await env.DB.prepare(
    `INSERT INTO actions_signing_credentials(owner_id,repository_id,profile_revision,platform,ciphertext,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,repository_id,profile_revision,platform) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`
  )
    .bind(ownerId, repositoryId, profile.revision, platform, envelope, Date.now())
    .run();
}

export async function importLegacySigningCredentials(
  env: SigningEnv,
  ownerId: string,
  repositoryId: string,
  profileName: string,
  kind: SigningCredentialPlatform
): Promise<void> {
  if (!env.LEGACY_SIGNING) throw new Error("legacy_credential_import_unavailable");
  const status = await signingCredentialStatus(env, ownerId, repositoryId, profileName, kind);
  if (!status || (kind !== "github-source" && status.platform !== kind))
    throw new Error("signing_profile_not_approved");

  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    false,
    ["encrypt", "decrypt"]
  );
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const recipientPublicKey = bytesToBase64(publicKey);
  const envelope = await env.LEGACY_SIGNING.exportCredential(kind, recipientPublicKey);
  const maxCiphertext = kind === "ios" ? 500_000 : kind === "macos" ? 32_768 : 4096;
  if (
    envelope.version !== 1 ||
    envelope.kind !== kind ||
    envelope.wrappedKey.length > 1024 ||
    envelope.iv.length > 64 ||
    envelope.ciphertext.length > maxCiphertext
  )
    throw new Error("legacy_credential_envelope_invalid");

  const rawKey = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      keyPair.privateKey,
      base64ToBytes(envelope.wrappedKey)
    )
  );
  if (rawKey.length !== 32) throw new Error("legacy_credential_envelope_invalid");
  const contentKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  rawKey.fill(0);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(envelope.iv),
      additionalData: new TextEncoder().encode(`gitedge-credential-migration:v1:${kind}`),
    },
    contentKey,
    base64ToBytes(envelope.ciphertext)
  );
  await installSigningCredentials(
    env,
    ownerId,
    repositoryId,
    profileName,
    kind,
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext))
  );
}

export async function removeSigningCredentials(
  env: SigningEnv,
  ownerId: string,
  repositoryId: string,
  profileName: string,
  platform: string
): Promise<void> {
  const profile = await readProfile(env, ownerId, repositoryId, profileName);
  if (!profile) throw new Error("signing_profile_not_approved");
  if (platform === "github-source") {
    await env.DB.prepare(
      `DELETE FROM actions_signing_source_credentials WHERE owner_id=? AND repository_id=? AND profile_revision=?`
    )
      .bind(ownerId, repositoryId, profile.revision)
      .run();
    return;
  }
  if (profile.platform !== platform) throw new Error("signing_profile_not_approved");
  await env.DB.prepare(
    `DELETE FROM actions_signing_credentials WHERE owner_id=? AND repository_id=? AND profile_revision=? AND platform=?`
  )
    .bind(ownerId, repositoryId, profile.revision, platform)
    .run();
}

export async function listApprovedProfiles(env: SigningEnv, ownerId: string, repositoryId: string) {
  const result = await env.DB.prepare(
    `SELECT profile_json,approved_at FROM actions_signing_profiles WHERE owner_id=? AND repository_id=? AND revoked_at IS NULL ORDER BY name`
  )
    .bind(ownerId, repositoryId)
    .all<{ profile_json: string; approved_at: number }>();
  return (result.results ?? []).flatMap((row) => {
    try {
      const profile = SigningProfileSchema.parse(JSON.parse(row.profile_json));
      return [
        SigningProfileMetadataSchema.parse({
          name: profile.name,
          revision: profile.revision,
          platform: profile.platform,
          workflowOid: profile.workflowOid,
          workflowPath: profile.workflowPath,
          enabled: profile.enabled,
          approvedAt: row.approved_at,
        }),
      ];
    } catch {
      return [];
    }
  });
}

export async function signingCredentialStatus(
  env: SigningEnv,
  ownerId: string,
  repositoryId: string,
  profileName: string,
  kind?: SigningCredentialPlatform
) {
  const profile = await readProfile(env, ownerId, repositoryId, profileName);
  if (!profile) return null;
  const platform = SigningCredentialPlatformSchema.parse(kind ?? profile.platform);
  if (platform === "github-source") {
    const source = await env.DB.prepare(
      `SELECT updated_at FROM actions_signing_source_credentials WHERE owner_id=? AND repository_id=? AND profile_revision=?`
    )
      .bind(ownerId, repositoryId, profile.revision)
      .first<{ updated_at: number }>();
    return SigningCredentialStatusSchema.parse({
      name: profile.name,
      revision: profile.revision,
      platform,
      configured: Boolean(source),
      updatedAt: source?.updated_at ?? null,
    });
  }
  if (platform !== profile.platform) return null;
  const row = await env.DB.prepare(
    `SELECT updated_at FROM actions_signing_credentials WHERE owner_id=? AND repository_id=? AND profile_revision=? AND platform=?`
  )
    .bind(ownerId, repositoryId, profile.revision, platform)
    .first<{ updated_at: number }>();
  return SigningCredentialStatusSchema.parse({
    name: profile.name,
    revision: profile.revision,
    platform,
    configured: Boolean(row),
    updatedAt: row?.updated_at ?? null,
  });
}

export async function saveApprovedProfile(
  env: SigningEnv,
  user: TrustedUser,
  repositoryId: string,
  name: string
): Promise<SigningProfile & { approvedAt: number }> {
  if (
    !user.recentAuthAt ||
    user.recentAuthAt > Date.now() ||
    Date.now() - user.recentAuthAt > 10 * 60_000
  )
    throw new Error("recent_auth_required");
  const { SigningProfileSchema } = await import("../../../../packages/contracts/src/signing");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error("signing_profile_name_invalid");
  const fileUrl = new URL(
    `/repositories/${encodeURIComponent(repositoryId)}/file`,
    "https://git.internal"
  );
  fileUrl.searchParams.set("ref", "main");
  fileUrl.searchParams.set("path", `.gitedge/signing/${name}.yml`);
  const fileResponse = await env.GIT.fetch(new Request(fileUrl, { headers: trustedHeaders(user) }));
  if (!fileResponse.ok) {
    await fileResponse.body?.cancel();
    throw new Error("signing_profile_file_unavailable");
  }
  const fileValue = z
    .object({ data: GitFileSchema })
    .strict()
    .parse(await readJsonLimited(fileResponse, 150_000));
  const content = fileValue.data.content;
  if (
    fileValue.data.binary ||
    typeof content !== "string" ||
    content.length > 100_000 ||
    fileValue.data.path !== `.gitedge/signing/${name}.yml`
  )
    throw new Error("signing_profile_file_invalid");
  const document = parseDocument(content, { schema: "core", uniqueKeys: true, strict: true });
  if (document.errors.length) throw new Error("signing_profile_file_invalid");
  const raw = document.toJS();
  const profileFileSchema = SigningProfileSchema.omit({
    revision: true,
    policyDigest: true,
    workflowSource: true,
  }).extend({ workflowSource: z.string().max(65_536).optional() });
  const parsedFile = profileFileSchema.parse(raw);
  const parsed = { ...parsedFile, workflowSource: "" };
  const policy = SigningPolicySchema.parse(parsed.policy);
  const stage = policy.stage;
  if (
    (parsed.platform === "macos" && stage !== "sign") ||
    (parsed.platform === "windows" && stage !== "windows_sign") ||
    (parsed.platform === "ios" && stage !== "ios_sign")
  )
    throw new Error("signing_profile_stage_mismatch");
  if (parsed.name !== name) throw new Error("signing_profile_name_mismatch");
  const repository = await env.DB.prepare(
    `SELECT r.id,n.created_by FROM repositories r JOIN namespaces n ON n.id=r.namespace_id WHERE r.id=? AND r.system_kind='account_runner' AND r.visibility='private' AND r.created_by=? AND n.kind='personal' AND n.created_by=? AND r.archived=0 AND r.deleted_at IS NULL`
  )
    .bind(repositoryId, user.id, user.id)
    .first<{ id: string; created_by: string }>();
  if (!repository) throw new Error("signing_runner_unavailable");
  if (!/^[a-f0-9]{40}$/.test(parsed.workflowOid)) throw new Error("signing_workflow_invalid");
  const workflowUrl = new URL(
    `/repositories/${encodeURIComponent(repositoryId)}/file`,
    "https://git.internal"
  );
  workflowUrl.searchParams.set("ref", parsed.workflowOid);
  workflowUrl.searchParams.set("path", parsed.workflowPath);
  const workflowResponse = await env.GIT.fetch(
    new Request(workflowUrl, { headers: trustedHeaders(user) })
  );
  if (!workflowResponse.ok) {
    await workflowResponse.body?.cancel();
    throw new Error("signing_workflow_not_found");
  }
  const workflowFile = z
    .object({ data: GitFileSchema })
    .strict()
    .parse(await readJsonLimited(workflowResponse, 100_000));
  const workflowSource = workflowFile.data.content;
  if (
    workflowFile.data.binary ||
    workflowFile.data.path !== parsed.workflowPath ||
    typeof workflowSource !== "string" ||
    workflowSource.length > 65_536
  )
    throw new Error("signing_workflow_invalid");
  parseRunnerWorkflow(parsed.workflowPath, workflowSource);
  const policyDigest = await digest(new TextEncoder().encode(JSON.stringify(parsed.policy)));
  const profile = SigningProfileSchema.parse({
    ...parsed,
    workflowSource,
    policyDigest,
    revision: "0".repeat(40),
  });
  const { revision: _revision, ...immutable } = profile;
  const revision = (await digest(new TextEncoder().encode(JSON.stringify(immutable)))).slice(7, 47);
  const approved = SigningProfileSchema.parse({
    ...parsed,
    workflowSource,
    policyDigest,
    revision,
  });
  const approvedAt = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM actions_signing_credentials WHERE owner_id=? AND repository_id=? AND profile_revision IN
      (SELECT revision FROM actions_signing_profiles WHERE owner_id=? AND repository_id=? AND name=? AND revoked_at IS NULL AND revision<>?)`
    ).bind(user.id, repositoryId, user.id, repositoryId, approved.name, approved.revision),
    env.DB.prepare(
      `DELETE FROM actions_signing_source_credentials WHERE owner_id=? AND repository_id=? AND profile_revision IN
      (SELECT revision FROM actions_signing_profiles WHERE owner_id=? AND repository_id=? AND name=? AND revoked_at IS NULL AND revision<>?)`
    ).bind(user.id, repositoryId, user.id, repositoryId, approved.name, approved.revision),
    env.DB.prepare(
      `UPDATE actions_signing_profiles SET revoked_at=? WHERE owner_id=? AND repository_id=? AND name=? AND revoked_at IS NULL`
    ).bind(approvedAt, user.id, repositoryId, approved.name),
    env.DB.prepare(
      `INSERT INTO actions_signing_profiles(owner_id,repository_id,name,revision,profile_json,approved_by,approved_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,repository_id,name,revision) DO UPDATE SET profile_json=excluded.profile_json,approved_by=excluded.approved_by,approved_at=excluded.approved_at,revoked_at=NULL`
    ).bind(
      user.id,
      repositoryId,
      approved.name,
      approved.revision,
      JSON.stringify(approved),
      user.id,
      approvedAt
    ),
  ]);
  return { ...approved, approvedAt };
}

async function grantCredentials(
  env: SigningEnv,
  context: SigningMachineContext,
  profile: SigningProfile
) {
  if (
    profile.platform === "macos" &&
    (context.stage === "finalize" || context.stage === "dmg_finalize")
  )
    return {
      credentials: {},
      expiresAt: Math.min(context.leaseExpiresAt, Date.now() + 5 * 60_000),
    };
  const credentials = await storedCredentials(env, context, profile);
  return credentials
    ? { credentials, expiresAt: Math.min(context.leaseExpiresAt, Date.now() + 5 * 60_000) }
    : null;
}

async function storedCredentials(
  env: SigningEnv,
  context: SigningMachineContext,
  profile: SigningProfile
): Promise<Record<string, unknown> | null> {
  return storedPlatformCredentials(
    env,
    context.ownerId,
    context.repositoryId,
    profile.revision,
    profile.platform
  );
}

async function storedPlatformCredentials(
  env: SigningEnv,
  ownerId: string,
  repositoryId: string,
  revision: string,
  platform: SigningPlatform
): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    `SELECT ciphertext FROM actions_signing_credentials WHERE owner_id=? AND repository_id=? AND profile_revision=? AND platform=?`
  )
    .bind(ownerId, repositoryId, revision, platform)
    .first<{ ciphertext: string }>();
  if (!row) return null;
  try {
    const [ivText, cipherText, extra] = row.ciphertext.split(".");
    if (!ivText || !cipherText || extra) return null;
    const iv = base64ToBytes(ivText);
    const cipher = base64ToBytes(cipherText);
    const aad = new TextEncoder().encode(`${ownerId}:${repositoryId}:${revision}:${platform}`);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      await credentialKey(env.SIGNING_ENCRYPTION_KEY),
      cipher
    );
    return credentialSchema(platform)(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    return null;
  }
}

async function verifyNotarization(
  env: SigningEnv,
  ownerId: string,
  repositoryId: string,
  profile: SigningProfile,
  raw: unknown
): Promise<"Accepted" | "In Progress" | "Invalid" | "Rejected"> {
  if (profile.platform !== "macos") return "Rejected";
  const report = macosVerificationSchema.parse(raw);
  if (report.stage !== "sign" && report.stage !== "dmg_sign") return "Rejected";
  const credentials = await storedPlatformCredentials(
    env,
    ownerId,
    repositoryId,
    profile.revision,
    "macos"
  );
  if (!credentials) return "Rejected";
  return appleNotarizationStatus(credentials, report.notarization_id, report.notary_archive_sha256);
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("notary_service_unavailable");
  }
  const value = await readJsonLimited(response, limit);
  if (value === null) throw new Error("notary_response_invalid");
  return value;
}
async function appleNotarizationStatus(
  credentials: Record<string, unknown>,
  id: string,
  expectedSha: string
): Promise<"Accepted" | "In Progress" | "Invalid" | "Rejected"> {
  const value = macosCredentialsSchema.parse(credentials).notarization;
  const pem = value.private_key.replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
    ""
  );
  const pkcs8 = base64ToBytes(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const header = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: value.key_id, typ: "JWT" }))
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ iss: value.issuer_id, aud: "appstoreconnect-v1", iat: now, exp: now + 300 })
    )
  );
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput)
    )
  );
  const token = `${signingInput}.${bytesToBase64Url(signature)}`;
  const getJson = async (suffix = "") => {
    const response = await fetch(
      `https://appstoreconnect.apple.com/notary/v2/submissions/${encodeURIComponent(id)}${suffix}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      }
    );
    return boundedJson(response, suffix ? 2_097_152 : 262_144);
  };
  const status = z
    .object({
      data: z.object({
        id: z.uuid(),
        attributes: z.object({
          status: z.enum(["Accepted", "Invalid", "Rejected", "In Progress"]),
        }),
      }),
    })
    .parse(await getJson());
  if (status.data.id.toLowerCase() !== id.toLowerCase()) throw new Error("notary_id_mismatch");
  if (["In Progress", "Invalid", "Rejected"].includes(status.data.attributes.status))
    return status.data.attributes.status;
  const logs = z
    .object({ data: z.object({ attributes: z.object({ developerLogUrl: z.url() }) }) })
    .parse(await getJson("/logs"));
  const logUrl = new URL(logs.data.attributes.developerLogUrl);
  if (
    logUrl.protocol !== "https:" ||
    logUrl.port ||
    logUrl.username ||
    logUrl.password ||
    !/(?:^|\.)(?:apple\.com|amazonaws\.com)$/.test(logUrl.hostname)
  )
    throw new Error("notary_log_url_invalid");
  const logResponse = await fetch(logUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const log = z
    .object({
      jobId: z.uuid().optional(),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
    })
    .passthrough()
    .parse(await boundedJson(logResponse, 2_097_152));
  if (
    (log.jobId && log.jobId.toLowerCase() !== id.toLowerCase()) ||
    log.sha256?.toLowerCase() !== expectedSha.toLowerCase()
  )
    throw new Error("notary_log_mismatch");
  return status.data.attributes.status;
}

const reportContextSchema = z.object({
  request_id: z.uuid(),
  generation: z.number().int().positive(),
  input_digest: z.string(),
  recipe_sha: z.string(),
  policy_digest: z.string(),
});

async function verifyOutput(
  env: SigningEnv,
  context: SigningMachineContext,
  profile: SigningProfile,
  platform: SigningPlatform,
  sourceDigest: string,
  sourceCommitOid: string,
  version: string,
  outputDigest: string,
  outputSize: number,
  raw: unknown
): Promise<boolean> {
  if (
    profile.platform !== platform ||
    outputSize < 1 ||
    outputSize > profile.policy.project.max_artifact_bytes ||
    !sha.test(profile.workflowOid) ||
    !archiveDigest.safeParse(outputDigest).success
  )
    return false;
  const project = profile.policy.project;
  if (platform === "windows") {
    const parsed = windowsVerificationSchema.safeParse(raw);
    const fields = reportContextSchema.safeParse(raw);
    const recipe = project.windows;
    const azure = profile.policy.azure;
    if (!parsed.success || !fields.success || !recipe || !azure) return false;
    const report = parsed.data;
    const expectedFiles =
      recipe.installer === "squirrel"
        ? ["product.exe", "RELEASES"]
        : recipe.portable
          ? ["product.exe", "product-portable.exe"]
          : ["product.exe"];
    return (
      fields.data.request_id === context.requestId &&
      fields.data.generation === context.generation &&
      fields.data.input_digest === sourceDigest &&
      fields.data.recipe_sha === profile.workflowOid &&
      fields.data.policy_digest === profile.policyDigest &&
      report.bundle_id === recipe.bundle_id &&
      report.version === version &&
      report.architecture === recipe.architecture &&
      report.subject === azure.subject &&
      expectedFiles.every((path) => report.files.some((file) => file.path === path))
    );
  }
  if (platform === "ios") {
    const parsed = iosVerificationSchema.safeParse(raw);
    const fields = reportContextSchema.safeParse(raw);
    const recipe = project.ios;
    if (!parsed.success || !fields.success || !recipe) return false;
    const report = parsed.data;
    return (
      fields.data.request_id === context.requestId &&
      fields.data.generation === context.generation &&
      fields.data.input_digest === sourceDigest &&
      fields.data.recipe_sha === profile.workflowOid &&
      fields.data.policy_digest === profile.policyDigest &&
      report.source_sha === sourceCommitOid &&
      report.bundle_id === recipe.bundle_id &&
      report.version === version &&
      report.team_id === profile.policy.teamId &&
      Date.parse(report.certificate_expiration) > Date.now() &&
      Date.parse(report.profile_expiration) > Date.now()
    );
  }
  const parsed = macosVerificationSchema.safeParse(raw);
  const fields = reportContextSchema.safeParse(raw);
  const recipe = project.macos;
  if (!parsed.success || !fields.success || !recipe) return false;
  const report = parsed.data;
  const finalStage = report.stage === "finalize" || report.stage === "dmg_finalize";
  const expectedPath =
    report.stage === "sign"
      ? "signed.tar.gz"
      : report.stage === "finalize"
        ? "product.zip"
        : report.stage === "dmg_sign"
          ? "signed.dmg"
          : "product.dmg";
  const filesValid =
    report.files[0].path === expectedPath && report.files[0].size <= project.max_artifact_bytes;
  if (!filesValid) return false;
  if (finalStage) {
    const credentials = await storedCredentials(env, context, profile);
    if (
      !credentials ||
      (await appleNotarizationStatus(
        credentials,
        report.notarization_id,
        report.notary_archive_sha256
      )) !== "Accepted"
    )
      return false;
  }
  return (
    fields.data.request_id === context.requestId &&
    fields.data.generation === context.generation &&
    report.stage === context.stage &&
    fields.data.input_digest === sourceDigest &&
    fields.data.recipe_sha === profile.workflowOid &&
    fields.data.policy_digest === profile.policyDigest &&
    report.version === version &&
    report.team_id === profile.policy.teamId &&
    report.bundle_id === recipe.bundle_id &&
    report.architecture === recipe.architecture &&
    report.files[0].path === expectedPath &&
    (recipe.profile !== "electron" || report.asar_integrity_verified) &&
    (finalStage
      ? report.notarization_status === "Accepted" &&
        report.gatekeeper_verified &&
        report.staple_verified
      : report.notarization_status === "Submitted" &&
        !report.gatekeeper_verified &&
        !report.staple_verified)
  );
}

export function createSigningExecutionHooks(
  env: SigningEnv,
  deps: Pick<SigningExecutionHooks, "enqueue">
): SigningExecutionHooks {
  return {
    ...deps,
    verifyNotarization: (ownerId, repositoryId, profile, report) =>
      verifyNotarization(env, ownerId, repositoryId, profile, report),
    loadApprovedProfile: (user, repositoryId, name) =>
      readProfile(env, user.id, repositoryId, name),
    verifySource: async (user, repositoryId, profile, submission, runIdentity, audience) =>
      verifySource(env, user.id, repositoryId, submission, profile, runIdentity, audience),
    verifySourceCurrent: (ownerId, repositoryId, profile, input) =>
      verifySourceCurrent(env, ownerId, repositoryId, input, profile),
    authorizeCredentials: (context, profile) => grantCredentials(env, context, profile),
    verifyOutput: ({
      context,
      profile,
      platform,
      sourceDigest,
      sourceCommitOid,
      version,
      outputDigest,
      outputSize,
      report,
    }) =>
      verifyOutput(
        env,
        context,
        profile,
        platform,
        sourceDigest,
        sourceCommitOid,
        version,
        outputDigest,
        outputSize,
        report
      ),
  };
}
