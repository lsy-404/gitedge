import { z } from "zod";
import { createLogger } from "../../../src/worker/common/logger";
import { parseJson, type ForgeEnv } from "./common";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";

const CheckInput = z
  .object({
    runId: z.string().min(1),
    status: z.enum(["queued", "in_progress", "completed"]),
    conclusion: z.enum(["success", "failure", "cancelled"]).nullable(),
    summary: z.string().max(8_000),
  })
  .refine((input) => (input.status === "completed") === (input.conclusion !== null));
type RunRow = {
  id: string;
  repository_id: string;
  commit_oid: string;
  path: string;
  source_ref: string;
  created_at: number;
  check_status: "queued" | "in_progress" | "completed" | null;
  check_conclusion: "success" | "failure" | "cancelled" | null;
};
const actor = JSON.stringify({ kind: "ci", id: "gitedge-actions", name: "GitEdge Actions" });

function checkStatement(
  db: ForgeEnv["DB"],
  run: RunRow,
  pullId: string,
  status: string,
  conclusion: string | null,
  summary: string
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO forge_check_runs(id,repository_id,pull_request_id,actor_json,actor_key,name,commit_oid,status,conclusion,summary,details_url,created_at,updated_at) VALUES(?,?,?,?,'ci:gitedge-actions',?,?,?,?,?,NULL,?,?) ON CONFLICT(pull_request_id,commit_oid,name,actor_key) DO UPDATE SET status=excluded.status,conclusion=excluded.conclusion,summary=excluded.summary,updated_at=excluded.updated_at"
    )
    .bind(
      crypto.randomUUID(),
      run.repository_id,
      pullId,
      actor,
      run.path,
      run.commit_oid,
      status,
      conclusion,
      summary,
      run.created_at,
      Date.now()
    );
}

export async function actionsCheck(request: Request, env: ForgeEnv): Promise<Response> {
  if (new URL(request.url).hostname !== "forge.internal" || request.method !== "POST")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const parsed = CheckInput.safeParse(await parseJson(request));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid Actions check.");
  const run = await env.DB.prepare("SELECT * FROM actions_runs WHERE id=?")
    .bind(parsed.data.runId)
    .first<RunRow>();
  if (!run) return errorResponse(404, "not_found", "Action run was not found.");
  const latest = await env.DB.prepare(
    "SELECT id FROM actions_runs WHERE repository_id=? AND path=? AND commit_oid=? AND source_ref=? ORDER BY created_at DESC,id DESC LIMIT 1"
  )
    .bind(run.repository_id, run.path, run.commit_oid, run.source_ref)
    .first<{ id: string }>();
  if (latest?.id !== run.id) return dataResponse({ superseded: true });
  const pulls = await env.DB.prepare(
    "SELECT id, merge_started_at FROM forge_pull_requests WHERE repository_id=? AND head_ref=? AND head_session_id IS NULL AND state='open' LIMIT 101"
  )
    .bind(run.repository_id, run.source_ref)
    .all<{ id: string; merge_started_at: number | null }>();
  if (pulls.results.length > 100)
    return errorResponse(413, "pull_limit", "Too many pull requests for this head.");
  if (
    pulls.results.some(
      (pull) => pull.merge_started_at !== null && pull.merge_started_at > Date.now() - 300_000
    )
  )
    return errorResponse(409, "merge_in_progress", "Retry check delivery after the active merge.");
  if (pulls.results.length > 0)
    await env.DB.batch(
      pulls.results.map((pull) =>
        checkStatement(
          env.DB,
          run,
          pull.id,
          parsed.data.status,
          parsed.data.conclusion,
          parsed.data.summary
        )
      )
    );
  createLogger(env.LOG_LEVEL, { service: "forge", repoId: run.repository_id }).info(
    "actions:check-published",
    { runId: run.id, count: pulls.results.length, oid: run.commit_oid }
  );
  return dataResponse({ published: pulls.results.length });
}

export async function attachActionChecks(
  env: ForgeEnv,
  repositoryId: string,
  pullId: string,
  headRef: string
): Promise<void> {
  const runs = await env.DB.prepare(
    "SELECT * FROM actions_runs WHERE repository_id=? AND source_ref=? ORDER BY created_at DESC,id DESC LIMIT 101"
  )
    .bind(repositoryId, headRef)
    .all<RunRow>();
  const seen = new Set<string>();
  const statements: D1PreparedStatement[] = [];
  for (const run of runs.results.slice(0, 100)) {
    const key = `${run.path}:${run.commit_oid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    statements.push(
      checkStatement(
        env.DB,
        run,
        pullId,
        run.check_status ?? "queued",
        run.check_conclusion,
        `GitEdge Actions run ${run.id}`
      )
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
  if (runs.results.length > 100)
    createLogger(env.LOG_LEVEL, { service: "forge", repoId: repositoryId }).warn(
      "actions:check-history-truncated",
      { pullId }
    );
}
