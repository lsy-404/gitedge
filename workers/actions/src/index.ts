import {
  cancelRunnerRun,
  expireRunnerRuns,
  getRunnerRun,
  queueRunnerRun,
  runnerMachineRequest,
  runnerManagement,
} from "./runners";
import { parseRunnerWorkflow, runnerDispatchInputs } from "./runner-workflow";
import { queueGithubRunner, expireGithubRunners } from "./github-runners";
import { cleanRunnerSchedulingData } from "./runner-scheduler";
import { handleRunnerHistory, handleRunnerOverview } from "./runner-overview";
import {
  runDueRunnerSchedules,
  syncRunnerSchedules,
  type ScheduledDefinitions,
} from "./runner-schedules";
import { deliverCheck, publishCheck } from "./check-delivery";
import type { MergeCandidateRecord } from "../../../packages/contracts/src/merge-candidates";
import { readJsonLimited } from "../../../src/worker/common/readText";
import {
  GitOidSchema,
  accessTokenAllows,
  accessTokenAllowsRepository,
  trustedHeaders,
  readTrustedUser,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import {
  isActionWorkflowPath,
  type ActionRunArtifact,
  type ActionEventType,
  type ActionCacheOutcome,
  type ActionRun as ActionRunDetails,
  type ActionRunSummary,
  type ActionWorkflow,
  type ActionWorkflowFile,
} from "../../../packages/contracts/src/actions";
import type {
  RepositorySnapshot,
  RepositorySnapshotFile,
} from "../../../packages/contracts/src/repository-controls";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole, writableRole } from "../../../src/worker/common/repositories";
import {
  parseWorkflow,
  WorkflowValidationError,
  workflowFiles,
  workflowMatchesEvent,
} from "./workflow";
import {
  ActionRun as ActionRunDurableObject,
  type ActionOutputMetadata,
  type ActionRunInput,
} from "./run";
import { base64ToBytes, bytesToBase64 } from "../../../src/worker/common/encoding";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { handleGitTransfer } from "./git-transfer";
import {
  createSigningExecutionHooks,
  handleSigningRoute,
  reconcileSigningRequests,
} from "./signing";
import { enqueueNativeSigningRun } from "./signing-execution";

export { ActionRunDurableObject as ActionRun };
export { GitTransfer } from "./git-transfer";
export { SigningCoordinator } from "./signing";

const MAX_SNAPSHOT_FILES = 2048;
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;
const TRANSFER_CHUNK_BYTES = 48 * 1024;
const MAX_TRANSFER_CHUNKS = 768;
const MAX_CACHE_ENTRIES_PER_REPOSITORY = 5;
const MAX_RUN_LIST = 20;
const CHECK_SCAN_LIMIT = 20;
const CHECK_RETRY_MS = 60_000;
const MISSING_RUN_TIMEOUT_MS = 150_000;

interface ActionsEnv extends Cloudflare.Env {
  readonly DB: D1Database;
  readonly GIT: Fetcher;
  readonly FORGE: Fetcher;
  readonly AUTH: Fetcher;
  readonly RELEASE_ASSETS: R2Bucket;
  readonly LOG_LEVEL?: string;
}

function signingExecutionHooks(env: ActionsEnv) {
  return createSigningExecutionHooks(env, {
    enqueue: (input) => enqueueNativeSigningRun(env, input),
  });
}

interface RepositoryRow {
  readonly id: string;
  readonly visibility: "public" | "private";
  readonly archived: number;
  readonly actions_enabled: number;
  readonly actions_network_enabled: number;
  readonly actions_runner_enabled: number;
  readonly default_branch: string;
  readonly system_kind: "account_runner" | null;
}

interface PendingCheckRow {
  readonly executor: "container" | "runner";
  readonly id: string;
  readonly repository_id: string;
  readonly created_at: number;
  readonly check_last_attempt_at: number | null;
  readonly check_status: "queued" | "in_progress" | "completed" | null;
  readonly check_conclusion: "success" | "failure" | "cancelled" | null;
}

interface CacheEntryRow {
  readonly object_key: string;
  readonly size: number;
  readonly sha256: string;
}

interface ArtifactRow {
  readonly name: string;
  readonly object_key: string;
  readonly size: number;
  readonly sha256: string;
  readonly created_at: number;
}

