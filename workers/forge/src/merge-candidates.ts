import { z } from "zod";
import {
  trustedHeaders,
  type MergeMethod,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import type {
  MergeCandidate,
  MergeCandidateRecord,
} from "../../../packages/contracts/src/merge-candidates";
import { branchRules, matchingBranchRules } from "../../../src/worker/common/branch-protection";
import { createLogger } from "../../../src/worker/common/logger";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import type { ForgeEnv, RepositoryRow } from "./common";
import { mergeResultOid } from "./pull-git";

export async function candidateState(
  env: ForgeEnv,
  row: MergeCandidateRecord
): Promise<MergeCandidate> {
  const runs = await env.DB.prepare(
    "SELECT path AS name, check_status AS status, check_conclusion AS conclusion FROM actions_runs WHERE candidate_id = ? ORDER BY path LIMIT 4"
  )
    .bind(row.id)
    .all<{ name: string; status: string | null; conclusion: string | null }>();
  const checks = runs.results.map((run) => ({ ...run, status: run.status ?? "queued" }));
  const expected = z.array(z.string()).max(3).parse(JSON.parse(row.expected_workflows));
  const complete =
    expected.length > 0 &&
    expected.every((name) =>
      checks.some(
        (check) =>
          check.name === name && check.status === "completed" && check.conclusion === "success"
      )
    );
  const timedOut = Date.now() - row.created_at > 30 * 60_000;
  return {
    id: row.id,
    baseOid: row.base_oid,
    headOid: row.head_oid,
    resultOid: row.result_oid,
    method: row.method,
    createdAt: row.created_at,
    checks,
    status:
      timedOut ||
      checks.some((check) => check.status === "completed" && check.conclusion !== "success")
        ? "failed"
        : !row.result_oid
          ? "preparing"
          : complete
            ? "passed"
            : "running",
  };
}

export async function ensureMergeCandidate(
  env: ForgeEnv,
  repository: RepositoryRow,
  pull: Record<string, unknown>,
  user: TrustedUser,
  method: MergeMethod,
  baseOid: string,
  headOid: string,
  queueEnteredAt: number
): Promise<{ row: MergeCandidateRecord; state: MergeCandidate } | Response> {
  if (!env.ACTIONS || repository.actions_enabled !== 1)
    return errorResponse(
      409,
      "merge_ci_unavailable",
      "Enable Actions with a merge_group workflow before using the merge queue."
    );
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO forge_merge_candidates (id,pull_request_id,repository_id,base_oid,head_oid,method,source_ref,created_at,queue_entered_at,author_name,author_email,message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  )
    .bind(
      id,
      pull.id,
      repository.id,
      baseOid,
      headOid,
      method,
      `refs/gitedge/merge-queue/${id}`,
      Date.now(),
      queueEnteredAt,
      user.identifier,
      `${user.identifier}@users.gitedge.invalid`,
      String(pull.title)
    )
    .run();
  const row = await env.DB.prepare(
    "SELECT * FROM forge_merge_candidates WHERE pull_request_id = ? AND base_oid = ? AND head_oid = ? AND method = ? AND queue_entered_at = ?"
  )
    .bind(pull.id, baseOid, headOid, method, queueEnteredAt)
    .first<MergeCandidateRecord>();
  if (!row) throw new Error("Candidate record was not created.");
  const headers = trustedHeaders(user);
  headers.set("Content-Type", "application/json");
  if (!row.result_oid) {
    const response = await env.GIT.fetch(
      new Request(`https://git.internal/repositories/${repository.id}/merge-candidate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          pullRequestId: String(pull.id),
          method,
          baseRef: String(pull.base_ref),
          headRef: String(pull.head_ref),
          headSessionId: pull.head_session_id ?? null,
          headRepositoryId: pull.head_repository_id ?? null,
          expectedBaseOid: baseOid,
          expectedHeadOid: headOid,
          author: { name: row.author_name, email: row.author_email },
          message: row.message,
          candidateId: row.id,
          commitTimestamp: Math.floor(row.created_at / 1000),
        }),
      })
    );
    const body: unknown = await response.json().catch(() => null);
    const oid = mergeResultOid(body);
    if (!response.ok || !oid)
      return errorResponse(
        409,
        "merge_candidate_failed",
        "The current base and head could not be combined. Update the source branch and retry."
      );
    await env.DB.prepare(
      "UPDATE forge_merge_candidates SET result_oid = ? WHERE id = ? AND result_oid IS NULL"
    )
      .bind(oid, row.id)
      .run();
    row.result_oid = oid;
  }
  let state = await candidateState(env, row);
  if (state.status !== "failed" && state.status !== "passed") {
    const response = await env.ACTIONS.fetch(
      new Request("https://actions.internal/internal/merge-group", {
        method: "POST",
        headers,
        body: JSON.stringify({
          repositoryId: repository.id,
          candidateId: row.id,
          pullRequestId: pull.id,
          ref: row.source_ref,
          expectedOid: row.result_oid,
          baseOid,
        }),
      })
    );
    if (!response.ok) {
      await response.body?.cancel();
      return errorResponse(
        409,
        "merge_ci_unavailable",
        "A merge_group workflow could not start. Check Actions configuration and quota."
      );
    }
    const payload: unknown = await response.json();
    if (
      payload &&
      typeof payload === "object" &&
      "data" in payload &&
      payload.data &&
      typeof payload.data === "object" &&
      "failures" in payload.data &&
      Array.isArray(payload.data.failures) &&
      payload.data.failures.length
    )
      return errorResponse(
        503,
        "merge_ci_pending",
        "Some candidate workflows could not start. Retry after Actions becomes available."
      );
    if (
      !payload ||
      typeof payload !== "object" ||
      !("data" in payload) ||
      !payload.data ||
      typeof payload.data !== "object" ||
      !("runs" in payload.data) ||
      !Array.isArray(payload.data.runs) ||
      payload.data.runs.length === 0
    )
      return errorResponse(
        409,
        "merge_ci_unavailable",
        "Add a supported merge_group workflow to the target branch."
      );
    const refreshed = await env.DB.prepare(
      "SELECT expected_workflows FROM forge_merge_candidates WHERE id = ?"
    )
      .bind(row.id)
      .first<{ expected_workflows: string }>();
    if (!refreshed) throw new Error("Candidate record disappeared while starting CI.");
    row.expected_workflows = refreshed.expected_workflows;
    state = await candidateState(env, row);
  }
  const rules = matchingBranchRules(
    await branchRules(env.DB, repository.id),
    String(pull.base_ref)
  );
  if (
    state.status === "passed" &&
    rules
      .flatMap((rule) => rule.requiredStatusChecks)
      .some(
        (name) =>
          !state.checks.some((check) => check.name === name && check.conclusion === "success")
      )
  )
    return errorResponse(
      409,
      "merge_checks_missing",
      "A required check is missing from the merge_group workflow."
    );
  createLogger(env.LOG_LEVEL, { service: "forge", repoId: repository.id }).info(
    "forge:merge-candidate-checked",
    { candidateId: row.id, status: state.status }
  );
  return { row, state };
}

export async function mergeCandidateRoute(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  parts: string[]
): Promise<Response | null> {
  if (parts[2] !== "pull-requests" || parts[4] !== "merge-candidate" || parts.length !== 5)
    return null;
  if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Use GET.");
  const row = await env.DB.prepare(
    "SELECT c.* FROM forge_merge_candidates c JOIN forge_pull_requests p ON p.id = c.pull_request_id WHERE p.repository_id = ? AND p.number = ? ORDER BY c.created_at DESC LIMIT 1"
  )
    .bind(repository.id, Number(parts[3]))
    .first<MergeCandidateRecord>();
  return dataResponse(row ? await candidateState(env, row) : null);
}

export async function candidateMergeAllowed(
  env: ForgeEnv,
  repository: RepositoryRow,
  pull: Record<string, unknown>,
  input: {
    method: MergeMethod;
    expectedBaseOid: string;
    expectedHeadOid: string;
    candidateId?: string;
    candidateOid?: string;
  }
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT * FROM forge_merge_candidates WHERE id = ? AND pull_request_id = ? AND repository_id = ? AND base_oid = ? AND head_oid = ? AND method = ? AND result_oid = ?"
  )
    .bind(
      input.candidateId ?? null,
      pull.id,
      repository.id,
      input.expectedBaseOid,
      input.expectedHeadOid,
      input.method,
      input.candidateOid ?? null
    )
    .first<MergeCandidateRecord>();
  if (!row) return false;
  const state = await candidateState(env, row);
  if (state.status !== "passed") return false;
  const rules = matchingBranchRules(
    await branchRules(env.DB, repository.id),
    String(pull.base_ref)
  );
  return rules
    .flatMap((rule) => rule.requiredStatusChecks)
    .every((name) =>
      state.checks.some((check) => check.name === name && check.conclusion === "success")
    );
}
