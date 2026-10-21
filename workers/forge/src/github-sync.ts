import { z } from "zod";
import {
  GitHubSyncEnabledSchema,
  GitHubSyncEvents,
  GitHubSyncInputSchema,
  type GitHubSyncState,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { auditActor, recordAudit } from "../../../src/worker/common/audit";
import { randomHex } from "../../../src/worker/common/encoding";
import { dataResponse, errorResponse, requireRecentAuth } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { readTextLimited } from "../../../src/worker/common/readText";
import { isAccountRunnerRepository, repositoryRole } from "../../../src/worker/common/repositories";
import { importSealingKey, sealText } from "../../../src/worker/common/secret-box";
import { parseJson, type ForgeEnv, type RepositoryRow } from "./common";
import {
  GithubApiError,
  GithubRepositorySchema,
  githubRepoPath,
  githubRequest,
} from "./github-client";
import {
  GithubSyncConflict,
  enqueueGithubJob,
  githubConnection,
  githubCredentials,
  presentGithubJob,
  type GithubConnectionRow,
  type GithubCredentials,
  type GithubJobRow,
} from "./github-sync-store";
import { githubSyncRefs, syncGithubRef } from "./github-sync-git";
import { syncGithubCollaboration } from "./github-sync-collaboration";
import { GitHubRunnerWebhookSchema } from "../../../packages/contracts/src/runners";
import { stopGithubRunners } from "./github-runners";

const LEASE_MS = 900_000;
const GithubHookSchema = z.object({
  id: z.number().int().positive(),
  config: z.object({ url: z.string() }),
});
const PushSchema = z.object({
  ref: z.string(),
  before: z.string().regex(/^[a-f0-9]{40}$/),
  after: z.string().regex(/^[a-f0-9]{40}$/),
});
const BootstrapSchema = z.object({
  phase: z.enum(["refs", "remote", "local", "thread"]),
  page: z.number().int().positive().max(101).default(1),
  kind: z.enum(["issue", "pull_request", "comment", "review", "review_comment"]).optional(),
  number: z.number().int().positive().optional(),
  category: z.enum(["comment", "review", "review_comment"]).optional(),
  cursor: z.string().optional(),
});

export async function githubSyncState(
  env: ForgeEnv,
  repositoryId: string
): Promise<GitHubSyncState> {
  const connection = await githubConnection(env.DB, repositoryId);
  if (!connection) return { connection: null, jobs: [] };
  const stats = await env.DB.prepare(
    "SELECT SUM(status IN ('pending','running')) AS pending, SUM(status='conflict') AS conflicts, SUM(status='failed') AS failed FROM forge_github_jobs WHERE connection_id=?"
  )
    .bind(connection.id)
    .first<{ pending: number; conflicts: number; failed: number }>();
  const jobs = await env.DB.prepare(
    "SELECT * FROM forge_github_jobs WHERE connection_id=? ORDER BY created_at DESC, id DESC LIMIT 50"
  )
    .bind(connection.id)
    .all<GithubJobRow>();
  return {
    connection: {
      id: connection.id,
      owner: connection.owner,
      repository: connection.name,
      githubRepositoryId: connection.github_repository_id,
      githubUrl: `https://github.com/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.name)}`,
      enabled: connection.enabled === 1,
      runnerEnabled: connection.runner_enabled === 1,
      webhookReady: connection.hook_id !== null,
      errorCode: connection.error_code,
      lastSyncedAt: connection.last_synced_at,
      pending: stats?.pending ?? 0,
      conflicts: stats?.conflicts ?? 0,
      failed: stats?.failed ?? 0,
      createdAt: connection.created_at,
    },
    jobs: jobs.results.map(presentGithubJob),
  };
}

async function setupGithubSync(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser
): Promise<Response> {
  const parsed = GitHubSyncInputSchema.safeParse(await parseJson(request));
  if (!parsed.success)
    return errorResponse(400, "bad_request", "Invalid GitHub synchronization settings.");
  const input = parsed.data;
  const key = await importSealingKey(env.WEBHOOK_ENCRYPTION_KEY);
  if (!key)
    return errorResponse(
      503,
      "github_encryption_unavailable",
      "Webhook encryption is not configured."
    );
  if (new URL(request.url).protocol !== "https:")
    return errorResponse(
      400,
      "github_public_url_required",
      "A public HTTPS GitEdge URL is required for GitHub webhooks."
    );
  const path = githubRepoPath(input.owner, input.repository);
  const remote = GithubRepositorySchema.parse(await githubRequest(input.token, path));
  if (remote.archived)
    return errorResponse(409, "github_archived", "The GitHub repository is archived.");
  if ((repository.visibility === "private") !== remote.private && !input.allowVisibilityMismatch)
    return errorResponse(
      409,
      "github_visibility_mismatch",
      "Confirm sharing repository data across different visibility settings."
    );
  const existing = await githubConnection(env.DB, repository.id);
  if (existing && existing.github_repository_id !== remote.id)
    return errorResponse(
      409,
      "github_already_connected",
      "Disconnect the existing repository before connecting another."
    );
  const candidateId = existing?.id ?? crypto.randomUUID();
  const secret = randomHex(32);
  const tokenBox = await sealText(key, input.token);
  const secretBox = await sealText(key, secret);
  const candidateCallback = new URL(
    `/api/forge/github-sync/hooks/${candidateId}`,
    request.url
  ).toString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO forge_github_connections (id,repository_id,owner,name,github_repository_id,github_private,created_by,enabled,callback_url,token_ciphertext,token_iv,secret_ciphertext,secret_iv,created_at) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?)"
  )
    .bind(
      candidateId,
      repository.id,
      input.owner,
      input.repository,
      remote.id,
      Number(remote.private),
      user.id,
      candidateCallback,
      tokenBox.ciphertext,
      tokenBox.iv,
      secretBox.ciphertext,
      secretBox.iv,
      existing?.created_at ?? Date.now()
    )
    .run();
  const configured = await githubConnection(env.DB, repository.id);
  if (!configured || configured.github_repository_id !== remote.id)
    return errorResponse(
      409,
      "github_already_connected",
      "The repository connection changed during setup."
    );
  const id = configured.id;
  const lease = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    "UPDATE forge_github_connections SET lease=?,lease_expires_at=? WHERE id=? AND lease_expires_at<?"
  )
    .bind(lease, Date.now() + LEASE_MS, id, Date.now())
    .run();
  if (!claimed.meta.changes)
    return errorResponse(
      409,
      "github_sync_busy",
      "A synchronization operation is in progress. Retry when it finishes."
    );
  try {
    const callback = new URL(`/api/forge/github-sync/hooks/${id}`, request.url).toString();
    await env.DB.prepare(
      "UPDATE forge_github_connections SET owner=?,name=?,github_private=?,allow_visibility_mismatch=?,created_by=?,enabled=0,callback_url=?,token_ciphertext=?,token_iv=?,secret_ciphertext=?,secret_iv=? WHERE id=? AND lease=?"
    )
      .bind(
        input.owner,
        input.repository,
        Number(remote.private),
        Number(input.allowVisibilityMismatch),
        user.id,
        callback,
        tokenBox.ciphertext,
        tokenBox.iv,
        secretBox.ciphertext,
        secretBox.iv,
        id,
        lease
      )
      .run();
    const hooks = z
      .array(GithubHookSchema)
      .max(100)
      .parse(await githubRequest(input.token, `${path}/hooks?per_page=100`));
    const owned = hooks.find(
      (hook) => hook.id === configured.hook_id || hook.config.url === callback
    );
    if (hooks.length === 100 && !owned)
      return errorResponse(
        409,
        "github_hook_limit",
        "The repository webhook inventory exceeds the setup limit."
      );
    const hook = GithubHookSchema.parse(
      await githubRequest(
        input.token,
        owned ? `${path}/hooks/${owned.id}` : `${path}/hooks`,
        owned ? "PATCH" : "POST",
        {
          name: "web",
          active: true,
          events: [...GitHubSyncEvents, "workflow_job"],
          config: { url: callback, content_type: "json", insecure_ssl: "0", secret },
        }
      )
    );
    await env.DB.prepare(
      "UPDATE forge_github_connections SET hook_id=?,enabled=1,retry_at=0,failure_count=0,error_code=NULL WHERE id=?"
    )
      .bind(hook.id, id)
      .run();
    await recordAudit(env, {
      action: "github_sync.connected",
      actor: auditActor(user),
      target: { type: "github_sync", id },
      repositoryId: repository.id,
      metadata: {
        repository: remote.full_name,
        visibilityMismatchAccepted: input.allowVisibilityMismatch,
      },
    });
    await seedGithubSync(env.DB, id);
    return dataResponse(await githubSyncState(env, repository.id), existing ? 200 : 201);
  } finally {
    await env.DB.prepare(
      "UPDATE forge_github_connections SET lease=NULL,lease_expires_at=0 WHERE id=? AND lease=?"
    )
      .bind(id, lease)
      .run();
  }
}