interface ActionRunStub {
  isContainerConfigured(): Promise<boolean>;
  initialize(input: ActionRunInput, chunks: number, cacheChunks: number): Promise<void>;
  writeInputChunk(index: number, chunk: string): Promise<void>;
  writeCacheChunk(index: number, chunk: string): Promise<void>;
  discardCacheInput(): Promise<void>;
  schedule(): Promise<void>;
  getRun(): Promise<ActionRunDetails | null>;
  getOutputMetadata(): Promise<readonly ActionOutputMetadata[]>;
  readOutputChunk(name: string, index: number): Promise<string | null>;
  markOutputPublished(name: string, artifact: ActionRunArtifact | null): Promise<void>;
  markArtifactFailed(name: string, message: string): Promise<void>;
  markArtifactSkipped(name: string): Promise<void>;
  markCacheSaved(): Promise<void>;
  markCacheFailed(): Promise<void>;
  setCacheOutcome(outcome: ActionCacheOutcome): Promise<void>;
  cancel(): Promise<ActionRunDetails | null>;
  failStaleRun(): Promise<ActionRunDetails | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function repositoryFor(env: ActionsEnv, id: string): Promise<RepositoryRow | null> {
  return env.DB.prepare(
    "SELECT id, visibility, archived, actions_enabled, actions_network_enabled, actions_runner_enabled, default_branch, system_kind FROM repositories WHERE id = ? AND deleted_at IS NULL"
  )
    .bind(id)
    .first<RepositoryRow>();
}

function parseRepositoryWorkflow(
  repo: RepositoryRow,
  path: string,
  source: string
): ActionWorkflow {
  const workflow =
    repo.actions_runner_enabled === 1 && path.startsWith(".github/")
      ? parseRunnerWorkflow(path, source).workflow
      : parseWorkflow(path, source);
  if (workflow.schedules?.length && repo.system_kind !== "account_runner")
    throw new WorkflowValidationError(
      "Cron workflows require the account's private Runner repository."
    );
  return workflow;
}

async function readScheduledDefinitions(
  env: ActionsEnv,
  repositoryId: string,
  branch: string,
  user: TrustedUser
): Promise<ScheduledDefinitions> {
  const repo = await repositoryFor(env, repositoryId);
  if (
    !repo ||
    repo.system_kind !== "account_runner" ||
    !(await canWriteRepository(env, repo, user))
  )
    throw new Error("Scheduled Runner repository is unavailable.");
  const snapshot = await repositorySnapshot(env, repositoryId, branch, undefined, user, true);
  const definitions = [];
  for (const file of workflowFiles(snapshot.files)) {
    if (!file.path.startsWith(".github/")) continue;
    const source = snapshotFile(snapshot, file.path);
    if (source === null) continue;
    try {
      definitions.push(parseRunnerWorkflow(file.path, source));
    } catch {
      /* Invalid definitions cannot retain an active schedule. */
    }
  }
  return { oid: snapshot.oid, definitions };
}

async function activeSession(
  env: ActionsEnv,
  user: TrustedUser,
  repositoryId: string
): Promise<boolean> {
  const session = user.agentSession;
  if (!session) return true;
  if (session.repositoryId !== repositoryId) return false;
  const row = await env.DB.prepare(
    "SELECT 1 AS found FROM auth_agent_sessions JOIN auth_agents ON auth_agents.id = auth_agent_sessions.agent_id WHERE auth_agent_sessions.id = ? AND auth_agent_sessions.user_id = ? AND auth_agent_sessions.repository_id = ? AND auth_agent_sessions.status = 'active' AND auth_agent_sessions.expires_at > ? AND auth_agents.disabled_at IS NULL AND EXISTS (SELECT 1 FROM repositories r WHERE r.id = auth_agent_sessions.repository_id AND ((r.system_kind = 'account_runner' AND r.created_by = auth_agent_sessions.user_id) OR (r.system_kind IS NULL AND (EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id = r.namespace_id AND m.user_id = auth_agent_sessions.user_id) OR EXISTS (SELECT 1 FROM repository_collaborators c WHERE c.repository_id = r.id AND c.user_id = auth_agent_sessions.user_id)))))"
  )
    .bind(session.id, user.id, repositoryId, Date.now())
    .first<{ found: number }>();
  return row !== null;
}

async function canReadRepository(
  env: ActionsEnv,
  repo: RepositoryRow,
  user: TrustedUser | null
): Promise<boolean> {
  if (
    user?.token &&
    (!accessTokenAllowsRepository(user.token, repo.id) ||
      !accessTokenAllows(user.token, "repo:read"))
  )
    return false;
  if (repo.visibility === "public") {
    if (!user?.agentSession) return true;
  }
  if (!user) return false;
  if (!(await activeSession(env, user, repo.id))) return false;
  if (repo.visibility === "public" && !user.agentSession) return true;
  return (await repositoryRole(env.DB, repo.id, user.id)) !== null;
}

async function canWriteRepository(
  env: ActionsEnv,
  repo: RepositoryRow,
  user: TrustedUser
): Promise<boolean> {
  if (
    user.token &&
    (!accessTokenAllowsRepository(user.token, repo.id) ||
      !accessTokenAllows(user.token, "repo:write"))
  )
    return false;
  if (!(await activeSession(env, user, repo.id))) return false;
  const role = await repositoryRole(env.DB, repo.id, user.id);
  if (user.agentSession) return user.agentSession.permission === "write" && writableRole(role);
  return writableRole(role);
}

function validRepoPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 2000 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function validateSnapshot(value: unknown): RepositorySnapshot {
  if (!isRecord(value) || !isRecord(value.data))
    throw new Error("Git service returned an invalid repository snapshot.");
  const data = value.data;
  if (
    typeof data.oid !== "string" ||
    !GitOidSchema.safeParse(data.oid).success ||
    !Array.isArray(data.files) ||
    data.files.length > MAX_SNAPSHOT_FILES ||
    typeof data.totalBytes !== "number" ||
    data.totalBytes < 0 ||
    data.totalBytes > MAX_SNAPSHOT_BYTES
  )
    throw new Error("Repository snapshot exceeds 2,048 files or 24 MiB.");
  let actualBytes = 0;
  const seen = new Set<string>();
  const files: RepositorySnapshotFile[] = [];
  const rawFiles: unknown[] = data.files;
  for (const entry of rawFiles) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !validRepoPath(entry.path) ||
      typeof entry.contentBase64 !== "string" ||
      typeof entry.mode !== "string"
    ) {
      throw new Error("Repository snapshot contains an invalid file.");
    }
    if (seen.has(entry.path)) throw new Error("Repository snapshot contains duplicate paths.");
    seen.add(entry.path);
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new Error("Repository snapshot contains a symlink, gitlink, or unsupported file mode.");
    }
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.contentBase64)
    ) {
      throw new Error("Repository snapshot contains invalid file data.");
    }
    const encoded = atob(entry.contentBase64);
    actualBytes += encoded.length;
    if (actualBytes > MAX_SNAPSHOT_BYTES) throw new Error("Repository snapshot exceeds 24 MiB.");
    files.push({ path: entry.path, contentBase64: entry.contentBase64, mode: entry.mode });
  }
  if (actualBytes !== data.totalBytes)
    throw new Error("Repository snapshot size did not match its contents.");
  return { oid: data.oid, files, totalBytes: actualBytes };
}

async function repositorySnapshot(
  env: ActionsEnv,
  repositoryId: string,
  ref: string,
  oid: string | undefined,
  user: TrustedUser | null,
  workflowsOnly: boolean,
  sessionId?: string | null
): Promise<RepositorySnapshot> {
  const url = new URL(
    `https://git.internal/repositories/${encodeURIComponent(repositoryId)}/snapshot`
  );
  url.searchParams.set("ref", ref);
  if (sessionId) url.searchParams.set("sessionId", sessionId);
  if (oid) url.searchParams.set("oid", oid);
  if (workflowsOnly) url.searchParams.set("scope", "workflows");
  const response = await env.GIT.fetch(
    new Request(url, { headers: trustedHeaders(user ?? undefined) })
  );
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "Commit was not found in this repository."
        : "Unable to load repository source."
    );
  return validateSnapshot(await readResponseJsonLimited(response, 40 * 1024 * 1024));
}

async function readResponseJsonLimited(response: Response, maximumBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error("Repository snapshot response exceeds the Actions transfer limit.");
  }
  if (!response.body) throw new Error("Git service returned an empty repository snapshot.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("Repository snapshot response exceeds the Actions transfer limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Git service returned invalid snapshot JSON.");
  }
}

function snapshotFile(snapshot: RepositorySnapshot, path: string): string | null {
  const file = snapshot.files.find((entry) => entry.path === path);
  if (!file) return null;
  try {
    const bytes = base64ToBytes(file.contentBase64);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function cacheKeyFor(
  repositoryId: string,
  ref: string,
  eventType: ActionEventType,
  workflow: ActionWorkflow,
  snapshot: RepositorySnapshot
): Promise<{ readonly cacheKey: string; readonly lockfileHash: string } | null> {
  if (!workflow.cache) return null;
  const keyParts: string[] = [];
  for (const path of workflow.cache.keyFiles) {
    const file = snapshot.files.find((entry) => entry.path === path);
    if (!file) return null;
    keyParts.push(`${path}\0${await sha256(base64ToBytes(file.contentBase64))}`);
  }
  const lockfileHash = await sha256(new TextEncoder().encode(keyParts.join("\n")));
  const identity = [repositoryId, eventType, ref, workflow.path, lockfileHash].join("\0");
  return { cacheKey: await sha256(new TextEncoder().encode(identity)), lockfileHash };
}

function cacheObjectKey(repositoryId: string, cacheKey: string): string {
  return `actions/cache/${repositoryId}/${cacheKey}.tar.gz`;
}

async function writeCacheObjectToRun(
  stub: ActionRunStub,
  body: ReadableStream<Uint8Array>,
  expectedSize: number
): Promise<number> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  let total = 0;
  let index = 0;
  const writeChunk = async (bytes: Uint8Array): Promise<void> => {
    if (!bytes.length) return;
    await stub.writeCacheChunk(index, bytesToBase64(bytes));
    index += 1;
    total += bytes.length;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      let offset = 0;
      if (buffer.length) {
        const take = Math.min(TRANSFER_CHUNK_BYTES - buffer.length, value.length);
        const joined = new Uint8Array(buffer.length + take);
        joined.set(buffer);
        joined.set(value.subarray(0, take), buffer.length);
        offset = take;
        buffer = new Uint8Array(0);
        if (joined.length === TRANSFER_CHUNK_BYTES) await writeChunk(joined);
        else buffer = joined;
      }
      while (offset + TRANSFER_CHUNK_BYTES <= value.length) {
        await writeChunk(value.subarray(offset, offset + TRANSFER_CHUNK_BYTES));
        offset += TRANSFER_CHUNK_BYTES;
      }
      if (offset < value.length) buffer = value.slice(offset);
      if (total > expectedSize) throw new Error("Cache object exceeded its recorded size.");
    }
    if (buffer.length) await writeChunk(buffer);
  } catch (cause) {
    await reader.cancel();
    throw cause;
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedSize) throw new Error("Cache object size did not match its metadata.");
  return index;
}

function fileJsonParts(file: RepositorySnapshotFile): {
  prefix: string;
  content: string;
  suffix: string;
} {
  return {
    prefix: `{"path":${JSON.stringify(file.path)},"contentBase64":"`,
    content: file.contentBase64,
    suffix: `","mode":${JSON.stringify(file.mode)}}`,
  };
}

