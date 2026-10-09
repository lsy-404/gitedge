import { z } from "zod";
import {
  AI_SUMMARY_DEFAULT_HOURLY_LIMIT,
  AI_SUMMARY_DEFAULT_MODEL,
  AI_SUMMARY_LABEL,
  AI_SUMMARY_PROMPT_CHARS,
  AI_SUMMARY_TIMEOUT_MS,
  AiSummaryContentSchema,
  type AiSummary,
  type AiSummaryErrorCode,
  type AiSummaryState,
  type AiSummaryUnavailableReason,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger, type Logger } from "../../../src/worker/common/logger";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { compareRequest, isMember, type ForgeEnv, type RepositoryRow } from "./common";
import { buildSummaryPrompt } from "./ai-summary-prompt";

const HOUR_MS = 3_600_000;
const STALE_RUNNING_MS = 120_000;
const KEPT_SUMMARIES = 10;
const JOBS_PER_DRAIN = 4;
// Later jobs wait for the next tick so overlapping cron invocations stay short.
const CLAIM_WINDOW_MS = 30_000;
const COMPARE_TIMEOUT_MS = 20_000;
const MAX_TOKENS = 900;

/** The kill switch is a site-wide off state; the Workers AI binding is optional. */
export function aiSummarySiteEnabled(env: Pick<ForgeEnv, "AI" | "AI_SUMMARIES_DISABLED">): boolean {
  return Boolean(env.AI) && env.AI_SUMMARIES_DISABLED !== "true";
}

export function aiSummaryUnavailable(
  env: Pick<ForgeEnv, "AI" | "AI_SUMMARIES_DISABLED">,
  repository: Pick<
    RepositoryRow,
    "visibility" | "ai_summaries_enabled" | "ai_summaries_private_consent"
  >
): AiSummaryUnavailableReason | null {
  if (!aiSummarySiteEnabled(env)) return "site_disabled";
  if (repository.ai_summaries_enabled !== 1) return "repository_disabled";
  if (repository.visibility === "private" && repository.ai_summaries_private_consent !== 1)
    return "private_consent_required";
  return null;
}

function hourlyLimit(env: Pick<ForgeEnv, "AI_SUMMARY_HOURLY_LIMIT">): number {
  const parsed = Number(env.AI_SUMMARY_HOURLY_LIMIT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : AI_SUMMARY_DEFAULT_HOURLY_LIMIT;
}

/** Seconds until a repository may call the model again, or 0 when it is under its hourly limit. */
async function retryAfterSeconds(env: ForgeEnv, repositoryId: string): Promise<number> {
  const limit = hourlyLimit(env);
  const rows = await env.DB.prepare(
    "SELECT created_at FROM forge_ai_usage WHERE repository_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?"
  )
    .bind(repositoryId, Date.now() - HOUR_MS, limit)
    .all<{ created_at: number }>();
  if (rows.results.length < limit) return 0;
  const oldest = rows.results[rows.results.length - 1].created_at;
  return Math.max(1, Math.ceil((oldest + HOUR_MS - Date.now()) / 1000));
}

/** Records one model call unless the repository already used its hourly allowance; atomic in D1. */
async function reserveModelCall(env: ForgeEnv, repositoryId: string): Promise<boolean> {
  const now = Date.now();
  const result = await env.DB.prepare(
    "INSERT INTO forge_ai_usage (id, repository_id, created_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM forge_ai_usage WHERE repository_id = ? AND created_at > ?) < ?"
  )
    .bind(crypto.randomUUID(), repositoryId, now, repositoryId, now - HOUR_MS, hourlyLimit(env))
    .run();
  return result.meta.changes === 1;
}

/** Queues a summary of the pull request's current head; one queued job per pull request. */
export async function enqueueAiSummary(
  env: ForgeEnv,
  repository: RepositoryRow,
  pullRequestId: string,
  requestedBy: string,
  force: boolean
): Promise<boolean> {
  if (aiSummaryUnavailable(env, repository)) return false;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM forge_ai_summaries WHERE pull_request_id = ? AND status = 'failed'"
    ).bind(pullRequestId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO forge_ai_summaries (id, repository_id, pull_request_id, requested_by, force, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)"
    ).bind(crypto.randomUUID(), repository.id, pullRequestId, requestedBy, Number(force), now, now),
    env.DB.prepare(
      "UPDATE forge_ai_summaries SET force = MAX(force, ?) WHERE pull_request_id = ? AND status = 'queued'"
    ).bind(Number(force), pullRequestId),
  ]);
  createLogger(env.LOG_LEVEL, { service: "ai-summary", repoId: repository.id }).info(
    "ai-summary:queued",
    { pullRequestId, force }
  );
  return true;
}

