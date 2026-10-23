import { parseJobClaim, matchesLabels } from "../packages/contracts/runner-scheduling.mjs";
import { localExecutionMinutes } from "./runner-capacity.mjs";

export function runnerProfileForClaim(profile, claim) {
  const labels = claim?.runnerLabels;
  if (
    !Array.isArray(labels) ||
    labels.length < 1 ||
    labels.length > 40 ||
    labels.some(
      (label) =>
        typeof label !== "string" ||
        label.trim() !== label ||
        label.length < 1 ||
        label.length > 100 ||
        !/^[A-Za-z0-9_. -]+$/.test(label)
    ) ||
    new Set(labels.map((label) => label.toLowerCase())).size !== labels.length
  )
    throw new Error("GitEdge returned an invalid runner label snapshot.");
  return { ...profile, labels: [...labels] };
}

export function runnerJobMatches(labels, profileLabels, hostLabels) {
  const claim = parseJobClaim(labels);
  const available = new Set([...hostLabels, ...profileLabels].map((label) => label.toLowerCase()));
  return (
    claim.valid &&
    claim.labels.includes("self-hosted") &&
    matchesLabels(claim.labels, [...available])
  );
}

export function runnerLabelsForJit(profileLabels, hostLabels) {
  const labels = new Map();
  for (const label of [...hostLabels, ...profileLabels]) {
    const key = label.toLowerCase();
    if (!labels.has(key)) labels.set(key, label);
  }
  return [...labels.values()];
}

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
