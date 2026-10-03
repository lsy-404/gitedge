import { readJsonLimited } from "../../../src/worker/common/readText";
import {
  GitOidSchema,
  trustedHeaders,
  readTrustedUser,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import type {
  ActionRun as ActionRunDetails,
  ActionRunSummary,
  ActionWorkflow,
  ActionWorkflowFile,
} from "../../../packages/contracts/src/actions";
import type {
  RepositorySnapshot,
  RepositorySnapshotFile,
} from "../../../packages/contracts/src/repository-controls";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole, writableRole } from "../../../src/worker/common/repositories";
import { parseWorkflow, WorkflowValidationError } from "./workflow";
import { ActionRun as ActionRunDurableObject, type ActionRunInput } from "./run";

export { ActionRunDurableObject as ActionRun };

const MAX_SNAPSHOT_FILES = 128;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_RUN_LIST = 20;
const CHECK_SCAN_LIMIT = 20;
const CHECK_RETRY_MS = 60_000;
const MISSING_RUN_TIMEOUT_MS = 150_000;

interface ActionsEnv extends Cloudflare.Env {
  readonly DB: D1Database;
  readonly GIT: Fetcher;
  readonly FORGE: Fetcher;
  readonly LOG_LEVEL?: string;
}

interface RepositoryRow {
  readonly id: string;
  readonly visibility: "public" | "private";
  readonly archived: number;
  readonly actions_enabled: number;
  readonly actions_network_enabled: number;
  readonly default_branch: string;
}

interface PendingCheckRow {
  readonly id: string;
  readonly repository_id: string;
  readonly created_at: number;
  readonly check_last_attempt_at: number | null;
  readonly check_status: "queued" | "in_progress" | "completed" | null;
  readonly check_conclusion: "success" | "failure" | "cancelled" | null;
}

interface ActionRunStub {
  isContainerConfigured(): Promise<boolean>;
  initialize(input: ActionRunInput, chunks: number): Promise<void>;
  writeInputChunk(index: number, chunk: string): Promise<void>;
  schedule(): Promise<void>;
  getRun(): Promise<ActionRunDetails | null>;
  cancel(): Promise<ActionRunDetails | null>;
  failStaleRun(): Promise<ActionRunDetails | null>;
}

function json(data: unknown, status = 200): Response {
  return Response.json({ data }, { status, headers: { "Cache-Control": "no-store" } });
}

function error(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function repositoryFor(env: ActionsEnv, id: string): Promise<RepositoryRow | null> {
  return env.DB.prepare(
    "SELECT id, visibility, archived, actions_enabled, actions_network_enabled, default_branch FROM repositories WHERE id = ?"
  )
    .bind(id)
    .first<RepositoryRow>();
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
    "SELECT 1 AS found FROM auth_agent_sessions JOIN auth_agents ON auth_agents.id = auth_agent_sessions.agent_id WHERE auth_agent_sessions.id = ? AND auth_agent_sessions.user_id = ? AND auth_agent_sessions.repository_id = ? AND auth_agent_sessions.status = 'active' AND auth_agent_sessions.expires_at > ? AND auth_agents.disabled_at IS NULL AND (EXISTS (SELECT 1 FROM repositories r JOIN namespace_memberships m ON m.namespace_id = r.namespace_id WHERE r.id = auth_agent_sessions.repository_id AND m.user_id = auth_agent_sessions.user_id) OR EXISTS (SELECT 1 FROM repository_collaborators c WHERE c.repository_id = auth_agent_sessions.repository_id AND c.user_id = auth_agent_sessions.user_id))"
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
    throw new Error("Repository snapshot exceeds supported limits.");
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
    if (actualBytes > MAX_SNAPSHOT_BYTES) throw new Error("Repository snapshot exceeds 4 MiB.");
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
  user: TrustedUser | null
): Promise<RepositorySnapshot> {
  const url = new URL(
    `https://git.internal/repositories/${encodeURIComponent(repositoryId)}/snapshot`
  );
  url.searchParams.set("ref", ref);
  if (oid) url.searchParams.set("oid", oid);
  const response = await env.GIT.fetch(
    new Request(url, { headers: trustedHeaders(user ?? undefined) })
  );
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "Commit was not found in this repository."
        : "Unable to load repository source."
    );
  return validateSnapshot(await response.json());
}

