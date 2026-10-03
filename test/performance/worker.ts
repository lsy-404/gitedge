import { timingSafeEqual } from "node:crypto";

type QueryMetrics = {
  queryCount: number;
  rowsReturned: number;
  rowsRead: number;
  rowsWritten: number;
  d1BindingCallCount: number;
  sqlDurationMs: number;
  sqlDurationSources: Array<"timings.sql_duration_ms" | "meta.duration">;
  d1BindingElapsedMs: number;
};

type BenchResult = {
  path: "read" | "write" | "mixed";
  mode: "sequential" | "batch";
  count: number;
  workerElapsedMs: number;
} & QueryMetrics;

const SESSION_COUNT = 16;
const AUDIT_COUNT = 8;
const MAX_OPERATIONS = 8;
const now = (): number => performance.now();

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function authorized(request: Request, token: string): boolean {
  const authorization = request.headers.get("Authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) return false;
  const expected = Buffer.from(token, "utf8");
  const supplied = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function fixtureNumber(value: number): string {
  return String((value % SESSION_COUNT) + 1).padStart(2, "0");
}

function readStatement(db: D1Database, sessionId: string, at: number): D1PreparedStatement {
  return db
    .prepare(
      "SELECT s.session_id, s.user_id, s.repository_id, c.role, s.expires_at FROM bench_sessions AS s JOIN bench_collaborators AS c ON c.repository_id = s.repository_id AND c.user_id = s.user_id WHERE s.session_id = ? AND s.status = 'active' AND s.expires_at > ?"
    )
    .bind(sessionId, at);
}

function writeStatement(db: D1Database, auditId: number, at: number): D1PreparedStatement {
  return db
    .prepare("UPDATE bench_audit SET write_count = write_count + 1, updated_at = ? WHERE id = ?")
    .bind(at, auditId);
}

async function executeStatements(
  db: D1Database,
  statements: D1PreparedStatement[],
  mode: "sequential" | "batch"
): Promise<QueryMetrics> {
  const started = now();
  let results: D1Result<Record<string, unknown>>[];
  if (mode === "batch") {
    results = await db.batch(statements);
  } else {
    results = [];
    for (const statement of statements) {
      results.push(await statement.run<Record<string, unknown>>());
    }
  }

  const d1BindingElapsedMs = now() - started;
  const sqlDurationSources = [
    ...new Set(
      results.map((result) =>
        result.meta.timings?.sql_duration_ms !== undefined
          ? "timings.sql_duration_ms"
          : "meta.duration"
      )
    ),
  ];
  return {
    queryCount: results.length,
    rowsReturned: results.reduce((total, result) => total + result.results.length, 0),
    rowsRead: results.reduce((total, result) => total + result.meta.rows_read, 0),
    rowsWritten: results.reduce((total, result) => total + result.meta.rows_written, 0),
    d1BindingCallCount: mode === "batch" ? 1 : statements.length,
    sqlDurationMs: results.reduce(
      (total, result) => total + (result.meta.timings?.sql_duration_ms ?? result.meta.duration),
      0
    ),
    sqlDurationSources,
    d1BindingElapsedMs,
  };
}

async function seed(db: D1Database): Promise<QueryMetrics> {
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM bench_audit"),
    db.prepare("DELETE FROM bench_collaborators"),
    db.prepare("DELETE FROM bench_sessions"),
  ];
  for (let index = 0; index < SESSION_COUNT; index += 1) {
    const sessionId = `bench-session-${fixtureNumber(index)}`;
    const userId = `bench-user-${String(index + 1).padStart(2, "0")}`;
    const repositoryId = `bench-repo-${String((index % 4) + 1).padStart(2, "0")}`;
    const active = index % 4 === 0 ? "disabled" : "active";
    statements.push(
      db
        .prepare(
          "INSERT INTO bench_sessions (session_id, user_id, repository_id, status, expires_at) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(sessionId, userId, repositoryId, active, Date.now() + 3_600_000),
      db
        .prepare("INSERT INTO bench_collaborators (repository_id, user_id, role) VALUES (?, ?, ?)")
        .bind(repositoryId, userId, index % 2 === 0 ? "admin" : "write")
    );
  }
  for (let index = 1; index <= AUDIT_COUNT; index += 1) {
    statements.push(
      db
        .prepare(
          "INSERT INTO bench_audit (id, session_id, write_count, updated_at) VALUES (?, ?, 0, ?)"
        )
        .bind(index, `bench-session-${fixtureNumber(index - 1)}`, Date.now())
    );
  }
  return executeStatements(db, statements, "batch");
}

function queryParameters(
  url: URL
): { mode: "sequential" | "batch"; count: number; offset: number } | null {
  const modeValue = url.searchParams.get("mode") ?? "sequential";
  const count = Number(url.searchParams.get("count") ?? 4);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (
    (modeValue !== "sequential" && modeValue !== "batch") ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_OPERATIONS ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1_000_000
  )
    return null;
  return { mode: modeValue, count, offset };
}

function operations(
  db: D1Database,
  path: "read" | "write" | "mixed",
  count: number,
  offset: number
): D1PreparedStatement[] {
  const at = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < count; index += 1) {
    const slot = offset + index;
    if (path === "read" || path === "mixed") {
      statements.push(readStatement(db, `bench-session-${fixtureNumber(slot)}`, at));
    }
    if (path === "write" || path === "mixed") {
      statements.push(writeStatement(db, (slot % AUDIT_COUNT) + 1, at));
    }
  }
  return statements;
}

async function handleBenchmark(
  request: Request,
  db: D1Database,
  path: "read" | "write" | "mixed"
): Promise<Response> {
  if (request.method !== (path === "read" ? "GET" : "POST")) {
    return json({ error: "method_not_allowed" }, 405);
  }
  const params = queryParameters(new URL(request.url));
  if (!params) return json({ error: "invalid_benchmark_parameters" }, 400);
  const workerStarted = now();
  const metrics = await executeStatements(
    db,
    operations(db, path, params.count, params.offset),
    params.mode
  );
  const result: BenchResult = {
    path,
    mode: params.mode,
    count: params.count,
    workerElapsedMs: now() - workerStarted,
    ...metrics,
  };
  return json({ ...result, d1QueueWaitMeasured: false });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.BENCH_TOKEN || !authorized(request, env.BENCH_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
    const url = new URL(request.url);
    if (url.pathname === "/seed") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const metrics = await seed(env.DB);
      return json({
        seededSessions: SESSION_COUNT,
        seededCollaborators: SESSION_COUNT,
        seededAuditRows: AUDIT_COUNT,
        ...metrics,
        d1QueueWaitMeasured: false,
      });
    }
    if (url.pathname === "/read") return handleBenchmark(request, env.DB, "read");
    if (url.pathname === "/write") return handleBenchmark(request, env.DB, "write");
    if (url.pathname === "/mixed") return handleBenchmark(request, env.DB, "mixed");
    return json({ error: "not_found" }, 404);
  },
};
