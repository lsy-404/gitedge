import { ActorSchema, type Actor, type TrustedUser } from "../../../packages/contracts/src/index";

export type ForgeEnv = {
  readonly DB: D1Database;
  readonly ARTIFACTS: Artifacts;
  readonly GIT: { fetch(request: Request): Promise<Response> };
  readonly LOG_LEVEL?: string;
  readonly USER_GROUP_LIMITS_JSON?: string;
};
export type RepositoryRow = {
  id: string;
  namespace_id: string;
  owner: string;
  slug: string;
  visibility: "public" | "private";
  description: string;
  artifact_name?: string | null;
  remote?: string | null;
  default_branch?: string;
  created_at: number;
  updated_at: number;
};
type NumberRow = { number: number | null };
export type NumberedTable =
  "forge_issues" | "forge_pull_requests" | "forge_discussions" | "forge_tasks";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function isMember(
  env: ForgeEnv,
  repositoryId: string,
  userId: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS found FROM repositories JOIN namespace_memberships ON namespace_memberships.namespace_id = repositories.namespace_id WHERE repositories.id = ? AND namespace_memberships.user_id = ?"
  )
    .bind(repositoryId, userId)
    .first<{ found: number }>();
  return row !== null;
}

export function canWriteSession(user: TrustedUser, repositoryId: string): boolean {
  return (
    !user.agentSession ||
    (user.agentSession.repositoryId === repositoryId && user.agentSession.permission === "write")
  );
}

export async function nextNumber(
  env: ForgeEnv,
  table: NumberedTable,
  repositoryId: string
): Promise<number> {
  const column =
    table === "forge_discussions"
      ? "discussion_number"
      : table === "forge_tasks"
        ? "task_number"
        : "conversation_number";
  await env.DB.prepare("INSERT OR IGNORE INTO forge_counters (repository_id) VALUES (?)")
    .bind(repositoryId)
    .run();
  const row = await env.DB.prepare(
    `UPDATE forge_counters SET ${column} = ${column} + 1 WHERE repository_id = ? RETURNING ${column} AS number`
  )
    .bind(repositoryId)
    .first<NumberRow>();
  if (!row?.number) throw new Error("Repository counter did not return a number.");
  return row.number;
}

export function parseActor(value: unknown, authorId: unknown): Actor {
  try {
    const parsed = ActorSchema.safeParse(JSON.parse(String(value)));
    if (parsed.success) return parsed.data;
  } catch {
    /* malformed legacy actor data falls back to the stored user identity */
  }
  const id = typeof authorId === "string" ? authorId : "unknown";
  return { kind: "user", id, name: id };
}
