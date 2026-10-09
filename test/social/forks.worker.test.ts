import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import forge from "../../workers/forge/src/index";
import gitWorker from "../../workers/git/src/index";
import { detachForks } from "../../workers/forge/src/forks";
import { resolveProposalHead, type GitRepositoryAccess } from "../../workers/git/src/access";
import type { PullRequest, Repository } from "../../packages/contracts/src/index";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { grantCollaborator, grantOrganizationMember } from "../support/membership";
import {
  artifacts,
  createPerson,
  createRepository,
  data,
  forgeEnv,
  migrate,
  origin,
  type Person,
} from "../support/stack";

const HEAD = "2".repeat(40);
const gitEnv = { DB: env.DB, ARTIFACTS: artifacts };
const BASE = "1".repeat(40);
const MERGE = "c".repeat(40);
const gitRequests: { method: string; url: URL; body: unknown }[] = [];
const platform = {
  ...forgeEnv,
  GIT: {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const body: unknown =
        request.method === "GET" || request.method === "HEAD"
          ? null
          : await request
              .clone()
              .json()
              .catch(() => null);
      gitRequests.push({ method: request.method, url, body });
      if (url.pathname.endsWith("/pull-head")) return Response.json({ data: { oid: HEAD } });
      if (url.pathname.endsWith("/compare"))
        return Response.json({ data: { headOid: HEAD, commits: [], files: [] } });
      if (url.pathname.endsWith("/merge")) return Response.json({ data: { oid: MERGE } });
      return Response.json({ data: { deleted: true } });
    },
  },
};

