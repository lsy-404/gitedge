import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { AuditPage, CreatedAccessToken } from "../../packages/contracts/src/index";
import { sha256Hex } from "../../packages/contracts/src/index";
import {
  authCall,
  createPerson,
  createRepository,
  data,
  forgeCall,
  migrate,
  totpFor,
  type Person,
} from "../support/stack";

let owner: Person;
let writer: Person;
let outsider: Person;
let repositoryId: string;

async function auditPage(person: Person, path: string): Promise<AuditPage> {
  const response = await forgeCall(person, path);
  expect(response.status).toBe(200);
  return data<AuditPage>(response);
}
const actions = (page: AuditPage) => page.events.map((event) => event.action);

beforeAll(async () => {
  await migrate();
  [owner, writer, outsider] = await Promise.all(
    ["audit-owner", "audit-writer", "audit-outsider"].map(createPerson)
  );
  repositoryId = await createRepository(owner, "audited", "private");
});

describe("repository audit log", () => {
  it("records settings, branch rule and collaborator changes with their actor", async () => {
    expect(
      (
        await forgeCall(owner, `/repositories/${repositoryId}/settings`, "PATCH", {
          visibility: "public",
        })
      ).status
    ).toBe(200);
    expect(
      (
        await forgeCall(owner, `/repositories/${repositoryId}/settings`, "PATCH", {
          name: "audited-2",
        })
      ).status
    ).toBe(200);
    const rule = await forgeCall(owner, `/repositories/${repositoryId}/branch-rules`, "POST", {
      pattern: "main",
    });
    const ruleId = (await data<{ id: string }>(rule)).id;
    await forgeCall(owner, `/repositories/${repositoryId}/branch-rules/${ruleId}`, "PATCH", {
      pattern: "main",
      locked: true,
    });
    await forgeCall(owner, `/repositories/${repositoryId}/branch-rules/${ruleId}`, "DELETE");

    const invitation = await data<{ id: string }>(
      await forgeCall(owner, `/repositories/${repositoryId}/invitations`, "POST", {
        identifier: "audit-writer",
        role: "read",
      })
    );
    await forgeCall(writer, `/invitations/${invitation.id}/accept`, "POST");
    await forgeCall(owner, `/repositories/${repositoryId}/collaborators/${writer.id}`, "PATCH", {
      role: "write",
    });
    await forgeCall(owner, `/repositories/${repositoryId}/collaborators/${writer.id}`, "DELETE");

    const page = await auditPage(owner, `/repositories/${repositoryId}/audit-log`);
    expect(actions(page)).toEqual(
      expect.arrayContaining([
        "repository.visibility_changed",
        "repository.renamed",
        "branch_rule.created",
        "branch_rule.updated",
        "branch_rule.deleted",
        "invitation.created",
        "invitation.accepted",
        "collaborator.role_changed",
        "collaborator.removed",
      ])
    );
    const visibility = page.events.find(
      (event) => event.action === "repository.visibility_changed"
    );
    expect(visibility).toMatchObject({
      actor: { kind: "user", name: "audit-owner", id: owner.id },
      metadata: { from: "private", to: "public" },
      repositoryId,
    });
    expect(page.events.find((event) => event.action === "invitation.accepted")?.actor.name).toBe(
      "audit-writer"
    );
  });

  it("is visible to repository administrators only and pages newest first", async () => {
    expect((await forgeCall(outsider, `/repositories/${repositoryId}/audit-log`)).status).toBe(403);
    expect((await forgeCall(writer, `/repositories/${repositoryId}/audit-log`)).status).toBe(403);
    const first = await auditPage(owner, `/repositories/${repositoryId}/audit-log?limit=3`);
    expect(first.events).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await auditPage(
      owner,
      `/repositories/${repositoryId}/audit-log?limit=3&cursor=${first.nextCursor}`
    );
    const ids = new Set([...first.events, ...second.events].map((event) => event.id));
    expect(ids.size).toBe(first.events.length + second.events.length);
    const times = [...first.events, ...second.events].map((event) => event.createdAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(
      (await forgeCall(owner, `/repositories/${repositoryId}/audit-log?cursor=bogus`)).status
    ).toBe(400);
  });

  it("records delete, restore and transfer", async () => {
    const id = await createRepository(owner, "lifecycle-audit", "private");
    await forgeCall(owner, `/repositories/${id}`, "DELETE", {
      confirm: "audit-owner/lifecycle-audit",
    });
    await forgeCall(owner, `/deleted-repositories/${id}/restore`, "POST");
    expect(
      (await forgeCall(owner, "/organizations", "POST", { slug: "audit-org", displayName: "A" }))
        .status
    ).toBe(201);
    expect(
      (
        await forgeCall(owner, `/repositories/${id}/transfer`, "POST", {
          owner: "audit-org",
          confirm: "audit-owner/lifecycle-audit",
        })
      ).status
    ).toBe(200);
    const page = await auditPage(owner, `/repositories/${id}/audit-log`);
    expect(actions(page)).toEqual(
      expect.arrayContaining([
        "repository.deleted",
        "repository.restored",
        "repository.transferred",
      ])
    );
    const organization = await auditPage(owner, "/organizations/audit-org/audit-log");
    expect(actions(organization)).toContain("repository.transfer_received");
  });
});

describe("organization audit log", () => {
  it("shows owners membership events and refuses members", async () => {
    await forgeCall(owner, "/organizations", "POST", { slug: "audit-team", displayName: "T" });
    const invitation = await data<{ id: string }>(
      await forgeCall(owner, "/organizations/audit-team/invitations", "POST", {
        identifier: "audit-writer",
      })
    );
    await forgeCall(writer, `/invitations/${invitation.id}/accept`, "POST");
    await forgeCall(owner, "/organizations/audit-team/members/audit-writer", "PATCH", {
      role: "owner",
    });
    await forgeCall(owner, "/organizations/audit-team/members/audit-writer", "DELETE");
    const page = await auditPage(owner, "/organizations/audit-team/audit-log");
    expect(actions(page)).toEqual(
      expect.arrayContaining([
        "invitation.created",
        "invitation.accepted",
        "member.role_changed",
        "member.removed",
      ])
    );
    expect((await forgeCall(outsider, "/organizations/audit-team/audit-log")).status).toBe(403);
  });
});

describe("account security log and secrecy", () => {
  it("records token and credential events for the account only, never secrets", async () => {
    const created = await authCall(owner, "/access-tokens", "POST", {
      name: "ci",
      scopes: ["repo:read"],
      expiresInDays: 7,
    });
    expect(created.status).toBe(201);
    const token = await data<CreatedAccessToken>(created);
    expect((await authCall(owner, `/access-tokens/${token.id}`, "DELETE")).status).toBe(200);

    const log = await data<AuditPage>(await authCall(owner, "/audit-log"));
    expect(actions(log)).toEqual(
      expect.arrayContaining(["access_token.created", "access_token.revoked"])
    );
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain(token.token);
    expect(serialized).not.toContain(await sha256Hex(token.token));
    expect(serialized).not.toMatch(/gep_[0-9a-f]{20}/);
    expect(log.events.find((event) => event.action === "access_token.created")).toMatchObject({
      metadata: { prefix: token.prefix, scopes: ["repo:read"] },
      actor: { kind: "user" },
    });

    const others = await data<AuditPage>(await authCall(outsider, "/audit-log"));
    expect(JSON.stringify(others)).not.toContain(token.id);
    expect((await authCall(null, "/audit-log")).status).toBe(401);
  });

  it("records two-factor and password changes", async () => {
    const person = await createPerson("audit-factor");
    await env.DB.prepare("UPDATE users SET password_auth_enabled = 1 WHERE id = ?")
      .bind(person.id)
      .run();
    const enrollment = await data<{ secret: string }>(
      await authCall(person, "/security/totp", "POST")
    );
    expect(
      (
        await authCall(person, "/security/totp/confirm", "POST", {
          code: totpFor(enrollment.secret),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await authCall(person, "/security/password", "POST", {
          newPassword: "another-long-password",
        })
      ).status
    ).toBe(200);
    const log = await data<AuditPage>(await authCall(person, "/audit-log"));
    expect(actions(log)).toEqual(
      expect.arrayContaining(["two_factor.totp_enabled", "account.password_changed"])
    );
    expect(JSON.stringify(log)).not.toContain(enrollment.secret);
  });

  it("is append-only", async () => {
    await expect(env.DB.prepare("UPDATE audit_events SET action = 'x'").run()).rejects.toThrow();
    await expect(env.DB.prepare("DELETE FROM audit_events").run()).rejects.toThrow();
  });
});
