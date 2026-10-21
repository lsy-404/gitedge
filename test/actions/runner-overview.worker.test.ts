import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { TrustedUser } from "../../packages/contracts/src/index";
import {
  handleRunnerHistory,
  handleRunnerOverview,
} from "../../workers/actions/src/runner-overview";
import { createPerson, createRepository, migrate, type Person } from "../support/stack";

let owner: Person;
let stranger: Person;
let repositoryId: string;
let runnerId: string;
let namespaceId: string;

beforeAll(async () => {
  await migrate();
  owner = await createPerson("runner-dashboard-owner");
  stranger = await createPerson("runner-dashboard-stranger");
  repositoryId = await createRepository(owner, "runner-dashboard-repo");
  namespaceId = (await env.DB.prepare("SELECT namespace_id FROM repositories WHERE id=?")
    .bind(repositoryId)
    .first<{ namespace_id: string }>())!.namespace_id;
  runnerId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO actions_runners
      (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      runnerId,
      "overview-runner",
      namespaceId,
      repositoryId,
      owner.id,
      '["linux","x64"]',
      `hash-${runnerId}`,
      Date.now(),
      Date.now()
    )
    .run();
});

function trusted(person: Person): TrustedUser {
  return { id: person.id, identifier: person.identifier, groupKey: person.groupKey };
}

function url(path: string): Request {
  return new Request(`https://actions.internal${path}`);
}