function snapshotJsonLength(files: readonly RepositorySnapshotFile[]): number {
  return (
    2 +
    files.reduce((length, file, index) => {
      const parts = fileJsonParts(file);
      return (
        length + (index ? 1 : 0) + parts.prefix.length + parts.content.length + parts.suffix.length
      );
    }, 0)
  );
}

async function writeSnapshotChunks(
  stub: ActionRunStub,
  files: readonly RepositorySnapshotFile[],
  expectedChunks: number
): Promise<void> {
  let pending = "[";
  let index = 0;
  const append = async (text: string): Promise<void> => {
    let offset = 0;
    while (offset < text.length) {
      const piece = text.slice(offset, offset + TRANSFER_CHUNK_BYTES - pending.length);
      pending += piece;
      offset += piece.length;
      if (pending.length === TRANSFER_CHUNK_BYTES) {
        await stub.writeInputChunk(index, pending);
        index += 1;
        pending = "";
      }
    }
  };
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    if (!file) continue;
    if (fileIndex) await append(",");
    const parts = fileJsonParts(file);
    await append(parts.prefix);
    await append(parts.content);
    await append(parts.suffix);
  }
  await append("]");
  if (pending.length) {
    await stub.writeInputChunk(index, pending);
    index += 1;
  }
  if (index !== expectedChunks)
    throw new Error("Serialized repository snapshot chunk count changed.");
}

function actionStub(env: ActionsEnv, id: string): ActionRunStub {
  const namespace = env.ACTION_RUNS;
  if (!namespace) throw new Error("Action container binding is unavailable.");
  return namespace.getByName(id);
}

function toSummary(run: ActionRunDetails): ActionRunSummary {
  return {
    id: run.id,
    commitOid: run.commitOid,
    workflowPath: run.workflowPath,
    workflowName: run.workflowName,
    ref: run.ref,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    status: run.status,
    conclusion: run.conclusion,
    cacheOutcome: run.cacheOutcome,
    artifactCount: run.artifacts.length,
    ...(run.executor ? { executor: run.executor } : {}),
  };
}

function outputBody(stub: ActionRunStub, output: ActionOutputMetadata): ReadableStream<Uint8Array> {
  let index = 0;
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index === output.chunks) {
        if (total !== output.size)
          controller.error(new Error("Action output size did not match its manifest."));
        else controller.close();
        return;
      }
      const encoded = await stub.readOutputChunk(output.name, index);
      if (encoded === null) {
        controller.error(new Error("Action output transfer chunk is missing."));
        return;
      }
      const bytes = base64ToBytes(encoded);
      index += 1;
      total += bytes.byteLength;
      if (total > output.size) {
        controller.error(new Error("Action output exceeded its manifest size."));
        return;
      }
      controller.enqueue(bytes);
    },
  });
}

async function evictOldCaches(
  env: ActionsEnv,
  repositoryId: string,
  keepCacheKey: string
): Promise<void> {
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM actions_cache_entries WHERE repository_id = ?"
  )
    .bind(repositoryId)
    .first<{ count: number }>();
  let remaining = count?.count ?? 0;
  while (remaining > MAX_CACHE_ENTRIES_PER_REPOSITORY) {
    const oldest = await env.DB.prepare(
      "SELECT cache_key, object_key FROM actions_cache_entries WHERE repository_id = ? AND cache_key != ? ORDER BY last_used_at ASC, created_at ASC LIMIT 1"
    )
      .bind(repositoryId, keepCacheKey)
      .first<{ cache_key: string; object_key: string }>();
    if (!oldest) return;
    await env.RELEASE_ASSETS.delete(oldest.object_key);
    await env.DB.prepare(
      "DELETE FROM actions_cache_entries WHERE repository_id = ? AND cache_key = ?"
    )
      .bind(repositoryId, oldest.cache_key)
      .run();
    remaining -= 1;
  }
}

async function publishActionOutputs(
  env: ActionsEnv,
  runId: string,
  stub: ActionRunStub
): Promise<void> {
  const run = await stub.getRun();
  if (!run || run.status !== "completed") return;
  const outputs = await stub.getOutputMetadata();
  if (!outputs.length) return;
  const row = await env.DB.prepare(
    "SELECT repository_id, cache_key, lockfile_hash, cache_event_type, source_ref, path FROM actions_runs WHERE id = ?"
  )
    .bind(runId)
    .first<{
      repository_id: string;
      cache_key: string | null;
      lockfile_hash: string | null;
      cache_event_type: ActionEventType | null;
      source_ref: string;
      path: string;
    }>();
  if (!row) return;
  for (const output of outputs) {
    const objectKey =
      output.kind === "cache"
        ? row.cache_key
          ? cacheObjectKey(row.repository_id, row.cache_key)
          : null
        : `actions/artifacts/${row.repository_id}/${runId}/${output.name}.tar.gz`;
    if (!objectKey) {
      if (output.kind === "cache") await stub.markCacheFailed();
      else await stub.markArtifactFailed(output.name, "Artifact metadata is missing.");
      continue;
    }
    try {
      const stored = await env.RELEASE_ASSETS.head(objectKey);
      if (
        !stored ||
        stored.size !== output.size ||
        stored.customMetadata?.sha256 !== output.sha256
      ) {
        const transfer = new FixedLengthStream(output.size);
        const copying = outputBody(stub, output).pipeTo(transfer.writable);
        await Promise.all([
          copying,
          env.RELEASE_ASSETS.put(objectKey, transfer.readable, {
            httpMetadata: {
              contentType: "application/gzip",
              contentDisposition:
                output.kind === "artifact"
                  ? `attachment; filename="${output.name}.tar.gz"`
                  : undefined,
            },
            customMetadata: { sha256: output.sha256, runId },
          }),
        ]);
      }
      if (output.kind === "cache") {
        if (!row.lockfile_hash || !row.cache_event_type || !row.cache_key) {
          await stub.markCacheFailed();
          continue;
        }
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO actions_cache_entries (repository_id, cache_key, source_ref, workflow_path, lockfile_hash, event_type, object_key, size, sha256, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id, cache_key) DO UPDATE SET source_ref = excluded.source_ref, workflow_path = excluded.workflow_path, lockfile_hash = excluded.lockfile_hash, event_type = excluded.event_type, object_key = excluded.object_key, size = excluded.size, sha256 = excluded.sha256, created_at = excluded.created_at, last_used_at = excluded.last_used_at"
        )
          .bind(
            row.repository_id,
            row.cache_key,
            row.source_ref,
            row.path,
            row.lockfile_hash,
            row.cache_event_type,
            objectKey,
            output.size,
            output.sha256,
            now,
            now
          )
          .run();
        await env.DB.prepare("UPDATE actions_runs SET cache_status = 'saved' WHERE id = ?")
          .bind(runId)
          .run();
        await evictOldCaches(env, row.repository_id, row.cache_key);
        await stub.markCacheSaved();
      } else {
        const now = Date.now();
        const artifact: ActionRunArtifact = {
          name: output.name,
          size: output.size,
          sha256: output.sha256,
          downloadUrl: `/api/actions/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(output.name)}`,
          createdAt: now,
        };
        await env.DB.prepare(
          "INSERT INTO actions_run_artifacts (repository_id, run_id, name, object_key, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, name) DO UPDATE SET object_key = excluded.object_key, size = excluded.size, sha256 = excluded.sha256, created_at = excluded.created_at"
        )
          .bind(row.repository_id, runId, output.name, objectKey, output.size, output.sha256, now)
          .run();
        await stub.markOutputPublished(output.name, artifact);
      }
    } catch (cause) {
      const logger = createLogger(env.LOG_LEVEL, {
        service: "actions",
        repoId: row.repository_id,
        doId: runId,
      });
      logger.warn("actions:output-publish-failed", {
        kind: output.kind,
        name: output.name,
        reason: cause instanceof Error ? cause.message : "unknown",
      });
    }
  }
}

