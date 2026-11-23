import { z } from "zod";
import {
  DEFAULT_RUNNER_TYPE_PRIORITY,
  RunnerTypePrioritySchema,
  type GithubQuota,
  type GithubQuotaState,
  type RunnerSettings,
  type RunnerType,
} from "../../../packages/contracts/src/runners";
import { createLogger } from "../../../src/worker/common/logger";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { storedSourceCredential } from "./signing/services";

export interface QuotaEnv {
  DB: D1Database;
  LOG_LEVEL?: string;
  SIGNING_ENCRYPTION_KEY?: string;
}

const REFRESH_INTERVAL_MS = 15 * 60_000;
const MANUAL_REFRESH_MIN_MS = 10_000;
const CRON_REFRESH_LIMIT = 5;
export const BILLING_BLOCKED_MESSAGE =
  "GitHub refused to start jobs: account payment failed or spending limit reached.";
const FORBIDDEN_MESSAGE =
  'GitHub rejected the token. It needs the fine-grained "Plan: read" permission or the classic "user" scope.';

interface AccountScope {
  namespaceId: string;
  runnerRepositoryId: string | null;
}

interface QuotaRow {
  state: GithubQuotaState;
  included_used_usd: number;
  paid_usd: number;
  minutes_json: string;
  message: string | null;
  checked_at: number | null;
}

const userSchema = z.object({ login: z.string().min(1).max(100) }).passthrough();
const summarySchema = z
  .object({
    usageItems: z.array(
      z
        .object({
          sku: z.string(),
          unitType: z.string().optional(),
          grossQuantity: z.number(),
          discountAmount: z.number(),
          netAmount: z.number(),
        })
        .passthrough()
    ),
  })
  .passthrough();
const minutesSchema = z.array(z.object({ sku: z.string(), minutes: z.number() }));

export async function accountScope(db: D1Database, userId: string): Promise<AccountScope | null> {
  const row = await db
    .prepare(
      `SELECT n.id AS namespace_id,r.id AS repository_id FROM namespaces n
      LEFT JOIN repositories r ON r.namespace_id=n.id AND r.system_kind='account_runner' AND r.deleted_at IS NULL
      WHERE n.kind='personal' AND n.created_by=?`
    )
    .bind(userId)
    .first<{ namespace_id: string; repository_id: string | null }>();
  return row ? { namespaceId: row.namespace_id, runnerRepositoryId: row.repository_id } : null;
}

export async function readRunnerSettings(
  db: D1Database,
  namespaceId: string
): Promise<RunnerSettings> {
  const row = await db
    .prepare(
      "SELECT type_priority_json,github_included_usd,colab_enabled FROM actions_runner_settings WHERE namespace_id=?"
    )
    .bind(namespaceId)
    .first<{
      type_priority_json: string;
      github_included_usd: number | null;
      colab_enabled: number;
    }>();
  if (!row)
    return {
      typePriority: [...DEFAULT_RUNNER_TYPE_PRIORITY],
      githubIncludedUsd: null,
      colabEnabled: false,
    };
  let parsed: ReturnType<typeof RunnerTypePrioritySchema.safeParse>;
  try {
    parsed = RunnerTypePrioritySchema.safeParse(JSON.parse(row.type_priority_json));
  } catch {
    parsed = RunnerTypePrioritySchema.safeParse(null);
  }
  return {
    typePriority: parsed.success ? parsed.data : [...DEFAULT_RUNNER_TYPE_PRIORITY],
    githubIncludedUsd: row.github_included_usd,
    colabEnabled: row.colab_enabled === 1,
  };
}

export async function readTypePriority(db: D1Database, namespaceId: string): Promise<RunnerType[]> {
  return (await readRunnerSettings(db, namespaceId)).typePriority;
}

export function quotaState(
  includedUsedUsd: number,
  paidUsd: number,
  includedLimitUsd: number | null
): "ok" | "exhausted" {
  return paidUsd > 0 || (includedLimitUsd !== null && includedUsedUsd >= includedLimitUsd)
    ? "exhausted"
    : "ok";
}

