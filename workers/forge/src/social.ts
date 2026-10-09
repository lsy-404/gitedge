import {
  ExploreQuerySchema,
  SetRepositoryTopicsInputSchema,
  SetWatchInputSchema,
  type ExplorePage,
  type ExploreRepository,
  type ExploreTopic,
  type RepositorySocial,
  type StarredPage,
  type TrustedUser,
  type WatchLevel,
} from "../../../packages/contracts/src/index";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole } from "../../../src/worker/common/repositories";
import {
  parseJson,
  type ForgeEnv,
  type RepositoryRow,
  type RepositorySocialFields,
} from "./common";

const POPULAR_TOPICS = 30;
const STARRED_PAGE = ExploreQuerySchema.pick({ limit: true, cursor: true });

/** Read access to repository alias `a` for the viewer bound twice as `?`: public, namespace member or collaborator. */
export function readableBy(alias: string): string {
  return `(${alias}.visibility = 'public' OR EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id = ${alias}.namespace_id AND m.user_id = ?) OR EXISTS (SELECT 1 FROM repository_collaborators c WHERE c.repository_id = ${alias}.id AND c.user_id = ?))`;
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

async function topicsByRepository(
  env: ForgeEnv,
  ids: readonly string[]
): Promise<Map<string, string[]>> {
  const topics = new Map<string, string[]>();
  if (ids.length === 0) return topics;
  const rows = await env.DB.prepare(
    "SELECT repository_id AS id, topic FROM repository_topics WHERE repository_id IN (SELECT value FROM json_each(?)) ORDER BY topic"
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string; topic: string }>();
  for (const row of rows.results) topics.set(row.id, [...(topics.get(row.id) ?? []), row.topic]);
  return topics;
}

/** Topics, visible fork counts and the readable parent of each repository, in three bounded queries. */
export async function repositorySocialFields(
  env: ForgeEnv,
  rows: readonly RepositoryRow[],
  viewerId: string | null
): Promise<Map<string, RepositorySocialFields>> {
  const result = new Map<string, RepositorySocialFields>();
  if (rows.length === 0) return result;
  const ids = JSON.stringify(rows.map((row) => row.id));
  const topics = await topicsByRepository(
    env,
    rows.map((row) => row.id)
  );
  const counts = await env.DB.prepare(
    `SELECT r.fork_of AS id, COUNT(*) AS total FROM repositories r WHERE r.fork_of IN (SELECT value FROM json_each(?)) AND r.deleted_at IS NULL AND r.artifact_name IS NOT NULL AND ${readableBy("r")} GROUP BY r.fork_of`
  )
    .bind(ids, viewerId, viewerId)
    .all<{ id: string; total: number }>();
  const parents = await env.DB.prepare(
    `SELECT f.id AS child, p.id, n.slug AS owner, p.slug AS name FROM repositories f JOIN repositories p ON p.id = f.fork_of JOIN namespaces n ON n.id = p.namespace_id WHERE f.id IN (SELECT value FROM json_each(?)) AND p.deleted_at IS NULL AND ${readableBy("p")}`
  )
    .bind(ids, viewerId, viewerId)
    .all<{ child: string; id: string; owner: string; name: string }>();
  const forkCounts = new Map(counts.results.map((row) => [row.id, row.total]));
  const origins = new Map(parents.results.map((row) => [row.child, row]));
  for (const row of rows) {
    const origin = origins.get(row.id);
    result.set(row.id, {
      topics: topics.get(row.id) ?? [],
      forkCount: forkCounts.get(row.id) ?? 0,
      forkOf: origin ? { id: origin.id, owner: origin.owner, name: origin.name } : null,
    });
  }
  return result;
}

export async function socialFieldsFor(
  env: ForgeEnv,
  row: RepositoryRow,
  viewerId: string | null
): Promise<RepositorySocialFields> {
  const fields = (await repositorySocialFields(env, [row], viewerId)).get(row.id);
  if (!fields) throw new Error("Repository social fields were not resolved.");
  return fields;
}

interface ExploreRow {
  id: string;
  owner: string;
  name: string;
  description: string;
  starCount: number;
  updatedAt: number;
  sortAt: number;
  parentId: string | null;
  parentOwner: string | null;
  parentName: string | null;
}
const EXPLORE_COLUMNS =
  "r.id, n.slug AS owner, r.slug AS name, r.description, r.star_count AS starCount, r.updated_at AS updatedAt, p.id AS parentId, pn.slug AS parentOwner, p.slug AS parentName";
const EXPLORE_JOINS =
  "JOIN namespaces n ON n.id = r.namespace_id LEFT JOIN repositories p ON p.id = r.fork_of AND p.visibility = 'public' AND p.deleted_at IS NULL LEFT JOIN namespaces pn ON pn.id = p.namespace_id";

async function presentExplore(
  env: ForgeEnv,
  rows: readonly ExploreRow[]
): Promise<ExploreRepository[]> {
  const topics = await topicsByRepository(
    env,
    rows.map((row) => row.id)
  );
  return rows.map((row) => ({
    id: row.id,
    owner: row.owner,
    name: row.name,
    description: row.description,
    topics: topics.get(row.id) ?? [],
    starCount: row.starCount,
    updatedAt: row.updatedAt,
    forkOf:
      row.parentId && row.parentOwner && row.parentName
        ? { id: row.parentId, owner: row.parentOwner, name: row.parentName }
        : null,
  }));
}

/** Public, non-deleted repositories only; private repositories never appear regardless of the viewer. */
async function explore(env: ForgeEnv, search: URLSearchParams): Promise<Response> {
  const parsed = ExploreQuerySchema.safeParse(Object.fromEntries(search));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid explore query.");
  const query = parsed.data;
  const filters = [
    "r.visibility = 'public'",
    "r.deleted_at IS NULL",
    "r.artifact_name IS NOT NULL",
  ];
  const binds: unknown[] = [];
  if (query.topic) {
    filters.push(
      "EXISTS (SELECT 1 FROM repository_topics t WHERE t.repository_id = r.id AND t.topic = ?)"
    );
    binds.push(query.topic);
  }
  if (query.q) {
    const pattern = likePattern(query.q);
    filters.push(
      "(r.slug LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\' OR n.slug LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM repository_topics t WHERE t.repository_id = r.id AND t.topic LIKE ? ESCAPE '\\'))"
    );
    binds.push(pattern, pattern, pattern, pattern);
  }
  if (query.cursor) {
    const numbers = query.cursor.split(":");
    const id = numbers.pop();
    if (query.sort === "stars") {
      const [stars, updatedAt] = numbers.map(Number);
      if (numbers.length !== 2) return errorResponse(400, "bad_request", "Invalid cursor.");
      filters.push(
        "(r.star_count < ? OR (r.star_count = ? AND (r.updated_at < ? OR (r.updated_at = ? AND r.id < ?))))"
      );
      binds.push(stars, stars, updatedAt, updatedAt, id);
    } else {
      const [updatedAt] = numbers.map(Number);
      if (numbers.length !== 1) return errorResponse(400, "bad_request", "Invalid cursor.");
      filters.push("(r.updated_at < ? OR (r.updated_at = ? AND r.id < ?))");
      binds.push(updatedAt, updatedAt, id);
    }
  }
  const order =
    query.sort === "stars"
      ? "r.star_count DESC, r.updated_at DESC, r.id DESC"
      : "r.updated_at DESC, r.id DESC";
  const rows = await env.DB.prepare(
    `SELECT ${EXPLORE_COLUMNS} FROM repositories r ${EXPLORE_JOINS} WHERE ${filters.join(" AND ")} ORDER BY ${order} LIMIT ?`
  )
    .bind(...binds, query.limit + 1)
    .all<ExploreRow>();
  const page = rows.results.slice(0, query.limit);
  const last = page.at(-1);
  const body: ExplorePage = {
    items: await presentExplore(env, page),
    nextCursor:
      rows.results.length > query.limit && last
        ? query.sort === "stars"
          ? `${last.starCount}:${last.updatedAt}:${last.id}`
          : `${last.updatedAt}:${last.id}`
        : null,
  };
  return dataResponse(body);
}

async function popularTopics(env: ForgeEnv): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT t.topic, COUNT(*) AS repositories FROM repository_topics t JOIN repositories r ON r.id = t.repository_id WHERE r.visibility = 'public' AND r.deleted_at IS NULL AND r.artifact_name IS NOT NULL GROUP BY t.topic ORDER BY repositories DESC, t.topic LIMIT ?"
  )
    .bind(POPULAR_TOPICS)
    .all<ExploreTopic>();
  return dataResponse(rows.results);
}