async function seedGithubSync(db: D1Database, id: string): Promise<void> {
  await enqueueGithubJob(db, id, "inbound", "bootstrap", { phase: "refs" });
  await enqueueGithubJob(db, id, "inbound", "bootstrap", { phase: "remote", page: 1 });
  for (const kind of ["issue", "pull_request", "comment", "review", "review_comment"])
    await enqueueGithubJob(db, id, "outbound", "bootstrap", { phase: "local", kind });
}

export async function handleGithubSyncSettings(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  parts: string[]
): Promise<Response | null> {
  if (parts[2] !== "github-sync") return null;
  if (await isAccountRunnerRepository(env.DB, repository.id))
    return errorResponse(
      409,
      "system_repository_locked",
      "GitHub synchronization cannot change Runner identity or ownership."
    );
  if (
    user.agentSession ||
    user.token ||
    (await repositoryRole(env.DB, repository.id, user.id)) !== "admin"
  )
    return errorResponse(
      403,
      "forbidden",
      "A repository administrator browser session is required."
    );
  if (request.method === "GET" && parts.length === 3)
    return dataResponse(await githubSyncState(env, repository.id));
  const recent = requireRecentAuth(user);
  if (recent) return recent;
  if (repository.archived === 1)
    return errorResponse(409, "archived", "Archived repositories cannot synchronize.");
  try {
    if (request.method === "PUT" && parts.length === 3)
      return await setupGithubSync(env, request, repository, user);
    const connection = await githubConnection(env.DB, repository.id);
    if (!connection)
      return errorResponse(404, "not_found", "GitHub synchronization is not configured.");
    if (connection.lease_expires_at > Date.now())
      return errorResponse(
        409,
        "github_sync_busy",
        "A synchronization operation is in progress. Retry when it finishes."
      );
    if (request.method === "PATCH" && parts[3] === "runner" && parts.length === 4) {
      const input = GitHubSyncEnabledSchema.safeParse(await parseJson(request));
      if (!input.success)
        return errorResponse(400, "bad_request", "Invalid GitHub runner settings.");
      if (input.data.enabled) {
        if (connection.enabled !== 1 || !connection.hook_id)
          return errorResponse(409, "github_hook_missing", "Enable the GitHub connection first.");
        const credentials = await githubCredentials(env, connection);
        const path = githubRepoPath(connection.owner, connection.name);
        await githubRequest(credentials.token, `${path}/actions/runners?per_page=1`);
        await githubRequest(credentials.token, `${path}/hooks/${connection.hook_id}`, "PATCH", {
          events: [...GitHubSyncEvents, "workflow_job"],
        });
      }
      await env.DB.prepare("UPDATE forge_github_connections SET runner_enabled=? WHERE id=?")
        .bind(Number(input.data.enabled), connection.id)
        .run();
      if (!input.data.enabled) await stopGithubRunners(env, connection);
    } else if (request.method === "PATCH" && parts.length === 3) {
      const input = GitHubSyncEnabledSchema.safeParse(await parseJson(request));
      if (!input.success)
        return errorResponse(400, "bad_request", "Invalid synchronization settings.");
      if (input.data.enabled && !connection.hook_id)
        return errorResponse(
          409,
          "github_hook_missing",
          "Complete the GitHub connection setup first."
        );
      await env.DB.prepare(
        "UPDATE forge_github_connections SET enabled=?,retry_at=0,failure_count=0,error_code=NULL WHERE id=?"
      )
        .bind(Number(input.data.enabled), connection.id)
        .run();
      if (input.data.enabled) await seedGithubSync(env.DB, connection.id);
      else await stopGithubRunners(env, connection);
    } else if (request.method === "DELETE" && parts.length === 3) {
      await env.DB.prepare("UPDATE forge_github_connections SET enabled=0 WHERE id=?")
        .bind(connection.id)
        .run();
      if (!(await stopGithubRunners(env, connection)))
        return errorResponse(
          409,
          "github_runner_cleanup_pending",
          "Temporary runners are being removed. Retry disconnecting shortly."
        );
      if (connection.hook_id) {
        const credentials = await githubCredentials(env, connection);
        try {
          await githubRequest(
            credentials.token,
            `${githubRepoPath(connection.owner, connection.name)}/hooks/${connection.hook_id}`,
            "DELETE"
          );
        } catch (cause) {
          if (!(cause instanceof GithubApiError && cause.status === 404)) throw cause;
        }
      }
      await env.DB.prepare("DELETE FROM forge_github_connections WHERE id=?")
        .bind(connection.id)
        .run();
    } else if (request.method === "POST" && parts[3] === "reconcile" && parts.length === 4) {
      if (connection.enabled !== 1)
        return errorResponse(
          409,
          "github_sync_paused",
          "Resume synchronization before reconciling."
        );
      await env.DB.prepare(
        "UPDATE forge_github_jobs SET status='pending',attempts=0,next_attempt_at=?,error_code=NULL,completed_at=NULL WHERE connection_id=? AND status IN ('conflict','failed')"
      )
        .bind(Date.now(), connection.id)
        .run();
      await seedGithubSync(env.DB, connection.id);
    } else if (
      request.method === "POST" &&
      parts[3] === "jobs" &&
      parts[5] === "retry" &&
      parts.length === 6
    ) {
      let jobId: string;
      try {
        jobId = decodeURIComponent(parts[4]);
      } catch {
        return errorResponse(400, "bad_request", "Invalid synchronization job identifier.");
      }
      const changed = await env.DB.prepare(
        "UPDATE forge_github_jobs SET status='pending',attempts=0,next_attempt_at=?,error_code=NULL,completed_at=NULL WHERE id=? AND connection_id=? AND status IN ('failed','conflict')"
      )
        .bind(Date.now(), jobId, connection.id)
        .run();
      if (!changed.meta.changes)
        return errorResponse(
          409,
          "github_job_not_retryable",
          "The synchronization job cannot be retried."
        );
    } else return errorResponse(405, "method_not_allowed", "Method is not allowed.");
    await recordAudit(env, {
      action: "github_sync.updated",
      actor: auditActor(user),
      target: { type: "github_sync", id: connection.id },
      repositoryId: repository.id,
      metadata: { operation: request.method, action: parts[3] ?? "settings" },
    });
    return dataResponse(await githubSyncState(env, repository.id));
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "github-sync", repoId: repository.id }).warn(
      "github-sync:setup-failed",
      { status: cause instanceof GithubApiError ? cause.status : null }
    );
    return errorResponse(
      cause instanceof GithubApiError ? 422 : 503,
      "github_connection_failed",
      "GitHub synchronization could not be configured. Check repository permissions and retry."
    );
  }
}

