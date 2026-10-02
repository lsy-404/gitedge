import {
  AgentAssignmentPolicySchema,
  type AgentAssignmentPolicy,
  type Assignee,
  type AssigneeCandidate,
  type AssigneeRef,
  type AssignmentRole,
  type SetAssignmentsInput,
  type TaskLinkKind,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { error, type ForgeEnv, type RepositoryRow } from "./common";

type AssignmentRow = { role: AssignmentRole; kind: "user" | "agent"; id: string; name: string };
export type AssignmentSets = { assignees: Assignee[]; reviewers: Assignee[] };
type AgentRow = {
  id: string;
  name: string;
  user_id: string;
  owner_name: string;
  disabled_at: number | null;
  owner_is_member: number;
};
export type AssignableResult = { ok: true; assignee: Assignee } | { ok: false; response: Response };

/** Correlated subquery that returns every assignment of one issue or pull request as JSON. */
export function assignmentsColumn(kind: TaskLinkKind, alias: string): string {
  return `(SELECT json_group_array(json_object('role', a.role, 'kind', a.assignee_kind, 'id', a.assignee_id, 'name', COALESCE(u.identifier, g.name, a.assignee_id))) FROM forge_assignments a LEFT JOIN users u ON a.assignee_kind = 'user' AND u.id = a.assignee_id LEFT JOIN auth_agents g ON a.assignee_kind = 'agent' AND g.id = a.assignee_id WHERE a.target_kind = '${kind}' AND a.target_id = ${alias}.id) AS assignments_json`;
}

function isAssignmentRow(value: unknown): value is AssignmentRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    (row.role === "assignee" || row.role === "reviewer") &&
    (row.kind === "user" || row.kind === "agent") &&
    typeof row.id === "string" &&
    typeof row.name === "string"
  );
}

export function parseAssignments(value: unknown): AssignmentSets {
  const sets: AssignmentSets = { assignees: [], reviewers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof value === "string" ? value : "[]");
  } catch {
    return sets;
  }
  if (!Array.isArray(parsed)) return sets;
  for (const row of parsed.filter(isAssignmentRow)) {
    const assignee: Assignee = { kind: row.kind, id: row.id, name: row.name };
    (row.role === "assignee" ? sets.assignees : sets.reviewers).push(assignee);
  }
  sets.assignees.sort((a, b) => a.name.localeCompare(b.name));
  sets.reviewers.sort((a, b) => a.name.localeCompare(b.name));
  return sets;
}

async function agentAssignmentPolicy(
  env: ForgeEnv,
  repositoryId: string
): Promise<AgentAssignmentPolicy> {
  const row = await env.DB.prepare(
    "SELECT agent_assignment_policy AS policy FROM repositories WHERE id = ?"
  )
    .bind(repositoryId)
    .first<{ policy: string }>();
  return AgentAssignmentPolicySchema.catch("owner").parse(row?.policy);
}

/**
 * Validates one assignee for a repository. Humans must be namespace members. Agents must be
 * enabled, owned by a namespace member, and obey the repository's agent assignment policy.
 */
