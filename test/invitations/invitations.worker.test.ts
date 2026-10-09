import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { CreatedInvitation, Invitation } from "../../packages/contracts/src/index";
import {
  createPerson,
  createRepository,
  data,
  forgeCall,
  migrate,
  type Person,
} from "../support/stack";

let owner: Person;
let bob: Person;
let carol: Person;
let dave: Person;

async function invite(
  actor: Person,
  path: string,
  body: Record<string, unknown>
): Promise<CreatedInvitation> {
  const response = await forgeCall(actor, path, "POST", body);
  expect(response.status).toBe(201);
  return data<CreatedInvitation>(response);
}

beforeAll(async () => {
  await migrate();
  [owner, bob, carol, dave] = await Promise.all(
    ["inv-owner", "inv-bob", "inv-carol", "inv-dave"].map(createPerson)
  );
  expect(
    (
      await forgeCall(owner, "/organizations", "POST", {
        slug: "inv-org",
        displayName: "Invite Org",
      })
    ).status
  ).toBe(201);
});

describe("organization invitations", () => {
  it("replaces direct member adds with a pending invitation the invitee accepts", async () => {
    expect(
      (await forgeCall(owner, "/organizations/inv-org/members", "POST", { identifier: "inv-bob" }))
        .status
    ).toBe(405);
    const created = await invite(owner, "/organizations/inv-org/invitations", {
      identifier: "inv-bob",
      role: "member",
    });
    expect(created).toMatchObject({
      kind: "organization",
      organization: "inv-org",
      invitee: "inv-bob",
      inviter: "inv-owner",
      status: "pending",
      token: null,
    });
    expect(created.expiresAt - created.createdAt).toBe(7 * 24 * 60 * 60 * 1000);
    const members = await data<{ identifier: string }[]>(
      await forgeCall(owner, "/organizations/inv-org/members")
    );
    expect(members.map((member) => member.identifier)).toEqual(["inv-owner"]);

    const mine = (await (await forgeCall(bob, "/invitations")).json()) as { data: Invitation[] };
    expect(mine.data.map((item) => item.id)).toEqual([created.id]);
    expect((await (await forgeCall(carol, "/invitations")).json()) as { data: [] }).toEqual({
      data: [],
      truncated: false,
    });

    expect((await forgeCall(carol, `/invitations/${created.id}/accept`, "POST")).status).toBe(404);
    expect((await forgeCall(carol, `/invitations/${created.id}/decline`, "POST")).status).toBe(404);
    expect((await forgeCall(bob, `/invitations/${created.id}/accept`, "POST")).status).toBe(200);
    expect((await forgeCall(bob, `/invitations/${created.id}/accept`, "POST")).status).toBe(409);
    expect((await forgeCall(bob, "/organizations/inv-org")).status).toBe(200);
  });

  it("allows only owners to invite, rejects duplicates and members, and lists pending ones", async () => {
    expect(
      (
        await forgeCall(bob, "/organizations/inv-org/invitations", "POST", {
          identifier: "inv-carol",
        })
      ).status
    ).toBe(403);
    expect(
      (
        await forgeCall(owner, "/organizations/inv-org/invitations", "POST", {
          identifier: "inv-bob",
        })
      ).status
    ).toBe(409);
    expect(
      (
        await forgeCall(owner, "/organizations/inv-org/invitations", "POST", {
          identifier: "nobody-here",
        })
      ).status
    ).toBe(404);
    expect(
      (await forgeCall(owner, "/organizations/inv-org/invitations", "POST", { role: "member" }))
        .status
    ).toBe(400);
    const pending = await invite(owner, "/organizations/inv-org/invitations", {
      identifier: "inv-carol",
    });
    expect(
      (
        await forgeCall(owner, "/organizations/inv-org/invitations", "POST", {
          identifier: "inv-carol",
        })
      ).status
    ).toBe(409);
    expect((await forgeCall(bob, "/organizations/inv-org/invitations")).status).toBe(403);
    const listed = (await (
      await forgeCall(owner, "/organizations/inv-org/invitations")
    ).json()) as { data: Invitation[] };
    expect(listed.data.map((item) => item.id)).toEqual([pending.id]);
  });

  it("lets the invitee decline and owners cancel; closed invitations cannot be accepted", async () => {
    const declined = await invite(owner, "/organizations/inv-org/invitations", {
      identifier: "inv-dave",
    });
    expect((await forgeCall(dave, `/invitations/${declined.id}/decline`, "POST")).status).toBe(200);
    expect((await forgeCall(dave, `/invitations/${declined.id}/accept`, "POST")).status).toBe(409);
    expect((await forgeCall(dave, "/organizations/inv-org/members")).status).toBe(403);

    const cancelled = await invite(owner, "/organizations/inv-org/invitations", {
      identifier: "inv-dave",
    });
    expect(
      (await forgeCall(bob, `/organizations/inv-org/invitations/${cancelled.id}`, "DELETE")).status
    ).toBe(403);
    expect(
      (await forgeCall(owner, `/organizations/inv-org/invitations/${cancelled.id}`, "DELETE"))
        .status
    ).toBe(200);
    expect((await forgeCall(dave, `/invitations/${cancelled.id}/accept`, "POST")).status).toBe(409);
    expect(
      (await forgeCall(owner, `/organizations/inv-org/invitations/${cancelled.id}`, "DELETE"))
        .status
    ).toBe(404);
  });

  it("expires invitations after seven days and allows inviting again", async () => {
    const stale = await invite(owner, "/organizations/inv-org/invitations", {
      identifier: "inv-dave",
    });
    await env.DB.prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, stale.id)
      .run();
    expect((await forgeCall(dave, `/invitations/${stale.id}/accept`, "POST")).status).toBe(409);
    expect(
      ((await (await forgeCall(dave, "/invitations")).json()) as { data: unknown[] }).data
    ).toEqual([]);
    const renewed = await invite(owner, "/organizations/inv-org/invitations", {
      identifier: "inv-dave",
    });
    expect(renewed.id).not.toBe(stale.id);
    const status = await env.DB.prepare("SELECT status FROM invitations WHERE id = ?")
      .bind(stale.id)
      .first<{ status: string }>();
    expect(status?.status).toBe("expired");
    expect((await forgeCall(dave, `/invitations/${renewed.id}/accept`, "POST")).status).toBe(200);
  });

  it("changes member roles with a last-owner guard", async () => {
    expect(
      (await forgeCall(owner, "/organizations/inv-org/members/inv-bob", "PATCH", { role: "owner" }))
        .status
    ).toBe(200);
    expect(
      (
        await forgeCall(owner, "/organizations/inv-org/members/inv-owner", "PATCH", {
          role: "member",
        })
      ).status
    ).toBe(200);
    expect(
      (await forgeCall(bob, "/organizations/inv-org/members/inv-bob", "PATCH", { role: "member" }))
        .status
    ).toBe(409);
  });
});

