import type { RepositoryRole } from "../../../packages/contracts/src/forge";

export interface RepositoryPath {
  id: string;
  owner: string;
  slug: string;
  namespaceId: string;
  visibility: "public" | "private";
}
export async function resolveRepositoryPath(
  db: D1Database,
  owner: string,
  slug: string
): Promise<RepositoryPath | null> {
  return db
    .prepare(
      "SELECT r.id,n.slug AS owner,r.slug,r.namespace_id AS namespaceId,r.visibility FROM repository_paths p JOIN repositories r ON r.id = p.repository_id JOIN namespaces n ON n.id = r.namespace_id JOIN namespaces pn ON pn.id = p.namespace_id WHERE pn.slug = ? AND p.slug = ? AND r.deleted_at IS NULL"
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
      "SELECT CASE WHEN m.role = 'owner' OR c.role = 'admin' THEN 'admin' WHEN m.role = 'member' OR c.role = 'write' THEN 'write' WHEN c.role = 'read' THEN 'read' ELSE NULL END AS role FROM repositories r LEFT JOIN namespace_memberships m ON m.namespace_id = r.namespace_id AND m.user_id = ? LEFT JOIN repository_collaborators c ON c.repository_id = r.id AND c.user_id = ? WHERE r.id = ? AND r.deleted_at IS NULL"
    )
    .bind(userId, userId, repositoryId)
    .first<{ role: RepositoryRole | null }>();
  return row?.role ?? null;
}
export function writableRole(role: RepositoryRole | null): boolean {
  return role === "admin" || role === "write";
}