/** Anonymous-readable discovery endpoints. */
export async function handleExplore(
  env: ForgeEnv,
  request: Request,
  parts: readonly string[]
): Promise<Response | null> {
  if (parts[0] !== "explore") return null;
  if (request.method !== "GET")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  if (parts.length === 1) return explore(env, new URL(request.url).searchParams);
  if (parts.length === 2 && parts[1] === "topics") return popularTopics(env);
  return errorResponse(404, "not_found", "Endpoint was not found.");
}

/** The signed-in user's starred repositories, newest star first, limited to what they can still read. */
export async function handleStarred(
  env: ForgeEnv,
  request: Request,
  user: TrustedUser,
  parts: readonly string[]
): Promise<Response | null> {
  if (parts[0] !== "stars") return null;
  if (parts.length !== 1 || request.method !== "GET")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const parsed = STARRED_PAGE.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid starred query.");
  const { limit, cursor } = parsed.data;
  const filters: string[] = [];
  const binds: unknown[] = [];
  if (cursor) {
    const [starredAt, id] = cursor.split(":");
    if (cursor.split(":").length !== 2) return errorResponse(400, "bad_request", "Invalid cursor.");
    filters.push("AND (s.created_at < ? OR (s.created_at = ? AND r.id < ?))");
    binds.push(Number(starredAt), Number(starredAt), id);
  }
  const allowed = user.token?.repositoryIds;
  if (allowed) {
    filters.push("AND r.id IN (SELECT value FROM json_each(?))");
    binds.push(JSON.stringify(allowed));
  }
  const rows = await env.DB.prepare(
    `SELECT ${EXPLORE_COLUMNS}, s.created_at AS sortAt FROM repository_stars s JOIN repositories r ON r.id = s.repository_id ${EXPLORE_JOINS} WHERE s.user_id = ? AND r.deleted_at IS NULL AND r.artifact_name IS NOT NULL AND ${readableBy("r")} ${filters.join(" ")} ORDER BY s.created_at DESC, r.id DESC LIMIT ?`
  )
    .bind(user.id, user.id, user.id, ...binds, limit + 1)
    .all<ExploreRow>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  const body: StarredPage = {
    items: await presentExplore(env, page),
    nextCursor: rows.results.length > limit && last ? `${last.sortAt}:${last.id}` : null,
  };
  return dataResponse(body);
}

