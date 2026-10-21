import { localExecutionMinutes } from "./runner-capacity.mjs";

export function createGitEdgeExecutionArgs({
  runnerScript,
  profile,
  run,
  workflowFile,
  actionsState,
  jobClaim,
  demandLabels,
  eventPayloadFile,
}) {
  const args = [
    runnerScript,
    "run",
    "--origin",
    profile.origin,
    "--repository",
    run.repository,
    "--workflow",
    workflowFile,
    "--runner-path",
    profile.runnerPath,
    "--sha",
    run.sha,
    "--ref",
    run.ref,
    "--event",
    run.event,
    "--timeout-minutes",
    String(localExecutionMinutes(jobClaim, run.timeoutMinutes)),
    "--state-dir",
    actionsState,
  ];
  const labels = new Map();
  for (const label of [...profile.labels, ...demandLabels]) {
    const key = label.toLowerCase();
    if (!labels.has(key)) labels.set(key, label);
  }
  for (const label of labels.values()) args.push("--label", label);
  if (eventPayloadFile) args.push("--event-file", eventPayloadFile);
  return args;
}