function call(person: Person | null, path: string, method = "GET", body?: unknown) {
  const headers = trustedHeaders(
    person
      ? {
          id: person.id,
          identifier: person.identifier,
          groupKey: person.groupKey,
          recentAuthAt: Date.now(),
        }
      : undefined
  );
  headers.set("Content-Type", "application/json");
  return forge.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    platform
  );
}
function gitCall(person: Person | null, repositoryId: string, resource: string, body: unknown) {
  const headers = trustedHeaders(
    person ? { id: person.id, identifier: person.identifier, groupKey: person.groupKey } : undefined
  );
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
async function fork(person: Person, repositoryId: string, body: object = {}): Promise<Response> {
  return call(person, `/repositories/${repositoryId}/forks`, "POST", body);
}
const forkOf = (id: string) =>
  env.DB.prepare("SELECT fork_of AS parent FROM repositories WHERE id = ?")
    .bind(id)
    .first<{ parent: string | null }>()
    .then((row) => row?.parent);

const aliceForkId = () =>
  env.DB.prepare(
    "SELECT r.id FROM repositories r JOIN namespaces n ON n.id = r.namespace_id WHERE n.slug = 'alice' AND r.slug = 'lib'"
  )
    .first<{ id: string }>()
    .then((row) => row?.id ?? "");

let owner: Person;
let alice: Person;
let bob: Person;
let carol: Person;
let publicId: string;
let privateId: string;

beforeAll(async () => {
  await migrate();
  [owner, alice, bob, carol] = await Promise.all(
    ["fowner", "alice", "bob", "carol"].map(createPerson)
  );
  publicId = await createRepository(owner, "lib", "public");
  privateId = await createRepository(owner, "secret", "private");
  await grantCollaborator(env.DB, privateId, bob.id, "read");
});

describe("forking", () => {
  it("lets any reader fork a public repository into their namespace", async () => {
    const response = await fork(alice, publicId);
    expect(response.status).toBe(201);
    const created = await data<Repository>(response);
    expect(created).toMatchObject({
      owner: "alice",
      slug: "lib",
      visibility: "public",
      forkOf: { id: publicId, owner: "fowner", name: "lib" },
      viewerRole: "admin",
    });
    expect(await forkOf(created.id)).toBe(publicId);
    const parent = await data<Repository>(await call(null, "/repositories/by-name/fowner/lib"));
    expect(parent.forkCount).toBe(1);
    const second = await fork(alice, publicId);
    expect(second.status).toBe(409);
    const renamed = await fork(alice, publicId, { name: "lib-again" });
    expect(renamed.status).toBe(201);
  });

  it("hides private repositories from users without access", async () => {
    expect((await fork(alice, privateId)).status).toBe(404);
  });

  it("keeps forks of private repositories private and invisible to others", async () => {
    const response = await fork(bob, privateId);
    expect(response.status).toBe(201);
    const created = await data<Repository>(response);
    expect(created.visibility).toBe("private");
    expect((await call(carol, `/repositories/${created.id}`)).status).toBe(404);
    const asOwner = await data<Repository[]>(await call(owner, `/repositories/${privateId}/forks`));
    expect(asOwner).toEqual([]);
    const asBob = await data<Repository[]>(await call(bob, `/repositories/${privateId}/forks`));
    expect(asBob.map((item) => item.id)).toEqual([created.id]);
    const forkPublicly = await call(bob, `/repositories/${created.id}/settings`, "PATCH", {
      visibility: "public",
    });
    expect(forkPublicly.status).toBe(409);
  });

  it("forks into an organization only for its owners", async () => {
    const created = await call(owner, "/organizations", "POST", {
      slug: "acme",
      displayName: "Acme",
    });
    expect(created.status).toBe(201);
    await grantOrganizationMember(env.DB, "acme", carol.id, "member");
    expect((await fork(carol, publicId, { owner: "acme" })).status).toBe(403);
    expect((await fork(owner, publicId, { owner: "acme" })).status).toBe(201);
    expect((await fork(owner, publicId, { owner: "missing-org" })).status).toBe(404);
  });

  it("enforces the repository quota for the forking user", async () => {
    const limited = {
      ...platform,
      USER_GROUP_LIMITS_JSON: JSON.stringify({ free: { maxRepositories: 1 } }),
    };
    const dave = await createPerson("dave");
    const headers = trustedHeaders({ id: dave.id, identifier: dave.identifier, groupKey: "free" });
    headers.set("Content-Type", "application/json");
    const attempt = () =>
      forge.fetch(
        new Request(`${origin}/repositories/${publicId}/forks`, {
          method: "POST",
          headers,
          body: "{}",
        }),
        limited
      );
    expect((await attempt()).status).toBe(201);
    const second = await attempt();
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ error: { code: "quota_exceeded" } });
  });

  it("detaches forks of private repositories when access is revoked", async () => {
    const forkId = (
      await data<Repository[]>(await call(bob, `/repositories/${privateId}/forks`))
    )[0].id;
    const removal = await call(
      owner,
      `/repositories/${privateId}/collaborators/${bob.id}`,
      "DELETE"
    );
    expect(removal.status).toBe(200);
    expect(await forkOf(forkId)).toBeNull();
    expect(await data<Repository[]>(await call(owner, `/repositories/${privateId}/forks`))).toEqual(
      []
    );
  });

  it("detaches forks and closes their pull requests when the parent is deleted", async () => {
    const parentId = await createRepository(owner, "doomed", "public");
    const child = await data<Repository>(await fork(alice, parentId));
    const pr = await call(alice, `/repositories/${parentId}/pull-requests`, "POST", {
      title: "From fork",
      baseRef: "main",
      headRef: "topic",
      headRepositoryId: child.id,
    });
    expect(pr.status).toBe(201);
    const deleted = await call(owner, `/repositories/${parentId}`, "DELETE", {
      confirm: "fowner/doomed",
    });
    expect(deleted.status).toBe(200);
    expect(await forkOf(child.id)).toBeNull();
    const state = await env.DB.prepare(
      "SELECT state FROM forge_pull_requests WHERE head_repository_id = ?"
    )
      .bind(child.id)
      .first<{ state: string }>();
    expect(state?.state).toBe("closed");
    expect(await detachForks(platform)).toBe(0);
  });
});

