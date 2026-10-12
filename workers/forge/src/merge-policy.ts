import type { MergeMethod, TrustedUser } from "../../../packages/contracts/src/index";
import { repositoryRole, writableRole } from "../../../src/worker/common/repositories";
import type { ForgeEnv, RepositoryRow } from "./common";
import { errorResponse } from "../../../src/worker/common/http";
import {
  evaluateMergeRequirements,
  firstBlocker,
  type MergeEvaluation,
} from "./merge-requirements";

export interface MergePolicyInput {
  method: MergeMethod;
  expectedHeadOid: string;
}
/** A reason a pull request cannot merge yet, with the HTTP status direct callers report. */
export interface MergeBlocker {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Machine-readable reason reported by Git when the merge itself failed. */
  readonly cause?: string;
}
export function blockerResponse(blocker: MergeBlocker): Response {
  return errorResponse(blocker.status, blocker.code, blocker.message);
}
function blocked(status: number, code: string, message: string): MergeBlocker {
  return { status, code, message };
}
export async function authorizeMerge(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: TrustedUser,
  pull: Record<string, unknown>,
  input: MergePolicyInput,
  evaluation?: MergeEvaluation
): Promise<MergeBlocker | null> {
  if (user.agentSession || !writableRole(await repositoryRole(env.DB, repository.id, user.id)))
    return blocked(403, "forbidden", "Only a human repository member may merge.");
  return firstBlocker(
    evaluation ??
      (await evaluateMergeRequirements(env, repository, pull, {
        method: input.method,
        headOid: input.expectedHeadOid,
      }))
  );
}