async function watchLevel(
  env: ForgeEnv,
  repositoryId: string,
  userId: string
): Promise<WatchLevel> {
  const row = await env.DB.prepare(
    "SELECT level FROM repository_watches WHERE repository_id = ? AND user_id = ?"
  )
    .bind(repositoryId, userId)
    .first<{ level: "all" | "ignore" }>();
  return row?.level ?? "participating";
}

async function socialState(
  env: ForgeEnv,
  repository: RepositoryRow,
  userId: string
): Promise<RepositorySocial> {
  const [counters, starred] = await Promise.all([
    env.DB.prepare("SELECT star_count AS starCount FROM repositories WHERE id = ?")
      .bind(repository.id)
      .first<{ starCount: number }>(),
    env.DB.prepare(
      "SELECT 1 AS found FROM repository_stars WHERE repository_id = ? AND user_id = ?"
    )
      .bind(repository.id, userId)
      .first<{ found: number }>(),
  ]);
  const fields = await socialFieldsFor(env, repository, userId);
  return {
    starCount: counters?.starCount ?? 0,
    starred: Boolean(starred),
    watchLevel: await watchLevel(env, repository.id, userId),
    forkCount: fields.forkCount,
  };
}

/** Stars, watch level and topics of one repository the caller can already read. */
export async function repositorySocial(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  parts: readonly string[]
): Promise<Response | null> {
  const resource = parts[2];
  if (!["social", "star", "watch", "topics"].includes(resource ?? "") || parts.length !== 3)
    return null;
  if (user.agentSession)
    return errorResponse(403, "forbidden", "Agent sessions cannot change social settings.");
  const logger = createLogger(env.LOG_LEVEL, { service: "forge", repoId: repository.id });

  if (resource === "social") {
    if (request.method !== "GET")
      return errorResponse(405, "method_not_allowed", "Method is not allowed.");
    return dataResponse(await socialState(env, repository, user.id));
  }
  if (resource === "star") {
    if (request.method !== "PUT" && request.method !== "DELETE")
      return errorResponse(405, "method_not_allowed", "Method is not allowed.");
    const change =
      request.method === "PUT"
        ? env.DB.prepare(
            "INSERT OR IGNORE INTO repository_stars (repository_id, user_id, created_at) VALUES (?, ?, ?)"
          ).bind(repository.id, user.id, Date.now())
        : env.DB.prepare(
            "DELETE FROM repository_stars WHERE repository_id = ? AND user_id = ?"
          ).bind(repository.id, user.id);
    await env.DB.batch([
      change,
      env.DB.prepare(
        "UPDATE repositories SET star_count = (SELECT COUNT(*) FROM repository_stars WHERE repository_id = ?1) WHERE id = ?1"
      ).bind(repository.id),
    ]);
    logger.debug("forge:star-changed", { userId: user.id, starred: request.method === "PUT" });
    return dataResponse(await socialState(env, repository, user.id));
  }
  if (resource === "watch") {
    if (request.method !== "PUT")
      return errorResponse(405, "method_not_allowed", "Method is not allowed.");
    const parsed = SetWatchInputSchema.safeParse(await parseJson(request));
    if (!parsed.success) return errorResponse(400, "bad_request", "Invalid watch level.");
    if (parsed.data.level === "participating")
      await env.DB.prepare("DELETE FROM repository_watches WHERE repository_id = ? AND user_id = ?")
        .bind(repository.id, user.id)
        .run();
    else
      await env.DB.prepare(
        "INSERT INTO repository_watches (repository_id, user_id, level, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(repository_id, user_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at"
      )
        .bind(repository.id, user.id, parsed.data.level, Date.now())
        .run();
    logger.debug("forge:watch-changed", { userId: user.id, level: parsed.data.level });
    return dataResponse(await socialState(env, repository, user.id));
  }
  if (request.method !== "PUT")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  if ((await repositoryRole(env.DB, repository.id, user.id)) !== "admin")
    return errorResponse(403, "forbidden", "Repository administrator access is required.");
  if (repository.archived === 1)
    return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
  const parsed = SetRepositoryTopicsInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid topics.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM repository_topics WHERE repository_id = ?").bind(repository.id),
    ...parsed.data.topics.map((topic) =>
      env.DB.prepare("INSERT INTO repository_topics (repository_id, topic) VALUES (?, ?)").bind(
        repository.id,
        topic
      )
    ),
  ]);
  logger.info("forge:topics-set", { userId: user.id, count: parsed.data.topics.length });
  return dataResponse({ topics: parsed.data.topics });
}
