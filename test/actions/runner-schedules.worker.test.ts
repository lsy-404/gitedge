import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createPerson, migrate } from "../support/stack";
import { parseRunnerWorkflow } from "../../workers/actions/src/runner-workflow";
import {
  runDueRunnerSchedules,
  syncRunnerSchedules,
  type ScheduledDefinitions,
} from "../../workers/actions/src/runner-schedules";
import type { RunnerEnv } from "../../workers/actions/src/runners";

const runtime: RunnerEnv = {
  DB: env.DB,
  FORGE: { fetch: async () => Response.json({ data: {} }) },
  LOG_LEVEL: "error",
};
const now = Date.parse("2026-10-21T23:00:00Z");
let snapshot: ScheduledDefinitions;
beforeAll(async () => {
  await migrate();
  snapshot = {
    oid: "a".repeat(40),
    definitions: [
      parseRunnerWorkflow(
        ".github/workflows/service.yml",
        `name: Scheduled service
on:
  schedule:
    - cron: '0 * * * *'
jobs:
  task:
    runs-on: [self-hosted]
    timeout-minutes: 5
    steps:
      - run: echo ready
`
      ),
    ],
  };
});
let sequence = 0;

async function repository(): Promise<string> {
  const person = await createPerson(`scheduled-owner-${++sequence}`);
  const namespace = await env.DB.prepare(
    "SELECT id FROM namespaces WHERE created_by=? AND kind='personal'"
  )
    .bind(person.id)
    .first<{ id: string }>();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO repositories
    (id,namespace_id,created_by,slug,do_name,visibility,description,default_branch,actions_enabled,actions_runner_enabled,system_kind,created_at,updated_at)
    VALUES (?,?,?,'runner',?,'private','','main',1,1,'account_runner',?,?)`
  )
    .bind(id, namespace!.id, person.id, `repo:${id}`, now, now)
    .run();
  await syncRunnerSchedules(runtime, id, snapshot, now - 60_000);
  return id;
}

async function runs(id: string) {
  return (
    await env.DB.prepare(
      "SELECT id,commit_oid,trigger_kind,scheduled_at FROM actions_runs WHERE repository_id=?"
    )
      .bind(id)
      .all()
  ).results;
}

describe("Runner schedule queue", () => {
  it("deduplicates concurrent ticks and binds the queued job to its UTC occurrence", async () => {
    const id = await repository();
    const read = vi.fn(async () => snapshot);
    await Promise.all([
      runDueRunnerSchedules(runtime, now, read),
      runDueRunnerSchedules(runtime, now, read),
    ]);
    expect(await runs(id)).toEqual([
      expect.objectContaining({
        commit_oid: snapshot.oid,
        trigger_kind: "schedule",
        scheduled_at: now,
      }),
    ]);
    const job = await env.DB.prepare(
      "SELECT event_json FROM actions_runner_runs WHERE run_id IN (SELECT id FROM actions_runs WHERE repository_id=?)"
    )
      .bind(id)
      .first<{ event_json: string }>();
    expect(JSON.parse(job!.event_json).schedule).toBe("0 * * * *");
  });
  it("removes deleted schedules without running an old definition", async () => {
    const id = await repository();
    await runDueRunnerSchedules(runtime, now, async () => ({
      oid: "b".repeat(40),
      definitions: [],
    }));
    expect(await runs(id)).toEqual([]);
    expect(
      await env.DB.prepare("SELECT 1 FROM actions_runner_schedules WHERE repository_id=?")
        .bind(id)
        .first()
    ).toBeNull();
  });
  it("uses the latest approved default-branch definition and coalesces missed intervals", async () => {
    const id = await repository();
    const fresh = { ...snapshot, oid: "b".repeat(40) };
    await runDueRunnerSchedules(runtime, now + 5 * 3_600_000, async () => fresh);
    expect(await runs(id)).toEqual([
      expect.objectContaining({ commit_oid: fresh.oid, scheduled_at: now }),
    ]);
    const schedule = await env.DB.prepare(
      "SELECT next_run_at FROM actions_runner_schedules WHERE repository_id=?"
    )
      .bind(id)
      .first<{ next_run_at: number }>();
    expect(schedule!.next_run_at).toBe(now + 6 * 3_600_000);
  });
  it("does not enqueue when repository execution is disabled", async () => {
    const id = await repository();
    await env.DB.prepare("UPDATE repositories SET actions_enabled=0 WHERE id=?").bind(id).run();
    const read = vi.fn(async () => snapshot);
    await runDueRunnerSchedules(runtime, now, read);
    expect(await runs(id)).toEqual([]);
  });
});