function snapshotFile(snapshot: RepositorySnapshot, path: string): string | null {
  const file = snapshot.files.find((entry) => entry.path === path);
  if (!file) return null;
  try {
    const bytes = Uint8Array.from(atob(file.contentBase64), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
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
  };
}

async function deliverCheck(
  env: ActionsEnv,
  runId: string,
  repositoryId: string,
  status: "queued" | "in_progress" | "completed",
  conclusion: "success" | "failure" | "cancelled" | null,
  summary: string,
  now = Date.now()
): Promise<boolean> {
  const logger = createLogger(env.LOG_LEVEL, {
    service: "actions",
    repoId: repositoryId,
    doId: runId,
  });
  let delivered = false;
  try {
    const response = await env.FORGE.fetch(
      new Request("https://forge.internal/internal/actions-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, status, conclusion, summary }),
      })
    );
    delivered = response.ok;
    if (!response.ok)
      logger.warn("actions:check-delivery-rejected", { statusCode: response.status });
  } catch (cause) {
    logger.warn("actions:check-delivery-failed", {
      reason: cause instanceof Error ? cause.message : "unknown",
    });
  }
  try {
    await env.DB.prepare(
      "UPDATE actions_runs SET check_last_attempt_at = ?, check_status = CASE WHEN ? = 1 THEN ? ELSE check_status END, check_conclusion = CASE WHEN ? = 1 THEN ? ELSE check_conclusion END, check_published_at = CASE WHEN ? = 1 AND ? = 'completed' THEN COALESCE(check_published_at, ?) ELSE check_published_at END WHERE id = ?"
    )
      .bind(
        now,
        delivered ? 1 : 0,
        status,
        delivered ? 1 : 0,
        conclusion,
        delivered ? 1 : 0,
        status,
        now,
        runId
      )
      .run();
  } catch (cause) {
    logger.warn("actions:check-outbox-update-failed", {
      reason: cause instanceof Error ? cause.message : "unknown",
    });
  }
  return delivered;
}

async function publishCheck(
  env: ActionsEnv,
  run: ActionRunDetails,
  now = Date.now()
): Promise<boolean> {
  const status =
    run.status === "completed" ? "completed" : run.status === "running" ? "in_progress" : "queued";
  const conclusion = status !== "completed" ? null : run.conclusion;
  const failed = run.jobs.flatMap((job) =>
    job.steps
      .filter((step) => step.conclusion === "failure")
      .map((step) => `${job.name} / ${step.name}`)
  );
  const summary =
    run.status === "completed"
      ? `${run.workflowName}: ${run.conclusion ?? "completed"}.${failed.length ? ` Failed: ${failed.join(", ")}.` : ""}${run.outputTruncated ? " Output was truncated at 16 KiB." : ""}`
      : `${run.workflowName} is ${run.status}.`;
  return deliverCheck(env, run.id, run.repositoryId, status, conclusion, summary, now);
}

