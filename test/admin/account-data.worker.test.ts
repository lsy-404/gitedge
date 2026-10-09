import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNT_EXPORT_SECTION_LIMIT,
  sha256Hex,
  type CreatedAccessToken,
} from "../../packages/contracts/src/index";
import {
  artifacts,
  authCall,
  createPerson,
  createRepository,
  data,
  expireRecentAuth,
  forgeCall,
  migrate,
  type Person,
} from "../support/stack";

interface ExportArchive {
  schemaVersion: number;
  profile: { identifier: string; id: string };
  repositories: { name: string }[];
  issues: { title: string }[];
  comments: { body: string }[];
  accessTokens: Record<string, unknown>[];
  organizations: { slug: string }[];
  truncated: string[];
  sectionLimit: number;
}

let alice: Person;
let bob: Person;

async function exportOf(person: Person): Promise<{ text: string; archive: ExportArchive }> {
  const response = await authCall(person, "/account/export");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(response.headers.get("Content-Disposition")).toContain("attachment");
  const text = await response.text();
  return { text, archive: JSON.parse(text) as ExportArchive };
}

beforeAll(async () => {
  await migrate();
  alice = await createPerson("export-alice");
  bob = await createPerson("export-bob");
});

describe("account export", () => {
  it("contains the account's own data and token metadata without secrets", async () => {
    const repositoryId = await createRepository(alice, "exported", "private");
    expect(
      (
        await forgeCall(alice, `/repositories/${repositoryId}/issues`, "POST", {
          title: "Mine",
          body: "text",
        })
      ).status
    ).toBe(201);
    expect(
      (await forgeCall(bob, "/organizations", "POST", { slug: "export-org", displayName: "O" }))
        .status
    ).toBe(201);
    const token = await data<CreatedAccessToken>(
      await authCall(alice, "/access-tokens", "POST", {
        name: "export-token",
        scopes: ["repo:read"],
        expiresInDays: 3,
      })
    );
    await env.DB.prepare(
      "INSERT INTO forge_comments (id, repository_id, target_kind, target_id, actor_json, author_id, body, created_at, updated_at) VALUES ('c1', ?, 'issue', 'x', '{}', ?, 'hello comment', 5, 5)"
    )
      .bind(repositoryId, alice.id)
      .run();

    const { text, archive } = await exportOf(alice);
    expect(archive.schemaVersion).toBe(1);
    expect(archive.profile.identifier).toBe("export-alice");
    expect(archive.repositories.map((repository) => repository.name)).toEqual(["exported"]);
    expect(archive.issues.map((issue) => issue.title)).toEqual(["Mine"]);
    expect(archive.comments.map((comment) => comment.body)).toEqual(["hello comment"]);
    expect(archive.accessTokens).toHaveLength(1);
    expect(archive.accessTokens[0]).toMatchObject({ name: "export-token", prefix: token.prefix });
    expect(archive.truncated).toEqual([]);
    expect(text).not.toContain(token.token);
    expect(text).not.toContain(await sha256Hex(token.token));
    expect(text).not.toMatch(/password_hash|token_hash/);
    expect(text).not.toContain("export-bob");

    const bobs = (await exportOf(bob)).archive;
    expect(bobs.repositories).toEqual([]);
    expect(bobs.issues).toEqual([]);
    expect(bobs.organizations.map((organization) => organization.slug)).toEqual(["export-org"]);
  });

  it("requires a signed-in browser session with recent authentication", async () => {
    expect((await authCall(null, "/account/export")).status).toBe(401);
    expect(
      (await authCall(null, "/account/export", "GET", undefined, { Authorization: "Bearer gep_x" }))
        .status
    ).toBe(403);
    await expireRecentAuth(alice);
    const response = await authCall(alice, "/account/export");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "reauth_required" } });
    await env.DB.prepare("UPDATE auth_sessions SET recent_auth_at = ? WHERE user_id = ?")
      .bind(Date.now(), alice.id)
      .run();
  });

  it("caps each section and reports truncation", async () => {
    const heavy = await createPerson("export-heavy");
    const repositoryId = await createRepository(heavy, "bulk", "private");
    const total = ACCOUNT_EXPORT_SECTION_LIMIT + 5;
    await env.DB.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO forge_issues (id, repository_id, number, author_id, title, body, state, created_at, updated_at) SELECT 'bulk-' || i, ?, i + 1000, ?, 'Issue ' || i, '', 'open', i, i FROM n"
    )
      .bind(total, repositoryId, heavy.id)
      .run();
    const { archive } = await exportOf(heavy);
    expect(archive.issues).toHaveLength(ACCOUNT_EXPORT_SECTION_LIMIT);
    expect(archive.truncated).toEqual(["issues"]);
    expect(archive.sectionLimit).toBe(ACCOUNT_EXPORT_SECTION_LIMIT);
  });
});

