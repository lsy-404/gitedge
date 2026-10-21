import { z } from "zod";
import type { TrustedUser } from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { nextCronTime, nextScheduleTime } from "./cron";
import { queueRunnerRun, type RunnerEnv } from "./runners";
import type { RunnerWorkflow } from "./runner-workflow";

interface ScheduleRow {
  repository_id: string;
  path: string;
  workflow_oid: string;
  crons_json: string;
  next_run_at: number;
}
interface DueSchedule extends ScheduleRow {
  owner_id: string;
  identifier: string;
  group_key: string;
  default_branch: string;
}
export interface ScheduledDefinitions {
  oid: string;
  definitions: RunnerWorkflow[];
}
export type ReadScheduledDefinitions = (
  repositoryId: string,
  branch: string,
  user: TrustedUser
) => Promise<ScheduledDefinitions>;

export async function syncRunnerSchedules(
  env: RunnerEnv,
  repositoryId: string,
  snapshot: ScheduledDefinitions,
  now: number
): Promise<void> {
  const definitions = snapshot.definitions.filter((item) => item.workflow.schedules?.length);
  const paths = definitions.map((item) => item.workflow.path);
  const statements = [
    env.DB.prepare(
      `DELETE FROM actions_runner_schedules WHERE repository_id=?${paths.length ? ` AND path NOT IN (${paths.map(() => "?").join(",")})` : ""}`
    ).bind(repositoryId, ...paths),
    ...definitions.map((definition) => {
      const expressions = definition.workflow.schedules ?? [];
      return env.DB.prepare(
        `INSERT INTO actions_runner_schedules (repository_id,path,workflow_oid,workflow_source,crons_json,next_run_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(repository_id,path) DO UPDATE SET
         workflow_oid=excluded.workflow_oid,workflow_source=excluded.workflow_source,
         next_run_at=CASE WHEN crons_json=excluded.crons_json THEN next_run_at ELSE excluded.next_run_at END,
         crons_json=excluded.crons_json`
      ).bind(
        repositoryId,
        definition.workflow.path,
        snapshot.oid,
        definition.source,
        JSON.stringify(expressions),
        nextScheduleTime(expressions, now)
      );
    }),
  ];
  await env.DB.batch(statements);
}

export async function runDueRunnerSchedules(
  env: RunnerEnv,
  now: number,
  readDefinitions: ReadScheduledDefinitions
): Promise<void> {
  const logger = createLogger(env.LOG_LEVEL, { service: "actions" });
  const due = await env.DB.prepare(
    `SELECT s.*,n.created_by AS owner_id,u.identifier,u.group_key,p.default_branch
     FROM actions_runner_schedules s JOIN repositories p ON p.id=s.repository_id
     JOIN namespaces n ON n.id=p.namespace_id JOIN users u ON u.id=n.created_by
     WHERE s.next_run_at<=? AND p.system_kind='account_runner' AND p.visibility='private'
       AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1
       AND p.actions_runner_enabled=1 AND n.kind='personal' AND u.disabled_at IS NULL
     ORDER BY s.next_run_at,s.repository_id,s.path LIMIT 20`
  )
    .bind(now)
    .all<DueSchedule>();
  const snapshots = new Map<string, ScheduledDefinitions>();
  for (const candidate of due.results) {
    try {
      const user: TrustedUser = {
        id: candidate.owner_id,
        identifier: candidate.identifier,
        groupKey: candidate.group_key,
      };
      let snapshot = snapshots.get(candidate.repository_id);
      if (!snapshot) {
        snapshot = await readDefinitions(candidate.repository_id, candidate.default_branch, user);
        await syncRunnerSchedules(env, candidate.repository_id, snapshot, now);
        snapshots.set(candidate.repository_id, snapshot);
      }
      const schedule = await env.DB.prepare(
        "SELECT * FROM actions_runner_schedules WHERE repository_id=? AND path=? AND next_run_at<=?"
      )
        .bind(candidate.repository_id, candidate.path, now)
        .first<ScheduleRow>();
      if (!schedule) continue;
      const definition = snapshot.definitions.find((item) => item.workflow.path === schedule.path);
      if (!definition?.workflow.schedules?.length) continue;
      const expressions = z.array(z.string()).min(1).max(5).parse(JSON.parse(schedule.crons_json));
      const cron = expressions.find(
        (item) => nextCronTime(item, schedule.next_run_at - 1) === schedule.next_run_at
      );
      if (!cron) throw new Error("Stored cron occurrence is invalid.");
      const result = await queueRunnerRun(
        env,
        candidate.repository_id,
        user,
        candidate.default_branch,
        snapshot.oid,
        definition,
        "schedule",
        {},
        { at: schedule.next_run_at, cron }
      );
      await env.DB.prepare(
        "UPDATE actions_runner_schedules SET next_run_at=? WHERE repository_id=? AND path=? AND next_run_at=? AND workflow_oid=?"
      )
        .bind(
          nextScheduleTime(expressions, now),
          candidate.repository_id,
          schedule.path,
          schedule.next_run_at,
          snapshot.oid
        )
        .run();
      if (!result)
        logger.info("actions:scheduled-run-skipped", {
          repositoryId: candidate.repository_id,
          path: schedule.path,
          reason: "duplicate-or-run-limit",
        });
    } catch (cause) {
      logger.error("actions:scheduled-run-failed", {
        repositoryId: candidate.repository_id,
        path: candidate.path,
        reason: cause instanceof Error ? cause.message : "unknown",
      });
    }
  }
}
