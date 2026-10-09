/** Direct grants for tests whose subject is something other than the invitation flow. */
export async function grantCollaborator(
  db: D1Database,
  repositoryId: string,
  userId: string,
  role: "read" | "write" | "admin"
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO repository_collaborators (repository_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(repository_id, user_id) DO UPDATE SET role = excluded.role"
    )
    .bind(repositoryId, userId, role, Date.now())
    .run();
}

export async function grantOrganizationMember(
  db: D1Database,
  organizationSlug: string,
  userId: string,
  role: "owner" | "member"
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO namespace_memberships (namespace_id, user_id, created_at, role) SELECT id, ?, ?, ? FROM namespaces WHERE slug = ?"
    )
    .bind(userId, Date.now(), role, organizationSlug)
    .run();
}