describe("cross-repository pull requests", () => {
  let forkId: string;
  let number: number;
  beforeAll(async () => {
    forkId = await aliceForkId();
  });

  it("accepts heads only from forks of the base repository", async () => {
    const unrelated = await createRepository(alice, "unrelated", "public");
    const body = { title: "x", baseRef: "main", headRef: "topic" };
    const post = (headRepositoryId: string) =>
      call(alice, `/repositories/${publicId}/pull-requests`, "POST", { ...body, headRepositoryId });
    expect((await post(unrelated)).status).toBe(404);
    expect((await post(publicId)).status).toBe(404);
    const both = await call(alice, `/repositories/${publicId}/pull-requests`, "POST", {
      ...body,
      headRepositoryId: forkId,
      headSessionId: "s",
    });
    expect(both.status).toBe(400);
    const created = await post(forkId);
    expect(created.status).toBe(201);
    const pull = await data<PullRequest>(created);
    number = pull.number;
    expect(pull.headRepositoryId).toBe(forkId);
    const detail = await data<PullRequest>(
      await call(null, `/repositories/${publicId}/pull-requests/${number}`)
    );
    expect(detail.headRepository).toEqual({ owner: "alice", name: "lib" });
  });

  it("keeps private fork heads unavailable to non-members", async () => {
    const parent = await createRepository(owner, "closed-parent", "private");
    await grantCollaborator(env.DB, parent, carol.id, "read");
    const child = await data<Repository>(await fork(carol, parent));
    const other = await createPerson("eve");
    const attempt = await call(other, `/repositories/${parent}/pull-requests`, "POST", {
      title: "x",
      baseRef: "main",
      headRef: "topic",
      headRepositoryId: child.id,
    });
    expect(attempt.status).toBe(404);
  });

  it("forwards the fork head to Git for diffs and merges with exact OIDs", async () => {
    gitRequests.length = 0;
    const diff = await call(alice, `/repositories/${publicId}/pull-requests/${number}/diff`);
    expect(diff.status).toBe(200);
    expect(gitRequests[0].url.searchParams.get("headRepositoryId")).toBe(forkId);
    expect(gitRequests[0].url.searchParams.get("headSessionId")).toBeNull();

    await call(owner, `/repositories/${publicId}/settings`, "PATCH", { deleteBranchOnMerge: true });
    gitRequests.length = 0;
    const merged = await call(
      owner,
      `/repositories/${publicId}/pull-requests/${number}/merge`,
      "POST",
      {
        method: "merge",
        expectedBaseOid: BASE,
        expectedHeadOid: HEAD,
      }
    );
    expect(merged.status).toBe(200);
    const mergeCall = gitRequests.find((entry) => entry.url.pathname.endsWith("/merge"));
    expect(mergeCall?.body).toMatchObject({
      headRepositoryId: forkId,
      headRef: "topic",
      expectedBaseOid: BASE,
      expectedHeadOid: HEAD,
    });
    expect(gitRequests.some((entry) => entry.method === "DELETE")).toBe(false);
  });

  it("rejects merge authorization that names another head", async () => {
    const pull = await data<PullRequest>(
      await call(alice, `/repositories/${publicId}/pull-requests`, "POST", {
        title: "second",
        baseRef: "main",
        headRef: "other",
        headRepositoryId: forkId,
      })
    );
    const leaseAt = Date.now();
    await env.DB.prepare(
      "UPDATE forge_pull_requests SET merge_started_at = ?, merge_base_oid = ?, merge_head_oid = ? WHERE id = ?"
    )
      .bind(leaseAt, BASE, HEAD, pull.id)
      .run();
    const authorize = (headRepositoryId: string | null) => {
      const headers = trustedHeaders({
        id: owner.id,
        identifier: owner.identifier,
        groupKey: "free",
      });
      headers.set("Content-Type", "application/json");
      return forge.fetch(
        new Request("https://forge.internal/internal/merge-authorization", {
          method: "POST",
          headers,
          body: JSON.stringify({
            repositoryId: publicId,
            pullRequestId: pull.id,
            leaseAt,
            method: "merge",
            baseRef: "main",
            headRef: "other",
            headRepositoryId,
            expectedBaseOid: BASE,
            expectedHeadOid: HEAD,
            author: { name: "o", email: "o@example.invalid" },
            message: "m",
          }),
        }),
        platform
      );
    };
    expect((await authorize(null)).status).toBe(409);
    expect((await authorize(forkId)).status).toBe(200);
  });
});

