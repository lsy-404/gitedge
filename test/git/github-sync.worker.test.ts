import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { handleGithubGitSync } from "../../workers/git/src/github-sync";
import type { GitEnv } from "../../workers/git/src/access";
import { createPerson, createRepository, migrate, type Person } from "../support/stack";

let owner: Person, repositoryId: string;
beforeAll(async () => {
  await migrate();
  owner = await createPerson("sync-owner");
  repositoryId = await createRepository(owner, "synchronized");
});
afterEach(() => vi.unstubAllGlobals());

it("rechecks synchronization authorization after native fetch and cleans the prepared container on revocation", async () => {
  const id = crypto.randomUUID(),
    lease = crypto.randomUUID(),
    job = crypto.randomUUID(),
    now = Date.now();
  await env.DB.prepare(
    `INSERT INTO forge_github_connections
    (id,repository_id,owner,name,github_repository_id,github_private,created_by,enabled,callback_url,token_ciphertext,token_iv,secret_ciphertext,secret_iv,created_at,lease,lease_expires_at)
    VALUES (?,?,'source-owner','repository',4242,1,?,1,'https://example.test/hook','sealed','iv','sealed','iv',?,?,?)`
  )
    .bind(id, repositoryId, owner.id, now, lease, now + 180_000)
    .run();
  await env.DB.prepare(
    `INSERT INTO forge_github_jobs
    (id,connection_id,direction,event,payload,status,lease,lease_expires_at,next_attempt_at,created_at)
    VALUES (?,?,'outbound','push','{}','running',?,?,?,?)`
  )
    .bind(job, id, lease, now + 180_000, now, now)
    .run();
  const before = "a".repeat(40),
    after = "b".repeat(40);
  let destination = before,
    revoked = false;
  const operations: string[] = [];
  const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, "0") + line;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const oid = url.startsWith("https://github.com/") ? destination : after;
      return new Response(
        pkt("# service=git-upload-pack\n") +
          "0000" +
          pkt(`${oid} refs/heads/main\0multi_ack_detailed side-band-64k\n`) +
          "0000",
        { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } }
      );
    })
  );
  const server = {
    DB: env.DB,
    ARTIFACTS: {
      get: async () => ({
        [Symbol.dispose]() {},
        info: async () => ({ remote: "https://artifacts.example.test/repository.git" }),
        createToken: async () => ({ id: "temporary-token", plaintext: "scoped-fixture" }),
        revokeToken: async () => {
          revoked = true;
        },
      }),
    },
    ACTIONS: {
      fetch: async (request: Request) => {
        const input = (await request.json()) as { operation: string };
        operations.push(input.operation);
        if (input.operation === "prepare")
          await env.DB.prepare("UPDATE forge_github_connections SET enabled=0 WHERE id=?")
            .bind(id)
            .run();
        if (input.operation === "push") destination = after;
        return Response.json({
          data:
            input.operation === "cleanup"
              ? { cleaned: true }
              : { status: input.operation === "prepare" ? "ready" : "synced" },
        });
      },
    },
  } as unknown as GitEnv;
  const response = await handleGithubGitSync(
    new Request("https://git.internal/internal/github-sync", {
      method: "POST",
      body: JSON.stringify({
        connectionId: id,
        jobId: job,
        lease,
        token: "server-only-fixture",
        direction: "outbound",
        ref: "refs/heads/main",
        targetRef: "refs/heads/main",
        before,
        after,
      }),
    }),
    server
  );
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ error: { code: "sync_ineligible" } });
  expect(operations).toEqual(["prepare", "cleanup"]);
  expect(destination).toBe(before);
  expect(revoked).toBe(true);
});
