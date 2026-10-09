import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import forge from "../../workers/forge/src/index";
import type {
  Notification,
  NotificationPage,
  NotificationUnreadCount,
  TrustedUser,
} from "../../packages/contracts/src/index";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const HEAD = "2".repeat(40);
const BASE = "1".repeat(40);
const MERGE = "c".repeat(40);
const forgeEnv = {
  DB: env.DB,
  ARTIFACTS: new FixtureArtifacts(),
  GIT: {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.endsWith("/pull-head"))
        return Response.json({ data: { oid: HEAD } });
      if (request.method === "GET" && path.endsWith("/compare"))
        return Response.json({ data: { headOid: HEAD } });
      return Response.json({ data: { oid: MERGE } });
    },
  },
};
const people = {
  owner: { id: "u-owner", identifier: "owner", groupKey: "free" },
  writer: { id: "u-writer", identifier: "writer", groupKey: "free" },
  reader: { id: "u-reader", identifier: "reader", groupKey: "free" },
  outsider: { id: "u-outsider", identifier: "outsider", groupKey: "free" },
} satisfies Record<string, TrustedUser>;
type Person = keyof typeof people;

async function call(
  path: string,
  method: string,
  person: Person,
  body?: unknown,
  overrides: Partial<TrustedUser> = {}
): Promise<Response> {
  const headers = trustedHeaders({ ...people[person], ...overrides });
  headers.set("Content-Type", "application/json");
  return forge.fetch(
    new Request(`https://forge.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    forgeEnv
  );
}

async function json<T>(response: Response, status?: number): Promise<T> {
  if (status !== undefined) expect(response.status).toBe(status);
  const payload: { data: T } = await response.json();
  return payload.data;
}

function inbox(person: Person, query = ""): Promise<NotificationPage> {
  return call(`/notifications${query}`, "GET", person).then((response) => json(response, 200));
}

async function issue(person: Person, title: string, body = ""): Promise<{ number: number }> {
  return json(await call("/repositories/rp/issues", "POST", person, { title, body }), 201);
}

async function pull(person: Person, title: string): Promise<{ number: number }> {
  return json(
    await call("/repositories/rp/pull-requests", "POST", person, {
      title,
      baseRef: "main",
      headRef: "topic",
    }),
    201
  );
}

async function reasons(person: Person): Promise<Record<string, string>> {
  const page = await inbox(person, "?limit=50");
  return Object.fromEntries(
    page.items.map((item) => [`${item.subjectKind}:${item.subjectNumber ?? "repo"}`, item.reason])
  );
}

beforeAll(async () => {
  for (const name of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[name]);
  for (const person of Object.values(people))
    await env.DB.prepare(
      "INSERT INTO users(id,identifier,password_salt,password_hash,created_at) VALUES(?,?,'s','h',1)"
    )
      .bind(person.id, person.identifier)
      .run();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO namespaces(id,slug,created_by,created_at,kind) VALUES('ns','owner','u-owner',1,'personal')"
    ),
    env.DB.prepare(
      "INSERT INTO namespace_memberships(namespace_id,user_id,role,created_at) VALUES('ns','u-owner','owner',1)"
    ),
    env.DB.prepare(
      "INSERT INTO repositories(id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at,artifact_name,remote) VALUES('rp','ns','u-owner','secret','do-rp','private','',1,1,'art-rp','artifact://art-rp')"
    ),
    env.DB.prepare(
      "INSERT INTO repositories(id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at,artifact_name,remote) VALUES('rpub','ns','u-owner','open','do-rpub','public','',1,1,'art-rpub','artifact://art-rpub')"
    ),
  ]);
  for (const [person, role] of [
    ["writer", "write"],
    ["reader", "read"],
  ] as const)
    await call("/repositories/rp/collaborators", "PUT", "owner", {
      identifier: people[person].identifier,
      role,
    });
});

describe("notification generation", () => {
  it("notifies collaborators who were invited", async () => {
    expect(await reasons("writer")).toMatchObject({ "repository:repo": "invited" });
    expect(await reasons("reader")).toMatchObject({ "repository:repo": "invited" });
    expect((await inbox("owner")).items).toEqual([]);
  });

  it("notifies mentioned users with access and skips code, outsiders and the author", async () => {
    const created = await issue(
      "owner",
      "Fix the flaky build",
      "cc @reader and @outsider and @owner, not `@writer` or @ghost-user.\n```\n@writer\n```"
    );
    const reader = await inbox("reader");
    const mention = reader.items.find((item) => item.subjectNumber === created.number);
    expect(mention).toMatchObject({
      reason: "mentioned",
      subjectKind: "issue",
      title: "Fix the flaky build",
      actor: "owner",
      repository: { id: "rp", owner: "owner", name: "secret" },
      readAt: null,
    });
    expect((await reasons("writer"))[`issue:${created.number}`]).toBeUndefined();
    expect((await inbox("outsider")).items).toEqual([]);
    expect((await reasons("owner"))[`issue:${created.number}`]).toBeUndefined();
  });

  it("notifies participants about comments but never the commenter", async () => {
    const created = await issue("owner", "Thread", "no mentions");
    const path = `/repositories/rp/issues/${created.number}/comments`;
    await json(await call(path, "POST", "writer", { body: "first" }), 201);
    expect((await reasons("owner"))[`issue:${created.number}`]).toBe("comment");
    expect((await reasons("writer"))[`issue:${created.number}`]).toBeUndefined();
    expect((await reasons("reader"))[`issue:${created.number}`]).toBeUndefined();
    await json(await call(path, "POST", "reader", { body: "hello @writer" }), 201);
    expect((await reasons("writer"))[`issue:${created.number}`]).toBe("mentioned");
    await json(await call(path, "POST", "owner", { body: "thanks" }), 201);
    expect((await reasons("writer"))[`issue:${created.number}`]).toBe("comment");
    expect((await reasons("reader"))[`issue:${created.number}`]).toBe("comment");
  });

  it("notifies only newly added mentions when a body is edited", async () => {
    const created = await issue("owner", "Edit me", "cc @reader");
    await json(await call(`/notifications/read`, "POST", "reader", { all: true }), 200);
    await json(
      await call(`/repositories/rp/issues/${created.number}`, "PATCH", "owner", {
        body: "cc @reader and @writer",
      }),
      200
    );
    expect((await reasons("writer"))[`issue:${created.number}`]).toBe("mentioned");
    const reader = await inbox("reader", "?unread=true");
    expect(reader.items.find((item) => item.subjectNumber === created.number)).toBeUndefined();
  });

  it("notifies assignees and requested reviewers", async () => {
    const created = await issue("owner", "Assign me");
    await json(
      await call(`/repositories/rp/issues/${created.number}/assignees`, "PUT", "owner", {
        role: "assignee",
        assignees: [{ kind: "user", id: people.writer.id }],
      }),
      200
    );
    expect((await reasons("writer"))[`issue:${created.number}`]).toBe("assigned");
    const request = await pull("owner", "Needs eyes");
    await json(
      await call(`/repositories/rp/pull-requests/${request.number}/assignees`, "PUT", "owner", {
        role: "reviewer",
        assignees: [{ kind: "user", id: people.writer.id }],
      }),
      200
    );
    expect((await reasons("writer"))[`pull_request:${request.number}`]).toBe("review_requested");
  });

  it("notifies the author about failed checks and participants about merges", async () => {
    const request = await pull("writer", "Ship it");
    const checks = `/repositories/rp/pull-requests/${request.number}/checks`;
    const passing = { name: "unit", commitOid: HEAD, status: "completed", conclusion: "success" };
    await json(await call(checks, "POST", "owner", passing), 201);
    expect((await reasons("writer"))[`pull_request:${request.number}`]).toBeUndefined();
    await json(await call(checks, "POST", "owner", { ...passing, conclusion: "failure" }), 200);
    expect((await reasons("writer"))[`pull_request:${request.number}`]).toBe("check_failed");
    await json(await call(checks, "POST", "owner", passing), 200);
    await json(
      await call(`/repositories/rp/pull-requests/${request.number}/merge`, "POST", "owner", {
        expectedBaseOid: BASE,
        expectedHeadOid: HEAD,
      }),
      200
    );
    expect((await reasons("writer"))[`pull_request:${request.number}`]).toBe("merged");
    expect((await reasons("owner"))[`pull_request:${request.number}`]).toBeUndefined();
  });

  it("records no notification when the sibling write is rejected", async () => {
    const request = await pull("owner", "Regress");
    const checks = `/repositories/rp/pull-requests/${request.number}/checks`;
    await json(
      await call(checks, "POST", "owner", {
        name: "lint",
        commitOid: HEAD,
        status: "completed",
        conclusion: "success",
      }),
      201
    );
    const before = await env.DB.prepare("SELECT COUNT(*) AS total FROM forge_notifications").first<{
      total: number;
    }>();
    const backwards = await call(checks, "POST", "owner", {
      name: "lint",
      commitOid: HEAD,
      status: "in_progress",
    });
    expect(backwards.status).toBe(409);
    const after = await env.DB.prepare("SELECT COUNT(*) AS total FROM forge_notifications").first<{
      total: number;
    }>();
    expect(after?.total).toBe(before?.total);
  });
});

describe("notification listing", () => {
  it("re-checks access so removed members lose private titles and counts", async () => {
    const secret = await issue("owner", "Confidential roadmap", "cc @reader");
    const before = await json<NotificationUnreadCount>(
      await call("/notifications/unread-count", "GET", "reader"),
      200
    );
    expect(before.unread).toBeGreaterThan(0);
    const listed = await inbox("reader", "?limit=50");
    expect(listed.items.some((item) => item.title === "Confidential roadmap")).toBe(true);

    const removed = await call(
      `/repositories/rp/collaborators/${people.reader.id}`,
      "DELETE",
      "owner"
    );
    expect(removed.status).toBe(200);
    const after = await inbox("reader", "?limit=50");
    expect(JSON.stringify(after)).not.toContain("Confidential roadmap");
    expect(after.items).toEqual([]);
    expect(
      (
        await json<NotificationUnreadCount>(
          await call("/notifications/unread-count", "GET", "reader"),
          200
        )
      ).unread
    ).toBe(0);
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM forge_notifications WHERE recipient_id = ?"
    )
      .bind(people.reader.id)
      .first<{ total: number }>();
    expect(stored?.total).toBeGreaterThan(0);
    expect(secret.number).toBeGreaterThan(0);

    await call("/repositories/rp/collaborators", "PUT", "owner", {
      identifier: "reader",
      role: "read",
    });
    expect((await inbox("reader", "?limit=50")).items.length).toBeGreaterThan(0);
  });

  it("pages with a cursor, filters by unread and reason, and marks read", async () => {
    for (let index = 0; index < 4; index += 1) await issue("owner", `Paged ${index}`, "@writer");
    const first = await inbox("writer", "?limit=2");
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await inbox("writer", `?limit=2&before=${first.nextCursor}`);
    expect(second.items.every((item) => !first.items.some((seen) => seen.id === item.id))).toBe(
      true
    );
    expect(second.items[0].createdAt).toBeLessThanOrEqual(first.items[1].createdAt);

    const mentions = await inbox("writer", "?reason=mentioned&limit=50");
    expect(mentions.items.length).toBeGreaterThanOrEqual(4);
    expect(mentions.items.every((item: Notification) => item.reason === "mentioned")).toBe(true);
    expect((await call("/notifications?reason=bogus", "GET", "writer")).status).toBe(400);

    const target = first.items[0];
    const marked = await json<{ updated: number }>(
      await call("/notifications/read", "POST", "writer", { ids: [target.id] }),
      200
    );
    expect(marked.updated).toBe(1);
    expect(
      (await inbox("writer", "?unread=true&limit=50")).items.some((item) => item.id === target.id)
    ).toBe(false);
    expect(
      (await call("/notifications/read", "POST", "outsider", { ids: [first.items[1].id] })).status
    ).toBe(200);
    expect(
      (await inbox("writer", "?unread=true&limit=50")).items.some(
        (item) => item.id === first.items[1].id
      )
    ).toBe(true);

    await json(
      await call("/notifications/read", "POST", "writer", { all: true, repositoryId: "rp" }),
      200
    );
    expect((await inbox("writer", "?unread=true")).items).toEqual([]);
    const count = await json<NotificationUnreadCount>(
      await call("/notifications/unread-count", "GET", "writer"),
      200
    );
    expect(count).toEqual({ unread: 0, capped: false });
    expect((await call("/notifications/read", "POST", "writer", { ids: [] })).status).toBe(400);
  });

  it("honors muted reasons for new notifications only", async () => {
    const saved = await call("/notification-preferences", "PUT", "reader", {
      mutedReasons: ["mentioned"],
    });
    expect(saved.status).toBe(200);
    expect(await json(await call("/notification-preferences", "GET", "reader"), 200)).toEqual({
      mutedReasons: ["mentioned"],
    });
    const created = await issue("owner", "Muted ping", "@reader");
    expect((await reasons("reader"))[`issue:${created.number}`]).toBeUndefined();
    await call("/notification-preferences", "PUT", "reader", { mutedReasons: [] });
    const next = await issue("owner", "Unmuted ping", "@reader");
    expect((await reasons("reader"))[`issue:${next.number}`]).toBe("mentioned");
    expect(
      (await call("/notification-preferences", "PUT", "reader", { mutedReasons: ["nope"] })).status
    ).toBe(400);
  });

  it("limits tokens to their repositories and refuses agent sessions", async () => {
    const limited = await call("/notifications", "GET", "writer", undefined, {
      token: { id: "t1", scopes: ["repo:read"], repositoryIds: ["rpub"] },
    });
    expect((await json<NotificationPage>(limited, 200)).items).toEqual([]);
    const unlimited = await call("/notifications", "GET", "writer", undefined, {
      token: { id: "t2", scopes: ["repo:read"] },
    });
    expect((await json<NotificationPage>(unlimited, 200)).items.length).toBeGreaterThan(0);
    await runSqlScript(
      env.DB,
      `INSERT INTO auth_agents (id,user_id,name,description,created_at) VALUES ('a1','u-writer','bot','',1);
INSERT INTO auth_git_tokens (id,user_id,repository_id,name,token_hash,permission,expires_at,created_at) VALUES ('gt1','u-writer','rp','test','git-hash','read',9999999999999,1);
INSERT INTO auth_agent_sessions (id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES ('s1','a1','u-writer','rp','session-hash','gt1','w','artifact://art-rp','main',NULL,'read','active',1,9999999999999);`
    );
    const agent = await call("/notifications", "GET", "writer", undefined, {
      agentSession: {
        id: "s1",
        agentId: "a1",
        agentName: "bot",
        repositoryId: "rp",
        permission: "read",
        workspaceName: "w",
      },
    });
    expect(agent.status).toBe(403);
  });
});
