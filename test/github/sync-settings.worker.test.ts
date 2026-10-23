import { env } from "cloudflare:workers";
import { z } from "zod";
import { beforeAll, expect, it } from "vitest";
import { githubLastSyncedRef } from "../../workers/forge/src/github-sync-store";
import {
  enqueueGithubRefReconciliation,
  purgeGithubSyncJobs,
} from "../../workers/forge/src/github-sync";
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

it("retains the last successful ref state after completed job cleanup", async () => {
  const owner = await createPerson("sync-ref-history-owner");
  const repositoryId = await createRepository(owner, "ref-history");
  const connectionId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO forge_github_connections
    (id,repository_id,owner,name,github_repository_id,github_private,created_by,enabled,callback_url,token_ciphertext,token_iv,secret_ciphertext,secret_iv,created_at)
    VALUES (?,?,'source-owner','repository',4243,1,?,1,'https://example.test/hook','sealed','iv','sealed','iv',?)`
  )
    .bind(connectionId, repositoryId, owner.id, now)
    .run();
  const old = now - 31 * 86_400_000;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO forge_github_jobs (id,connection_id,direction,event,payload,status,next_attempt_at,created_at,completed_at) VALUES (?,?,'outbound','push',?,'success',?,?,?)"
    ).bind(
      "sync-ref-history-old",
      connectionId,
      JSON.stringify({ ref: "refs/heads/main", after: "a".repeat(40) }),
      old,
      old,
      old
    ),
    env.DB.prepare(
      "INSERT INTO forge_github_jobs (id,connection_id,direction,event,payload,status,next_attempt_at,created_at,completed_at) VALUES (?,?,'inbound','push',?,'success',?,?,?)"
    ).bind(
      "sync-ref-history-new",
      connectionId,
      JSON.stringify({ ref: "refs/heads/main", after: "b".repeat(40) }),
      old + 1,
      old + 1,
      old + 1
    ),
  ]);

  await purgeGithubSyncJobs(env);

  await expect(githubLastSyncedRef(env.DB, connectionId, "refs/heads/main")).resolves.toEqual({
    oid: "b".repeat(40),
  });
  await expect(
    env.DB.prepare("SELECT id FROM forge_github_jobs WHERE id='sync-ref-history-old'").first()
  ).resolves.toBeNull();
});

it("records a matching ref baseline and reconciles later deletions without resurrection", async () => {
  const owner = await createPerson("sync-ref-reconcile-owner");
  const repositoryId = await createRepository(owner, "ref-reconcile");
  const connectionId = crypto.randomUUID();
  const now = Date.now();
  const main = "refs/heads/main";
  const localOnly = "refs/heads/local-only";
  const tag = "refs/tags/v1";
  const mainOid = "a".repeat(40);
  const localOnlyOid = "c".repeat(40);
  const tagOid = "b".repeat(40);
  await env.DB.prepare(
    `INSERT INTO forge_github_connections
    (id,repository_id,owner,name,github_repository_id,github_private,created_by,enabled,callback_url,token_ciphertext,token_iv,secret_ciphertext,secret_iv,created_at)
    VALUES (?,?,'source-owner','repository',4244,1,?,1,'https://example.test/hook','sealed','iv','sealed','iv',?)`
  )
    .bind(connectionId, repositoryId, owner.id, now)
    .run();

  await enqueueGithubRefReconciliation(
    env.DB,
    connectionId,
    [
      { ref: main, oid: mainOid },
      { ref: localOnly, oid: localOnlyOid },
      { ref: tag, oid: tagOid },
    ],
    [
      { ref: main, oid: mainOid },
      { ref: tag, oid: tagOid },
      { ref: "refs/heads/gitedge/pr/7", oid: "d".repeat(40) },
    ]
  );
  const checkpoints = await env.DB.prepare(
    "SELECT direction,payload FROM forge_github_jobs WHERE connection_id=? AND event='push' ORDER BY created_at"
  )
    .bind(connectionId)
    .all<{ direction: string; payload: string }>();
  expect(checkpoints.results).toHaveLength(3);
  const checkpointPlans = checkpoints.results.map((job) => ({
    direction: job.direction,
    payload: z
      .object({ ref: z.string(), before: z.string().nullable(), after: z.string() })
      .parse(JSON.parse(job.payload)),
  }));
  expect(checkpointPlans).toEqual(
    expect.arrayContaining([
      { direction: "outbound", payload: { ref: main, before: mainOid, after: mainOid } },
      {
        direction: "outbound",
        payload: { ref: localOnly, before: "0".repeat(40), after: localOnlyOid },
      },
      { direction: "outbound", payload: { ref: tag, before: tagOid, after: tagOid } },
    ])
  );
  await env.DB.prepare(
    "UPDATE forge_github_jobs SET status='success',completed_at=? WHERE connection_id=? AND event='push'"
  )
    .bind(now + 1, connectionId)
    .run();

  await enqueueGithubRefReconciliation(env.DB, connectionId, [{ ref: main, oid: mainOid }], []);
  const remoteDeletion = await env.DB.prepare(
    "SELECT direction,event,payload FROM forge_github_jobs WHERE connection_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1"
  )
    .bind(connectionId)
    .first<{ direction: string; event: string; payload: string }>();
  expect(remoteDeletion).not.toBeNull();
  expect(remoteDeletion).toMatchObject({ direction: "inbound", event: "push" });
  expect(JSON.parse(remoteDeletion?.payload ?? "{}")).toEqual({
    ref: main,
    before: mainOid,
    after: "0".repeat(40),
  });

  await enqueueGithubRefReconciliation(
    env.DB,
    connectionId,
    [{ ref: main, oid: "c".repeat(40) }],
    []
  );
  const concurrentDeletion = await env.DB.prepare(
    "SELECT direction,event,payload FROM forge_github_jobs WHERE connection_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1"
  )
    .bind(connectionId)
    .first<{ direction: string; event: string; payload: string }>();
  expect(concurrentDeletion).not.toBeNull();
  expect(concurrentDeletion).toMatchObject({ direction: "inbound", event: "ref_conflict" });
  expect(JSON.parse(concurrentDeletion?.payload ?? "{}")).toEqual({ ref: main });

  await enqueueGithubRefReconciliation(env.DB, connectionId, [], [{ ref: tag, oid: tagOid }]);
  const localDeletion = await env.DB.prepare(
    "SELECT direction,event,payload FROM forge_github_jobs WHERE connection_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1"
  )
    .bind(connectionId)
    .first<{ direction: string; event: string; payload: string }>();
  expect(localDeletion).not.toBeNull();
  expect(localDeletion).toMatchObject({ direction: "outbound", event: "push" });
  expect(JSON.parse(localDeletion?.payload ?? "{}")).toEqual({
    ref: tag,
    before: tagOid,
    after: "0".repeat(40),
  });
});