describe("Git head resolution", () => {
  function access(repositoryId: string, user: Person | null): GitRepositoryAccess {
    return {
      user: user ? { id: user.id, identifier: user.identifier, groupKey: "free" } : null,
      repository: {
        id: repositoryId,
        namespaceId: "",
        artifactName: "base",
        remote: null,
        defaultBranch: "main",
        visibility: "public",
        owner: "",
        slug: "",
        canWrite: 0,
        archived: 0,
        agentsEnabled: 1,
        graphEnabled: 1,
        onlineEditingEnabled: 1,
      },
    };
  }

  it("resolves public forks and refuses repositories that are not forks", async () => {
    const forkId = await aliceForkId();
    const row = await env.DB.prepare("SELECT artifact_name AS name FROM repositories WHERE id = ?")
      .bind(forkId)
      .first<{ name: string }>();
    expect(
      await resolveProposalHead(gitEnv, access(publicId, null), {
        repositoryId: forkId,
        ref: "topic",
      })
    ).toBe(row?.name);
    expect(
      await resolveProposalHead(gitEnv, access(publicId, null), {
        repositoryId: privateId,
        ref: "topic",
      })
    ).toBeNull();
    expect(
      await resolveProposalHead(gitEnv, access(publicId, null), {
        repositoryId: forkId,
        sessionId: "s",
        ref: "topic",
      })
    ).toBeNull();
  });

  it("grants a private fork head to readers only through a published pull request", async () => {
    const parent = await createRepository(owner, "pr-parent", "private");
    await grantCollaborator(env.DB, parent, carol.id, "read");
    const child = await data<Repository>(await fork(carol, parent));
    const row = await env.DB.prepare("SELECT artifact_name AS name FROM repositories WHERE id = ?")
      .bind(child.id)
      .first<{ name: string }>();
    const reader = access(parent, owner);
    reader.repository.visibility = "private";
    const resolve = (ref: string) =>
      resolveProposalHead(
        gitEnv,
        { ...reader, user: { id: "x", identifier: "x", groupKey: "free" } },
        {
          repositoryId: child.id,
          ref,
        }
      );
    expect(await resolve("topic")).toBeNull();
    const pr = await call(carol, `/repositories/${parent}/pull-requests`, "POST", {
      title: "x",
      baseRef: "main",
      headRef: "topic",
      headRepositoryId: child.id,
    });
    expect(pr.status).toBe(201);
    expect(await resolve("topic")).toBe(row?.name);
    expect(await resolve("elsewhere")).toBeNull();
    await env.DB.prepare("UPDATE forge_pull_requests SET state = 'closed' WHERE repository_id = ?")
      .bind(parent)
      .run();
    expect(await resolve("topic")).toBeNull();
  });

  it("rejects fork merges whose recorded OIDs are stale before minting tokens", async () => {
    const forkId = await aliceForkId();
    const forkRow = await env.DB.prepare(
      "SELECT artifact_name AS name FROM repositories WHERE id = ?"
    )
      .bind(forkId)
      .first<{ name: string }>();
    const before = artifacts.snapshot(forkRow?.name ?? "").tokens.length;
    const response = await gitCall(owner, publicId, "merge", {
      pullRequestId: "pr",
      leaseAt: 1,
      baseRef: "main",
      headRef: "topic",
      headRepositoryId: forkId,
      expectedBaseOid: BASE,
      expectedHeadOid: HEAD,
      author: { name: "o", email: "o@example.invalid" },
      message: "m",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "refs_changed" } });
    expect(artifacts.snapshot(forkRow?.name ?? "").tokens.length).toBe(before);
    const unrelated = await gitCall(owner, publicId, "merge", {
      pullRequestId: "pr",
      leaseAt: 1,
      baseRef: "main",
      headRef: "topic",
      headRepositoryId: privateId,
      expectedBaseOid: BASE,
      expectedHeadOid: HEAD,
      author: { name: "o", email: "o@example.invalid" },
      message: "m",
    });
    expect(unrelated.status).toBe(404);
  });
});

