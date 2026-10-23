import { readFile } from "node:fs/promises";
import { parseDocument, stringify } from "yaml";

export function createSigningWorkflow(
  source,
  { platform, clientPath, contextFile, outputParent, receiptFile, timeoutMinutes }
) {
  const normalizedSource = normalizeSigningWorkflowTimeout(source, timeoutMinutes);
  const document = parseDocument(normalizedSource, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (document.errors.length) throw new Error("The approved signing workflow is invalid YAML.");
  const workflow = document.toJS({ maxAliasCount: 0 });
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs) || Object.keys(jobs).length !== 1)
    throw new Error("Signing workflows must contain exactly one job.");
  const [jobId, job] = Object.entries(jobs)[0];
  if (
    !job ||
    typeof job !== "object" ||
    Array.isArray(job) ||
    (job.strategy !== undefined &&
      (typeof job.strategy !== "object" ||
        job.strategy === null ||
        Array.isArray(job.strategy) ||
        job.strategy.matrix !== undefined))
  )
    throw new Error("Signing workflows cannot use matrix jobs.");
  if (job.if !== undefined)
    throw new Error("Signing workflow jobs cannot be conditionally skipped.");
  const shell = platform === "windows" ? "pwsh" : "bash";
  const command =
    platform === "windows"
      ? "& $env:GITEDGE_SIGNING_NODE $env:GITEDGE_SIGNING_CLIENT execute --context-file $env:GITEDGE_SIGNING_CONTEXT_FILE --output-parent $env:GITEDGE_SIGNING_OUTPUT_PARENT --receipt-file $env:GITEDGE_SIGNING_RECEIPT_FILE"
      : '"$GITEDGE_SIGNING_NODE" "$GITEDGE_SIGNING_CLIENT" execute --context-file "$GITEDGE_SIGNING_CONTEXT_FILE" --output-parent "$GITEDGE_SIGNING_OUTPUT_PARENT" --receipt-file "$GITEDGE_SIGNING_RECEIPT_FILE"';
  const steps = job.steps;
  if (!Array.isArray(steps) || steps.length >= 128)
    throw new Error("Signing workflow has no space for its trusted SDK step.");
  steps.push({
    name: "GitEdge native signing",
    shell,
    env: {
      GITEDGE_SIGNING_NODE: process.execPath,
      GITEDGE_SIGNING_CLIENT: clientPath,
      GITEDGE_SIGNING_CONTEXT_FILE: contextFile,
      GITEDGE_SIGNING_OUTPUT_PARENT: outputParent,
      GITEDGE_SIGNING_RECEIPT_FILE: receiptFile,
    },
    run: command,
  });
  jobs[jobId] = job;
  return stringify(workflow);
}

export function normalizeSigningWorkflowTimeout(source, timeoutMinutes) {
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 360)
    throw new Error("Signing workflow timeout is invalid.");
  const document = parseDocument(source, { schema: "core", uniqueKeys: true, strict: true });
  if (document.errors.length) throw new Error("The approved signing workflow is invalid YAML.");
  const workflow = document.toJS({ maxAliasCount: 0 });
  if (!workflow?.jobs || typeof workflow.jobs !== "object")
    throw new Error("The approved signing workflow has no job.");
  for (const job of Object.values(workflow.jobs)) {
    if (!job || typeof job !== "object") continue;
    const requested = typeof job["runs-on"] === "string" ? [job["runs-on"]] : job["runs-on"];
    if (Array.isArray(requested) && requested.every((label) => typeof label === "string")) {
      const labels = requested.filter((label) => {
        const match = /^need-time-(\d+)m$/i.exec(label);
        if (!match) return true;
        const minutes = Number(match[1]);
        return !Number.isInteger(minutes) || minutes < 1 || minutes > 360;
      });
      labels.push(`need-time-${timeoutMinutes}m`);
      job["runs-on"] = labels;
    }
    job["timeout-minutes"] = timeoutMinutes;
  }
  return stringify(workflow);
}

export async function readSigningReceipt(receiptFile, requestId) {
  const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  if (
    receipt?.requestId !== requestId ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.outputDigest ?? "") ||
    !Number.isSafeInteger(receipt.outputSize) ||
    receipt.outputSize < 1
  )
    throw new Error("The trusted signing step did not leave a valid completion receipt.");
  return receipt;
}
