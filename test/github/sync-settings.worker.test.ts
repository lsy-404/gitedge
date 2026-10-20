import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { createPerson, createRepository, forgeCall, migrate } from "../support/stack";

beforeAll(migrate);

it("retries a failed push job whose URL-encoded ID includes a ref path and percent sign", async () => {
  const owner = await createPerson("sync-settings-owner");
  const repositoryId = await createRepository(owner, "synchronized");
  const connectionId = crypto.randomUUID();
  const jobId = `push:${crypto.randomUUID()}:refs/heads/feature/100%`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO forge_github_connections
    (id,repository_id,owner,name,github_repository_id,github_private,created_by,enabled,callback_url,token_ciphertext,token_iv,secret_ciphertext,secret_iv,created_at)
    VALUES (?,?,'source-owner','repository',4242,1,?,1,'https://example.test/hook','sealed','iv','sealed','iv',?)`
  )
    .bind(connectionId, repositoryId, owner.id, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO forge_github_jobs
    (id,connection_id,direction,event,payload,status,attempts,error_code,next_attempt_at,created_at,completed_at)
    VALUES (?,?,'outbound','push','{}','failed',5,'service_unavailable',?,?,?)`
  )
    .bind(jobId, connectionId, now, now, now)
    .run();

  const response = await forgeCall(
    owner,
    `/repositories/${repositoryId}/github-sync/jobs/${encodeURIComponent(jobId)}/retry`,
    "POST"
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: { jobs: [{ id: jobId, status: "pending", attempts: 0, errorCode: null }] },
  });
  await expect(
    env.DB.prepare(
      "SELECT status,attempts,error_code,completed_at FROM forge_github_jobs WHERE id=?"
    )
      .bind(jobId)
      .first()
  ).resolves.toMatchObject({
    status: "pending",
    attempts: 0,
    error_code: null,
    completed_at: null,
  });
});
