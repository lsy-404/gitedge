import type { ActionRun as ActionRunDetails } from "../../../packages/contracts/src/actions";
import { createLogger } from "../../../src/worker/common/logger";

interface ActionCheckEnv {
  DB: D1Database;
  FORGE: Fetcher;
  LOG_LEVEL?: string;
}

export async function deliverCheck(
  env: ActionCheckEnv,
  runId: string,
  repositoryId: string,
  status: "queued" | "in_progress" | "completed",
  conclusion: "success" | "failure" | "cancelled" | null,
  summary: string,
  now = Date.now()
): Promise<boolean> {
  const logger = createLogger(env.LOG_LEVEL, {
    service: "actions",
    repoId: repositoryId,
    doId: runId,
  });
  let delivered = false;
  try {
    const response = await env.FORGE.fetch(
      new Request("https://forge.internal/internal/actions-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, status, conclusion, summary }),
      })
    );
    delivered = response.ok;
    if (!response.ok)
      logger.warn("actions:check-delivery-rejected", { statusCode: response.status });
  } catch (cause) {
    logger.warn("actions:check-delivery-failed", {
      reason: cause instanceof Error ? cause.message : "unknown",
    });
  }
  try {
    await env.DB.prepare(
      "UPDATE actions_runs SET check_last_attempt_at = ?, check_status = CASE WHEN ? = 1 THEN ? ELSE check_status END, check_conclusion = CASE WHEN ? = 1 THEN ? ELSE check_conclusion END, check_published_at = CASE WHEN ? = 1 AND ? = 'completed' THEN COALESCE(check_published_at, ?) ELSE check_published_at END WHERE id = ?"
    )
      .bind(
        now,
        delivered ? 1 : 0,
        status,
        delivered ? 1 : 0,
        conclusion,
        delivered ? 1 : 0,
        status,
        now,
        runId
      )
      .run();
  } catch (cause) {
    logger.warn("actions:check-outbox-update-failed", {
      reason: cause instanceof Error ? cause.message : "unknown",
    });
  }
  return delivered;
}

export async function publishCheck(
  env: ActionCheckEnv,
  run: ActionRunDetails,
  now = Date.now()
): Promise<boolean> {
  const status =
    run.status === "completed" ? "completed" : run.status === "running" ? "in_progress" : "queued";
  const conclusion = status !== "completed" ? null : run.conclusion;
  const failed = run.jobs.flatMap((job) =>
    job.steps
      .filter((step) => step.conclusion === "failure")
      .map((step) => `${job.name} / ${step.name}`)
  );
  const summary =
    run.status === "completed"
      ? `${run.workflowName}: ${run.conclusion ?? "completed"}.${failed.length ? ` Failed: ${failed.join(", ")}.` : ""}${run.outputTruncated ? " Output was truncated at 16 KiB." : ""}`
      : `${run.workflowName} is ${run.status}.`;
  return deliverCheck(env, run.id, run.repositoryId, status, conclusion, summary, now);
}