/** Queues summaries for open pull requests whose head branch just moved. */
export async function enqueueAiSummariesForPush(
  env: ForgeEnv,
  repository: RepositoryRow,
  pusherId: string,
  refs: readonly string[]
): Promise<void> {
  if (aiSummaryUnavailable(env, repository)) return;
  const branches = refs.flatMap((ref) => (ref.startsWith("refs/heads/") ? [ref.slice(11)] : []));
  if (!branches.length) return;
  const rows = await env.DB.prepare(
    `SELECT id FROM forge_pull_requests WHERE repository_id = ? AND state = 'open' AND head_session_id IS NULL AND head_ref IN (${branches.map(() => "?").join(",")}) LIMIT 50`
  )
    .bind(repository.id, ...branches)
    .all<{ id: string }>();
  for (const row of rows.results) await enqueueAiSummary(env, repository, row.id, pusherId, false);
}

type SummaryRow = {
  id: string;
  head_oid: string;
  model: string;
  summary_json: string;
  truncated: number;
  updated_at: number;
};
type JobRow = {
  status: "queued" | "running" | "failed";
  error_code: string | null;
  updated_at: number;
};

const ErrorCodeSchema = z.enum([
  "disabled",
  "diff_unavailable",
  "rate_limited",
  "model_error",
  "invalid_output",
  "timeout",
]);

async function readState(
  env: ForgeEnv,
  repository: RepositoryRow,
  pullRequestId: string
): Promise<AiSummaryState> {
  const unavailable = aiSummaryUnavailable(env, repository);
  if (unavailable) return { unavailable, summary: null, job: null };
  const [summaryRow, jobRow] = await Promise.all([
    env.DB.prepare(
      "SELECT id, head_oid, model, summary_json, truncated, updated_at FROM forge_ai_summaries WHERE pull_request_id = ? AND status = 'succeeded' ORDER BY updated_at DESC, rowid DESC LIMIT 1"
    )
      .bind(pullRequestId)
      .first<SummaryRow>(),
    env.DB.prepare(
      "SELECT status, error_code, updated_at FROM forge_ai_summaries WHERE pull_request_id = ? AND status != 'succeeded' ORDER BY updated_at DESC, rowid DESC LIMIT 1"
    )
      .bind(pullRequestId)
      .first<JobRow>(),
  ]);
  const content = summaryRow
    ? AiSummaryContentSchema.safeParse(JSON.parse(summaryRow.summary_json))
    : null;
  const summary: AiSummary | null =
    summaryRow && content?.success
      ? {
          id: summaryRow.id,
          author: { kind: "system", name: AI_SUMMARY_LABEL },
          headOid: summaryRow.head_oid,
          model: summaryRow.model,
          content: content.data,
          truncated: summaryRow.truncated === 1,
          generatedAt: summaryRow.updated_at,
        }
      : null;
  return {
    unavailable: null,
    summary,
    job: jobRow
      ? {
          status: jobRow.status,
          errorCode: ErrorCodeSchema.catch("model_error").parse(jobRow.error_code),
          updatedAt: jobRow.updated_at,
        }
      : null,
  };
}