export async function receiveGithubWebhook(
  env: ForgeEnv,
  request: Request,
  id: string
): Promise<Response> {
  if (request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  const connection = await env.DB.prepare("SELECT * FROM forge_github_connections WHERE id=?")
    .bind(id)
    .first<GithubConnectionRow>();
  if (!connection) return errorResponse(404, "not_found", "Webhook was not found.");
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature))
    return errorResponse(401, "invalid_webhook_signature", "Invalid webhook signature.");
  const body = await readTextLimited(request.body, 1_048_576);
  if (body === null)
    return errorResponse(
      413,
      "github_payload_limit",
      "Webhook payload exceeds the synchronization limit."
    );
  let credentials: GithubCredentials;
  try {
    credentials = await githubCredentials(env, connection);
  } catch {
    return errorResponse(
      503,
      "github_encryption_unavailable",
      "Webhook verification is unavailable."
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(credentials.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const digest = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    digest[i] = Number.parseInt(signature.slice(7 + i * 2, 9 + i * 2), 16);
  if (!(await crypto.subtle.verify("HMAC", key, digest, new TextEncoder().encode(body))))
    return errorResponse(401, "invalid_webhook_signature", "Invalid webhook signature.");
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return errorResponse(400, "bad_request", "Invalid webhook payload.");
  }
  const source = z.object({ repository: z.object({ id: z.number().int() }) }).safeParse(payload);
  if (!source.success || source.data.repository.id !== connection.github_repository_id)
    return errorResponse(
      403,
      "github_repository_mismatch",
      "Webhook repository does not match its connection."
    );
  const event = request.headers.get("X-GitHub-Event");
  if (event === "ping") return dataResponse({ accepted: true }, 202);
  if (event === "workflow_job") {
    if (connection.enabled !== 1 || connection.runner_enabled !== 1)
      return dataResponse({ ignored: true }, 202);
    const parsed = GitHubRunnerWebhookSchema.safeParse(payload);
    if (!parsed.success) return errorResponse(400, "bad_request", "Invalid GitHub workflow job.");
    if (!env.ACTIONS) return errorResponse(503, "service_unavailable", "Actions is unavailable.");
    return env.ACTIONS.fetch(
      new Request("https://actions.internal/internal/github-runner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...parsed.data, connectionId: connection.id }),
      })
    );
  }
  if (!event || !GitHubSyncEvents.some((supported) => supported === event))
    return dataResponse({ ignored: true }, 202);
  const delivery = request.headers.get("X-GitHub-Delivery");
  if (!delivery || !/^[a-zA-Z0-9-]{1,100}$/.test(delivery))
    return errorResponse(400, "bad_request", "A delivery identifier is required.");
  await enqueueGithubJob(
    env.DB,
    connection.id,
    "inbound",
    event,
    payload,
    `github:${connection.id}:${delivery}`
  );
  return dataResponse({ accepted: true }, 202);
}