async function publishPendingOutputs(env: ActionsEnv): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id FROM actions_runs WHERE executor = 'container' ORDER BY created_at DESC LIMIT ?"
  )
    .bind(MAX_RUN_LIST)
    .all<{ id: string }>();
  let transferred = 0;
  for (const row of rows.results) {
    const stub = actionStub(env, row.id);
    const outputs = await stub.getOutputMetadata();
    const pendingBytes = outputs.reduce((total, item) => total + item.size, 0);
    if (pendingBytes > MAX_ARCHIVE_BYTES - transferred) continue;
    await publishActionOutputs(env, row.id, stub);
    transferred += pendingBytes;
  }
}

async function publishPendingChecks(env: ActionsEnv): Promise<void> {
  const now = Date.now();
  const rows = await env.DB.prepare(
    "SELECT id, repository_id, created_at, check_last_attempt_at, check_status, check_conclusion, executor FROM actions_runs WHERE check_published_at IS NULL AND (check_last_attempt_at IS NULL OR check_last_attempt_at <= ?) ORDER BY check_last_attempt_at ASC, created_at ASC LIMIT ?"
  )
    .bind(now - CHECK_RETRY_MS, CHECK_SCAN_LIMIT)
    .all<PendingCheckRow>();
  for (const row of rows.results) {
    if (row.executor === "runner") {
      const run = await getRunnerRun(env, row.id);
      if (run) {
        const status = run.status === "running" ? "in_progress" : run.status;
        if (status !== row.check_status || run.conclusion !== row.check_conclusion)
          await publishCheck(env, run, now);
        else
          await env.DB.prepare("UPDATE actions_runs SET check_last_attempt_at = ? WHERE id = ?")
            .bind(now, row.id)
            .run();
      } else
        await deliverCheck(
          env,
          row.id,
          row.repository_id,
          "completed",
          "failure",
          "Runner run did not initialize.",
          now
        );
      continue;
    }
    const stub = actionStub(env, row.id);
    try {
      let run = await stub.getRun();
      if (!run) {
        try {
          await stub.cancel();
        } catch {
          // The run Durable Object might not have been initialized.
        }
        await deliverCheck(
          env,
          row.id,
          row.repository_id,
          "completed",
          "failure",
          "Action run did not initialize.",
          now
        );
        continue;
      }
      if (
        (run.status === "queued" || run.status === "running") &&
        now - (run.startedAt ?? run.createdAt) >= MISSING_RUN_TIMEOUT_MS
      ) {
        run = await stub.failStaleRun();
      }
      if (!run) continue;
      const status =
        run.status === "completed"
          ? "completed"
          : run.status === "running"
            ? "in_progress"
            : "queued";
      const conclusion = status === "completed" ? run.conclusion : null;
      if (status === row.check_status && conclusion === row.check_conclusion) {
        await env.DB.prepare(
          "UPDATE actions_runs SET check_last_attempt_at = ? WHERE id = ? AND check_published_at IS NULL"
        )
          .bind(now, row.id)
          .run();
      } else {
        await publishCheck(env, run, now);
      }
    } catch (cause) {
      if (now - row.created_at >= MISSING_RUN_TIMEOUT_MS) {
        try {
          await stub.cancel();
        } catch {
          // The run Durable Object might not have been initialized.
        }
        await deliverCheck(
          env,
          row.id,
          row.repository_id,
          "completed",
          "failure",
          "Action run could not be reached and was stopped.",
          now
        );
      } else {
        await env.DB.prepare(
          "UPDATE actions_runs SET check_last_attempt_at = ? WHERE id = ? AND check_published_at IS NULL"
        )
          .bind(now, row.id)
          .run();
      }
      const logger = createLogger(env.LOG_LEVEL, { service: "actions", doId: row.id });
      logger.warn("actions:check-run-unavailable", {
        reason: cause instanceof Error ? cause.message : "unknown",
      });
    }
  }
}

async function listWorkflows(
  request: Request,
  env: ActionsEnv,
  repo: RepositoryRow,
  user: TrustedUser | null,
  repositoryId: string
): Promise<Response> {
  const url = new URL(request.url);
  const ref = url.searchParams.get("ref") ?? repo.default_branch;
  const oid = url.searchParams.get("oid") ?? undefined;
  if (!ref || ref.length > 255 || (oid && !GitOidSchema.safeParse(oid).success)) {
    return errorResponse(400, "bad_request", "Invalid ref or commit OID.");
  }
  try {
    const snapshot = await repositorySnapshot(
      env,
      repositoryId,
      ref,
      oid,
      user,
      repo.actions_runner_enabled === 1
    );
    const workflows: ActionWorkflowFile[] = [];
    for (const file of workflowFiles(snapshot.files)) {
      const source = snapshotFile(snapshot, file.path);
      if (source === null) {
        workflows.push({
          path: file.path,
          name: file.path.split("/").pop() ?? file.path,
          triggers: [],
          jobs: [],
          supported: false,
          unsupportedReason: "Workflow file is not valid UTF-8.",
        });
        continue;
      }
      try {
        workflows.push({ ...parseRepositoryWorkflow(repo, file.path, source), supported: true });
      } catch (cause) {
        const unsupportedReason =
          cause instanceof WorkflowValidationError ? cause.message : "Workflow file is invalid.";
        workflows.push({
          path: file.path,
          name: file.path.split("/").pop() ?? file.path,
          triggers: [],
          jobs: [],
          supported: false,
          unsupportedReason,
        });
      }
    }
    return dataResponse({ oid: snapshot.oid, workflows });
  } catch (cause) {
    const logger = createLogger(env.LOG_LEVEL, { service: "actions", repoId: repositoryId });
    logger.warn("actions:workflow-list-failed", {
      reason: cause instanceof Error ? cause.message : "unknown",
    });
    return errorResponse(
      422,
      "bad_request",
      cause instanceof Error ? cause.message : "Unable to load workflows."
    );
  }
}

type QueueActionResult =
  | { readonly ok: true; readonly summary: ActionRunSummary }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: "conflict" | "run_limit" | "internal_error" | "bad_request";
      readonly message: string;
      readonly retryAfter?: number;
    };

const RUN_LIMIT_PER_HOUR = 6;
const RUN_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// A slot frees once the oldest run counted in the window leaves it.
async function runLimitRetryAfter(
  env: ActionsEnv,
  repositoryId: string,
  now: number
): Promise<number> {
  const oldest = await env.DB.prepare(
    "SELECT created_at FROM actions_runs WHERE repository_id = ? AND created_at > ? AND NOT EXISTS (SELECT 1 FROM actions_signing_runs signing WHERE signing.run_id = actions_runs.id AND signing.stage NOT IN ('sign','windows_sign','ios_sign')) ORDER BY created_at DESC LIMIT 1 OFFSET ?"
  )
    .bind(repositoryId, now - RUN_LIMIT_WINDOW_MS, RUN_LIMIT_PER_HOUR - 1)
    .first<{ created_at: number }>();
  if (!oldest) return 1;
  return Math.max(1, Math.ceil((oldest.created_at + RUN_LIMIT_WINDOW_MS - now) / 1000));
}