async function publishPendingChecks(env: ActionsEnv): Promise<void> {
  const now = Date.now();
  const rows = await env.DB.prepare(
    "SELECT id, repository_id, created_at, check_last_attempt_at, check_status, check_conclusion FROM actions_runs WHERE check_published_at IS NULL AND (check_last_attempt_at IS NULL OR check_last_attempt_at <= ?) ORDER BY check_last_attempt_at ASC, created_at ASC LIMIT ?"
  )
    .bind(now - CHECK_RETRY_MS, CHECK_SCAN_LIMIT)
    .all<PendingCheckRow>();
  for (const row of rows.results) {
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
    return error(400, "bad_request", "Invalid ref or commit OID.");
  }
  try {
    const snapshot = await repositorySnapshot(env, repositoryId, ref, oid, user);
    const workflows: ActionWorkflowFile[] = [];
    for (const file of snapshot.files) {
      if (!file.path.startsWith(".github/workflows/") || !/\.(?:yml|yaml)$/.test(file.path))
        continue;
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
        workflows.push({ ...parseWorkflow(file.path, source), supported: true });
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
    return json({ oid: snapshot.oid, workflows });
  } catch (cause) {
    const logger = createLogger(env.LOG_LEVEL, { service: "actions", repoId: repositoryId });
    logger.warn("actions:workflow-list-failed", {
      reason: cause instanceof Error ? cause.message : "unknown",
    });
    return error(
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
      readonly code: "conflict" | "internal_error";
      readonly message: string;
    };

async function queueActionRun(
  env: ActionsEnv,
  repo: RepositoryRow,
  user: TrustedUser,
  repositoryId: string,
  ref: string,
  snapshot: RepositorySnapshot,
  workflow: ActionWorkflow
): Promise<QueueActionResult> {
  ref = ref.replace(/^refs\/heads\//, "");
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
    "INSERT INTO actions_runs (id, repository_id, commit_oid, workflow, path, source_ref, created_by, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM actions_runs WHERE repository_id = ? AND created_at > ?) < 6"
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
      repositoryId,
      now - 60 * 60 * 1000
    )
    .run();
  if (created.meta.changes !== 1) {
    return {
      ok: false,
      status: 429,
      code: "conflict",
      message: "This repository has reached its limit of six runs per hour.",
    };
  }

  const serialized = JSON.stringify(snapshot.files);
  const chunks: string[] = [];
  for (let offset = 0; offset < serialized.length; offset += 48 * 1024) {
    chunks.push(serialized.slice(offset, offset + 48 * 1024));
  }
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
  };
  let scheduleAttempted = false;
  try {
    await stub.initialize(input, chunks.length);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk !== undefined) await stub.writeInputChunk(index, chunk);
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
    return error(404, "not_found", "Actions endpoint was not found.");
  }
  if (request.method !== "POST") {
    return error(405, "method_not_allowed", "Method is not allowed.");
  }
  const user = readTrustedUser(request);
  if (!user) return error(401, "unauthorized", "Trusted user context is required.");
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
    return error(400, "bad_request", "A repository, ref, and expected commit OID are required.");
  }
  const repositoryId = body.repositoryId;
  const repo = await repositoryFor(env, repositoryId);
  if (!repo || !(await canReadRepository(env, repo, user))) {
    return error(404, "not_found", "Repository was not found.");
  }
  if (!(await canWriteRepository(env, repo, user))) {
    return error(403, "forbidden", "Write permission is required for push Actions.");
  }
  if (repo.archived) return error(409, "conflict", "Archived repositories cannot run Actions.");
  if (repo.actions_enabled !== 1) return error(409, "conflict", "Repository Actions are disabled.");
  if (!env.ACTION_RUNS) {
    return error(503, "internal_error", "Repository Actions are unavailable on this deployment.");
  }

  let snapshot: RepositorySnapshot;
  const workflows: ActionWorkflow[] = [];
  try {
    snapshot = await repositorySnapshot(env, repositoryId, body.ref, body.expectedOid, user);
    if (snapshot.oid !== body.expectedOid) {
      return error(409, "conflict", "The pushed ref no longer points to the expected commit.");
    }
    const files = snapshot.files.filter(
      (file) => file.path.startsWith(".github/workflows/") && /\.(?:yml|yaml)$/.test(file.path)
    );
    for (const file of files) {
      const source = snapshotFile(snapshot, file.path);
      if (source === null) {
        return error(422, "bad_request", `Workflow ${file.path} is not valid UTF-8.`);
      }
      try {
        workflows.push(parseWorkflow(file.path, source));
      } catch (cause) {
        const reason =
          cause instanceof WorkflowValidationError ? cause.message : "Workflow file is invalid.";
        return error(422, "bad_request", `Workflow ${file.path} is unsupported: ${reason}`);
      }
    }
  } catch (cause) {
    return error(
      422,
      "bad_request",
      cause instanceof Error ? cause.message : "Unable to inspect push workflows."
    );
  }

  const triggered = workflows.filter((workflow) => workflow.triggers.includes("push"));
  if (triggered.length > 3) {
    return error(422, "bad_request", "A push may start at most three workflows.");
  }
  const runs: ActionRunSummary[] = [];
  const failures: Array<{ path: string; message: string }> = [];
  for (const workflow of triggered) {
    const result = await queueActionRun(
      env,
      repo,
      user,
      repositoryId,
      body.ref,
      snapshot,
      workflow
    );
    if (result.ok) runs.push(result.summary);
    else failures.push({ path: workflow.path, message: result.message });
  }
  return json({ runs, failures }, failures.length ? 207 : 202);
}

async function startRun(
  request: Request,
  env: ActionsEnv,
  repo: RepositoryRow,
  user: TrustedUser,
  repositoryId: string
): Promise<Response> {
  if (repo.archived) return error(409, "conflict", "Archived repositories cannot run Actions.");
  if (repo.actions_enabled !== 1) return error(409, "conflict", "Repository Actions are disabled.");
  if (!(await canWriteRepository(env, repo, user)))
    return error(403, "forbidden", "Write permission is required to run Actions.");
  const body: unknown = await readJsonLimited(request, 65_536);
  if (
    !isRecord(body) ||
    typeof body.workflowPath !== "string" ||
    typeof body.ref !== "string" ||
    typeof body.expectedOid !== "string"
  ) {
    return error(400, "bad_request", "A workflow path, ref, and expected commit OID are required.");
  }
  if (
    body.ref.length === 0 ||
    body.ref.length > 255 ||
    !GitOidSchema.safeParse(body.expectedOid).success
  ) {
    return error(400, "bad_request", "Invalid ref or expected commit OID.");
  }
  let snapshot: RepositorySnapshot;
  let workflow: ActionWorkflow;
  try {
    snapshot = await repositorySnapshot(env, repositoryId, body.ref, body.expectedOid, user);
    if (snapshot.oid !== body.expectedOid)
      return error(409, "conflict", "The selected ref no longer points to the expected commit.");
    const source = snapshotFile(snapshot, body.workflowPath);
    if (source === null)
      return error(404, "not_found", "Workflow file was not found at the selected commit.");
    workflow = parseWorkflow(body.workflowPath, source);
    if (!workflow.triggers.includes("workflow_dispatch")) {
      return error(409, "conflict", "This workflow does not enable manual dispatch.");
    }
  } catch (cause) {
    return error(
      422,
      "bad_request",
      cause instanceof Error ? cause.message : "Workflow is not supported."
    );
  }

  const result = await queueActionRun(env, repo, user, repositoryId, body.ref, snapshot, workflow);
  if (!result.ok) return error(result.status, result.code, result.message);
  return json(result.summary, 202);
}

