import {
  MergeRequirementsQuerySchema,
  type MergeRequirements,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import type { ForgeEnv, RepositoryRow } from "./common";
import { evaluateMergeRequirements } from "./merge-requirements";
import { pullRequestHeadOid } from "./pull-git";

export async function readMergeRequirements(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  pull: Record<string, unknown>,
  user: TrustedUser | null
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const parsed = MergeRequirementsQuerySchema.safeParse({
    headOid: query.get("headOid") ?? undefined,
    method: query.get("method") ?? undefined,
  });
  if (!parsed.success)
    return errorResponse(400, "bad_request", "Invalid merge requirements query.");
  if (pull.state === "closed" && (pull.head_session_id || pull.head_repository_id))
    return errorResponse(404, "not_found", "Pull request head was not found.");
  const head =
    parsed.data.headOid ??
    (pull.state === "merged" && typeof pull.merge_head_oid === "string"
      ? pull.merge_head_oid
      : await pullRequestHeadOid(env, request.url, repository, pull, user));
  if (head instanceof Response) return head;
  const evaluation = await evaluateMergeRequirements(env, repository, pull, {
    headOid: head,
    method: parsed.data.method ?? null,
  });
  const result: MergeRequirements = {
    headOid: head,
    ready: evaluation.requirements.every((requirement) => requirement.status !== "unsatisfied"),
    requirements: evaluation.requirements.map(({ blocker, ...requirement }) => requirement),
    excludedApprovals: evaluation.excludedApprovals,
  };
  return dataResponse(result);
}