async function bootstrapGithub(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  credentials: GithubCredentials,
  job: GithubJobRow
): Promise<void> {
  const input = BootstrapSchema.parse(JSON.parse(job.payload));
  if (input.page > 100) throw new GithubSyncConflict("github_backfill_limit");
  const path = githubRepoPath(connection.owner, connection.name);
  if (input.phase === "refs") {
    const refs = await githubSyncRefs(env, connection, credentials, job);
    const local = new Map(refs.local.map((r) => [r.ref, r.oid]));
    const remote = new Map(refs.remote.map((r) => [r.ref, r.oid]));
    const names = [...new Set([...local.keys(), ...remote.keys()])]
      .sort()
      .filter((ref) => ref > (input.cursor ?? ""));
    for (const ref of names.slice(0, 20)) {
      const edge = local.get(ref),
        github = remote.get(ref);
      if (edge === github) continue;
      if (github)
        await enqueueGithubJob(env.DB, connection.id, "inbound", "push", {
          ref,
          before: null,
          after: github,
        });
      if (edge)
        await enqueueGithubJob(env.DB, connection.id, "outbound", "push", {
          ref,
          before: null,
          after: edge,
        });
    }
    if (names.length > 20)
      await enqueueGithubJob(env.DB, connection.id, "inbound", "bootstrap", {
        ...input,
        page: input.page + 1,
        cursor: names[19],
      });
    return;
  }
  if (input.phase === "local") {
    const kind = input.kind;
    if (!kind) throw new Error("github_invalid_bootstrap");
    const tables = {
      issue: "forge_issues",
      pull_request: "forge_pull_requests",
      comment: "forge_comments",
      review: "forge_reviews",
      review_comment: "forge_review_comments",
    };
    const condition =
      kind === "review_comment"
        ? " AND pending=0"
        : kind === "comment"
          ? " AND target_kind IN ('issue','pull_request')"
          : "";
    const rows = await env.DB.prepare(
      `SELECT id FROM ${tables[kind]} r WHERE r.repository_id=? AND r.id>?${condition} AND NOT EXISTS (SELECT 1 FROM forge_github_mappings m WHERE m.connection_id=? AND m.kind=? AND m.local_id=r.id) ORDER BY r.id LIMIT 20`
    )
      .bind(connection.repository_id, input.cursor ?? "", connection.id, kind)
      .all<{ id: string }>();
    for (const row of rows.results)
      await enqueueGithubJob(env.DB, connection.id, "outbound", kind, {
        kind,
        action: "upsert",
        id: row.id,
      });
    if (rows.results.length === 20)
      await enqueueGithubJob(env.DB, connection.id, "outbound", "bootstrap", {
        ...input,
        page: input.page + 1,
        cursor: rows.results.at(-1)?.id,
      });
    return;
  }
  if (input.phase === "remote") {
    const items = z
      .array(
        z.object({ number: z.number().int().positive(), pull_request: z.unknown().optional() })
      )
      .max(20)
      .parse(
        await githubRequest(
          credentials.token,
          `${path}/issues?state=all&sort=created&direction=asc&per_page=20&page=${input.page}`
        )
      );
    for (const item of items)
      await enqueueGithubJob(env.DB, connection.id, "inbound", "snapshot", {
        kind: item.pull_request ? "pull_request" : "issue",
        number: item.number,
      });
    if (items.length === 20)
      await enqueueGithubJob(env.DB, connection.id, "inbound", "bootstrap", {
        ...input,
        page: input.page + 1,
      });
    return;
  }
  if (!input.number || !input.category || (input.kind !== "issue" && input.kind !== "pull_request"))
    throw new Error("github_invalid_bootstrap");
  const pull = input.kind === "pull_request";
  const suffix =
    input.category === "comment"
      ? `/issues/${input.number}/comments`
      : input.category === "review"
        ? `/pulls/${input.number}/reviews`
        : `/pulls/${input.number}/comments`;
  const items = z
    .array(z.unknown())
    .max(20)
    .parse(
      await githubRequest(credentials.token, `${path}${suffix}?per_page=20&page=${input.page}`)
    );
  if (items.length) {
    const parent = await githubRequest(
      credentials.token,
      `${path}/${pull ? "pulls" : "issues"}/${input.number}`
    );
    for (const item of items) {
      const event =
        input.category === "comment"
          ? "issue_comment"
          : input.category === "review"
            ? "pull_request_review"
            : "pull_request_review_comment";
      await enqueueGithubJob(env.DB, connection.id, "inbound", event, {
        action: input.category === "review" ? "submitted" : "created",
        repository: { id: connection.github_repository_id },
        ...(input.category === "comment"
          ? { issue: parent, comment: item }
          : { pull_request: parent, [input.category === "review" ? "review" : "comment"]: item }),
      });
    }
  }
  if (items.length === 20)
    await enqueueGithubJob(env.DB, connection.id, "inbound", "bootstrap", {
      ...input,
      page: input.page + 1,
    });
}