describe("account deletion", () => {
  it("requires the username and recent authentication", async () => {
    const person = await createPerson("delete-guard");
    expect((await authCall(person, "/account/delete", "POST", { confirm: "wrong" })).status).toBe(
      400
    );
    expect((await authCall(person, "/account/delete", "POST")).status).toBe(400);
    expect(
      (
        await authCall(
          person,
          "/account/delete",
          "POST",
          { confirm: "delete-guard" },
          { Origin: "https://evil.test" }
        )
      ).status
    ).toBe(403);
    await expireRecentAuth(person);
    const stale = await authCall(person, "/account/delete", "POST", { confirm: "delete-guard" });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: { code: "reauth_required" } });
    expect((await authCall(person, "/session")).status).toBe(200);
  });

  it("is blocked while the user solely owns an organization with members or repositories", async () => {
    const lead = await createPerson("delete-lead");
    const member = await createPerson("delete-member");
    await forgeCall(lead, "/organizations", "POST", { slug: "delete-team", displayName: "T" });
    const invitation = await data<{ id: string }>(
      await forgeCall(lead, "/organizations/delete-team/invitations", "POST", {
        identifier: "delete-member",
      })
    );
    await forgeCall(member, `/invitations/${invitation.id}/accept`, "POST");
    const blocked = await authCall(lead, "/account/delete", "POST", { confirm: "delete-lead" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { code: "organization_ownership", organizations: ["delete-team"] },
    });
    expect((await authCall(lead, "/session")).status).toBe(200);

    await forgeCall(lead, "/organizations/delete-team/members/delete-member", "PATCH", {
      role: "owner",
    });
    expect(
      (await authCall(lead, "/account/delete", "POST", { confirm: "delete-lead" })).status
    ).toBe(204);
    const remaining = await env.DB.prepare(
      "SELECT role FROM namespace_memberships m JOIN namespaces n ON n.id = m.namespace_id WHERE n.slug = 'delete-team'"
    ).all<{ role: string }>();
    expect(remaining.results).toEqual([{ role: "owner" }]);

    await forgeCall(member, "/organizations", "POST", { slug: "delete-solo", displayName: "S" });
    await createRepository(member, "solo-repo", "private", "delete-solo");
    expect(
      (await authCall(member, "/account/delete", "POST", { confirm: "delete-member" })).status
    ).toBe(409);
  });

  it("revokes credentials, soft-deletes repositories and keeps the name reserved", async () => {
    const leaving = await createPerson("delete-leaving");
    const keeper = await createPerson("delete-keeper");
    const repositoryId = await createRepository(leaving, "mine", "public");
    const shared = await createRepository(keeper, "shared", "private");
    const invitation = await data<{ id: string }>(
      await forgeCall(keeper, `/repositories/${shared}/invitations`, "POST", {
        identifier: "delete-leaving",
        role: "write",
      })
    );
    await forgeCall(leaving, `/invitations/${invitation.id}/accept`, "POST");
    const pending = await data<{ id: string }>(
      await forgeCall(keeper, `/repositories/${shared}/invitations`, "POST", {
        email: "x@example.test",
      })
    );
    const token = await data<CreatedAccessToken>(
      await authCall(leaving, "/access-tokens", "POST", {
        name: "ci",
        scopes: ["repo:read"],
        expiresInDays: 3,
      })
    );
    const response = await authCall(leaving, "/account/delete", "POST", {
      confirm: "delete-leaving",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");

    expect((await authCall(leaving, "/session")).status).toBe(401);
    expect(
      (
        await authCall(null, "/session", "GET", undefined, {
          Authorization: `Bearer ${token.token}`,
        })
      ).status
    ).toBe(401);
    expect(
      (
        await authCall(null, "/login", "POST", {
          identifier: "delete-leaving",
          password: "irrelevant-pass-1",
        })
      ).status
    ).toBe(401);
    const repository = await env.DB.prepare(
      "SELECT deleted_at, purge_after, deleted_slug FROM repositories WHERE id = ?"
    )
      .bind(repositoryId)
      .first<{ deleted_at: number; purge_after: number; deleted_slug: string }>();
    expect(repository?.deleted_slug).toBe("mine");
    expect(repository?.purge_after).toBeLessThanOrEqual(Date.now());
    expect(
      (await forgeCall(keeper, "/repositories/by-name/delete-leaving/mine", "GET")).status
    ).toBe(404);
    const collaborator = await env.DB.prepare(
      "SELECT 1 FROM repository_collaborators WHERE user_id = ?"
    )
      .bind(leaving.id)
      .first();
    expect(collaborator).toBeNull();
    const user = await env.DB.prepare(
      "SELECT deleted_at, disabled_at, password_hash, identifier FROM users WHERE id = ?"
    )
      .bind(leaving.id)
      .first<{
        deleted_at: number;
        disabled_at: number;
        password_hash: string;
        identifier: string;
      }>();
    expect(user).toMatchObject({ password_hash: "", identifier: "delete-leaving" });
    expect(user?.deleted_at).toBeTruthy();
    const sent = await env.DB.prepare("SELECT status FROM invitations WHERE id = ?")
      .bind(pending.id)
      .first<{ status: string }>();
    expect(sent?.status).toBe("pending");
    const taken = await authCall(null, "/register", "POST", {
      identifier: "delete-leaving",
      password: "a-long-enough-test-password",
    });
    expect(taken.status).toBe(409);
    const event = await env.DB.prepare(
      "SELECT action FROM audit_events WHERE subject_user_id = ? AND action = 'account.deleted'"
    )
      .bind(leaving.id)
      .first();
    expect(event).not.toBeNull();
  });

  it("revokes other people's agent sessions on its repositories and closes what it alone owns", async () => {
    const owner = await createPerson("delete-owner");
    const helper = await createPerson("delete-helper");
    const live = await createRepository(owner, "live", "public");
    const pending = await createRepository(owner, "pending", "public");
    await env.DB.prepare(
      "UPDATE repositories SET deleted_at = ?1, deleted_by = ?2, deleted_slug = slug, slug = 'deleted~' || id, purge_after = ?3 WHERE id = ?4"
    )
      .bind(Date.now(), owner.id, Date.now() + 86_400_000, pending)
      .run();
    await forgeCall(owner, "/organizations", "POST", { slug: "delete-empty", displayName: "E" });
    await artifacts.create("fork-delete-helper");
    const credential = await (await artifacts.get("fork-delete-helper")).createToken("write", 3600);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO auth_agents(id,user_id,name,description,created_at) VALUES('helper-agent',?,'bot','',1)"
      ).bind(helper.id),
      env.DB.prepare(
        "INSERT INTO auth_agent_sessions(id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,permission,status,created_at,expires_at) VALUES('helper-session','helper-agent',?,?,?,?,'fork-delete-helper','https://r.test','main','read','active',1,?)"
      ).bind(
        helper.id,
        live,
        await sha256Hex("helper-agent-token"),
        credential.id,
        Date.now() + 600_000
      ),
    ]);

    expect(
      (await authCall(owner, "/account/delete", "POST", { confirm: "delete-owner" })).status
    ).toBe(204);
    expect(
      artifacts.snapshot("fork-delete-helper").tokens.find((token) => token.id === credential.id)
        ?.state
    ).toBe("revoked");
    const session = await env.DB.prepare(
      "SELECT status FROM auth_agent_sessions WHERE id = 'helper-session'"
    ).first<{ status: string }>();
    expect(session?.status).toBe("revoked");
    const purge = await env.DB.prepare("SELECT purge_after FROM repositories WHERE id = ?")
      .bind(pending)
      .first<{ purge_after: number }>();
    expect(purge?.purge_after).toBeLessThanOrEqual(Date.now());
    const organization = await env.DB.prepare(
      "SELECT 1 FROM namespaces WHERE slug = 'delete-empty'"
    ).first();
    expect(organization).toBeNull();
  });
});