export async function writeRunnerSettings(
  db: D1Database,
  namespaceId: string,
  settings: RunnerSettings
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO actions_runner_settings (namespace_id,type_priority_json,github_included_usd,colab_enabled,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(namespace_id) DO UPDATE SET type_priority_json=excluded.type_priority_json,
        github_included_usd=excluded.github_included_usd,colab_enabled=excluded.colab_enabled,updated_at=excluded.updated_at`
    )
    .bind(
      namespaceId,
      JSON.stringify(settings.typePriority),
      settings.githubIncludedUsd,
      settings.colabEnabled ? 1 : 0,
      now
    )
    .run();
  // A changed included-quota ceiling takes effect without waiting for the next GitHub read.
  await db
    .prepare(
      `UPDATE actions_github_quota SET state=CASE
        WHEN paid_usd>0 OR (?1 IS NOT NULL AND included_used_usd>=?1) THEN 'exhausted' ELSE 'ok' END
      WHERE namespace_id=?2 AND state IN ('ok','exhausted') AND message IS NOT ?3`
    )
    .bind(settings.githubIncludedUsd, namespaceId, BILLING_BLOCKED_MESSAGE)
    .run();
}

function presentQuota(row: QuotaRow): GithubQuota {
  let minutes: GithubQuota["minutes"] = [];
  try {
    const parsed = minutesSchema.safeParse(JSON.parse(row.minutes_json));
    if (parsed.success) minutes = parsed.data;
  } catch {
    // Unreadable cached minutes are shown as empty until the next refresh.
  }
  return {
    state: row.state,
    includedUsedUsd: row.included_used_usd,
    paidUsd: row.paid_usd,
    minutes,
    checkedAt: row.checked_at,
    message: row.message,
  };
}

async function hasSourceToken(db: D1Database, userId: string, repositoryId: string | null) {
  if (!repositoryId) return false;
  const row = await db
    .prepare(
      "SELECT 1 AS present FROM actions_signing_source_token WHERE owner_id=? AND repository_id=?"
    )
    .bind(userId, repositoryId)
    .first();
  return row !== null;
}

export async function readGithubQuota(
  db: D1Database,
  userId: string,
  scope: AccountScope | null
): Promise<GithubQuota> {
  const empty: GithubQuota = {
    state: "no-token",
    includedUsedUsd: 0,
    paidUsd: 0,
    minutes: [],
    checkedAt: null,
    message: null,
  };
  if (!scope || !(await hasSourceToken(db, userId, scope.runnerRepositoryId))) return empty;
  const row = await db
    .prepare("SELECT * FROM actions_github_quota WHERE namespace_id=?")
    .bind(scope.namespaceId)
    .first<QuotaRow>();
  // A token added after the last check has not been read yet.
  if (!row || row.state === "no-token") return { ...empty, state: "ok" };
  return presentQuota(row);
}

type Reading =
  | { kind: "usage"; includedUsedUsd: number; paidUsd: number; minutes: GithubQuota["minutes"] }
  | { kind: "failure"; state: "forbidden" | "error"; message: string };

async function githubGet(token: string, path: string): Promise<unknown | Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "gitedge",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return response;
  }
  return readJsonLimited(response, 1_048_576);
}

const monthStart = (now: number) =>
  Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);

const cents = (value: number) => Math.round(value * 100) / 100;

async function readGithubUsage(token: string, now: Date): Promise<Reading> {
  const failure = (response: Response): Reading =>
    [401, 403, 404].includes(response.status)
      ? { kind: "failure", state: "forbidden", message: FORBIDDEN_MESSAGE }
      : {
          kind: "failure",
          state: "error",
          message: `GitHub returned status ${response.status}.`,
        };
  try {
    const profile = await githubGet(token, "/user");
    if (profile instanceof Response) return failure(profile);
    const user = userSchema.safeParse(profile);
    if (!user.success)
      return { kind: "failure", state: "error", message: "GitHub returned an unexpected profile." };
    const usage = await githubGet(
      token,
      `/users/${encodeURIComponent(user.data.login)}/settings/billing/usage/summary?product=actions&year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`
    );
    if (usage instanceof Response) return failure(usage);
    const summary = summarySchema.safeParse(usage);
    if (!summary.success)
      return {
        kind: "failure",
        state: "error",
        message: "GitHub returned an unexpected usage summary.",
      };
    let included = 0;
    let paid = 0;
    const minutes = new Map<string, number>();
    for (const item of summary.data.usageItems) {
      included += item.discountAmount;
      paid += item.netAmount;
      if (item.grossQuantity > 0 && (!item.unitType || /minute/i.test(item.unitType)))
        minutes.set(item.sku, (minutes.get(item.sku) ?? 0) + item.grossQuantity);
    }
    return {
      kind: "usage",
      includedUsedUsd: cents(included),
      paidUsd: cents(paid),
      minutes: [...minutes].map(([sku, value]) => ({ sku, minutes: Math.round(value) })),
    };
  } catch {
    return { kind: "failure", state: "error", message: "GitHub could not be reached." };
  }
}

export async function refreshGithubQuota(
  env: QuotaEnv,
  userId: string,
  options: { manual?: boolean } = {}
): Promise<GithubQuota> {
  const logger = createLogger(env.LOG_LEVEL, { service: "github-quota" });
  const scope = await accountScope(env.DB, userId);
  if (!scope) return readGithubQuota(env.DB, userId, null);
  const now = Date.now();
  const cached = await env.DB.prepare("SELECT * FROM actions_github_quota WHERE namespace_id=?")
    .bind(scope.namespaceId)
    .first<QuotaRow>();
  // The billing summary cannot see a payment refusal, so only a manual refresh or a new month clears it.
  if (
    !options.manual &&
    cached?.message === BILLING_BLOCKED_MESSAGE &&
    (cached.checked_at ?? 0) >= monthStart(now)
  )
    return presentQuota(cached);
  if (
    options.manual &&
    cached?.checked_at != null &&
    now - cached.checked_at < MANUAL_REFRESH_MIN_MS &&
    cached.state !== "no-token"
  )
    return presentQuota(cached);
  let token: string | null = null;
  let keyMissing = false;
  if (scope.runnerRepositoryId) {
    if (!env.SIGNING_ENCRYPTION_KEY) keyMissing = true;
    else
      token = await storedSourceCredential(
        { DB: env.DB, SIGNING_ENCRYPTION_KEY: env.SIGNING_ENCRYPTION_KEY },
        userId,
        scope.runnerRepositoryId
      );
  }
  const write = (
    state: GithubQuotaState,
    values: { included: number; paid: number; minutes: GithubQuota["minutes"] } | null,
    message: string | null
  ) =>
    env.DB.prepare(
      `INSERT INTO actions_github_quota (namespace_id,state,included_used_usd,paid_usd,minutes_json,message,checked_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7)
      ON CONFLICT(namespace_id) DO UPDATE SET state=excluded.state,message=excluded.message,checked_at=excluded.checked_at,
        included_used_usd=CASE WHEN ?8=1 THEN excluded.included_used_usd ELSE included_used_usd END,
        paid_usd=CASE WHEN ?8=1 THEN excluded.paid_usd ELSE paid_usd END,
        minutes_json=CASE WHEN ?8=1 THEN excluded.minutes_json ELSE minutes_json END`
    )
      .bind(
        scope.namespaceId,
        state,
        values?.included ?? 0,
        values?.paid ?? 0,
        JSON.stringify(values?.minutes ?? []),
        message,
        now,
        values || state === "no-token" ? 1 : 0
      )
      .run();
  if (!token) {
    if (keyMissing) logger.warn("github-quota:key-missing", { namespaceId: scope.namespaceId });
    await write(
      keyMissing ? "error" : "no-token",
      null,
      keyMissing ? "Token storage is not configured." : null
    );
  } else {
    const reading = await readGithubUsage(token, new Date(now));
    if (reading.kind === "failure") {
      await write(reading.state, null, reading.message);
      logger.warn("github-quota:refresh-failed", {
        namespaceId: scope.namespaceId,
        state: reading.state,
      });
    } else {
      const limit = (await readRunnerSettings(env.DB, scope.namespaceId)).githubIncludedUsd;
      const state = quotaState(reading.includedUsedUsd, reading.paidUsd, limit);
      await write(
        state,
        { included: reading.includedUsedUsd, paid: reading.paidUsd, minutes: reading.minutes },
        null
      );
      logger.info("github-quota:refreshed", { namespaceId: scope.namespaceId, state });
    }
  }
  const row = await env.DB.prepare("SELECT * FROM actions_github_quota WHERE namespace_id=?")
    .bind(scope.namespaceId)
    .first<QuotaRow>();
  return row ? presentQuota(row) : readGithubQuota(env.DB, userId, scope);
}

// Accounts with GitHub-hosted fallback enabled are the only ones whose dispatch depends on the quota.
export async function refreshDueGithubQuotas(env: QuotaEnv): Promise<void> {
  const logger = createLogger(env.LOG_LEVEL, { service: "github-quota" });
  let owners: string[];
  try {
    const due = await env.DB.prepare(
      `SELECT s.owner_id FROM forge_hosted_runner_settings s JOIN users u ON u.id=s.owner_id AND u.disabled_at IS NULL
      JOIN namespaces n ON n.kind='personal' AND n.created_by=s.owner_id
      LEFT JOIN actions_github_quota q ON q.namespace_id=n.id
      WHERE (q.checked_at IS NULL OR q.checked_at<?) AND NOT (q.message=? AND q.checked_at>=?)
      ORDER BY COALESCE(q.checked_at,0) LIMIT ?`
    )
      .bind(
        Date.now() - REFRESH_INTERVAL_MS,
        BILLING_BLOCKED_MESSAGE,
        monthStart(Date.now()),
        CRON_REFRESH_LIMIT
      )
      .all<{ owner_id: string }>();
    owners = due.results.map((row) => row.owner_id);
  } catch (cause) {
    logger.error("github-quota:due-query-failed", {
      reason: cause instanceof Error ? cause.message : "unknown",
    });
    return;
  }
  for (const owner of owners) {
    try {
      await refreshGithubQuota(env, owner);
    } catch (cause) {
      logger.error("github-quota:refresh-threw", {
        reason: cause instanceof Error ? cause.message : "unknown",
      });
    }
  }
}