/** Read and regenerate routes under `pull-requests/:number/ai-summary`; null for other paths. */
export async function aiSummaryRequest(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser | null,
  rest: string[]
): Promise<Response | null> {
  if (rest[0] !== "pull-requests" || rest[2] !== "ai-summary" || rest.length !== 3) return null;
  if (repository.pulls_enabled === 0)
    return errorResponse(404, "feature_disabled", "Repository pull requests are disabled.");
  const number = Number(rest[1]);
  if (!Number.isSafeInteger(number) || number < 1)
    return errorResponse(404, "not_found", "Pull request was not found.");
  const pull = await env.DB.prepare(
    "SELECT id, state FROM forge_pull_requests WHERE repository_id = ? AND number = ?"
  )
    .bind(repository.id, number)
    .first<{ id: string; state: string }>();
  if (!pull) return errorResponse(404, "not_found", "Pull request was not found.");
  if (request.method === "GET") return dataResponse(await readState(env, repository, pull.id));
  if (request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  if (!user || user.agentSession || !(await isMember(env, repository.id, user.id)))
    return errorResponse(
      403,
      "forbidden",
      "Repository write access is required to regenerate the summary."
    );
  if (repository.archived === 1)
    return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
  const unavailable = aiSummaryUnavailable(env, repository);
  if (unavailable)
    return errorResponse(
      409,
      "ai_summary_unavailable",
      `AI summaries are unavailable: ${unavailable}.`
    );
  if (pull.state !== "open")
    return errorResponse(409, "pull_request_closed", "Only open pull requests are summarized.");
  const wait = await retryAfterSeconds(env, repository.id);
  if (wait > 0)
    return errorResponse(
      429,
      "rate_limited",
      "This repository reached its hourly AI summary limit.",
      { "Retry-After": String(wait) }
    );
  await enqueueAiSummary(env, repository, pull.id, user.id, true);
  return dataResponse(await readState(env, repository, pull.id), 202);
}

type JobContext = {
  id: string;
  repository_id: string;
  pull_request_id: string;
  requested_by: string;
  force: number;
};

/**
 * Runs queued jobs from the scheduled handler, which allows a model call longer than the 30 seconds
 * `waitUntil` grants after a response. Safe to call concurrently: each job is claimed atomically.
 */
export async function drainAiSummaries(env: ForgeEnv): Promise<void> {
  if (!aiSummarySiteEnabled(env)) return;
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE forge_ai_summaries SET status = 'failed', error_code = 'timeout', updated_at = ? WHERE status = 'running' AND started_at < ?"
  )
    .bind(now, now - STALE_RUNNING_MS)
    .run();
  for (let handled = 0; handled < JOBS_PER_DRAIN && Date.now() - now < CLAIM_WINDOW_MS; handled++) {
    // A pull request never has two running jobs, so a head is not summarized twice concurrently.
    const job = await env.DB.prepare(
      "UPDATE forge_ai_summaries SET status = 'running', started_at = ?, updated_at = ? WHERE status = 'queued' AND id = (SELECT id FROM forge_ai_summaries AS queued WHERE status = 'queued' AND NOT EXISTS (SELECT 1 FROM forge_ai_summaries AS running WHERE running.pull_request_id = queued.pull_request_id AND running.status = 'running') ORDER BY created_at LIMIT 1) RETURNING id, repository_id, pull_request_id, requested_by, force"
    )
      .bind(Date.now(), Date.now())
      .first<JobContext>();
    if (!job) return;
    const logger = createLogger(env.LOG_LEVEL, {
      service: "ai-summary",
      repoId: job.repository_id,
    });
    try {
      await runJob(env, job, logger);
    } catch (cause) {
      logger.error("ai-summary:job-crashed", {
        jobId: job.id,
        error: cause instanceof Error ? cause.name : "unknown",
      });
      await failJob(env, job.id, "model_error");
    }
  }
}

async function failJob(env: ForgeEnv, id: string, code: AiSummaryErrorCode): Promise<void> {
  await env.DB.prepare(
    "UPDATE forge_ai_summaries SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ? AND status = 'running'"
  )
    .bind(code, Date.now(), id)
    .run();
}

async function dropJob(env: ForgeEnv, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM forge_ai_summaries WHERE id = ?").bind(id).run();
}