async function eligibleConnection(
  env: ForgeEnv,
  connection: GithubConnectionRow
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS active FROM users u JOIN repositories r ON r.id=? AND r.deleted_at IS NULL AND r.archived=0 WHERE u.id=? AND u.disabled_at IS NULL AND u.deleted_at IS NULL"
  )
    .bind(connection.repository_id, connection.created_by)
    .first();
  return (
    !!row &&
    (await repositoryRole(env.DB, connection.repository_id, connection.created_by)) === "admin"
  );
}

export async function wakeGithubSync(env: ForgeEnv, connectionId?: string): Promise<void> {
  const now = Date.now();
  const rows = await env.DB.prepare(
    "SELECT c.id,MAX(c.retry_at,c.lease_expires_at,MIN(CASE WHEN j.status='running' THEN j.lease_expires_at ELSE j.next_attempt_at END)) AS due_at FROM forge_github_connections c JOIN forge_github_jobs j ON j.connection_id=c.id WHERE c.enabled=1 AND j.status IN ('pending','running') AND (? IS NULL OR c.id=?) GROUP BY c.id ORDER BY due_at LIMIT 20"
  )
    .bind(connectionId ?? null, connectionId ?? null)
    .all<{ id: string; due_at: number }>();
  if (!rows.results.length) return;
  await env.GITHUB_SYNC_QUEUE.sendBatch(
    rows.results.map((row) => ({
      body: { connectionId: row.id },
      delaySeconds: Math.max(0, Math.min(86_400, Math.ceil((row.due_at - now) / 1000))),
    }))
  );
}