describe("repository invitations", () => {
  it("grants the invited role only after acceptance and requires repository admin to invite", async () => {
    const repositoryId = await createRepository(carol, "invited-repo", "private");
    const route = `/repositories/${repositoryId}/invitations`;
    const created = await invite(carol, route, { identifier: "inv-owner", role: "write" });
    expect(created).toMatchObject({
      kind: "repository",
      role: "write",
      repository: { owner: "inv-carol", name: "invited-repo" },
    });
    expect((await forgeCall(owner, `/repositories/${repositoryId}`)).status).toBe(404);
    expect((await forgeCall(owner, route, "POST", { identifier: "inv-bob" })).status).toBe(404);
    expect((await forgeCall(owner, `/invitations/${created.id}/accept`, "POST")).status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT role FROM repository_collaborators WHERE repository_id = ? AND user_id = ?"
    )
      .bind(repositoryId, owner.id)
      .first<{ role: string }>();
    expect(row?.role).toBe("write");
    expect((await forgeCall(owner, route, "POST", { identifier: "inv-bob" })).status).toBe(403);
    expect(
      (await forgeCall(carol, route, "POST", { identifier: "inv-owner", role: "read" })).status
    ).toBe(409);
    expect(
      (await forgeCall(carol, route, "POST", { identifier: "inv-carol", role: "read" })).status
    ).toBe(409);
    expect(
      (
        await forgeCall(carol, `/repositories/${repositoryId}/collaborators`, "PUT", {
          identifier: "inv-bob",
          role: "read",
        })
      ).status
    ).toBe(405);
  });

  it("does not list or accept an invitation once its repository is deleted", async () => {
    const repositoryId = await createRepository(carol, "short-lived", "private");
    const created = await invite(carol, `/repositories/${repositoryId}/invitations`, {
      identifier: "inv-dave",
      role: "read",
    });
    expect(
      (
        await forgeCall(carol, `/repositories/${repositoryId}`, "DELETE", {
          confirm: "inv-carol/short-lived",
        })
      ).status
    ).toBe(200);
    expect((await forgeCall(dave, `/invitations/${created.id}/accept`, "POST")).status).toBe(404);
  });
});

describe("link invitations", () => {
  it("issues a one-time token, stores only its hash and lets any signed-in holder accept once", async () => {
    const repositoryId = await createRepository(carol, "link-repo", "private");
    const created = await invite(carol, `/repositories/${repositoryId}/invitations`, {
      email: "Someone@Example.test",
      role: "read",
    });
    expect(created.token).toMatch(/^gei_[0-9a-f]{64}$/);
    expect(created).toMatchObject({ invitee: null, inviteeEmail: "someone@example.test" });
    const stored = JSON.stringify(
      (await env.DB.prepare("SELECT * FROM invitations WHERE id = ?").bind(created.id).first()) ??
        {}
    );
    expect(stored).not.toContain(created.token ?? "missing");
    const token = created.token ?? "";

    expect(
      (await forgeCall(dave, "/invitations/lookup", "POST", { token: "gei_" + "0".repeat(64) }))
        .status
    ).toBe(404);
    const looked = await data<Invitation>(
      await forgeCall(dave, "/invitations/lookup", "POST", { token })
    );
    expect(looked.repository?.name).toBe("link-repo");
    expect((await forgeCall(dave, "/invitations/accept", "POST", { token })).status).toBe(200);
    expect((await forgeCall(dave, `/repositories/${repositoryId}`)).status).toBe(200);
    expect((await forgeCall(bob, "/invitations/accept", "POST", { token })).status).toBe(409);
    expect((await forgeCall(bob, `/invitations/${created.id}/accept`, "POST")).status).toBe(404);
    expect(
      (
        await forgeCall(carol, `/repositories/${repositoryId}/invitations`, "POST", {
          email: "someone@example.test",
        })
      ).status
    ).toBe(201);
  });
});
