import type { RepositoryRole } from "../../../packages/contracts/src/forge";

export interface RepositoryPath {
  id: string;
  owner: string;
  slug: string;
  namespaceId: string;
  visibility: "public" | "private";
  systemKind?: "account_runner" | null;
}
export async function resolveRepositoryPath(
  db: D1Database,
  owner: string,
  slug: string
): Promise<RepositoryPath | null> {
  return db
    .prepare(
      "SELECT r.id,n.slug AS owner,r.slug,r.namespace_id AS namespaceId,r.visibility,r.system_kind AS systemKind FROM repository_paths p JOIN repositories r ON r.id = p.repository_id JOIN namespaces n ON n.id = r.namespace_id JOIN namespaces pn ON pn.id = p.namespace_id WHERE pn.slug = ? AND p.slug = ? AND r.deleted_at IS NULL"
    )
    .bind(owner.toLowerCase(), slug.toLowerCase())
    .first<RepositoryPath>();
}
export async function repositoryRole(
  db: D1Database,
  repositoryId: string,
  userId: string
): Promise<RepositoryRole | null> {
  const row = await db
    .prepare(
      "SELECT CASE WHEN r.system_kind = 'account_runner' THEN CASE WHEN n.kind = 'personal' AND n.created_by = ? THEN 'admin' ELSE NULL END WHEN m.role = 'owner' OR c.role = 'admin' THEN 'admin' WHEN m.role = 'member' OR c.role = 'write' THEN 'write' WHEN c.role = 'read' THEN 'read' ELSE NULL END AS role FROM repositories r JOIN namespaces n ON n.id = r.namespace_id LEFT JOIN namespace_memberships m ON m.namespace_id = r.namespace_id AND m.user_id = ? LEFT JOIN repository_collaborators c ON c.repository_id = r.id AND c.user_id = ? WHERE r.id = ? AND r.deleted_at IS NULL"
    )
    .bind(userId, userId, userId, repositoryId)
    .first<{ role: RepositoryRole | null }>();
  return row?.role ?? null;
}

export async function isAccountRunnerRepository(
  db: D1Database,
  repositoryId: string
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM repositories WHERE id = ? AND system_kind = 'account_runner'")
    .bind(repositoryId)
    .first<{ found: number }>();
  return row !== null;
}

export function writableRole(role: RepositoryRole | null): boolean {
  return role === "admin" || role === "write";
}
