import { localExecutionMinutes } from "./runner-capacity.mjs";

export function createGitEdgeExecutionArgs({
  runnerScript,
  profile,
  run,
  workflowFile,
  actionsState,
  jobClaim,
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
  for (const label of profile.labels) args.push("--label", label);
  if (eventPayloadFile) args.push("--event-file", eventPayloadFile);
  return args;
}