async function listRuns(env: ActionsEnv, repositoryId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT id FROM actions_runs WHERE repository_id = ? ORDER BY created_at DESC LIMIT ?"
  )
    .bind(repositoryId, MAX_RUN_LIST)
    .all<{ id: string }>();
  const runs: ActionRunSummary[] = [];
  for (const row of rows.results) {
    const run = await actionStub(env, row.id).getRun();
    if (run) runs.push(toSummary(run));
  }
  return json(runs);
}

async function getRun(env: ActionsEnv, id: string): Promise<ActionRunDetails | null> {
  const row = await env.DB.prepare("SELECT id FROM actions_runs WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  return row ? actionStub(env, row.id).getRun() : null;
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
    return error(404, "not_found", "Repository was not found.");
  if (repo.actions_enabled !== 1) return error(409, "conflict", "Repository Actions are disabled.");
  if (!env.ACTION_RUNS)
    return error(503, "internal_error", "Repository Actions are unavailable on this deployment.");
  if (tail.length === 1 && tail[0] === "workflows" && request.method === "GET") {
    return listWorkflows(request, env, repo, user, repositoryId);
  }
  if (tail.length === 1 && tail[0] === "runs" && request.method === "GET") {
    return listRuns(env, repositoryId);
  }
  if (tail.length === 1 && tail[0] === "runs" && request.method === "POST") {
    if (!user) return error(401, "unauthorized", "Sign in to run Actions.");
    return startRun(request, env, repo, user, repositoryId);
  }
  return error(404, "not_found", "Actions endpoint was not found.");
}

async function handleRunRoute(
  request: Request,
  env: ActionsEnv,
  user: TrustedUser | null,
  runId: string,
  cancel: boolean
): Promise<Response> {
  if (!env.ACTION_RUNS)
    return error(503, "internal_error", "Repository Actions are unavailable on this deployment.");
  const row = await env.DB.prepare(
    "SELECT actions_runs.repository_id, actions_runs.check_published_at FROM actions_runs WHERE actions_runs.id = ?"
  )
    .bind(runId)
    .first<{ repository_id: string; check_published_at: number | null }>();
  if (!row) return error(404, "not_found", "Action run was not found.");
  const repo = await repositoryFor(env, row.repository_id);
  if (!repo || !(await canReadRepository(env, repo, user)))
    return error(404, "not_found", "Action run was not found.");
  if (cancel) {
    if (request.method !== "POST")
      return error(405, "method_not_allowed", "Method is not allowed.");
    if (!user || !(await canWriteRepository(env, repo, user)))
      return error(403, "forbidden", "Write permission is required to cancel Actions.");
    const cancelled = await actionStub(env, runId).cancel();
    return cancelled ? json(cancelled) : error(404, "not_found", "Action run was not found.");
  }
  if (request.method !== "GET") return error(405, "method_not_allowed", "Method is not allowed.");
  const run = await getRun(env, runId);
  if (!run) return error(404, "not_found", "Action run was not found.");
  if (run.status === "completed" && row.check_published_at === null) await publishCheck(env, run);
  return json(run);
}

export default {
  async fetch(request: Request, env: ActionsEnv): Promise<Response> {
    const logger = createLogger(env.LOG_LEVEL, { service: "actions" });
    try {
      const url = new URL(request.url);
      if (url.pathname === "/internal/push") return await handleInternalPush(request, env);
      const user = readTrustedUser(request);
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
      return error(404, "not_found", "Actions endpoint was not found.");
    } catch (cause) {
      logger.error("actions:request-failed", {
        reason: cause instanceof Error ? cause.message : "unknown",
      });
      return error(503, "internal_error", "Actions request failed.");
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: ActionsEnv,
    context: ExecutionContext
  ): Promise<void> {
    context.waitUntil(
      publishPendingChecks(env).catch((cause: unknown) => {
        const logger = createLogger(env.LOG_LEVEL, { service: "actions" });
        logger.error("actions:check-scan-failed", {
          reason: cause instanceof Error ? cause.message : "unknown",
        });
      })
    );
  },
};
