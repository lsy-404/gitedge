export class RefWriteBlocked extends Error {
  constructor(public readonly code: "pull_locked" | "ref_busy") {
    super(
      code === "pull_locked"
        ? "This pull request is locked. A repository writer must unlock it before changing its source branch."
        : "A write to this branch is in progress. Retry when it finishes."
    );
  }
}

export interface RefWriteLease extends AsyncDisposable {
  release(): Promise<void>;
}

const lockedSource = `SELECT p.id FROM forge_pull_requests p
  LEFT JOIN auth_agent_sessions s ON s.id = p.head_session_id
  JOIN repositories r ON r.id = COALESCE(p.head_repository_id, p.repository_id)
  WHERE p.state = 'open' AND p.locked_at IS NOT NULL
    AND CASE WHEN p.head_session_id IS NOT NULL THEN s.workspace_name ELSE r.artifact_name END = ?
    AND 'refs/heads/' || p.head_ref = ?`;

export async function acquireRefWrites(
  db: D1Database,
  artifactName: string,
  refs: readonly string[],
  changingLock = false
): Promise<RefWriteLease> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const release = async () => {
    await db.prepare("DELETE FROM git_ref_writes WHERE token = ?").bind(token).run();
  };
  try {
    for (const ref of [...new Set(refs)].sort()) {
      const statement = `INSERT INTO git_ref_writes (artifact_name, ref, token, expires_at)
        SELECT ?, ?, ?, ? WHERE ${changingLock ? "1" : `NOT EXISTS (${lockedSource})`}
        ON CONFLICT(artifact_name, ref) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
        WHERE git_ref_writes.expires_at < ?`;
      const values = [artifactName, ref, token, now + 300_000];
      if (!changingLock) values.push(artifactName, ref);
      values.push(now);
      const result = await db
        .prepare(statement)
        .bind(...values)
        .run();
      if (result.meta.changes !== 1) {
        const locked = await db.prepare(lockedSource).bind(artifactName, ref).first();
        throw new RefWriteBlocked(locked ? "pull_locked" : "ref_busy");
      }
    }
    return { release, [Symbol.asyncDispose]: release };
  } catch (cause) {
    await release();
    throw cause;
  }
}

export function holdRefWrites(
  body: ReadableStream<Uint8Array>,
  lease: RefWriteLease
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          await lease.release();
          controller.close();
        } else controller.enqueue(result.value);
      } catch (cause) {
        await lease.release();
        controller.error(cause);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await lease.release();
      }
    },
  });
}
