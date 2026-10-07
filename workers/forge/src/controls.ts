import {
  BranchProtectionInputSchema,
  PutRepositoryCollaboratorSchema,
} from "../../../packages/contracts/src/repository-controls";
import type { TrustedUser } from "../../../packages/contracts/src/index";
import { branchRules } from "../../../src/worker/common/branch-protection";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { createLogger } from "../../../src/worker/common/logger";
import { revokeAgentSessions } from "./agent-events";
import { parseJson, type ForgeEnv, type RepositoryRow } from "./common";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";

export async function repositoryControls(
  env: ForgeEnv,
  request: Request,
  repo: RepositoryRow,
  user: TrustedUser,
  parts: string[]
): Promise<Response | null> {
  const resource = parts[2],
    id = parts[3];
  if (resource !== "branch-rules" && resource !== "collaborators") return null;
  if (user.agentSession || (await repositoryRole(env.DB, repo.id, user.id)) !== "admin")
    return errorResponse(403, "forbidden", "Repository administrator access is required.");
  const logger = createLogger(env.LOG_LEVEL, {
    service: "repository-controls",
    repoId: repo.id,
  });
  if (resource === "branch-rules") {
    if (request.method === "GET" && !id) return dataResponse(await branchRules(env.DB, repo.id));
    if (request.method === "DELETE" && id) {
      const removed = await env.DB.prepare(
        "DELETE FROM repository_branch_rules WHERE id=? AND repository_id=? RETURNING id"
      )
        .bind(id, repo.id)
        .first();
      if (!removed) return errorResponse(404, "not_found", "Branch rule was not found.");
      logger.info("rules:deleted", { ruleId: id });
      return dataResponse({ deleted: true });
    }
    if ((request.method === "POST" && !id) || (request.method === "PATCH" && id)) {
      const parsed = BranchProtectionInputSchema.safeParse(await parseJson(request));
      if (!parsed.success)
        return errorResponse(400, "bad_request", "Invalid branch protection rule.");
      const existing = await branchRules(env.DB, repo.id);
      if (!id && existing.length >= 50)
        return errorResponse(409, "rule_limit", "At most 50 branch rules are allowed.");
      if (id && !existing.some((rule) => rule.id === id))
        return errorResponse(404, "not_found", "Branch rule was not found.");
      const input = parsed.data,
        ruleId = id ?? crypto.randomUUID(),
        now = Date.now();
      try {
        await env.DB.prepare(
          "INSERT INTO repository_branch_rules (id,repository_id,pattern,enabled,locked,required_approvals,require_passing_checks,required_status_checks,require_linear_history,require_signed_commits,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET pattern=excluded.pattern,enabled=excluded.enabled,locked=excluded.locked,required_approvals=excluded.required_approvals,require_passing_checks=excluded.require_passing_checks,required_status_checks=excluded.required_status_checks,require_linear_history=excluded.require_linear_history,require_signed_commits=excluded.require_signed_commits,updated_at=excluded.updated_at"
        )
          .bind(
            ruleId,
            repo.id,
            input.pattern,
            Number(input.enabled),
            Number(input.locked),
            input.requiredApprovals,
            Number(input.requirePassingChecks),
            JSON.stringify([...new Set(input.requiredStatusChecks)]),
            Number(input.requireLinearHistory),
            Number(input.requireSignedCommits),
            now,
            now
          )
          .run();
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes("UNIQUE"))
          return errorResponse(409, "conflict", "A rule for this pattern already exists.");
        throw cause;
      }
      logger.info("rules:saved", { ruleId });
      return dataResponse(
        (await branchRules(env.DB, repo.id)).find((rule) => rule.id === ruleId),
        id ? 200 : 201
      );
    }
  }
  if (resource === "collaborators") {
    if (request.method === "GET" && !id) {
      const rows = await env.DB.prepare(
        "SELECT u.id,u.identifier,CASE WHEN m.role='owner' OR c.role='admin' THEN 'admin' WHEN m.role='member' OR c.role='write' THEN 'write' ELSE 'read' END AS role,m.user_id IS NOT NULL AS inherited FROM users u LEFT JOIN namespace_memberships m ON m.user_id=u.id AND m.namespace_id=? LEFT JOIN repository_collaborators c ON c.user_id=u.id AND c.repository_id=? WHERE m.user_id IS NOT NULL OR c.user_id IS NOT NULL ORDER BY u.identifier LIMIT 101"
      )
        .bind(repo.namespace_id, repo.id)
        .all<{
          id: string;
          identifier: string;
          role: "read" | "write" | "admin";
          inherited: number;
        }>();
      if (rows.results.length > 100)
        return errorResponse(413, "member_limit", "Collaborator list exceeds its limit.");
      return dataResponse(rows.results.map((row) => ({ ...row, inherited: row.inherited === 1 })));
    }
    if (request.method === "PUT" && !id) {
      const parsed = PutRepositoryCollaboratorSchema.safeParse(await parseJson(request));
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid collaborator.");
      const person = await env.DB.prepare("SELECT id FROM users WHERE identifier=?")
        .bind(parsed.data.identifier)
        .first<{ id: string }>();
      if (!person) return errorResponse(404, "not_found", "User was not found.");
      const inherited = await env.DB.prepare(
        "SELECT 1 FROM namespace_memberships WHERE namespace_id=? AND user_id=?"
      )
        .bind(repo.namespace_id, person.id)
        .first();
      if (inherited)
        return errorResponse(
          409,
          "inherited_access",
          "Manage inherited access in organization settings."
        );
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM repository_collaborators WHERE repository_id=? AND user_id<>?"
      )
        .bind(repo.id, person.id)
        .first<{ count: number }>();
      if ((count?.count ?? 0) >= 80)
        return errorResponse(409, "member_limit", "Collaborator limit reached.");
      await env.DB.prepare(
        "INSERT INTO repository_collaborators(repository_id,user_id,role,created_at) VALUES (?,?,?,?) ON CONFLICT(repository_id,user_id) DO UPDATE SET role=excluded.role"
      )
        .bind(repo.id, person.id, parsed.data.role, Date.now())
        .run();
      logger.info("collaborator:saved", { userId: person.id, role: parsed.data.role });
      return dataResponse({
        id: person.id,
        identifier: parsed.data.identifier,
        role: parsed.data.role,
        inherited: false,
      });
    }
    if (request.method === "DELETE" && id) {
      const deleted = await env.DB.prepare(
        "DELETE FROM repository_collaborators WHERE repository_id=? AND user_id=? RETURNING user_id"
      )
        .bind(repo.id, id)
        .first();
      if (!deleted)
        return errorResponse(
          404,
          "not_found",
          "Collaborator was not found or has inherited access."
        );
      logger.info("collaborator:removed", { userId: id });
      const stillHasAccess = (await repositoryRole(env.DB, repo.id, id)) !== null;
      const revoked =
        stillHasAccess || (await revokeAgentSessions(env, { repositoryId: repo.id, userId: id }));
      return dataResponse({ deleted: true, revocationIncomplete: !revoked });
    }
  }
  return errorResponse(405, "method_not_allowed", "Method is not allowed.");
}
