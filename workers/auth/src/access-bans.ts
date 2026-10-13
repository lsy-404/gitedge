export async function expireAccessBans(env: { DB: D1Database }, now = Date.now()): Promise<void> {
  for (let batch = 0; batch < 5; batch += 1) {
    const [, removed] = await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET disabled_at = NULL WHERE id IN (SELECT subject_value FROM access_bans WHERE kind = 'user' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT 100) AND disabled_at = (SELECT created_at FROM access_bans WHERE kind = 'user' AND subject_value = users.id LIMIT 1)"
      ).bind(now),
      env.DB.prepare(
        "DELETE FROM access_bans WHERE id IN (SELECT id FROM access_bans WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT 100)"
      ).bind(now),
    ]);
    if (removed.meta.changes === 0) return;
  }
}

export async function expireUserAccessBan(
  env: { DB: D1Database },
  userId: string,
  now = Date.now()
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at = (SELECT created_at FROM access_bans WHERE kind = 'user' AND subject_value = ? AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 1)"
    ).bind(userId, userId, now),
    env.DB.prepare(
      "DELETE FROM access_bans WHERE kind = 'user' AND subject_value = ? AND expires_at IS NOT NULL AND expires_at <= ?"
    ).bind(userId, now),
  ]);
}