const ComparisonSchema = z.object({
  data: z.object({
    headOid: z.string().regex(/^[0-9a-f]{40}$/),
    truncated: z.boolean(),
    commits: z.array(z.object({ message: z.string() })),
    files: z.array(
      z.object({
        path: z.string(),
        type: z.enum(["added", "deleted", "modified"]),
        oldOid: z.string().nullable(),
        newOid: z.string().nullable(),
        patch: z.string().nullable(),
        binary: z.boolean(),
      })
    ),
  }),
});

const ModelOutputSchema = z.object({
  response: z.unknown().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).optional(),
});
const clip = (value: string, limit: number) => value.trim().slice(0, limit);
const LenientContentSchema = z.object({
  overview: z.string().transform((value) => clip(value, 1500)),
  notableChanges: z
    .array(z.string())
    .default([])
    .transform((items) =>
      items
        .map((item) => clip(item, 400))
        .filter(Boolean)
        .slice(0, 8)
    ),
  riskAreas: z
    .array(z.string())
    .default([])
    .transform((items) =>
      items
        .map((item) => clip(item, 400))
        .filter(Boolean)
        .slice(0, 6)
    ),
  reviewerFocus: z
    .array(z.string())
    .default([])
    .transform((items) =>
      items
        .map((item) => clip(item, 400))
        .filter(Boolean)
        .slice(0, 6)
    ),
});

