import type { GitHubSyncJob, GitHubSyncStatus } from "../../../packages/contracts/src/github-sync";
import { importSealingKey, openText } from "../../../src/worker/common/secret-box";
import type { ForgeEnv } from "./common";
import type { StatementCondition } from "./notifications";

export interface GithubConnectionRow {
  id: string;
  repository_id: string;
  owner: string;
  name: string;
  github_repository_id: number;
  github_private: number;
  allow_visibility_mismatch: number;
  created_by: string;
  enabled: number;
  hook_id: number | null;
  callback_url: string;
  token_ciphertext: string;
  token_iv: string;
  secret_ciphertext: string;
  secret_iv: string;
  last_synced_at: number | null;
  lease_expires_at: number;
  retry_at: number;
  failure_count: number;
  error_code: string | null;
  created_at: number;
}
export interface GithubJobRow {
  id: string;
  connection_id: string;
  direction: "inbound" | "outbound";
  event: string;
  payload: string;
  status: GitHubSyncStatus;
  attempts: number;
  lease: string | null;
  error_code: string | null;
  created_at: number;
  completed_at: number | null;
}
export interface GithubCredentials {
  token: string;
  secret: string;
}
export class GithubSyncConflict extends Error {}
export type GithubResourceKind = "issue" | "pull_request" | "comment" | "review" | "review_comment";
export interface GithubMappingRow {
  connection_id: string;
  kind: GithubResourceKind;
  local_id: string;
  remote_id: string;
  remote_number: number | null;
  remote_fingerprint: string | null;
  local_fingerprint: string | null;
  remote_updated_at: number;
}

export async function githubConnection(
  db: D1Database,
  repositoryId: string
): Promise<GithubConnectionRow | null> {
  return db
    .prepare("SELECT * FROM forge_github_connections WHERE repository_id = ?")
    .bind(repositoryId)
    .first<GithubConnectionRow>();
}
export async function githubCredentials(
  env: ForgeEnv,
  row: GithubConnectionRow
): Promise<GithubCredentials> {
  const key = await importSealingKey(env.WEBHOOK_ENCRYPTION_KEY);
  if (!key) throw new Error("github_encryption_unavailable");
  return {
    token: await openText(key, { ciphertext: row.token_ciphertext, iv: row.token_iv }),
    secret: await openText(key, { ciphertext: row.secret_ciphertext, iv: row.secret_iv }),
  };
}
export function presentGithubJob(row: GithubJobRow): GitHubSyncJob {
  return {
    id: row.id,
    direction: row.direction,
    event: row.event,
    status: row.status,
    errorCode: row.error_code,
    attempts: row.attempts,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
export async function enqueueGithubJob(
  db: D1Database,
  connectionId: string,
  direction: GithubJobRow["direction"],
  event: string,
  payload: unknown,
  key = crypto.randomUUID()
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      "INSERT OR IGNORE INTO forge_github_jobs (id, connection_id, direction, event, payload, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)"
    )
    .bind(key, connectionId, direction, event, JSON.stringify(payload), now, now)
    .run();
}

export async function githubMapping(
  db: D1Database,
  connectionId: string,
  kind: GithubResourceKind,
  identity: { localId: string } | { remoteId: string }
): Promise<GithubMappingRow | null> {
  const column = "localId" in identity ? "local_id" : "remote_id";
  const id = "localId" in identity ? identity.localId : identity.remoteId;
  return db
    .prepare(
      `SELECT * FROM forge_github_mappings WHERE connection_id = ? AND kind = ? AND ${column} = ?`
    )
    .bind(connectionId, kind, id)
    .first<GithubMappingRow>();
}
export function githubMappingStatement(
  db: D1Database,
  mapping: GithubMappingRow
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO forge_github_mappings (connection_id, kind, local_id, remote_id, remote_number, remote_fingerprint, local_fingerprint, remote_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(connection_id, kind, local_id) DO UPDATE SET remote_id=excluded.remote_id, remote_number=excluded.remote_number, remote_fingerprint=excluded.remote_fingerprint, local_fingerprint=excluded.local_fingerprint, remote_updated_at=excluded.remote_updated_at"
    )
    .bind(
      mapping.connection_id,
      mapping.kind,
      mapping.local_id,
      mapping.remote_id,
      mapping.remote_number,
      mapping.remote_fingerprint,
      mapping.local_fingerprint,
      mapping.remote_updated_at
    );
}
export async function applyGithubInbound(
  db: D1Database,
  connectionId: string,
  statements: D1PreparedStatement[],
  guard?: StatementCondition
): Promise<void> {
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO forge_github_inbound (connection_id, guard) VALUES (?, ${guard ? `CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END` : "1"})`
        )
        .bind(connectionId, ...(guard?.binds ?? [])),
      ...statements,
      db.prepare("DELETE FROM forge_github_inbound WHERE connection_id = ?").bind(connectionId),
    ]);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("github_sync_guard"))
      throw new GithubSyncConflict("concurrent_local_edit");
    throw cause;
  }
}
