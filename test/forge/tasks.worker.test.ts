import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import git from "../../workers/git/src/index";
import forge from "../../workers/forge/src/index";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const MIGRATION_UNDER_TEST = "0010_agent_tasks.sql";
const MERGE_OID = "c".repeat(40);
const BASE_OID = "a".repeat(40);

const artifacts = new FixtureArtifacts();

/** Commit lookups hit the real Git worker over fixture Artifacts; merges are stubbed. */
const forgeEnv: Parameters<typeof forge.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  GIT: {
    async fetch(request: Request) {
      if (request.method === "GET") return git.fetch(request, forgeEnv);
      return Response.json({ data: { oid: MERGE_OID } });
    },
  },
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function sessionFor(id: string, agentId: string, agentName: string, permission: "read" | "write") {
  return {
    id,
    agentId,
    agentName,
    repositoryId: "r1",
    workspaceName: `workspace-${id}`,
    permission,
  };
}
const writeSession = sessionFor("s1", "a1", "bob-agent", "write");
const readSession = sessionFor("s2", "a1", "bob-agent", "read");

function headers(userId: string, name: string, session?: unknown): Headers {
  const result = new Headers({
    "X-GitEdge-User-Id": userId,
    "X-GitEdge-User-Name": name,
    "X-GitEdge-User-Group": "free",
    "Content-Type": "application/json",
  });
  if (session) result.set("X-GitEdge-Agent-Session", JSON.stringify(session));
  return result;
}