async function queueActionRun(
  env: ActionsEnv,
  repo: RepositoryRow,
  user: TrustedUser,
  repositoryId: string,
  ref: string,
  snapshot: RepositorySnapshot,
  workflow: ActionWorkflow,
  context: {
    eventType: ActionEventType;
    pullRequestId?: string;
    candidateId?: string;
  } = { eventType: "push" },
  transferBudget = { remaining: MAX_TRANSFER_CHUNKS },
  dispatchInputs?: unknown
): Promise<QueueActionResult> {
  if (workflow.executor === "runner") {
    if (
      user.job ||
      user.agentSession ||
      (context.eventType !== "push" && context.eventType !== "workflow_dispatch")
    )
      return {
        ok: false,
        status: 422,
        code: "bad_request",
        message: "Runner execution currently supports human push and workflow_dispatch events.",
      };
    const source = snapshotFile(snapshot, workflow.path);
    if (source === null)
      return {
        ok: false,
        status: 422,
        code: "bad_request",
        message: "Runner workflow source is unavailable.",
      };
    const definition = parseRunnerWorkflow(workflow.path, source);
    const inputs =
      context.eventType === "workflow_dispatch"
        ? runnerDispatchInputs(definition, dispatchInputs)
        : {};
    const summary = await queueRunnerRun(
      env,
      repositoryId,
      user,
      ref,
      snapshot.oid,
      definition,
      context.eventType,
      inputs
    );
    return summary
      ? { ok: true, summary }
      : {
          ok: false,
          status: 429,
          code: "run_limit",
          message: "This repository has reached its limit of six runs per hour.",
          retryAfter: await runLimitRetryAfter(env, repositoryId, Date.now()),
        };
  }
  ref = ref.replace(/^refs\/heads\//, "");
  if (context.candidateId) {
    const prior = await env.DB.prepare(
      "SELECT id FROM actions_runs WHERE candidate_id = ? AND path = ?"
    )
      .bind(context.candidateId, workflow.path)
      .first<{ id: string }>();
    if (prior) {
      const run = await getRun(env, prior.id);
      if (run) return { ok: true, summary: toSummary(run) };
      return {
        ok: false,
        status: 503,
        code: "internal_error",
        message: "Candidate run initialization is pending.",
      };
    }
  }
  const inputChunks = Math.ceil(snapshotJsonLength(snapshot.files) / TRANSFER_CHUNK_BYTES);
  if (inputChunks > transferBudget.remaining)
    return {
      ok: false,
      status: 413,
      code: "conflict",
      message:
        "Workflow source transfers exceed this event's limit. Reduce the source size or workflow count.",
    };
  transferBudget.remaining -= inputChunks;
  const eventType = context.eventType;
  const cacheIdentity = await cacheKeyFor(repositoryId, ref, eventType, workflow, snapshot);
  const cacheOutcome: ActionCacheOutcome = workflow.cache ? "miss" : "disabled";
  const cacheEntry = cacheIdentity
    ? await env.DB.prepare(
        "SELECT object_key, size, sha256 FROM actions_cache_entries WHERE repository_id = ? AND cache_key = ?"
      )
        .bind(repositoryId, cacheIdentity.cacheKey)
        .first<CacheEntryRow>()
    : null;
  const id = crypto.randomUUID();
  let stub: ActionRunStub;
  try {
    stub = actionStub(env, id);
    if (!(await stub.isContainerConfigured())) {
      return {
        ok: false,
        status: 503,
        code: "internal_error",
        message: "Repository Actions require an available Containers deployment.",
      };
    }
  } catch {
    return {
      ok: false,
      status: 503,
      code: "internal_error",
      message: "Repository Actions are unavailable on this deployment.",
    };
  }
  const now = Date.now();
  const created = await env.DB.prepare(
    "INSERT INTO actions_runs (id, repository_id, commit_oid, workflow, path, source_ref, created_by, created_at, pull_request_id, candidate_id, trigger_kind, cache_key, lockfile_hash, cache_event_type, cache_status) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM actions_runs WHERE repository_id = ? AND created_at > ? AND NOT EXISTS (SELECT 1 FROM actions_signing_runs signing WHERE signing.run_id = actions_runs.id AND signing.stage NOT IN ('sign','windows_sign','ios_sign'))) < ?"
  )
    .bind(
      id,
      repositoryId,
      snapshot.oid,
      workflow.name,
      workflow.path,
      ref,
      user.id,
      now,
      context.pullRequestId ?? null,
      context.candidateId ?? null,
      context.eventType,
      cacheIdentity?.cacheKey ?? null,
      cacheIdentity?.lockfileHash ?? null,
      workflow.cache ? eventType : null,
      cacheOutcome,
      repositoryId,
      now - RUN_LIMIT_WINDOW_MS,
      RUN_LIMIT_PER_HOUR
    )
    .run();
  if (created.meta.changes !== 1) {
    return {
      ok: false,
      status: 429,
      code: "run_limit",
      message: "This repository has reached its limit of six runs per hour.",
      retryAfter: await runLimitRetryAfter(env, repositoryId, now),
    };
  }

  let cachedObject: R2ObjectBody | null = null;
  let resolvedCacheOutcome: ActionCacheOutcome = cacheOutcome;
  if (cacheEntry && Math.ceil(cacheEntry.size / TRANSFER_CHUNK_BYTES) > transferBudget.remaining) {
    resolvedCacheOutcome = "failed";
    createLogger(env.LOG_LEVEL, { service: "actions", repoId: repositoryId, doId: id }).warn(
      "actions:cache-transfer-limited",
      { size: cacheEntry.size }
    );
  } else if (cacheEntry && cacheEntry.size > 0 && cacheEntry.size <= MAX_ARCHIVE_BYTES) {
    try {
      cachedObject = await env.RELEASE_ASSETS.get(cacheEntry.object_key);
      if (!cachedObject || cachedObject.size !== cacheEntry.size) {
        await env.DB.prepare(
          "DELETE FROM actions_cache_entries WHERE repository_id = ? AND cache_key = ?"
        )
          .bind(repositoryId, cacheIdentity?.cacheKey ?? "")
          .run();
        cachedObject = null;
      } else resolvedCacheOutcome = "hit";
    } catch (cause) {
      resolvedCacheOutcome = "failed";
      const logger = createLogger(env.LOG_LEVEL, {
        service: "actions",
        repoId: repositoryId,
        doId: id,
      });
      logger.warn("actions:cache-read-failed", {
        reason: cause instanceof Error ? cause.message : "unknown",
      });
    }
  }
  if (cachedObject && !cachedObject.body) {
    cachedObject = null;
    resolvedCacheOutcome = "failed";
  }
  if (cachedObject && cacheIdentity) {
    await env.DB.prepare(
      "UPDATE actions_cache_entries SET last_used_at = ? WHERE repository_id = ? AND cache_key = ?"
    )
      .bind(now, repositoryId, cacheIdentity.cacheKey)
      .run();
  }
  const cacheChunks = cachedObject ? Math.ceil(cachedObject.size / TRANSFER_CHUNK_BYTES) : 0;
  transferBudget.remaining -= cacheChunks;
  const artifactsToCapture = workflow.jobs.flatMap((job) => job.artifacts ?? []);

  const input: ActionRunInput = {
    id,
    repositoryId,
    commitOid: snapshot.oid,
    workflowPath: workflow.path,
    workflowName: workflow.name,
    ref,
    createdBy: user.id,
    createdAt: now,
    enableInternet: repo.actions_network_enabled === 1,
    eventType,
    cacheKey: cacheIdentity?.cacheKey ?? null,
    cacheOutcome: cachedObject ? "hit" : resolvedCacheOutcome,
    cachePaths: workflow.cache?.paths ?? [],
    cachedArchiveSha256: cachedObject ? (cacheEntry?.sha256 ?? null) : null,
    artifactsToCapture,
    jobs: workflow.jobs,
    fileCount: snapshot.files.length,
  };
  const queuedSummary: ActionRunSummary = {
    id,
    commitOid: snapshot.oid,
    workflowPath: workflow.path,
    workflowName: workflow.name,
    ref,
    createdBy: user.id,
    createdAt: now,
    status: "queued",
    conclusion: null,
    cacheOutcome: cachedObject ? "hit" : resolvedCacheOutcome,
    artifactCount: 0,
  };
  let scheduleAttempted = false;
  try {
    await stub.initialize(input, inputChunks, cacheChunks);
    await writeSnapshotChunks(stub, snapshot.files, inputChunks);
    if (cachedObject?.body) {
      try {
        await writeCacheObjectToRun(stub, cachedObject.body, cachedObject.size);
      } catch (cause) {
        await stub.discardCacheInput();
        resolvedCacheOutcome = "failed";
        await stub.setCacheOutcome("failed");
        const logger = createLogger(env.LOG_LEVEL, {
          service: "actions",
          repoId: repositoryId,
          doId: id,
        });
        logger.warn("actions:cache-transfer-failed", {
          reason: cause instanceof Error ? cause.message : "unknown",
        });
      }
    }
    if (resolvedCacheOutcome !== cacheOutcome) {
      await env.DB.prepare("UPDATE actions_runs SET cache_status = ? WHERE id = ?")
        .bind(resolvedCacheOutcome, id)
        .run();
    }
    scheduleAttempted = true;
    await stub.schedule();
    const run = await stub.getRun();
    if (run && run.status !== "queued") await publishCheck(env, run);
    else {
      await deliverCheck(env, id, repositoryId, "queued", null, `${workflow.name} is queued.`, now);
    }
    return { ok: true, summary: run ? toSummary(run) : queuedSummary };
  } catch (cause) {
    const logger = createLogger(env.LOG_LEVEL, {
      service: "actions",
      repoId: repositoryId,
      doId: id,
    });
    if (scheduleAttempted) {
      logger.warn("actions:run-schedule-unconfirmed", {
        reason: cause instanceof Error ? cause.message : "unknown",
      });
      await deliverCheck(env, id, repositoryId, "queued", null, `${workflow.name} is queued.`, now);
      return { ok: true, summary: queuedSummary };
    }
    try {
      await stub.cancel();
    } catch {
      // The run Durable Object may not have been fully initialized.
    }
    try {
      await env.DB.prepare("DELETE FROM actions_runs WHERE id = ?").bind(id).run();
    } catch (deleteCause) {
      logger.error("actions:run-index-cleanup-failed", {
        reason: deleteCause instanceof Error ? deleteCause.message : "unknown",
      });
    }
    logger.error("actions:run-enqueue-failed", {
      reason: cause instanceof Error ? cause.message : "unknown",
    });
    return {
      ok: false,
      status: 503,
      code: "internal_error",
      message: "Actions could not queue this run.",
    };
  }
}

async function handleInternalPush(request: Request, env: ActionsEnv): Promise<Response> {
  if (new URL(request.url).hostname !== "actions.internal") {
    return errorResponse(404, "not_found", "Actions endpoint was not found.");
  }
  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  }
  const user = readTrustedUser(request);
  if (!user) return errorResponse(401, "unauthorized", "Trusted user context is required.");
  const body: unknown = await readJsonLimited(request, 65_536);
  if (
    !isRecord(body) ||
    typeof body.repositoryId !== "string" ||
    typeof body.ref !== "string" ||
    typeof body.expectedOid !== "string" ||
    !body.repositoryId ||
    body.ref.length === 0 ||
    body.ref.length > 255 ||
    !GitOidSchema.safeParse(body.expectedOid).success
  ) {
    return errorResponse(
      400,
      "bad_request",
      "A repository, ref, and expected commit OID are required."
    );
  }
  if (user.job) return dataResponse({ runs: [], failures: [], skipped: "job_token_push" });
  const repositoryId = body.repositoryId;
  const repo = await repositoryFor(env, repositoryId);
  if (!repo || !(await canReadRepository(env, repo, user))) {
    return errorResponse(404, "not_found", "Repository was not found.");
  }
  if (!(await canWriteRepository(env, repo, user))) {
    return errorResponse(403, "forbidden", "Write permission is required for push Actions.");
  }
  if (repo.archived)
    return errorResponse(409, "conflict", "Archived repositories cannot run Actions.");
  if (repo.actions_enabled !== 1)
    return errorResponse(409, "conflict", "Repository Actions are disabled.");
  if (!env.ACTION_RUNS) {
    return errorResponse(
      503,
      "internal_error",
      "Repository Actions are unavailable on this deployment."
    );
  }

  let snapshot: RepositorySnapshot;
  const workflows: ActionWorkflow[] = [];
  try {
    snapshot = await repositorySnapshot(
      env,
      repositoryId,
      body.ref,
      body.expectedOid,
      user,
      repo.actions_runner_enabled === 1
    );
    if (snapshot.oid !== body.expectedOid) {
      return errorResponse(
        409,
        "conflict",
        "The pushed ref no longer points to the expected commit."
      );
    }
    const files = workflowFiles(snapshot.files);
    for (const file of files) {
      const source = snapshotFile(snapshot, file.path);
      if (source === null) {
        return errorResponse(422, "bad_request", `Workflow ${file.path} is not valid UTF-8.`);
      }
      try {
        workflows.push(parseRepositoryWorkflow(repo, file.path, source));
      } catch (cause) {
        const reason =
          cause instanceof WorkflowValidationError ? cause.message : "Workflow file is invalid.";
        return errorResponse(422, "bad_request", `Workflow ${file.path} is unsupported: ${reason}`);
      }
    }
  } catch (cause) {
    return errorResponse(
      422,
      "bad_request",
      cause instanceof Error ? cause.message : "Unable to inspect push workflows."
    );
  }

  const pushBranch = body.ref.replace(/^refs\/heads\//, "");
  if (repo.system_kind === "account_runner" && pushBranch === repo.default_branch) {
    await syncRunnerSchedules(
      env,
      repositoryId,
      await readScheduledDefinitions(env, repositoryId, repo.default_branch, user),
      Date.now()
    );
  }
  const triggered = workflows.filter((workflow) =>
    workflowMatchesEvent(workflow, "push", pushBranch)
  );
  if (triggered.length > 3) {
    return errorResponse(422, "bad_request", "A push may start at most three workflows.");
  }
  if (
    repo.actions_runner_enabled === 1 &&
    triggered.some((workflow) => workflow.executor !== "runner")
  ) {
    try {
      snapshot = await repositorySnapshot(
        env,
        repositoryId,
        body.ref,
        body.expectedOid,
        user,
        false
      );
    } catch (cause) {
      return errorResponse(
        422,
        "bad_request",
        cause instanceof Error ? cause.message : "Unable to load repository source."
      );
    }
  }
  const runs: ActionRunSummary[] = [];
  const failures: Array<{ path: string; message: string }> = [];
  const transferBudget = { remaining: MAX_TRANSFER_CHUNKS };
  for (const workflow of triggered) {
    const result = await queueActionRun(
      env,
      repo,
      user,
      repositoryId,
      body.ref,
      snapshot,
      workflow,
      { eventType: "push" },
      transferBudget
    );
    if (result.ok) runs.push(result.summary);
    else failures.push({ path: workflow.path, message: result.message });
  }
  return dataResponse({ runs, failures }, failures.length ? 207 : 202);
}

async function handleInternalProposal(
  request: Request,
  env: ActionsEnv,
  eventType: "pull_request" | "merge_group"
): Promise<Response> {
  if (new URL(request.url).hostname !== "actions.internal" || request.method !== "POST")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const user = readTrustedUser(request);
  const body: unknown = await readJsonLimited(request, 65_536);
  if (
    !user ||
    !isRecord(body) ||
    typeof body.repositoryId !== "string" ||
    typeof body.pullRequestId !== "string"
  )
    return errorResponse(400, "bad_request", "A trusted user and pull request are required.");
  const repo = await repositoryFor(env, body.repositoryId);
  if (!repo || !(await canWriteRepository(env, repo, user)))
    return errorResponse(404, "not_found", "Repository was not found.");
  if (repo.archived || repo.actions_enabled !== 1)
    return errorResponse(409, "actions_disabled", "Actions are disabled.");
  const pull = await env.DB.prepare(
    "SELECT id, base_ref, head_ref, head_session_id, head_repository_id FROM forge_pull_requests WHERE id = ? AND repository_id = ? AND state = 'open'"
  )
    .bind(body.pullRequestId, repo.id)
    .first<{
      id: string;
      base_ref: string;
      head_ref: string;
      head_session_id: string | null;
      head_repository_id: string | null;
    }>();
  if (!pull) return errorResponse(404, "not_found", "Open pull request was not found.");
  let candidate: MergeCandidateRecord | null = null;
  if (eventType === "merge_group") {
    if (typeof body.candidateId !== "string")
      return errorResponse(400, "bad_request", "Candidate is required.");
    candidate = await env.DB.prepare(
      "SELECT * FROM forge_merge_candidates WHERE id = ? AND pull_request_id = ? AND repository_id = ?"
    )
      .bind(body.candidateId, pull.id, repo.id)
      .first<MergeCandidateRecord>();
    if (!candidate?.result_oid)
      return errorResponse(409, "candidate_pending", "The merge candidate is not prepared.");
  } else if (pull.head_repository_id)
    return dataResponse({ runs: [], failures: [], skipped: "fork_pull_request" });
  const ref = candidate?.source_ref ?? pull.head_ref;
  const snapshot = await repositorySnapshot(
    env,
    repo.id,
    candidate?.result_oid ?? ref,
    candidate?.result_oid ?? undefined,
    user,
    false,
    candidate ? null : pull.head_session_id
  );
  const definitions = await repositorySnapshot(
    env,
    repo.id,
    candidate?.base_oid ?? pull.base_ref,
    candidate?.base_oid,
    user,
    repo.actions_runner_enabled === 1
  );
  const files = workflowFiles(definitions.files);
  const triggered: ActionWorkflow[] = [];
  for (const file of files) {
    const source = snapshotFile(definitions, file.path);
    if (source === null) return errorResponse(422, "bad_request", "Workflow is not UTF-8.");
    const workflow = parseRepositoryWorkflow(repo, file.path, source);
    if (workflowMatchesEvent(workflow, eventType, pull.base_ref)) triggered.push(workflow);
  }
  if (triggered.length > 3)
    return errorResponse(422, "workflow_limit", "At most three workflows may run per event.");
  if (candidate)
    await env.DB.prepare("UPDATE forge_merge_candidates SET expected_workflows = ? WHERE id = ?")
      .bind(JSON.stringify(triggered.map((workflow) => workflow.path)), candidate.id)
      .run();
  const runs: ActionRunSummary[] = [];
  const failures: Array<{ path: string; message: string }> = [];
  const transferBudget = { remaining: MAX_TRANSFER_CHUNKS };
  for (const workflow of triggered) {
    const result = await queueActionRun(
      env,
      repo,
      user,
      repo.id,
      ref,
      snapshot,
      workflow,
      {
        eventType,
        pullRequestId: pull.id,
        candidateId: candidate?.id,
      },
      transferBudget
    );
    if (result.ok) runs.push(result.summary);
    else failures.push({ path: workflow.path, message: result.message });
  }
  return dataResponse({ runs, failures }, failures.length ? 207 : 202);
}

async function startRun(
  request: Request,
  env: ActionsEnv,
  repo: RepositoryRow,
  user: TrustedUser,
  repositoryId: string
): Promise<Response> {
  if (repo.archived)
    return errorResponse(409, "conflict", "Archived repositories cannot run Actions.");
  if (repo.actions_enabled !== 1)
    return errorResponse(409, "conflict", "Repository Actions are disabled.");
  if (!(await canWriteRepository(env, repo, user)))
    return errorResponse(403, "forbidden", "Write permission is required to run Actions.");
  const body: unknown = await readJsonLimited(request, 65_536);
  if (
    !isRecord(body) ||
    typeof body.workflowPath !== "string" ||
    typeof body.ref !== "string" ||
    typeof body.expectedOid !== "string"
  ) {
    return errorResponse(
      400,
      "bad_request",
      "A workflow path, ref, and expected commit OID are required."
    );
  }
  if (
    body.ref.length === 0 ||
    body.ref.length > 255 ||
    !GitOidSchema.safeParse(body.expectedOid).success
  ) {
    return errorResponse(400, "bad_request", "Invalid ref or expected commit OID.");
  }
  if (!isActionWorkflowPath(body.workflowPath))
    return errorResponse(404, "not_found", "Workflow file was not found at the selected commit.");
  let snapshot: RepositorySnapshot;
  let workflow: ActionWorkflow;
  try {
    snapshot = await repositorySnapshot(
      env,
      repositoryId,
      body.ref,
      body.expectedOid,
      user,
      repo.actions_runner_enabled === 1
    );
    if (snapshot.oid !== body.expectedOid)
      return errorResponse(
        409,
        "conflict",
        "The selected ref no longer points to the expected commit."
      );
    const source = snapshotFile(snapshot, body.workflowPath);
    if (source === null)
      return errorResponse(404, "not_found", "Workflow file was not found at the selected commit.");
    workflow = parseRepositoryWorkflow(repo, body.workflowPath, source);
    if (!workflow.triggers.includes("workflow_dispatch")) {
      return errorResponse(409, "conflict", "This workflow does not enable manual dispatch.");
    }
    if (repo.actions_runner_enabled === 1 && workflow.executor !== "runner") {
      snapshot = await repositorySnapshot(
        env,
        repositoryId,
        body.ref,
        body.expectedOid,
        user,
        false
      );
    }
  } catch (cause) {
    return errorResponse(
      422,
      "bad_request",
      cause instanceof Error ? cause.message : "Workflow is not supported."
    );
  }

  let result: QueueActionResult;
  try {
    result = await queueActionRun(
      env,
      repo,
      user,
      repositoryId,
      body.ref,
      snapshot,
      workflow,
      {
        eventType: "workflow_dispatch",
      },
      undefined,
      body.inputs
    );
  } catch (cause) {
    return errorResponse(
      422,
      "bad_request",
      cause instanceof Error ? cause.message : "Workflow inputs are invalid."
    );
  }
  if (!result.ok)
    return errorResponse(
      result.status,
      result.code,
      result.message,
      result.retryAfter === undefined ? undefined : { "Retry-After": String(result.retryAfter) }
    );
  return dataResponse(result.summary, 202);
}

async function listRuns(env: ActionsEnv, repositoryId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT id, executor FROM actions_runs WHERE repository_id = ? ORDER BY created_at DESC LIMIT ?"
  )
    .bind(repositoryId, MAX_RUN_LIST)
    .all<{ id: string; executor: "container" | "runner" }>();
  const runs: ActionRunSummary[] = [];
  for (const row of rows.results) {
    const run =
      row.executor === "runner"
        ? await getRunnerRun(env, row.id)
        : await actionStub(env, row.id).getRun();
    if (run) runs.push(toSummary(run));
  }
  return dataResponse(runs);
}

