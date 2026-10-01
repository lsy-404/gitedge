export async function runSqlScript(db: D1Database, sql: string): Promise<void> {
  let statement = "";
  let inTrigger = false;
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (!statement && (!trimmed || trimmed.startsWith("--") || /^PRAGMA\b/i.test(trimmed)))
      continue;
    if (/^CREATE TRIGGER\b/i.test(trimmed)) inTrigger = true;
    statement += `${line}\n`;
    if (inTrigger && /^END;?$/i.test(trimmed)) {
      await db.prepare(statement).run();
      statement = "";
      inTrigger = false;
    } else if (!inTrigger && trimmed.endsWith(";")) {
      await db.prepare(statement).run();
      statement = "";
    }
  }
  if (statement.trim()) await db.prepare(statement).run();
}