function parseModelContent(output: unknown) {
  const raw = ModelOutputSchema.safeParse(output);
  if (!raw.success) return null;
  const text = raw.data.response ?? raw.data.choices?.[0]?.message.content;
  let candidate: unknown = text;
  if (typeof text === "string") {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      candidate = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  const lenient = LenientContentSchema.safeParse(candidate);
  if (!lenient.success) return null;
  const content = AiSummaryContentSchema.safeParse(lenient.data);
  return content.success ? content.data : null;
}

async function runJob(env: ForgeEnv, job: JobContext, logger: Logger): Promise<void> {
  const pull = await env.DB.prepare(
    "SELECT id, title, body, state, base_ref, head_ref, head_session_id FROM forge_pull_requests WHERE id = ?"
  )
    .bind(job.pull_request_id)
    .first<{
      id: string;
      title: string;
      body: string;
      state: string;
      base_ref: string;
      head_ref: string;
      head_session_id: string | null;
    }>();
  const repository = await env.DB.prepare(
    "SELECT repositories.*, namespaces.slug AS owner FROM repositories JOIN namespaces ON namespaces.id = repositories.namespace_id WHERE repositories.id = ? AND repositories.deleted_at IS NULL"
  )
    .bind(job.repository_id)
    .first<RepositoryRow>();
  const requester = await env.DB.prepare(
    "SELECT id, identifier, group_key, disabled_at FROM users WHERE id = ?"
  )
    .bind(job.requested_by)
    .first<{ id: string; identifier: string; group_key: string; disabled_at: number | null }>();
  if (!pull || !repository || pull.state !== "open") return dropJob(env, job.id);
  if (aiSummaryUnavailable(env, repository) || !requester || requester.disabled_at !== null) {
    logger.info("ai-summary:skipped", { jobId: job.id, reason: "disabled" });
    return failJob(env, job.id, "disabled");
  }
  if (
    repository.visibility === "private" &&
    (await repositoryRole(env.DB, repository.id, requester.id)) === null
  )
    return failJob(env, job.id, "diff_unavailable");

  const user: TrustedUser = {
    id: requester.id,
    identifier: requester.identifier,
    groupKey: requester.group_key,
  };
  const response = await env.GIT.fetch(
    new Request(compareRequest("https://git.internal", repository, pull, user), {
      signal: AbortSignal.timeout(COMPARE_TIMEOUT_MS),
    })
  ).catch(() => null);
  const comparison = response?.ok
    ? ComparisonSchema.safeParse(await response.json().catch(() => null))
    : null;
  if (!comparison?.success) {
    if (response && !response.ok) await response.body?.cancel();
    logger.warn("ai-summary:diff-unavailable", { jobId: job.id, status: response?.status ?? 0 });
    return failJob(env, job.id, "diff_unavailable");
  }
  const diff = comparison.data.data;

  if (!job.force) {
    const cached = await env.DB.prepare(
      "SELECT 1 AS found FROM forge_ai_summaries WHERE pull_request_id = ? AND head_oid = ? AND status = 'succeeded'"
    )
      .bind(pull.id, diff.headOid)
      .first<{ found: number }>();
    if (cached) {
      logger.info("ai-summary:cache-hit", { jobId: job.id, headOid: diff.headOid });
      return dropJob(env, job.id);
    }
  }
  if (!(await reserveModelCall(env, repository.id))) {
    logger.warn("ai-summary:rate-limited", { jobId: job.id });
    return failJob(env, job.id, "rate_limited");
  }

  const prompt = buildSummaryPrompt(
    {
      title: pull.title,
      body: pull.body,
      baseRef: pull.base_ref,
      headRef: pull.head_ref,
      commitMessages: diff.commits.map((commit) => commit.message),
      files: diff.files,
      comparisonTruncated: diff.truncated,
    },
    AI_SUMMARY_PROMPT_CHARS
  );
  const model = env.AI_SUMMARY_MODEL || AI_SUMMARY_DEFAULT_MODEL;
  const started = Date.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), AI_SUMMARY_TIMEOUT_MS);
  let output: Record<string, unknown>;
  try {
    if (!env.AI) throw new Error("AI binding missing");
    output = await Promise.race([
      env.AI.run(
        model,
        { messages: prompt.messages, max_tokens: MAX_TOKENS, temperature: 0.2 },
        { signal: deadline.signal }
      ),
      new Promise<never>((_, reject) =>
        deadline.signal.addEventListener("abort", () => reject(new Error("timeout")), {
          once: true,
        })
      ),
    ]);
  } catch (cause) {
    const timedOut = deadline.signal.aborted;
    logger.error("ai-summary:model-failed", {
      jobId: job.id,
      model,
      timedOut,
      durationMs: Date.now() - started,
      error: cause instanceof Error ? cause.name : "unknown",
    });
    return failJob(env, job.id, timedOut ? "timeout" : "model_error");
  } finally {
    clearTimeout(timer);
  }
  const content = parseModelContent(output);
  if (!content) {
    logger.warn("ai-summary:invalid-output", { jobId: job.id, model });
    return failJob(env, job.id, "invalid_output");
  }
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM forge_ai_summaries WHERE pull_request_id = ? AND head_oid = ? AND status = 'succeeded'"
    ).bind(pull.id, diff.headOid),
    env.DB.prepare(
      "UPDATE forge_ai_summaries SET status = 'succeeded', head_oid = ?, model = ?, summary_json = ?, truncated = ?, error_code = NULL, updated_at = ? WHERE id = ? AND status = 'running'"
    ).bind(
      diff.headOid,
      model,
      JSON.stringify(content),
      Number(prompt.truncated),
      Date.now(),
      job.id
    ),
    env.DB.prepare(
      "DELETE FROM forge_ai_summaries WHERE pull_request_id = ? AND status = 'succeeded' AND id NOT IN (SELECT id FROM forge_ai_summaries WHERE pull_request_id = ? AND status = 'succeeded' ORDER BY updated_at DESC, rowid DESC LIMIT ?)"
    ).bind(pull.id, pull.id, KEPT_SUMMARIES),
  ]);
  logger.info("ai-summary:generated", {
    jobId: job.id,
    model,
    headOid: diff.headOid,
    truncated: prompt.truncated,
    files: diff.files.length,
    durationMs: Date.now() - started,
  });
}

/** Drops stale usage counters and old failed jobs. */
export async function purgeAiSummaryRecords(env: Pick<ForgeEnv, "DB">): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM forge_ai_usage WHERE created_at < ?").bind(now - 2 * HOUR_MS),
    env.DB.prepare(
      "DELETE FROM forge_ai_summaries WHERE status = 'failed' AND updated_at < ?"
    ).bind(now - 7 * 24 * HOUR_MS),
  ]);
}