export async function consumeGithubSync(
  batch: MessageBatch<{ connectionId: string }>,
  env: ForgeEnv
): Promise<void> {
  for (const message of batch.messages) {
    const input = z.object({ connectionId: z.uuid() }).safeParse(message.body);
    if (!input.success) {
      message.ack();
      continue;
    }
    await drainGithubSync(env, input.data.connectionId);
    await wakeGithubSync(env, input.data.connectionId);
    message.ack();
  }
}

export async function drainGithubSync(env: ForgeEnv, connectionId?: string): Promise<void> {
  const logger = createLogger(env.LOG_LEVEL, { service: "github-sync" });
  const started = Date.now();
  const due = await env.DB.prepare(
    "SELECT DISTINCT c.id FROM forge_github_connections c JOIN forge_github_jobs j ON j.connection_id=c.id WHERE c.enabled=1 AND c.retry_at<=? AND c.lease_expires_at<? AND (? IS NULL OR c.id=?) AND ((j.status='pending' AND j.next_attempt_at<=?) OR (j.status='running' AND j.lease_expires_at<?)) ORDER BY j.created_at LIMIT 5"
  )
    .bind(started, started, connectionId ?? null, connectionId ?? null, started, started)
    .all<{ id: string }>();
  for (const entry of due.results) {
    if (Date.now() - started > 20_000) break;
    const lease = crypto.randomUUID();
    const claimed = await env.DB.prepare(
      "UPDATE forge_github_connections SET lease=?,lease_expires_at=? WHERE id=? AND enabled=1 AND lease_expires_at<? RETURNING *"
    )
      .bind(lease, Date.now() + LEASE_MS, entry.id, Date.now())
      .first<GithubConnectionRow>();
    if (!claimed) continue;
    try {
      if (!(await eligibleConnection(env, claimed))) {
        await env.DB.prepare(
          "UPDATE forge_github_connections SET enabled=0,error_code='github_owner_ineligible' WHERE id=?"
        )
          .bind(claimed.id)
          .run();
        logger.warn("github-sync:owner-ineligible", { connectionId: claimed.id });
        continue;
      }
      const credentials = await githubCredentials(env, claimed);
      const remote = GithubRepositorySchema.parse(
        await githubRequest(credentials.token, githubRepoPath(claimed.owner, claimed.name))
      );
      const visibility = await env.DB.prepare("SELECT visibility FROM repositories WHERE id=?")
        .bind(claimed.repository_id)
        .first<{ visibility: string }>();
      if (
        remote.id !== claimed.github_repository_id ||
        remote.archived ||
        (claimed.allow_visibility_mismatch !== 1 &&
          remote.private !== (visibility?.visibility === "private"))
      ) {
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE forge_github_connections SET enabled=0,error_code='github_repository_policy_changed' WHERE id=?"
          ).bind(claimed.id),
          env.DB.prepare(
            "UPDATE forge_github_jobs SET status='conflict',error_code='github_repository_policy_changed',completed_at=? WHERE connection_id=? AND status='pending'"
          ).bind(Date.now(), claimed.id),
        ]);
        continue;
      }
      await env.DB.prepare(
        "UPDATE forge_github_connections SET failure_count=0,retry_at=0,error_code=NULL WHERE id=? AND lease=?"
      )
        .bind(claimed.id, lease)
        .run();
      claimed.failure_count = 0;
      await env.DB.prepare(
        "UPDATE forge_github_jobs SET status='failed',error_code='github_retry_exhausted',completed_at=?,lease=NULL,lease_expires_at=0 WHERE id IN (SELECT id FROM forge_github_jobs WHERE connection_id=? AND status='running' AND attempts>=5 AND lease_expires_at<? LIMIT 5)"
      )
        .bind(Date.now(), claimed.id, Date.now())
        .run();
      for (let count = 0; count < 5 && Date.now() - started < 20_000; count++) {
        const job = await env.DB.prepare(
          "UPDATE forge_github_jobs SET status='running',attempts=attempts+1,lease=?,lease_expires_at=? WHERE id=(SELECT id FROM forge_github_jobs WHERE connection_id=? AND ((status='pending' AND next_attempt_at<=?) OR (status='running' AND lease_expires_at<?)) ORDER BY created_at,id LIMIT 1) RETURNING *"
        )
          .bind(lease, Date.now() + LEASE_MS, claimed.id, Date.now(), Date.now())
          .first<GithubJobRow>();
        if (!job) break;
        try {
          let status: "success" | "ignored" = "success";
          if (job.event === "bootstrap") await bootstrapGithub(env, claimed, credentials, job);
          else if (job.event === "push") {
            const input = PushSchema.extend({ before: PushSchema.shape.before.nullable() }).parse(
              JSON.parse(job.payload)
            );
            if (!/^refs\/(heads|tags)\//.test(input.ref)) status = "ignored";
            else {
              const linked =
                job.direction === "inbound"
                  ? await env.DB.prepare(
                      "SELECT p.id,p.head_ref FROM forge_pull_requests p JOIN forge_github_mappings m ON m.local_id=p.id AND m.kind='pull_request' AND m.connection_id=? WHERE p.repository_id=? AND 'refs/heads/gitedge/pr/'||p.number=? AND p.state='open'"
                    )
                      .bind(claimed.id, claimed.repository_id, input.ref)
                      .first<{ id: string; head_ref: string }>()
                  : null;
              const result = await syncGithubRef(env, claimed, credentials, job, {
                ...input,
                targetRef: linked ? `refs/heads/${linked.head_ref}` : input.ref,
                ...(linked ? { pullRequestId: linked.id } : {}),
              });
              if (result.status === "stale") status = "ignored";
            }
          } else status = await syncGithubCollaboration(env, claimed, credentials, job);
          await env.DB.batch([
            env.DB.prepare(
              "UPDATE forge_github_jobs SET status=?,error_code=NULL,completed_at=?,lease=NULL,lease_expires_at=0 WHERE id=? AND lease=?"
            ).bind(status, Date.now(), job.id, lease),
            env.DB.prepare(
              "UPDATE forge_github_connections SET last_synced_at=? WHERE id=? AND lease=?"
            ).bind(Date.now(), claimed.id, lease),
          ]);
        } catch (cause) {
          const conflict = cause instanceof GithubSyncConflict;
          const rateLimit = cause instanceof GithubApiError ? cause.retryAfter * 1000 : 0;
          const code =
            cause instanceof Error && /^[a-z][a-z0-9_]{0,80}$/.test(cause.message)
              ? cause.message
              : "github_sync_failed";
          const status = conflict ? "conflict" : job.attempts >= 5 ? "failed" : "pending";
          await env.DB.prepare(
            "UPDATE forge_github_jobs SET status=?,error_code=?,next_attempt_at=?,completed_at=?,lease=NULL,lease_expires_at=0 WHERE id=? AND lease=?"
          )
            .bind(
              status,
              code,
              Date.now() + Math.max(rateLimit, 60_000 * 2 ** Math.min(job.attempts - 1, 4)),
              status === "pending" ? null : Date.now(),
              job.id,
              lease
            )
            .run();
          logger.warn("github-sync:job-failed", {
            jobId: job.id,
            direction: job.direction,
            code,
            status,
          });
        }
      }
    } catch (cause) {
      const code =
        cause instanceof Error && /^[a-z][a-z0-9_]{0,80}$/.test(cause.message)
          ? cause.message
          : "github_connection_unavailable";
      const permanent =
        cause instanceof GithubApiError &&
        [401, 403, 404].includes(cause.status) &&
        cause.retryAfter === 0;
      const delay = cause instanceof GithubApiError ? cause.retryAfter * 1000 : 0;
      await env.DB.prepare(
        "UPDATE forge_github_connections SET retry_at=?,failure_count=failure_count+1,error_code=?,enabled=CASE WHEN ? OR failure_count>=4 THEN 0 ELSE enabled END WHERE id=? AND lease=?"
      )
        .bind(
          Date.now() + Math.max(delay, 60_000 * 2 ** Math.min(claimed.failure_count, 4)),
          code,
          Number(permanent),
          claimed.id,
          lease
        )
        .run();
      logger.error("github-sync:drain-failed", { connectionId: claimed.id, code });
    } finally {
      await env.DB.prepare(
        "UPDATE forge_github_connections SET lease=NULL,lease_expires_at=0 WHERE id=? AND lease=?"
      )
        .bind(claimed.id, lease)
        .run();
    }
  }
}

export async function purgeGithubSyncJobs(env: ForgeEnv): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM forge_github_jobs WHERE id IN (SELECT id FROM forge_github_jobs WHERE completed_at<? AND status IN ('success','ignored') LIMIT 200)"
  )
    .bind(Date.now() - 30 * 86_400_000)
    .run();
}
