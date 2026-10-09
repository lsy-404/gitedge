import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import forge from "../../workers/forge/src/index";
import gitWorker from "../../workers/git/src/index";
import type {
  ExplorePage,
  ExploreTopic,
  NotificationPage,
  Repository,
  RepositorySocial,
  StarredPage,
} from "../../packages/contracts/src/index";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { grantCollaborator } from "../support/membership";
import {
  artifacts,
  createPerson,
  createRepository,
  data,
  forgeCall,
  migrate,
  origin,
  type Person,
} from "../support/stack";

function git(person: Person, repositoryId: string, resource: string, body: unknown) {
  const headers = trustedHeaders({
    id: person.id,
    identifier: person.identifier,
    groupKey: person.groupKey,
  });
  headers.set("Content-Type", "application/json");
  return gitWorker.fetch(
    new Request(`${origin}/repositories/${repositoryId}/${resource}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { DB: env.DB, ARTIFACTS: artifacts }
  );
}
const social = async (person: Person, id: string) =>
  data<RepositorySocial>(await forgeCall(person, `/repositories/${id}/social`));
const explore = async (query = "", person: Person | null = null) =>
  data<ExplorePage>(await forgeCall(person, `/explore${query}`));
const names = (page: ExplorePage) => page.items.map((item) => `${item.owner}/${item.name}`);

let owner: Person;
let fan: Person;
let other: Person;
let lib: string;
let tool: string;
let vault: string;

beforeAll(async () => {
  await migrate();
  [owner, fan, other] = await Promise.all(["sowner", "fan", "other"].map(createPerson));
  lib = await createRepository(owner, "alpha-lib", "public");
  tool = await createRepository(owner, "beta-tool", "public");
  vault = await createRepository(owner, "vault", "private");
  await grantCollaborator(env.DB, vault, fan.id, "read");
});

describe("stars", () => {
  it("counts each user once and supports unstarring", async () => {
    expect(await social(fan, lib)).toMatchObject({ starCount: 0, starred: false });
    const first = await forgeCall(fan, `/repositories/${lib}/star`, "PUT");
    expect(await data<RepositorySocial>(first)).toMatchObject({ starCount: 1, starred: true });
    const again = await forgeCall(fan, `/repositories/${lib}/star`, "PUT");
    expect((await data<RepositorySocial>(again)).starCount).toBe(1);
    await forgeCall(other, `/repositories/${lib}/star`, "PUT");
    const anonymous = await data<Repository>(
      await forgeCall(null, "/repositories/by-name/sowner/alpha-lib")
    );
    expect(anonymous.starCount).toBe(2);
    const removed = await forgeCall(other, `/repositories/${lib}/star`, "DELETE");
    expect(await data<RepositorySocial>(removed)).toMatchObject({ starCount: 1, starred: false });
  });

  it("lists a user's stars and drops repositories they can no longer read", async () => {
    await forgeCall(fan, `/repositories/${vault}/star`, "PUT");
    const starred = await data<StarredPage>(await forgeCall(fan, "/stars"));
    expect(starred.items.map((item) => item.name).sort()).toEqual(["alpha-lib", "vault"]);
    await env.DB.prepare("DELETE FROM repository_collaborators WHERE repository_id = ?")
      .bind(vault)
      .run();
    const after = await data<StarredPage>(await forgeCall(fan, "/stars"));
    expect(after.items.map((item) => item.name)).toEqual(["alpha-lib"]);
    expect((await forgeCall(null, "/stars")).status).toBe(401);
  });

  it("hides private repositories from users who cannot read them", async () => {
    expect((await forgeCall(other, `/repositories/${vault}/star`, "PUT")).status).toBe(404);
    const stars = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM repository_stars WHERE repository_id = ? AND user_id = ?"
    )
      .bind(vault, other.id)
      .first<{ total: number }>();
    expect(stars?.total).toBe(0);
  });
});

describe("watch levels and notifications", () => {
  let watcher: Person;
  let muted: Person;
  const inbox = async (person: Person) =>
    (await data<NotificationPage>(await forgeCall(person, "/notifications"))).items;

  beforeAll(async () => {
    [watcher, muted] = await Promise.all([createPerson("watcher"), createPerson("muted")]);
    expect(
      (await forgeCall(watcher, `/repositories/${lib}/watch`, "PUT", { level: "all" })).status
    ).toBe(200);
    await forgeCall(muted, `/repositories/${lib}/watch`, "PUT", { level: "ignore" });
  });

  it("validates and reports the level", async () => {
    expect(await social(watcher, lib)).toMatchObject({ watchLevel: "all" });
    expect(await social(fan, lib)).toMatchObject({ watchLevel: "participating" });
    const invalid = await forgeCall(fan, `/repositories/${lib}/watch`, "PUT", { level: "loud" });
    expect(invalid.status).toBe(400);
    await forgeCall(fan, `/repositories/${lib}/watch`, "PUT", { level: "all" });
    await forgeCall(fan, `/repositories/${lib}/watch`, "PUT", { level: "participating" });
    expect(await social(fan, lib)).toMatchObject({ watchLevel: "participating" });
  });

  it("notifies all-activity watchers of new issues, pull requests and discussions", async () => {
    await forgeCall(other, `/repositories/${lib}/issues`, "POST", { title: "Broken build" });
    await forgeCall(other, `/repositories/${lib}/pull-requests`, "POST", {
      title: "Fix build",
      baseRef: "main",
      headRef: "fix",
    });
    await forgeCall(other, `/repositories/${lib}/discussions`, "POST", { title: "Roadmap" });
    const items = await inbox(watcher);
    expect(items.map((item) => item.reason)).toEqual(["watching", "watching", "watching"]);
    expect(items.map((item) => item.subjectKind).sort()).toEqual([
      "discussion",
      "issue",
      "pull_request",
    ]);
    expect(await inbox(fan)).toEqual([]);
    expect(await inbox(other)).toEqual([]);
  });

  it("does not notify the actor or ignoring users, even when mentioned", async () => {
    await forgeCall(watcher, `/repositories/${lib}/issues`, "POST", {
      title: "Mention",
      body: "@muted please look",
    });
    expect(await inbox(muted)).toEqual([]);
    const own = await inbox(watcher);
    expect(own.find((item) => item.title === "Mention")).toBeUndefined();
    await forgeCall(muted, `/repositories/${lib}/watch`, "PUT", { level: "participating" });
    await forgeCall(watcher, `/repositories/${lib}/issues`, "POST", {
      title: "Mention again",
      body: "@muted please look",
    });
    expect((await inbox(muted)).map((item) => item.reason)).toEqual(["mentioned"]);
  });

  it("stops notifying watchers who lost access to a private repository", async () => {
    await grantCollaborator(env.DB, vault, fan.id, "read");
    await forgeCall(fan, `/repositories/${vault}/watch`, "PUT", { level: "all" });
    await grantCollaborator(env.DB, vault, other.id, "write");
    await forgeCall(other, `/repositories/${vault}/issues`, "POST", { title: "Private news" });
    expect((await inbox(fan)).some((item) => item.title === "Private news")).toBe(true);
    await env.DB.prepare(
      "DELETE FROM repository_collaborators WHERE repository_id = ? AND user_id = ?"
    )
      .bind(vault, fan.id)
      .run();
    await forgeCall(other, `/repositories/${vault}/issues`, "POST", { title: "Hidden news" });
    expect((await inbox(fan)).some((item) => item.title === "Hidden news")).toBe(false);
  });
});

describe("topics", () => {
  it("lets repository administrators replace the topic set", async () => {
    const set = await forgeCall(owner, `/repositories/${lib}/topics`, "PUT", {
      topics: ["Rust", "cli", "rust", "edge-git"],
    });
    expect(await data<{ topics: string[] }>(set)).toEqual({ topics: ["cli", "edge-git", "rust"] });
    const repository = await data<Repository>(
      await forgeCall(null, "/repositories/by-name/sowner/alpha-lib")
    );
    expect(repository.topics).toEqual(["cli", "edge-git", "rust"]);
    await forgeCall(owner, `/repositories/${tool}/topics`, "PUT", { topics: ["cli"] });
  });

  it("refuses non-administrators and invalid topics", async () => {
    expect(
      (await forgeCall(fan, `/repositories/${lib}/topics`, "PUT", { topics: ["x"] })).status
    ).toBe(403);
    for (const topics of [
      ["has space"],
      ["-lead"],
      ["UPPER_case"],
      [""],
      ["a".repeat(36)],
      ["ok", 3],
    ])
      expect(
        (await forgeCall(owner, `/repositories/${lib}/topics`, "PUT", { topics })).status
      ).toBe(400);
    const tooMany = Array.from({ length: 21 }, (_, index) => `topic-${index}`);
    expect(
      (await forgeCall(owner, `/repositories/${lib}/topics`, "PUT", { topics: tooMany })).status
    ).toBe(400);
    expect(
      (await forgeCall(owner, `/repositories/${lib}/topics`, "PUT", { topics: ["a".repeat(35)] }))
        .status
    ).toBe(200);
    await forgeCall(owner, `/repositories/${lib}/topics`, "PUT", {
      topics: ["cli", "edge-git", "rust"],
    });
  });

  it("rejects invalid topic rows at the database", async () => {
    await expect(
      env.DB.prepare("INSERT INTO repository_topics (repository_id, topic) VALUES (?, ?)")
        .bind(lib, "Bad Topic")
        .run()
    ).rejects.toThrow();
  });
});

describe("explore", () => {
  it("lists only public, live repositories to anonymous visitors", async () => {
    const gone = await createRepository(owner, "gone", "public");
    await forgeCall(owner, `/repositories/${gone}`, "DELETE", { confirm: "sowner/gone" });
    await env.DB.prepare(
      "INSERT INTO repositories (id, namespace_id, created_by, slug, do_name, visibility, description, created_at, updated_at) SELECT 'importing', namespace_id, created_by, 'importing', 'repo:importing', 'public', '', 1, 1 FROM repositories WHERE id = ?"
    )
      .bind(lib)
      .run();
    const page = await explore();
    expect(names(page)).toEqual(expect.arrayContaining(["sowner/alpha-lib", "sowner/beta-tool"]));
    expect(names(page)).not.toContain("sowner/vault");
    expect(names(page)).not.toContain("sowner/gone");
    expect(names(page)).not.toContain("sowner/importing");
    expect(page.items.find((item) => item.name === "alpha-lib")).toMatchObject({
      topics: ["cli", "edge-git", "rust"],
      starCount: 1,
    });
  });

  it("sorts by recent updates or stars and pages with a cursor", async () => {
    await env.DB.prepare("UPDATE repositories SET updated_at = ? WHERE id = ?")
      .bind(9_000_000_000_000, tool)
      .run();
    expect(names(await explore("?sort=updated")).at(0)).toBe("sowner/beta-tool");
    expect(names(await explore("?sort=stars")).at(0)).toBe("sowner/alpha-lib");
    const first = await explore("?sort=stars&limit=1");
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await explore(`?sort=stars&limit=1&cursor=${first.nextCursor}`);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ExplorePage = await explore(`?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      walked.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(walked).size).toBe(walked.length);
    expect(walked).toEqual(expect.arrayContaining([lib, tool]));
  });

  it("searches names, descriptions and topics literally", async () => {
    expect(names(await explore("?q=alpha"))).toEqual(["sowner/alpha-lib"]);
    expect(names(await explore("?q=BETA"))).toEqual(["sowner/beta-tool"]);
    expect(names(await explore("?q=rust"))).toEqual(["sowner/alpha-lib"]);
    expect(names(await explore("?q=%25"))).toEqual([]);
    expect(names(await explore("?q=_"))).toEqual([]);
    expect(names(await explore("?q=vault"))).toEqual([]);
    await env.DB.prepare("UPDATE repositories SET description = 'Fast edge forge' WHERE id = ?")
      .bind(tool)
      .run();
    expect(names(await explore("?q=edge%20forge"))).toEqual(["sowner/beta-tool"]);
  });

  it("filters by topic and lists popular topics", async () => {
    expect(names(await explore("?topic=cli")).sort()).toEqual([
      "sowner/alpha-lib",
      "sowner/beta-tool",
    ]);
    expect(names(await explore("?topic=rust"))).toEqual(["sowner/alpha-lib"]);
    expect((await forgeCall(null, "/explore?topic=Bad%20Topic")).status).toBe(400);
    const topics = await data<ExploreTopic[]>(await forgeCall(null, "/explore/topics"));
    expect(topics[0]).toEqual({ topic: "cli", repositories: 2 });
    await forgeCall(owner, `/repositories/${vault}/topics`, "PUT", { topics: ["secret-topic"] });
    const after = await data<ExploreTopic[]>(await forgeCall(null, "/explore/topics"));
    expect(after.map((item) => item.topic)).not.toContain("secret-topic");
  });

  it("rejects malformed queries", async () => {
    for (const query of ["?sort=hot", "?limit=0", "?limit=500", "?cursor=bad"])
      expect((await forgeCall(null, `/explore${query}`)).status).toBe(400);
    expect((await forgeCall(null, "/explore", "POST", {})).status).toBe(405);
  });
});