describe("private fork boundaries", () => {
  let keeper: Person;
  let reader: Person;
  let outsider: Person;
  let vaultId: string;
  let vaultForkId: string;
  const invite = (person: Person, repositoryId: string, invitee: object) =>
    call(person, `/repositories/${repositoryId}/invitations`, "POST", { ...invitee, role: "read" });

  beforeAll(async () => {
    [keeper, reader, outsider] = await Promise.all(
      ["keeper", "reader", "outsider"].map(createPerson)
    );
    vaultId = await createRepository(keeper, "vault", "private");
    await grantCollaborator(env.DB, vaultId, reader.id, "read");
    const organization = await call(reader, "/organizations", "POST", {
      slug: "reader-org",
      displayName: "Reader org",
    });
    expect(organization.status).toBe(201);
  });

  it("forks a private repository only into the caller's account or the parent's owner", async () => {
    const elsewhere = await fork(reader, vaultId, { owner: "reader-org" });
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toMatchObject({ error: { code: "fork_owner_not_allowed" } });
    const own = await fork(reader, vaultId);
    expect(own.status).toBe(201);
    vaultForkId = (await data<Repository>(own)).id;
    const shared = await createRepository(owner, "shared-lib", "public");
    expect((await fork(reader, shared, { owner: "reader-org" })).status).toBe(201);
  });

  it("refuses forks through repository-limited tokens", async () => {
    const headers = trustedHeaders({
      id: reader.id,
      identifier: reader.identifier,
      groupKey: reader.groupKey,
      token: { id: "limited", scopes: ["repo:write"], repositoryIds: [vaultId] },
    });
    headers.set("Content-Type", "application/json");
    const response = await forge.fetch(
      new Request(`${origin}/repositories/${vaultId}/forks`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "vault-token" }),
      }),
      platform
    );
    expect(response.status).toBe(403);
  });

  it("invites only collaborators who can already read the parent", async () => {
    const stranger = await invite(reader, vaultForkId, { identifier: outsider.identifier });
    expect(stranger.status).toBe(409);
    expect(await stranger.json()).toMatchObject({
      error: { code: "fork_collaborator_not_allowed" },
    });
    expect((await invite(reader, vaultForkId, { email: "someone@example.com" })).status).toBe(409);
    expect((await invite(reader, vaultForkId, { identifier: keeper.identifier })).status).toBe(201);
  });

  it("refuses moving a private fork into another organization", async () => {
    const moved = await call(reader, `/repositories/${vaultForkId}/transfer`, "POST", {
      owner: "reader-org",
      confirm: "reader/vault",
    });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ error: { code: "fork_owner_not_allowed" } });
  });

  it("requires write access to a private fork to publish its branch", async () => {
    await grantCollaborator(env.DB, vaultForkId, keeper.id, "read");
    const request = {
      title: "From a read-only fork member",
      baseRef: "main",
      headRef: "topic",
      headRepositoryId: vaultForkId,
    };
    const readOnly = await call(keeper, `/repositories/${vaultId}/pull-requests`, "POST", request);
    expect(readOnly.status).toBe(403);
    const published = await call(reader, `/repositories/${vaultId}/pull-requests`, "POST", request);
    expect(published.status).toBe(201);
  });

  it("does not open private fork heads to agents or tokens limited to the base", async () => {
    const forkRow = await env.DB.prepare(
      "SELECT artifact_name AS name FROM repositories WHERE id = ?"
    )
      .bind(vaultForkId)
      .first<{ name: string }>();
    const base: GitRepositoryAccess["repository"] = {
      id: vaultId,
      namespaceId: "",
      artifactName: "base",
      remote: null,
      defaultBranch: "main",
      visibility: "private",
      owner: "keeper",
      slug: "vault",
      canWrite: 0,
      archived: 0,
      agentsEnabled: 1,
      graphEnabled: 1,
      onlineEditingEnabled: 1,
    };
    const head = { repositoryId: vaultForkId, ref: "unpublished" };
    const member = { id: reader.id, identifier: reader.identifier, groupKey: "free" };
    expect(await resolveProposalHead(gitEnv, { repository: base, user: member }, head)).toBe(
      forkRow?.name
    );
    expect(
      await resolveProposalHead(
        gitEnv,
        {
          repository: base,
          user: { ...member, token: { id: "t", scopes: ["repo:read"], repositoryIds: [vaultId] } },
        },
        head
      )
    ).toBeNull();
  });

  it("detaches a fork once one of its readers cannot read the parent", async () => {
    await grantCollaborator(env.DB, vaultForkId, outsider.id, "read");
    expect(await detachForks(platform)).toBeGreaterThanOrEqual(1);
    expect(await forkOf(vaultForkId)).toBeNull();
    const pulls = await env.DB.prepare(
      "SELECT state FROM forge_pull_requests WHERE head_repository_id = ?"
    )
      .bind(vaultForkId)
      .all<{ state: string }>();
    expect(pulls.results.map((row) => row.state)).toEqual(["closed"]);
  });

  it("refuses an invitation accepted after the parent became private", async () => {
    const parentId = await createRepository(keeper, "opening", "public");
    await grantCollaborator(env.DB, parentId, reader.id, "read");
    const child = await data<Repository>(await fork(reader, parentId));
    expect(
      (
        await call(reader, `/repositories/${child.id}/settings`, "PATCH", {
          visibility: "private",
        })
      ).status
    ).toBe(200);
    const pending = await data<{ id: string }>(
      await invite(reader, child.id, { identifier: outsider.identifier })
    );
    const closed = await call(keeper, `/repositories/${parentId}/settings`, "PATCH", {
      visibility: "private",
    });
    expect(closed.status).toBe(200);
    expect(await forkOf(child.id)).toBe(parentId);
    const accepted = await call(outsider, `/invitations/${pending.id}/accept`, "POST");
    expect(accepted.status).toBe(409);
    expect(await accepted.json()).toMatchObject({
      error: { code: "fork_collaborator_not_allowed" },
    });
  });

  it("closes pull requests whose fork is deleted", async () => {
    const parentId = await createRepository(keeper, "upstream-x", "public");
    const child = await data<Repository>(await fork(outsider, parentId));
    const pull = await call(outsider, `/repositories/${parentId}/pull-requests`, "POST", {
      title: "Soon orphaned",
      baseRef: "main",
      headRef: "topic",
      headRepositoryId: child.id,
    });
    expect(pull.status).toBe(201);
    const deleted = await call(outsider, `/repositories/${child.id}`, "DELETE", {
      confirm: "outsider/upstream-x",
    });
    expect(deleted.status).toBe(200);
    const state = await env.DB.prepare(
      "SELECT state FROM forge_pull_requests WHERE head_repository_id = ?"
    )
      .bind(child.id)
      .first<{ state: string }>();
    expect(state?.state).toBe("closed");
  });
});
