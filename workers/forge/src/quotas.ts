import {
  parseUserGroupLimits,
  type TrustedUser,
  type UserGroupLimits,
} from "../../../packages/contracts/src/index";
import { quotaExceededResponse } from "../../../src/worker/common/http";
import type { QuotaDetail } from "../../../packages/contracts/src/ops";
import type { ForgeEnv } from "./common";

export interface RepositoryCounts {
  total: number;
  public: number;
  private: number;
}

export interface RepositoryQuotaCondition {
  sql: string;
  bindings: (string | number)[];
}

const REPOSITORY_COUNTS_SQL =
  "SELECT COUNT(*) AS total, COALESCE(SUM(visibility = 'public'), 0) AS public, COALESCE(SUM(visibility = 'private'), 0) AS private FROM (SELECT visibility FROM repositories WHERE created_by = ? AND system_kind IS NULL UNION ALL SELECT visibility FROM repository_imports WHERE created_by = ? AND status IN ('queued','running'))";

export function groupLimitsFor(env: ForgeEnv, groupKey: string): UserGroupLimits {
  const groups = parseUserGroupLimits(env.USER_GROUP_LIMITS_JSON);
  return Object.hasOwn(groups, groupKey) ? groups[groupKey] : groups.free;
}

export async function repositoryCounts(env: ForgeEnv, userId: string): Promise<RepositoryCounts> {
  const counts = await env.DB.prepare(REPOSITORY_COUNTS_SQL)
    .bind(userId, userId)
    .first<RepositoryCounts>();
  return counts ?? { total: 0, public: 0, private: 0 };
}

export function repositoryQuotaCondition(
  env: ForgeEnv,
  user: Pick<TrustedUser, "id" | "groupKey">,
  visibility: "public" | "private",
  visibilityOnly = false
): RepositoryQuotaCondition {
  const limits = groupLimitsFor(env, user.groupKey);
  const total = visibilityOnly ? -1 : limits.maxRepositories;
  const category =
    visibility === "public" ? limits.maxPublicRepositories : limits.maxPrivateRepositories;
  return {
    sql: `EXISTS (SELECT 1 FROM (${REPOSITORY_COUNTS_SQL}) WHERE (? = -1 OR total < ?) AND (? = -1 OR ${visibility} < ?))`,
    bindings: [user.id, user.id, total, total, category, category],
  };
}

export async function checkRepositoryQuota(
  env: ForgeEnv,
  user: Pick<TrustedUser, "id" | "groupKey">,
  visibility: "public" | "private",
  visibilityOnly = false
): Promise<Response | null> {
  const limits = groupLimitsFor(env, user.groupKey);
  const used = await repositoryCounts(env, user.id);
  const checks: QuotaDetail[] = [
    { resource: "repositories", used: used.total, limit: limits.maxRepositories },
    {
      resource: visibility === "public" ? "public_repositories" : "private_repositories",
      used: used[visibility],
      limit: visibility === "public" ? limits.maxPublicRepositories : limits.maxPrivateRepositories,
    },
  ];
  for (const check of visibilityOnly ? checks.slice(1) : checks) {
    if (check.limit !== -1 && check.used >= check.limit)
      return quotaExceededResponse(
        "Repository quota reached. Deleted repositories and pending imports count until purged or completed.",
        check
      );
  }
  return null;
}