describe("runner overview and history", () => {
  it("rejects jobs, agents, and non-admin personal access tokens", async () => {
    const jobUser = {
      ...trusted(owner),
      token: { id: "token", scopes: ["admin"] as const },
      job: { runId: "run-1", repositoryId, commitOid: "a".repeat(40) },
    };
    const agentUser = {
      ...trusted(owner),
      agentSession: {
        id: "session",
        agentId: "agent",
        agentName: "helper",
        repositoryId,
        workspaceName: "main",
        permission: "read" as const,
      },
    };
    const readToken = { ...trusted(owner), token: { id: "token", scopes: ["repo:read"] as const } };
    for (const user of [jobUser, agentUser, readToken]) {
      const response = await handleRunnerOverview(
        user,
        { DB: env.DB },
        url("/api/actions/runners/overview")
      );
      expect(response.status).toBe(403);
    }
  });

  it("only returns runners and queue data visible to the owner", async () => {
    const otherRepository = await createRepository(stranger, "private-queue");
    const otherNamespace = (await env.DB.prepare("SELECT namespace_id FROM repositories WHERE id=?")
      .bind(otherRepository)
      .first<{ namespace_id: string }>())!.namespace_id;
    const otherRunner = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
      VALUES (?,?,?,NULL,?,?,?,?)`
    )
      .bind(
        otherRunner,
        "other-runner",
        otherNamespace,
        stranger.id,
        '["linux","x64"]',
        `hash-${otherRunner}`,
        Date.now()
      )
      .run();
    const otherRun = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO actions_runs (id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?)`
    )
      .bind(
        otherRun,
        otherRepository,
        "b".repeat(40),
        "Private",
        ".github/workflows/private.yml",
        "main",
        stranger.id,
        Date.now()
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO actions_runner_runs (run_id,workflow_source,labels_json,permission,timeout_minutes,event_json,status)
      VALUES (?,?,?,?,?,?, 'queued')`
    )
      .bind(otherRun, "github", '["linux"]', "read", 30, "{}")
      .run();

    const response = await handleRunnerOverview(
      trusted(owner),
      { DB: env.DB },
      url("/api/actions/runners/overview")
    );
    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as {
      data: { runners: Array<{ id: string }>; queue: Array<{ id: string; repository: string }> };
    };
    expect(body.data.runners.map((runner) => runner.id)).toEqual([runnerId]);
    expect(body.data.queue.some((job) => job.repository.includes("private-queue"))).toBe(false);
  });

  it("uses a composite cursor to retain rows that share the same start time", async () => {
    const startedAt = Date.now() - 5000;
    const runIds: string[] = [];
    for (let index = 0; index < 56; index += 1) {
      const runId = crypto.randomUUID();
      runIds.push(runId);
      await env.DB.prepare(
        `INSERT INTO actions_runs (id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?)`
      )
        .bind(
          runId,
          repositoryId,
          "c".repeat(40),
          `History ${index}`,
          ".github/workflows/history.yml",
          "main",
          owner.id,
          startedAt
        )
        .run();
      await env.DB.prepare(
        `INSERT INTO actions_runner_runs (run_id,workflow_source,labels_json,permission,timeout_minutes,event_json,status,
          conclusion,runner_id,started_at,completed_at) VALUES (?,?,?,?,?,?, 'completed','success',?,?,?)`
      )
        .bind(
          runId,
          "github",
          '["linux","x64"]',
          "read",
          30,
          "{}",
          runnerId,
          startedAt,
          startedAt + 1000
        )
        .run();
    }
    const firstResponse = await handleRunnerHistory(
      trusted(owner),
      { DB: env.DB },
      url(`/api/actions/runners/history?runner=${runnerId}&limit=50`)
    );
    const first = (await firstResponse.json()) as {
      data: { items: Array<{ id: string }>; nextBefore: string | null };
    };
    expect(first.data.items).toHaveLength(50);
    expect(first.data.nextBefore).toEqual(expect.any(String));
    const nextUrl = `/api/actions/runners/history?runner=${runnerId}&limit=50&before=${encodeURIComponent(first.data.nextBefore!)}`;
    const secondResponse = await handleRunnerHistory(trusted(owner), { DB: env.DB }, url(nextUrl));
    const second = (await secondResponse.json()) as {
      data: { items: Array<{ id: string }>; nextBefore: string | null };
    };
    expect(second.data.items).toHaveLength(6);
    const all = [...first.data.items, ...second.data.items].map((item) => item.id);
    expect(new Set(all).size).toBe(56);
    expect(all.sort()).toEqual([...runIds].sort());
  });

  it("reports the runner limit honestly while keeping overview queries within D1 bind limits", async () => {
    const rows = await env.DB.prepare("SELECT id FROM actions_runners WHERE namespace_id=?")
      .bind(namespaceId)
      .all<{ id: string }>();
    for (let index = rows.results.length; index < 101; index += 1) {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
        VALUES (?, ?, ?, NULL, ?, ' ["linux","x64"]', ?, ?)`
      )
        .bind(id, `runner-${index}`, namespaceId, owner.id, `hash-${id}`, Date.now() + index)
        .run();
    }
    const response = await handleRunnerOverview(
      trusted(owner),
      { DB: env.DB },
      url("/api/actions/runners/overview")
    );
    const body = (await response.json()) as {
      data: { runners: Array<{ id: string }>; truncated: boolean };
    };
    expect(body.data.runners).toHaveLength(100);
    expect(body.data.truncated).toBe(true);
  });

  it("shows owned queued jobs even before a runner has been registered", async () => {
    const ownerWithoutRunner = await createPerson("runner-dashboard-no-runner");
    const repo = await createRepository(ownerWithoutRunner, "waiting-repo");
    const runId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO actions_runs (id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?)`
    )
      .bind(
        runId,
        repo,
        "d".repeat(40),
        "Waiting",
        ".github/workflows/waiting.yml",
        "main",
        ownerWithoutRunner.id,
        Date.now()
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO actions_runner_runs (run_id,workflow_source,labels_json,permission,timeout_minutes,event_json,status)
      VALUES (?,?,?,?,?,?, 'queued')`
    )
      .bind(runId, "github", '["linux","need-mem-4g"]', "read", 30, "{}")
      .run();

    const response = await handleRunnerOverview(
      trusted(ownerWithoutRunner),
      { DB: env.DB },
      url("/api/actions/runners/overview")
    );
    const body = (await response.json()) as {
      data: {
        runners: unknown[];
        queue: Array<{ id: string; blockedBy: Record<string, string[]> }>;
      };
    };
    expect(body.data.runners).toHaveLength(0);
    expect(body.data.queue).toEqual([expect.objectContaining({ id: runId, blockedBy: {} })]);
  });
});