describe("fork sync", () => {
  let upstream: string;
  let copy: string;
  beforeAll(async () => {
    upstream = await createRepository(owner, "synced", "public");
    copy = (
      await data<Repository>(await forgeCall(fan, `/repositories/${upstream}/forks`, "POST", {}))
    ).id;
  });

  it("reports an up-to-date fork without writing", async () => {
    const response = await git(fan, copy, "fork-sync", { branch: "main" });
    expect(response.status).toBe(200);
    expect(await data<{ status: string }>(response)).toMatchObject({ status: "up_to_date" });
  });

  it("refuses diverged forks, readers and repositories that are not forks", async () => {
    const row = await env.DB.prepare("SELECT artifact_name AS name FROM repositories WHERE id = ?")
      .bind(copy)
      .first<{ name: string }>();
    await artifacts.seedFiles(row?.name ?? "", { "local.txt": "fork only" });
    const diverged = await git(fan, copy, "fork-sync", { branch: "main" });
    expect(diverged.status).toBe(409);
    expect(await diverged.json()).toMatchObject({ error: { code: "not_fast_forward" } });
    expect((await git(other, copy, "fork-sync", { branch: "main" })).status).toBe(403);
    expect((await git(owner, upstream, "fork-sync", { branch: "main" })).status).toBe(404);
    expect((await git(fan, copy, "fork-sync", { branch: "refs/heads/x" })).status).toBe(400);
  });

  it("stops syncing once the fork is detached", async () => {
    await env.DB.prepare("UPDATE repositories SET fork_of = NULL WHERE id = ?").bind(copy).run();
    const response = await git(fan, copy, "fork-sync", { branch: "main" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "upstream_unavailable" } });
  });
});