async function getRun(env: ActionsEnv, id: string): Promise<ActionRunDetails | null> {
  const row = await env.DB.prepare("SELECT id, executor FROM actions_runs WHERE id = ?")
    .bind(id)
    .first<{ id: string; executor: "container" | "runner" }>();
  if (!row) return null;
  if (row.executor === "runner") return getRunnerRun(env, id);
  const stub = actionStub(env, row.id);
  await publishActionOutputs(env, row.id, stub);
  const run = await stub.getRun();
  if (run) {
    await env.DB.prepare("UPDATE actions_runs SET cache_status = ? WHERE id = ?")
      .bind(run.cacheOutcome, row.id)
      .run();
  }
  return run;
}

async function downloadActionArtifact(
  env: ActionsEnv,
  user: TrustedUser | null,
  runId: string,
  name: string
): Promise<Response> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name))
    return errorResponse(404, "not_found", "Action artifact was not found.");
  const row = await env.DB.prepare(
    "SELECT a.repository_id, a.object_key, a.size, a.sha256, a.name FROM actions_run_artifacts a JOIN actions_runs r ON r.id = a.run_id WHERE a.run_id = ? AND a.name = ? AND r.id = ?"
  )
    .bind(runId, name, runId)
    .first<ArtifactRow & { readonly repository_id: string }>();
  if (!row) return errorResponse(404, "not_found", "Action artifact was not found.");
  const repository = await repositoryFor(env, row.repository_id);
  if (!repository || !(await canReadRepository(env, repository, user)))
    return errorResponse(404, "not_found", "Action artifact was not found.");
  const object = await env.RELEASE_ASSETS.get(row.object_key);
  if (!object || object.size !== row.size || object.customMetadata?.sha256 !== row.sha256)
    return errorResponse(404, "not_found", "Action artifact content was not found.");
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(row.size),
      "Content-Disposition": `attachment; filename="${row.name}.tar.gz"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleRepositoryRoute(
  request: Request,
  env: ActionsEnv,
  user: TrustedUser | null,
  repositoryId: string,
  tail: string[]
): Promise<Response> {
  const repo = await repositoryFor(env, repositoryId);
  if (!repo || !(await canReadRepository(env, repo, user)))
    return errorResponse(404, "not_found", "Repository was not found.");
  if (repo.actions_enabled !== 1)
    return errorResponse(409, "conflict", "Repository Actions are disabled.");
  if (tail.length === 1 && tail[0] === "workflows" && request.method === "GET") {
    return listWorkflows(request, env, repo, user, repositoryId);
  }
  if (tail.length === 1 && tail[0] === "runs" && request.method === "GET") {
    return listRuns(env, repositoryId);
  }
  if (tail.length === 1 && tail[0] === "runs" && request.method === "POST") {
    if (!user) return errorResponse(401, "unauthorized", "Sign in to run Actions.");
    return startRun(request, env, repo, user, repositoryId);
  }
  return errorResponse(404, "not_found", "Actions endpoint was not found.");
}

async function handleRunRoute(
  request: Request,
  env: ActionsEnv,
  user: TrustedUser | null,
  runId: string,
  cancel: boolean
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT actions_runs.repository_id, actions_runs.check_published_at, actions_runs.executor FROM actions_runs WHERE actions_runs.id = ?"
  )
    .bind(runId)
    .first<{
      repository_id: string;
      check_published_at: number | null;
      executor: "container" | "runner";
    }>();
  if (!row) return errorResponse(404, "not_found", "Action run was not found.");
  const repo = await repositoryFor(env, row.repository_id);
  if (!repo || !(await canReadRepository(env, repo, user)))
    return errorResponse(404, "not_found", "Action run was not found.");
  if (cancel) {
    if (request.method !== "POST")
      return errorResponse(405, "method_not_allowed", "Method is not allowed.");
    if (!user || !(await canWriteRepository(env, repo, user)))
      return errorResponse(403, "forbidden", "Write permission is required to cancel Actions.");
    const cancelled =
      row.executor === "runner"
        ? await cancelRunnerRun(env, runId)
        : await actionStub(env, runId).cancel();
    return cancelled
      ? dataResponse(cancelled)
      : errorResponse(404, "not_found", "Action run was not found.");
  }
  if (request.method !== "GET")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  const run = await getRun(env, runId);
  if (!run) return errorResponse(404, "not_found", "Action run was not found.");
  if (run.status === "completed" && row.check_published_at === null) await publishCheck(env, run);
  return dataResponse(run);
}

export default {
  async fetch(request: Request, env: ActionsEnv): Promise<Response> {
    const logger = createLogger(env.LOG_LEVEL, { service: "actions" });
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/internal/health")
        return dataResponse({ ok: true });
      if (url.pathname === "/internal/git-transfer") return await handleGitTransfer(request, env);
      if (url.pathname === "/internal/pull-request")
        return await handleInternalProposal(request, env, "pull_request");
      if (url.pathname === "/internal/merge-group")
        return await handleInternalProposal(request, env, "merge_group");
      if (url.pathname === "/internal/push") return await handleInternalPush(request, env);
      if (url.pathname === "/internal/github-runner") return await queueGithubRunner(request, env);
      if (
        /^\/runner\/(?:claim|heartbeat|complete|github\/(?:heartbeat|complete)|signing\/requests\/[0-9a-f-]{36}\/(?:start|heartbeat|download|authorize-sign|output(?:\/parts\/\d+|\/complete)?|complete|fail))$/.test(
          url.pathname
        )
      )
        return await runnerMachineRequest(request, env);
      const user = readTrustedUser(request);
      if (url.pathname.startsWith("/signing/"))
        return handleSigningRoute(request, env, user, signingExecutionHooks(env));
      if (request.method === "GET" && url.pathname === "/runners/overview")
        return await handleRunnerOverview(user, env, request);
      if (request.method === "GET" && url.pathname === "/runners/history")
        return await handleRunnerHistory(user, env, request);
      if (url.pathname === "/runners" || url.pathname.startsWith("/runners/"))
        return await runnerManagement(request, env, user);
      if (user?.job)
        return errorResponse(403, "forbidden", "Job credentials cannot control Actions.");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 2 && parts[0] === "repositories") {
        return await handleRepositoryRoute(request, env, user, parts[1] ?? "", []);
      }
      if (parts.length === 3 && parts[0] === "repositories") {
        return await handleRepositoryRoute(request, env, user, parts[1] ?? "", parts.slice(2));
      }
      if (parts.length === 2 && parts[0] === "runs")
        return handleRunRoute(request, env, user, parts[1] ?? "", false);
      if (parts.length === 3 && parts[0] === "runs" && parts[2] === "cancel") {
        return handleRunRoute(request, env, user, parts[1] ?? "", true);
      }
      if (parts.length === 4 && parts[0] === "runs" && parts[2] === "artifacts") {
        return downloadActionArtifact(env, user, parts[1] ?? "", parts[3] ?? "");
      }
      return errorResponse(404, "not_found", "Actions endpoint was not found.");
    } catch (cause) {
      logger.error("actions:request-failed", {
        reason: cause instanceof Error ? cause.message : "unknown",
      });
      return errorResponse(503, "internal_error", "Actions request failed.");
    }
  },
  async scheduled(
    controller: ScheduledController,
    env: ActionsEnv,
    context: ExecutionContext
  ): Promise<void> {
    context.waitUntil(
      reconcileSigningRequests(env, signingExecutionHooks(env)).catch((cause: unknown) => {
        createLogger(env.LOG_LEVEL, { service: "actions" }).error(
          "actions:signing-reconcile-failed",
          {
            reason: cause instanceof Error ? cause.message : "unknown",
          }
        );
      })
    );
    context.waitUntil(
      runDueRunnerSchedules(
        env,
        controller.scheduledTime,
        async (repositoryId, branch, user): Promise<ScheduledDefinitions> => {
          return readScheduledDefinitions(env, repositoryId, branch, user);
        }
      ).catch((cause: unknown) => {
        createLogger(env.LOG_LEVEL, { service: "actions" }).error("actions:schedule-scan-failed", {
          reason: cause instanceof Error ? cause.message : "unknown",
        });
      })
    );
    context.waitUntil(
      (async () => {
        await expireRunnerRuns(env);
        await expireGithubRunners(env);
        await cleanRunnerSchedulingData(env, Date.now());
        await publishPendingChecks(env);
      })().catch((cause: unknown) => {
        const logger = createLogger(env.LOG_LEVEL, { service: "actions" });
        logger.error("actions:check-scan-failed", {
          reason: cause instanceof Error ? cause.message : "unknown",
        });
      })
    );
    context.waitUntil(
      publishPendingOutputs(env).catch((cause: unknown) => {
        const logger = createLogger(env.LOG_LEVEL, { service: "actions" });
        logger.error("actions:output-scan-failed", {
          reason: cause instanceof Error ? cause.message : "unknown",
        });
      })
    );
  },
};