async function call(
  path: string,
  method: string,
  who: [string, string] | null,
  body?: unknown,
  session?: unknown
): Promise<Response> {
  return forge.fetch(
    new Request(`https://forge.test${path}`, {
      method,
      headers: who ? headers(who[0], who[1], session) : undefined,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    forgeEnv
  );
}

async function data(response: Response): Promise<Json> {
  return ((await response.json()) as { data: Json }).data;
}

const alice: [string, string] = ["u1", "alice"];
const bob: [string, string] = ["u2", "bob"];
const eve: [string, string] = ["u3", "eve"];

async function createTask(title: string, who = alice): Promise<Json> {
  const response = await call("/repositories/r1/tasks", "POST", who, { type: "Feature", title });
  expect(response.status).toBe(201);
  return data(response);
}

async function createIssue(title: string): Promise<number> {
  const response = await call("/repositories/r1/issues", "POST", alice, { title });
  return (await data(response)).number;
}

async function createPull(title: string): Promise<number> {
  const response = await call("/repositories/r1/pull-requests", "POST", alice, {
    title,
    baseRef: "main",
    headRef: "topic",
  });
  return (await data(response)).number;
}

beforeAll(async () => {
  const names = Object.keys(migrations).sort();
  const base = names.filter((path) => !path.endsWith(MIGRATION_UNDER_TEST));
  for (const path of base) await runSqlScript(env.DB, migrations[path]);
  await runSqlScript(
    env.DB,
    `INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES ('u1','alice','x','x',1), ('u2','bob','x','x',1), ('u3','eve','x','x',1), ('u4','carol','x','x',1);
INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES ('n1','alice','u1',1,'personal','Alice','');
INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('n1','u1',1,'owner'), ('n1','u2',1,'member');
INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at) VALUES ('r1','n1','u1','demo','repo:r1','public','',1,1), ('r2','n1','u1','secret','repo:r2','private','',1,1);
INSERT INTO forge_counters (repository_id, conversation_number) VALUES ('r1', 1), ('r2', 0);
INSERT INTO forge_issues (id,repository_id,number,author_id,title,body,state,created_at,updated_at,assignees_json) VALUES ('legacy-issue','r1',1,'u1','Legacy issue','','open',1,1,'["alice","bob","nobody","carol","alice"]');
INSERT INTO auth_agents (id,user_id,name,description,created_at,disabled_at) VALUES ('a1','u2','bob-agent','',1,NULL), ('a2','u1','alice-agent','',1,NULL), ('a3','u3','eve-agent','',1,NULL), ('a4','u2','retired-agent','',1,5);
INSERT INTO auth_git_tokens (id,user_id,repository_id,name,token_hash,permission,expires_at,created_at) VALUES ('gt1','u2','r1','t1','h1','write',9999999999999,1), ('gt2','u2','r1','t2','h2','read',9999999999999,1);
INSERT INTO auth_agent_sessions (id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES ('s1','a1','u2','r1','sh1','gt1','workspace-s1','artifact://repo-r1','main',NULL,'write','active',1,9999999999999), ('s2','a1','u2','r1','sh2','gt2','workspace-s2','artifact://repo-r1','main',NULL,'read','active',1,9999999999999);`
  );
  await runSqlScript(
    env.DB,
    migrations[names.find((path) => path.endsWith(MIGRATION_UNDER_TEST))!]
  );
  for (const [id, repositoryId] of [
    ["repo-r1", "r1"],
    ["repo-r2", "r2"],
  ]) {
    const created = await artifacts.create(id, { setDefaultBranch: "main" });
    await env.DB.prepare(
      "UPDATE repositories SET artifact_name = ?, remote = ?, default_branch = 'main' WHERE id = ?"
    )
      .bind(created.name, created.remote, repositoryId)
      .run();
  }
});

describe("Migration 0010", () => {
  it("moves matching string assignees to assignments and drops the column", async () => {
    const rows = await env.DB.prepare(
      "SELECT assignee_kind, assignee_id, role FROM forge_assignments WHERE target_id = 'legacy-issue' ORDER BY assignee_id"
    ).all<{ assignee_kind: string; assignee_id: string; role: string }>();
    expect(rows.results).toEqual([
      { assignee_kind: "user", assignee_id: "u1", role: "assignee" },
      { assignee_kind: "user", assignee_id: "u2", role: "assignee" },
    ]);
    await expect(env.DB.prepare("SELECT assignees_json FROM forge_issues").all()).rejects.toThrow();
    const issue = await data(await call("/repositories/r1/issues/1", "GET", alice));
    expect(issue.assignees).toEqual([
      { kind: "user", id: "u1", name: "alice" },
      { kind: "user", id: "u2", name: "bob" },
    ]);
    expect(issue.reviewers).toEqual([]);
  });
});

describe("Memory index", () => {
  it("stores revisions with optimistic concurrency and history", async () => {
    expect(await data(await call("/repositories/r1/memory", "GET", bob))).toMatchObject({
      revision: 0,
      content: "",
      guidelineVersion: "v0.2.2",
    });
    const created = await call("/repositories/r1/memory", "PUT", bob, {
      content: "# Project",
      expectedRevision: 0,
    });
    expect(created.status).toBe(201);
    expect(
      (await call("/repositories/r1/memory", "PUT", bob, { content: "x", expectedRevision: 0 }))
        .status
    ).toBe(409);
    const upgraded = await call("/repositories/r1/memory", "PUT", bob, {
      content: "# Two",
      guidelineVersion: "v0.3.0",
      expectedRevision: 1,
    });
    expect(upgraded.status).toBe(200);
    const results = await Promise.all([
      call("/repositories/r1/memory", "PUT", bob, { content: "# Three", expectedRevision: 2 }),
      call("/repositories/r1/memory", "PUT", alice, { content: "# Other", expectedRevision: 2 }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const current = await data(await call("/repositories/r1/memory", "GET", bob));
    expect(current).toMatchObject({ revision: 3, guidelineVersion: "v0.3.0" });
    const history = await data(await call("/repositories/r1/memory/history", "GET", bob));
    expect(history.map((entry: Json) => entry.revision)).toEqual([3, 2, 1]);
    expect(history[2].actor).toMatchObject({ kind: "user", name: "bob" });
    expect(await data(await call("/repositories/r1/memory/revisions/1", "GET", bob))).toMatchObject(
      { content: "# Project", revision: 1 }
    );
    expect((await call("/repositories/r1/memory/revisions/9", "GET", bob)).status).toBe(404);
  });
});

describe("Memory visibility and repository settings", () => {
  it("hides tasks from anonymous users and non-members until the repository opts in", async () => {
    expect((await call("/repositories/r1/tasks", "GET", null)).status).toBe(403);
    expect((await call("/repositories/r1/memory", "GET", eve)).status).toBe(403);
    expect((await call("/repositories/r1/tasks", "GET", bob)).status).toBe(200);

    expect(
      (await call("/repositories/r1/settings", "PATCH", bob, { memoryVisibility: "public" })).status
    ).toBe(403);
    expect(await data(await call("/repositories/r1/settings", "GET", bob))).toEqual({
      memoryVisibility: "members",
      agentAssignmentPolicy: "owner",
      canManage: false,
    });
    const opened = await call("/repositories/r1/settings", "PATCH", alice, {
      memoryVisibility: "public",
    });
    expect(opened.status).toBe(200);
    expect((await data(opened)).canManage).toBe(true);
    try {
      expect((await call("/repositories/r1/tasks", "GET", null)).status).toBe(200);
      expect((await call("/repositories/r1/tasks/table", "GET", null)).status).toBe(200);
      expect((await call("/repositories/r1/memory", "GET", null)).status).toBe(200);
      expect((await call("/repositories/r1/memory/history", "GET", eve)).status).toBe(200);
      expect(
        (await call("/repositories/r1/tasks", "POST", eve, { type: "Feature", title: "Nope" }))
          .status
      ).toBe(403);
      expect(
        (await call("/repositories/r1/tasks", "POST", null, { type: "Feature", title: "Nope" }))
          .status
      ).toBe(401);
    } finally {
      await call("/repositories/r1/settings", "PATCH", alice, { memoryVisibility: "members" });
    }
    expect((await call("/repositories/r1/tasks", "GET", null)).status).toBe(403);
  });

  it("allows public memory only on public repositories", async () => {
    const rejected = await call("/repositories/r2/settings", "PATCH", alice, {
      memoryVisibility: "public",
    });
    expect(rejected.status).toBe(400);
    expect(await data(await call("/repositories/r2/settings", "GET", alice))).toMatchObject({
      memoryVisibility: "members",
    });
    expect((await call("/repositories/r2/tasks", "GET", eve)).status).toBe(404);
    expect(
      (
        await call("/repositories/r2/settings", "PATCH", alice, {
          agentAssignmentPolicy: "members",
        })
      ).status
    ).toBe(200);
  });

  it("rejects invalid settings payloads", async () => {
    expect(
      (await call("/repositories/r1/settings", "PATCH", alice, { memoryVisibility: "world" }))
        .status
    ).toBe(400);
    expect((await call("/repositories/r1/settings", "PATCH", alice, {})).status).toBe(400);
  });
});

describe("Tasks", () => {
  it("creates, lists, updates and filters tasks with generated table and system progress", async () => {
    const invalid = await call("/repositories/r1/tasks", "POST", alice, {
      type: "Bad Type!",
      title: "x",
    });
    expect(invalid.status).toBe(400);
    const task = await createTask("Pipe | title");
    expect(task).toMatchObject({
      number: 1,
      type: "Feature",
      status: "pending",
      assignee: null,
      progress: { total: 0, done: 0, percent: null },
      documents: { plan: { revision: 0 }, findings: { revision: 0 }, progress: { revision: 0 } },
    });
    const second = await createTask("Second", bob);
    expect(second.number).toBe(2);

    const patched = await call("/repositories/r1/tasks/1", "PATCH", alice, {
      status: "in_progress",
      motivation: "Because | reasons",
      description: "Line one\nline two",
    });
    expect(patched.status).toBe(200);
    const detail = await data(patched);
    expect(detail.status).toBe("in_progress");
    expect(detail.documents.progress.revision).toBe(1);
    expect(detail.documents.progress.content).toMatch(
      /\[system\] Task status changed from pending to in_progress by alice\n$/
    );
    expect(detail.documents.progress.actor).toMatchObject({ kind: "system" });
    const progressHistory = await data(
      await call("/repositories/r1/tasks/1/documents/progress/history", "GET", alice)
    );
    expect(progressHistory).toHaveLength(1);
    expect(progressHistory[0].actor.kind).toBe("system");

    expect(
      (await call("/repositories/r1/tasks/1", "PATCH", alice, { status: "finished" })).status
    ).toBe(400);
    expect((await call("/repositories/r1/tasks/1", "PATCH", alice, {})).status).toBe(400);
    expect((await call("/repositories/r1/tasks/99", "GET", alice)).status).toBe(404);

    const all = await data(await call("/repositories/r1/tasks", "GET", bob));
    expect(all.map((entry: Json) => entry.number)).toEqual([2, 1]);
    const active = await data(await call("/repositories/r1/tasks?status=in_progress", "GET", bob));
    expect(active.map((entry: Json) => entry.number)).toEqual([1]);
    expect((await call("/repositories/r1/tasks?status=nope", "GET", bob)).status).toBe(400);

    const table = await data(await call("/repositories/r1/tasks/table", "GET", bob));
    expect(table.guidelineVersion).toBe("v0.3.0");
    expect(table.markdown).toContain("> 准则版本: v0.3.0");
    expect(table.markdown).toContain(
      "| 001 | [Feature] Pipe \\| title | Line one line two | Because \\| reasons | 🔄 进行中 |"
    );
    expect(table.markdown).toContain("| 002 | [Feature] Second |  |  | ⏳ 待处理 |");
    expect(table.markdown.indexOf("001")).toBeLessThan(table.markdown.indexOf("002"));
  });

  it("keeps plan, findings and progress documents under optimistic revisions", async () => {
    const path = "/repositories/r1/tasks/2/documents/plan";
    expect(await data(await call(path, "GET", bob))).toMatchObject({ revision: 0, content: "" });
    const first = await call(path, "PUT", bob, { content: "- [ ] step", expectedRevision: 0 });
    expect(first.status).toBe(200);
    expect(await data(first)).toMatchObject({ revision: 1, actor: { kind: "user", name: "bob" } });
    expect((await call(path, "PUT", alice, { content: "stale", expectedRevision: 0 })).status).toBe(
      409
    );
    const racing = await Promise.all([
      call(path, "PUT", alice, { content: "a", expectedRevision: 1 }),
      call(path, "PUT", bob, { content: "b", expectedRevision: 1 }),
    ]);
    expect(racing.map((result) => result.status).sort()).toEqual([200, 409]);
    const history = await data(await call(`${path}/history`, "GET", bob));
    expect(history.map((entry: Json) => entry.revision)).toEqual([2, 1]);
    expect(await data(await call(`${path}/revisions/1`, "GET", bob))).toMatchObject({
      content: "- [ ] step",
    });
    expect((await call(`${path}/revisions/7`, "GET", bob)).status).toBe(404);
    expect((await call("/repositories/r1/tasks/2/documents/notes", "GET", bob)).status).toBe(404);
    expect((await call(path, "PUT", bob, { content: "x" })).status).toBe(400);
    const agentWrite = await call(
      "/repositories/r1/tasks/2/documents/findings",
      "PUT",
      bob,
      { content: "agent notes", expectedRevision: 0 },
      writeSession
    );
    expect(agentWrite.status).toBe(200);
    expect((await data(agentWrite)).actor).toMatchObject({ kind: "agent", id: "a1" });
    expect(
      (
        await call(
          "/repositories/r1/tasks/2/documents/findings",
          "PUT",
          bob,
          { content: "blocked", expectedRevision: 1 },
          readSession
        )
      ).status
    ).toBe(403);
  });

  it("limits writes to writable members and read sessions", async () => {
    expect(
      (await call("/repositories/r1/tasks", "POST", bob, { type: "Docs", title: "x" }, readSession))
        .status
    ).toBe(403);
    expect((await call("/repositories/r1/tasks/1", "PATCH", eve, { title: "x" })).status).toBe(403);
    expect((await call("/repositories/r1/tasks", "GET", bob, undefined, readSession)).status).toBe(
      200
    );
    const byAgent = await call(
      "/repositories/r1/tasks",
      "POST",
      bob,
      { type: "Audit", title: "Agent made" },
      writeSession
    );
    expect(byAgent.status).toBe(201);
    expect((await data(byAgent)).actor).toMatchObject({ kind: "agent", name: "bob-agent" });
  });
});

describe("Task links, progress and commits", () => {
  it("links an issue or pull request to at most one task and reports progress", async () => {
    const task = await createTask("Linked work");
    const other = await createTask("Other work");
    const issue = await createIssue("Tracked issue");
    const pull = await createPull("Tracked pull");
    const link = (number: number, kind: string, taskNumber = task.number) =>
      call(`/repositories/r1/tasks/${taskNumber}/links`, "POST", alice, { kind, number });

    expect((await link(issue, "issue")).status).toBe(201);
    expect((await link(pull, "pull_request")).status).toBe(201);
    expect((await link(issue, "issue", other.number)).status).toBe(409);
    expect((await link(issue, "issue")).status).toBe(409);
    expect((await link(9999, "issue")).status).toBe(404);
    expect((await link(1, "discussion")).status).toBe(400);

    let detail = await data(await call(`/repositories/r1/tasks/${task.number}`, "GET", bob));
    expect(detail.links).toHaveLength(2);
    expect(detail.progress).toEqual({ total: 2, done: 0, percent: 0 });

    await call(`/repositories/r1/issues/${issue}`, "PATCH", alice, { state: "closed" });
    await call(`/repositories/r1/issues/${issue}`, "PATCH", alice, { state: "open" });
    await call(`/repositories/r1/issues/${issue}`, "PATCH", alice, { state: "closed" });
    await call(`/repositories/r1/pull-requests/${pull}`, "PATCH", alice, { state: "closed" });
    detail = await data(await call(`/repositories/r1/tasks/${task.number}`, "GET", bob));
    expect(detail.progress).toEqual({ total: 2, done: 2, percent: 100 });
    const lines = (detail.documents.progress.content as string).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain(`Issue #${issue} closed by alice`);
    expect(lines[1]).toContain(`Issue #${issue} reopened by alice`);
    expect(lines[3]).toContain(`Pull request #${pull} closed by alice`);
    expect(detail.documents.progress.revision).toBe(4);

    // Unlinked items change state without touching any task.
    const loose = await createIssue("Loose issue");
    await call(`/repositories/r1/issues/${loose}`, "PATCH", alice, { state: "closed" });
    const unchanged = await data(await call(`/repositories/r1/tasks/${other.number}`, "GET", bob));
    expect(unchanged.documents.progress.revision).toBe(0);

    const detach = await call(
      `/repositories/r1/tasks/${task.number}/links/issue/${issue}`,
      "DELETE",
      alice
    );
    expect(detach.status).toBe(204);
    expect(
      (await call(`/repositories/r1/tasks/${task.number}/links/issue/${issue}`, "DELETE", alice))
        .status
    ).toBe(404);
    expect((await link(issue, "issue", other.number)).status).toBe(201);
  });

  it("binds commits verified by the Git service and rejects unknown ones", async () => {
    const task = await createTask("Commit work");
    const path = `/repositories/r1/tasks/${task.number}/commits`;
    const bound = await call(path, "POST", alice, { oid: BASE_OID, ref: "main" });
    expect(bound.status).toBe(201);
    expect(await data(bound)).toMatchObject({
      oid: BASE_OID,
      ref: "main",
      summary: "Fixture repository base",
      author: "Fixture",
      source: "manual",
      boundBy: { kind: "user", name: "alice" },
    });
    expect((await call(path, "POST", alice, { oid: BASE_OID, ref: "main" })).status).toBe(409);
    expect((await call(path, "POST", alice, { oid: "9".repeat(40), ref: "main" })).status).toBe(
      404
    );
    expect((await call(path, "POST", alice, { oid: "short", ref: "main" })).status).toBe(400);
    expect((await call(path, "POST", alice, { oid: BASE_OID, ref: "bad..ref" })).status).toBe(400);
    expect(
      (await call(path, "POST", bob, { oid: BASE_OID, ref: "main" }, readSession)).status
    ).toBe(403);
    expect((await call(path, "POST", eve, { oid: BASE_OID, ref: "main" })).status).toBe(403);
    const detail = await data(await call(`/repositories/r1/tasks/${task.number}`, "GET", alice));
    expect(detail.commits).toHaveLength(1);
    expect(detail.commitCount).toBe(1);
    expect((await call(`${path}/${BASE_OID}`, "DELETE", alice)).status).toBe(204);
    expect((await call(`${path}/${BASE_OID}`, "DELETE", alice)).status).toBe(404);
  });

  it("binds the merge commit and appends a system entry when a linked pull request merges", async () => {
    const task = await createTask("Merged work");
    const pull = await createPull("Ship it");
    const loose = await createPull("Unlinked");
    await call(`/repositories/r1/tasks/${task.number}/links`, "POST", alice, {
      kind: "pull_request",
      number: pull,
    });
    const mergeBody = { expectedBaseOid: "1".repeat(40), expectedHeadOid: "2".repeat(40) };
    expect(
      (
        await call(
          `/repositories/r1/pull-requests/${pull}/merge`,
          "POST",
          bob,
          mergeBody,
          writeSession
        )
      ).status
    ).toBe(403);
    expect(
      (await call(`/repositories/r1/pull-requests/${pull}/merge`, "POST", alice, mergeBody)).status
    ).toBe(200);
    const detail = await data(await call(`/repositories/r1/tasks/${task.number}`, "GET", alice));
    expect(detail.commits).toEqual([
      expect.objectContaining({
        oid: MERGE_OID,
        ref: "main",
        summary: "Ship it",
        author: "alice",
        source: "pull_request_merge",
        boundBy: { kind: "user", id: "u1", name: "alice" },
      }),
    ]);
    expect(detail.documents.progress.content).toContain(
      `Pull request #${pull} merged as ccccccc into main`
    );
    expect(detail.progress).toEqual({ total: 1, done: 1, percent: 100 });
    const history = await data(
      await call(`/repositories/r1/tasks/${task.number}/documents/progress/history`, "GET", alice)
    );
    expect(history).toHaveLength(1);
    expect(history[0].actor).toMatchObject({ kind: "system" });

    // A second merge of an unlinked pull request leaves task data alone.
    const before = await env.DB.prepare("SELECT COUNT(*) AS count FROM forge_task_commits").first<{
      count: number;
    }>();
    expect(
      (await call(`/repositories/r1/pull-requests/${loose}/merge`, "POST", alice, mergeBody)).status
    ).toBe(200);
    const after = await env.DB.prepare("SELECT COUNT(*) AS count FROM forge_task_commits").first<{
      count: number;
    }>();
    expect(after?.count).toBe(before?.count);
  });
});

describe("Commit verification, merge entries and link moves", () => {
  const commitFixture = (hash: string, message: string): ArtifactsCommitMetadata => ({
    hash,
    treeHash: "b".repeat(40),
    message,
    author: { name: "Fixture", email: "fixture@example.test" },
    committer: { name: "Fixture", email: "fixture@example.test" },
    parents: ["a".repeat(40)],
    authoredAt: 1_790_000_100,
    committedAt: 1_790_000_100,
  });

  it("verifies commits against the repository and ref, never an agent workspace", async () => {
    const featureOid = "d".repeat(40);
    const forkOid = "e".repeat(40);
    const feature = commitFixture(featureOid, "Feature commit");
    const repository = artifacts.repositories.get("repo-r1")!;
    const base = repository.commits[0];
    await artifacts.create("workspace-s1");
    artifacts.repositories.get("workspace-s1")!.commits.push(commitFixture(forkOid, "Fork only"));
    repository.commits.push(feature);
    repository.branchCommits.set("main", [base]);
    repository.branchCommits.set("feature", [feature, base]);
    try {
      const task = await createTask("Verified commits");
      const path = `/repositories/r1/tasks/${task.number}/commits`;
      // A commit that exists only in the agent's fork is not a repository commit.
      expect(
        (await call(path, "POST", bob, { oid: forkOid, ref: "main" }, writeSession)).status
      ).toBe(404);
      expect((await call(path, "POST", alice, { oid: forkOid, ref: "main" })).status).toBe(404);
      // The commit must be in the history of the claimed ref.
      expect((await call(path, "POST", alice, { oid: featureOid, ref: "main" })).status).toBe(404);
      const bound = await call(
        path,
        "POST",
        bob,
        { oid: featureOid, ref: "feature" },
        writeSession
      );
      expect(bound.status).toBe(201);
      expect(await data(bound)).toMatchObject({
        oid: featureOid,
        ref: "feature",
        summary: "Feature commit",
        boundBy: { kind: "agent", id: "a1" },
      });
      expect((await call(path, "POST", alice, { oid: BASE_OID, ref: "main" })).status).toBe(201);
    } finally {
      repository.commits.splice(1);
      repository.branchCommits.clear();
      artifacts.repositories.delete("workspace-s1");
    }
  });

  it("records the merge entry even when the merged commit is already bound", async () => {
    const task = await createTask("Pre-bound merge");
    const pull = await createPull("Fast forward");
    await call(`/repositories/r1/tasks/${task.number}/links`, "POST", alice, {
      kind: "pull_request",
      number: pull,
    });
    await env.DB.prepare(
      "INSERT INTO forge_task_commits (id, repository_id, task_id, oid, ref, summary, author_name, bound_by_json, source, bound_at) VALUES ('prebound', 'r1', ?, ?, 'topic', 'Head commit', 'Fixture', '{\"kind\":\"user\",\"id\":\"u1\",\"name\":\"alice\"}', 'manual', 1)"
    )
      .bind(task.id, MERGE_OID)
      .run();
    const mergeBody = { expectedBaseOid: "1".repeat(40), expectedHeadOid: "2".repeat(40) };
    expect(
      (await call(`/repositories/r1/pull-requests/${pull}/merge`, "POST", alice, mergeBody)).status
    ).toBe(200);
    const detail = await data(await call(`/repositories/r1/tasks/${task.number}`, "GET", alice));
    expect(detail.commits).toHaveLength(1);
    expect(detail.commits[0]).toMatchObject({ source: "manual", summary: "Head commit" });
    expect(detail.documents.progress.content).toContain(
      `Pull request #${pull} merged as ccccccc into main`
    );
    expect(detail.documents.progress.revision).toBe(1);
  });

  it("keeps non-member authors out of members-only task progress", async () => {
    const task = await createTask("Outsider issue");
    const created = await call("/repositories/r1/issues", "POST", eve, { title: "From outside" });
    expect(created.status).toBe(201);
    const issue = (await data(created)).number;
    await call(`/repositories/r1/tasks/${task.number}/links`, "POST", alice, {
      kind: "issue",
      number: issue,
    });
    const patch = (who: [string, string], state: string) =>
      call(`/repositories/r1/issues/${issue}`, "PATCH", who, { state });
    expect((await patch(eve, "closed")).status).toBe(200);
    expect((await patch(eve, "open")).status).toBe(200);
    let detail = await data(await call(`/repositories/r1/tasks/${task.number}`, "GET", alice));
    expect(detail.documents.progress.revision).toBe(0);
    expect(detail.progress).toEqual({ total: 1, done: 0, percent: 0 });
    expect((await patch(alice, "closed")).status).toBe(200);
    detail = await data(await call(`/repositories/r1/tasks/${task.number}`, "GET", alice));
    expect(detail.documents.progress.revision).toBe(1);
    expect(detail.documents.progress.content).toContain(`Issue #${issue} closed by alice`);
  });

  it("reads and moves the task of an issue in one operation", async () => {
    const first = await createTask("Move from");
    const second = await createTask("Move to");
    const issue = await createIssue("Movable");
    const path = `/repositories/r1/tasks/link/issue/${issue}`;
    const move = (who: [string, string] | null, task: number | null) =>
      call(path, "PUT", who, { task });

    expect(await data(await call(path, "GET", alice))).toBeNull();
    expect((await data(await move(alice, first.number))).number).toBe(first.number);
    expect(await data(await call(path, "GET", bob))).toMatchObject({
      number: first.number,
      title: "Move from",
      type: "Feature",
      status: "pending",
    });
    expect((await data(await move(bob, second.number))).number).toBe(second.number);
    const links = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM forge_task_links WHERE target_id = (SELECT id FROM forge_issues WHERE repository_id = 'r1' AND number = ?)"
    )
      .bind(issue)
      .first<{ count: number }>();
    expect(links?.count).toBe(1);
    expect((await move(alice, 9999)).status).toBe(404);
    expect((await data(await call(path, "GET", alice))).number).toBe(second.number);
    expect((await move(eve, null)).status).toBe(403);
    expect((await move(null, null)).status).toBe(401);
    expect((await call(path, "GET", null)).status).toBe(403);
    expect(await data(await move(alice, null))).toBeNull();
    expect(await data(await call(path, "GET", alice))).toBeNull();
    expect((await call("/repositories/r1/tasks/link/issue/9999", "GET", alice)).status).toBe(404);
    expect((await call("/repositories/r1/tasks/link/bogus/1", "GET", alice)).status).toBe(404);
    expect((await call(path, "PUT", alice, { task: 0 })).status).toBe(400);
  });
});

describe("Assignments", () => {
  const ref = (kind: "user" | "agent", id: string) => ({ kind, id });

  it("replaces assignee and reviewer sets independently for issues and pull requests", async () => {
    const issue = await createIssue("Assign me");
    const pull = await createPull("Review me");
    const set = (resource: string, number: number, who: [string, string], body: unknown) =>
      call(`/repositories/r1/${resource}/${number}/assignees`, "PUT", who, body);

    const first = await set("issues", issue, alice, {
      role: "assignee",
      assignees: [ref("user", "u2"), ref("user", "u1"), ref("user", "u2")],
    });
    expect(first.status).toBe(200);
    expect((await data(first)).assignees.map((entry: Json) => entry.name)).toEqual([
      "alice",
      "bob",
    ]);
    const reviewers = await set("issues", issue, alice, {
      role: "reviewer",
      assignees: [ref("user", "u2")],
    });
    expect(await data(reviewers)).toMatchObject({
      assignees: [{ name: "alice" }, { name: "bob" }],
      reviewers: [{ kind: "user", id: "u2", name: "bob" }],
    });
    const replaced = await data(
      await set("issues", issue, alice, { role: "assignee", assignees: [ref("user", "u2")] })
    );
    expect(replaced.assignees).toEqual([{ kind: "user", id: "u2", name: "bob" }]);
    expect(replaced.reviewers).toHaveLength(1);
    const cleared = await data(
      await set("issues", issue, alice, { role: "assignee", assignees: [] })
    );
    expect(cleared.assignees).toEqual([]);

    const onPull = await set("pull-requests", pull, bob, {
      role: "reviewer",
      assignees: [ref("user", "u1")],
    });
    expect(await data(onPull)).toMatchObject({ reviewers: [{ name: "alice" }], assignees: [] });
    const listed = await data(await call("/repositories/r1/pull-requests", "GET", bob));
    expect(
      listed.find((entry: Json) => entry.number === pull).reviewers.map((entry: Json) => entry.id)
    ).toEqual(["u1"]);

    expect(
      (await set("issues", issue, alice, { role: "assignee", assignees: [ref("user", "u3")] }))
        .status
    ).toBe(400);
    expect((await set("issues", issue, alice, { role: "owner", assignees: [] })).status).toBe(400);
    expect((await set("issues", issue, eve, { role: "assignee", assignees: [] })).status).toBe(403);
    expect(
      (
        await call(
          `/repositories/r1/issues/${issue}/assignees`,
          "PUT",
          bob,
          { role: "assignee", assignees: [] },
          readSession
        )
      ).status
    ).toBe(403);
    expect((await call("/repositories/r1/issues/9999/assignees", "PUT", alice, {})).status).toBe(
      404
    );
  });

  it("applies the agent assignment policy to assignees, reviewers and tasks", async () => {
    await call("/repositories/r1/settings", "PATCH", alice, { agentAssignmentPolicy: "owner" });
    const issue = await createIssue("Agent work");
    const task = await createTask("Agent task");
    const set = (who: [string, string], role: string, id: string) =>
      call(`/repositories/r1/issues/${issue}/assignees`, "PUT", who, {
        role,
        assignees: [ref("agent", id)],
      });

    // Owner policy: only the agent's owner may use it.
    expect((await set(bob, "assignee", "a1")).status).toBe(200);
    expect((await set(bob, "reviewer", "a2")).status).toBe(403);
    expect((await set(alice, "reviewer", "a1")).status).toBe(403);
    expect((await set(alice, "assignee", "a2")).status).toBe(200);
    // Non-members cannot assign at all; an agent whose owner is outside the namespace or that is
    // disabled is never assignable.
    expect((await set(eve, "assignee", "a3")).status).toBe(403);
    expect((await set(alice, "assignee", "a3")).status).toBe(400);
    expect((await set(bob, "assignee", "a4")).status).toBe(400);
    expect((await set(bob, "assignee", "missing")).status).toBe(400);

    const ownerCandidates = await data(
      await call("/repositories/r1/assignee-candidates", "GET", bob)
    );
    expect(ownerCandidates.filter((entry: Json) => entry.kind === "agent")).toEqual([
      { kind: "agent", id: "a1", name: "bob-agent", ownerName: "bob" },
    ]);
    expect(
      ownerCandidates
        .filter((entry: Json) => entry.kind === "user")
        .map((entry: Json) => entry.name)
    ).toEqual(["alice", "bob"]);
    expect((await call("/repositories/r1/assignee-candidates", "GET", eve)).status).toBe(403);

    const taskAssign = (who: [string, string], assignee: unknown) =>
      call(`/repositories/r1/tasks/${task.number}/assignee`, "PUT", who, { assignee });
    expect((await taskAssign(bob, ref("agent", "a2"))).status).toBe(403);
    const assigned = await taskAssign(bob, ref("agent", "a1"));
    expect(assigned.status).toBe(200);
    expect((await data(assigned)).assignee).toEqual({
      kind: "agent",
      id: "a1",
      name: "bob-agent",
    });
    expect((await data(await taskAssign(alice, ref("user", "u2")))).assignee).toMatchObject({
      kind: "user",
      name: "bob",
    });
    expect((await taskAssign(alice, ref("user", "u3"))).status).toBe(400);
    expect((await data(await taskAssign(alice, null))).assignee).toBeNull();

    // Members policy: any member may assign any visible agent.
    expect(
      (
        await call("/repositories/r1/settings", "PATCH", alice, {
          agentAssignmentPolicy: "members",
        })
      ).status
    ).toBe(200);
    expect((await set(bob, "reviewer", "a2")).status).toBe(200);
    expect((await set(alice, "reviewer", "a1")).status).toBe(200);
    expect((await set(alice, "assignee", "a3")).status).toBe(400);
    const memberCandidates = await data(
      await call("/repositories/r1/assignee-candidates", "GET", bob)
    );
    expect(
      memberCandidates
        .filter((entry: Json) => entry.kind === "agent")
        .map((entry: Json) => entry.id)
    ).toEqual(["a2", "a1"]);
    expect((await taskAssign(bob, ref("agent", "a2"))).status).toBe(200);
    await call("/repositories/r1/settings", "PATCH", alice, { agentAssignmentPolicy: "owner" });
  });

  it("validates only newly added entries when a set is edited", async () => {
    await call("/repositories/r1/settings", "PATCH", alice, { agentAssignmentPolicy: "owner" });
    const issue = await createIssue("Shared set");
    const path = `/repositories/r1/issues/${issue}/assignees`;
    const put = (who: [string, string], assignees: unknown[]) =>
      call(path, "PUT", who, { role: "assignee", assignees });

    expect((await put(bob, [ref("agent", "a1")])).status).toBe(200);
    // Alice cannot add bob's agent but may edit a set that already holds it.
    expect((await put(alice, [ref("agent", "a2")])).status).toBe(200);
    expect((await put(alice, [ref("agent", "a2"), ref("agent", "a1")])).status).toBe(403);
    // Bob keeps alice's agent while adding his own; dropping it is always allowed.
    expect((await put(bob, [ref("agent", "a2"), ref("agent", "a1")])).status).toBe(200);
    expect((await put(bob, [ref("agent", "a1")])).status).toBe(200);
    const edited = await put(alice, [ref("agent", "a1"), ref("user", "u1")]);
    expect(edited.status).toBe(200);
    expect((await data(edited)).assignees.map((entry: Json) => entry.name)).toEqual([
      "alice",
      "bob-agent",
    ]);
    const kept = await env.DB.prepare(
      "SELECT assigned_by FROM forge_assignments WHERE target_id = (SELECT id FROM forge_issues WHERE repository_id = 'r1' AND number = ?) AND assignee_id = 'a1'"
    )
      .bind(issue)
      .first<{ assigned_by: string }>();
    expect(kept?.assigned_by).toBe("u2");

    // A stale entry (a disabled agent) does not block unrelated edits and can still be removed.
    await env.DB.prepare("UPDATE auth_agents SET disabled_at = 9 WHERE id = 'a1'").run();
    try {
      expect((await put(alice, [ref("agent", "a1"), ref("user", "u2")])).status).toBe(200);
      const removed = await data(await put(alice, [ref("user", "u2")]));
      expect(removed.assignees).toEqual([{ kind: "user", id: "u2", name: "bob" }]);
    } finally {
      await env.DB.prepare("UPDATE auth_agents SET disabled_at = NULL WHERE id = 'a1'").run();
    }
  });

  it("never lets an assigned or approving agent merge or satisfy a gate", async () => {
    const pull = await createPull("Agent reviewed");
    expect(
      (
        await call(`/repositories/r1/pull-requests/${pull}/assignees`, "PUT", bob, {
          role: "reviewer",
          assignees: [ref("agent", "a1")],
        })
      ).status
    ).toBe(200);
    const head = "3".repeat(40);
    const approval = await call(
      `/repositories/r1/pull-requests/${pull}/reviews`,
      "POST",
      bob,
      { state: "approved", commitOid: head },
      writeSession
    );
    expect(approval.status).toBe(201);
    expect((await data(approval)).actor).toMatchObject({ kind: "agent", id: "a1" });
    const mergeBody = { expectedBaseOid: "4".repeat(40), expectedHeadOid: head };
    expect(
      (
        await call(
          `/repositories/r1/pull-requests/${pull}/merge`,
          "POST",
          bob,
          mergeBody,
          writeSession
        )
      ).status
    ).toBe(403);
    // The agent's changes_requested review still blocks, as it did before assignments existed.
    await call(
      `/repositories/r1/pull-requests/${pull}/reviews`,
      "POST",
      bob,
      { state: "changes_requested", commitOid: head },
      writeSession
    );
    expect(
      (await call(`/repositories/r1/pull-requests/${pull}/merge`, "POST", alice, mergeBody)).status
    ).toBe(409);
  });

  it("serves tasks anonymously only when memory visibility is public", async () => {
    await call("/repositories/r1/settings", "PATCH", alice, { memoryVisibility: "public" });
    try {
      for (const path of [
        "/repositories/r1/tasks",
        "/repositories/r1/tasks/1",
        "/repositories/r1/tasks/1/documents/progress",
        "/repositories/r1/tasks/1/documents/progress/history",
        "/repositories/r1/tasks/table",
        "/repositories/r1/memory",
        "/repositories/by-name/alice/demo/tasks",
        "/repositories/r1/settings",
      ]) {
        expect((await call(path, "GET", null)).status, path).toBe(200);
      }
    } finally {
      await call("/repositories/r1/settings", "PATCH", alice, { memoryVisibility: "members" });
    }
  });
});
