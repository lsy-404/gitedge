import { describe, expect, it } from "vitest";
import {
  ActorSchema,
  AgentSessionIdentitySchema,
  CreateAgentSessionInputSchema,
  CreatePullRequestInputSchema,
  GitBranchSchema,
  PutCheckRunInputSchema,
  PutWikiPageInputSchema,
  actorForUser,
  readTrustedUser,
  trustedHeaders,
  type TrustedUser,
} from "../../packages/contracts/src/index";

describe("service identity and mutation contracts", () => {
  it("retains the authenticated session actor while discarding body-supplied identity", () => {
    const user: TrustedUser = {
      id: "user-one",
      identifier: "developer",
      groupKey: "free",
      agentSession: {
        id: "session-one",
        agentId: "agent-one",
        agentName: "reviewer",
        repositoryId: "repo-one",
        workspaceName: "session-one",
        permission: "write",
      },
    };
    const request = new Request("https://gitedge.test/repositories/repo-one", {
      headers: trustedHeaders(user),
    });
    const authenticated = readTrustedUser(request);
    expect(authenticated).toEqual(user);
    expect(authenticated && actorForUser(authenticated)).toEqual({
      kind: "agent",
      id: "agent-one",
      name: "reviewer",
      sessionId: "session-one",
    });
    const parsed = PutCheckRunInputSchema.parse({
      name: "review",
      commitOid: "a".repeat(40),
      status: "completed",
      conclusion: "success",
      actor: { kind: "user", name: "forged" },
    });
    expect(parsed).not.toHaveProperty("actor");
  });

  it("fails closed for malformed forwarded agent identity", () => {
    const headers = trustedHeaders({ id: "user-one", identifier: "developer", groupKey: "free" });
    headers.set("X-GitEdge-Agent-Session", "{}");
    expect(readTrustedUser(new Request("https://gitedge.test", { headers }))).toBeNull();
    expect(
      AgentSessionIdentitySchema.safeParse({ id: "session-one", permission: "admin" }).success
    ).toBe(false);
    expect(ActorSchema.safeParse({ kind: "system", id: "system", name: "system" }).success).toBe(
      false
    );
  });

  it("rejects invalid Git branch syntax and incomplete check states", () => {
    for (const name of [
      "../main",
      "refs/heads/.hidden",
      "feature.lock",
      "main@{1}",
      "main?other",
      "main//other",
    ])
      expect(GitBranchSchema.safeParse(name).success).toBe(false);
    expect(
      CreatePullRequestInputSchema.safeParse({
        title: "change",
        baseRef: "main",
        headRef: "feature/topic",
      }).success
    ).toBe(true);
    expect(
      PutCheckRunInputSchema.safeParse({
        name: "check",
        commitOid: "a".repeat(40),
        status: "completed",
        conclusion: null,
      }).success
    ).toBe(false);
    expect(
      PutCheckRunInputSchema.safeParse({
        name: "check",
        commitOid: "a".repeat(40),
        status: "queued",
        conclusion: "success",
      }).success
    ).toBe(false);
  });

  it("bounds session scope and requires valid wiki revision values", () => {
    expect(
      CreateAgentSessionInputSchema.safeParse({ repositoryId: "repo-one", ttlSeconds: 1 }).success
    ).toBe(false);
    expect(
      CreateAgentSessionInputSchema.safeParse({
        repositoryId: "repo-one",
        permission: "write",
        ttlSeconds: 3600,
      }).success
    ).toBe(true);
    expect(
      PutWikiPageInputSchema.safeParse({ title: "Home", content: "text", expectedRevision: -1 })
        .success
    ).toBe(false);
  });
});