export async function resolveAssignable(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: TrustedUser,
  ref: AssigneeRef,
  policy?: AgentAssignmentPolicy
): Promise<AssignableResult> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  if (ref.kind === "user") {
    const row = await env.DB.prepare(
      "SELECT users.id, users.identifier FROM users JOIN namespace_memberships ON namespace_memberships.user_id = users.id WHERE users.id = ? AND namespace_memberships.namespace_id = ?"
    )
      .bind(ref.id, repository.namespace_id)
      .first<{ id: string; identifier: string }>();
    if (!row) {
      logger.warn("forge:assignment-rejected-user", { repositoryId: repository.id });
      return {
        ok: false,
        response: error(400, "bad_request", "Assignee must be a repository member."),
      };
    }
    return { ok: true, assignee: { kind: "user", id: row.id, name: row.identifier } };
  }
  const agent = await env.DB.prepare(
    "SELECT auth_agents.id, auth_agents.name, auth_agents.user_id, auth_agents.disabled_at, owner.identifier AS owner_name, EXISTS (SELECT 1 FROM namespace_memberships WHERE namespace_memberships.namespace_id = ? AND namespace_memberships.user_id = auth_agents.user_id) AS owner_is_member FROM auth_agents JOIN users AS owner ON owner.id = auth_agents.user_id WHERE auth_agents.id = ?"
  )
    .bind(repository.namespace_id, ref.id)
    .first<AgentRow>();
  if (!agent || agent.disabled_at !== null || agent.owner_is_member !== 1) {
    logger.warn("forge:assignment-rejected-agent", { repositoryId: repository.id });
    return {
      ok: false,
      response: error(400, "bad_request", "Agent is unavailable in this repository."),
    };
  }
  const effectivePolicy = policy ?? (await agentAssignmentPolicy(env, repository.id));
  if (effectivePolicy === "owner" && agent.user_id !== user.id) {
    logger.warn("forge:assignment-rejected-policy", {
      repositoryId: repository.id,
      policy: effectivePolicy,
    });
    return {
      ok: false,
      response: error(
        403,
        "forbidden",
        "Only the agent owner may assign this agent under the current policy."
      ),
    };
  }
  return { ok: true, assignee: { kind: "agent", id: agent.id, name: agent.name } };
}

/** Members plus the agents the caller may assign under the repository policy. */
export async function assigneeCandidates(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: TrustedUser
): Promise<AssigneeCandidate[]> {
  const policy = await agentAssignmentPolicy(env, repository.id);
  const users = await env.DB.prepare(
    "SELECT users.id, users.identifier AS name FROM namespace_memberships JOIN users ON users.id = namespace_memberships.user_id WHERE namespace_memberships.namespace_id = ? ORDER BY users.identifier ASC"
  )
    .bind(repository.namespace_id)
    .all<{ id: string; name: string }>();
  const agents = await env.DB.prepare(
    "SELECT auth_agents.id, auth_agents.name, owner.identifier AS owner_name FROM auth_agents JOIN users AS owner ON owner.id = auth_agents.user_id JOIN namespace_memberships ON namespace_memberships.user_id = auth_agents.user_id AND namespace_memberships.namespace_id = ? WHERE auth_agents.disabled_at IS NULL AND (? = 'members' OR auth_agents.user_id = ?) ORDER BY owner.identifier ASC, auth_agents.name ASC"
  )
    .bind(repository.namespace_id, policy, user.id)
    .all<{ id: string; name: string; owner_name: string }>();
  return [
    ...users.results.map((row): AssigneeCandidate => ({ kind: "user", ...row })),
    ...agents.results.map((row): AssigneeCandidate => ({
      kind: "agent",
      id: row.id,
      name: row.name,
      ownerName: row.owner_name,
    })),
  ];
}

/**
 * Replaces the whole assignee or reviewer set of one issue or pull request. Validation happens
 * first; the delete and inserts then land in a single D1 batch.
 */
export async function replaceAssignments(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: TrustedUser,
  target: { kind: TaskLinkKind; id: string },
  input: SetAssignmentsInput
): Promise<Response | null> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  const unique = new Map(input.assignees.map((ref) => [`${ref.kind}:${ref.id}`, ref]));
  const policy = await agentAssignmentPolicy(env, repository.id);
  for (const ref of unique.values()) {
    const resolved = await resolveAssignable(env, repository, user, ref, policy);
    if (!resolved.ok) return resolved.response;
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM forge_assignments WHERE target_kind = ? AND target_id = ? AND role = ?"
    ).bind(target.kind, target.id, input.role),
    ...[...unique.values()].map((ref) =>
      env.DB.prepare(
        "INSERT INTO forge_assignments (id, repository_id, target_kind, target_id, role, assignee_kind, assignee_id, assigned_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        repository.id,
        target.kind,
        target.id,
        input.role,
        ref.kind,
        ref.id,
        user.id,
        now
      )
    ),
  ]);
  logger.info("forge:assignments-replaced", {
    repositoryId: repository.id,
    targetKind: target.kind,
    targetId: target.id,
    role: input.role,
    count: unique.size,
  });
  return null;
}
