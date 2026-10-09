import { describe, expect, it } from "vitest";
import { PushEventInputSchema } from "../../packages/contracts/src/index";
import type { GitEnv } from "../../workers/git/src/access";
import { reportPushEvent } from "../../workers/git/src/events";

const user = { id: "u1", identifier: "alice", groupKey: "free" };
const update = { ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40) };

function environment(status = 200): { env: GitEnv; calls: Request[] } {
  const calls: Request[] = [];
  const env: GitEnv = {
    DB: {} as D1Database,
    ARTIFACTS: {} as Artifacts,
    FORGE: {
      async fetch(request: Request) {
        calls.push(request);
        return new Response(null, { status });
      },
    },
  };
  return { env, calls };
}

describe("push event reporting", () => {
  it("posts the updates to the internal Forge endpoint", async () => {
    const { env, calls } = environment();
    await reportPushEvent(env, "repo-1", user, [update]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://forge.internal/internal/push-event");
    const body = PushEventInputSchema.parse(await calls[0].json());
    expect(body).toEqual({ repositoryId: "repo-1", pusherId: "u1", updates: [update] });
  });

  it("skips agent sessions, empty updates and a missing Forge binding", async () => {
    const { env, calls } = environment();
    await reportPushEvent(
      env,
      "repo-1",
      {
        ...user,
        agentSession: {
          id: "s",
          agentId: "a",
          agentName: "bot",
          repositoryId: "repo-1",
          workspaceName: "w",
          permission: "write",
        },
      },
      [update]
    );
    await reportPushEvent(env, "repo-1", user, []);
    await reportPushEvent({ ...env, FORGE: undefined }, "repo-1", user, [update]);
    expect(calls).toEqual([]);
  });

  it("does not throw when Forge rejects or fails", async () => {
    await expect(
      reportPushEvent(environment(500).env, "repo-1", user, [update])
    ).resolves.toBeUndefined();
    const failing: GitEnv = {
      ...environment().env,
      FORGE: {
        async fetch() {
          throw new Error("unreachable");
        },
      },
    };
    await expect(reportPushEvent(failing, "repo-1", user, [update])).resolves.toBeUndefined();
  });
});
