import { isAlias, isMap, isSeq, parseDocument } from "yaml";
import {
  ActionWorkflowSchema,
  type ActionJob,
  type ActionStep,
  type ActionWorkflow,
} from "../../../packages/contracts/src/actions";

export class WorkflowValidationError extends Error {}

const MAX_WORKFLOW_BYTES = 64 * 1024;
const ALLOWED_WORKFLOW_KEYS = new Set(["name", "on", "jobs"]);
const ALLOWED_JOB_KEYS = new Set(["name", "steps"]);
const ALLOWED_STEP_KEYS = new Set(["name", "run", "shell", "working-directory", "env"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new WorkflowValidationError(`${label} must be a mapping.`);
  }
  return value;
}

function assertKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new WorkflowValidationError(`${label} key "${key}" is unsupported.`);
  }
}

function literalString(value: unknown, label: string, max = 16_384): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new WorkflowValidationError(
      `${label} must be a non-empty string of at most ${max} characters.`
    );
  }
  if (value.includes("${{")) throw new WorkflowValidationError(`${label} cannot use expressions.`);
  if (value.includes("\0"))
    throw new WorkflowValidationError(`${label} cannot contain null characters.`);
  return value;
}

function parseWorkingDirectory(value: unknown, label: string): string | null {
  const path = literalString(value, label, 256);
  if (path === ".") return null;
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new WorkflowValidationError(`${label} must be a safe path inside the workspace.`);
  }
  return path;
}

function rejectAliases(node: unknown): void {
  if (isAlias(node)) throw new WorkflowValidationError("YAML aliases are unsupported.");
  if (isMap(node)) {
    for (const pair of node.items) {
      rejectAliases(pair.key);
      rejectAliases(pair.value);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) rejectAliases(item);
  }
}

function parseTriggers(value: unknown): Array<"workflow_dispatch" | "push"> {
  const triggers = record(value, "on");
  const keys = Object.keys(triggers);
  if (keys.length === 0 || keys.some((key) => key !== "workflow_dispatch" && key !== "push")) {
    throw new WorkflowValidationError("Only workflow_dispatch and push triggers are supported.");
  }
  for (const key of keys) {
    const config = triggers[key];
    if (config === null) continue;
    if (Object.keys(record(config, `on.${key}`)).length !== 0) {
      throw new WorkflowValidationError(`on.${key} filters and options are unsupported.`);
    }
  }
  const supported: Array<"workflow_dispatch" | "push"> = [];
  for (const key of keys) {
    if (key === "workflow_dispatch" || key === "push") supported.push(key);
  }
  return supported;
}

function parseStep(value: unknown, index: number): ActionStep {
  const raw = record(value, `jobs step ${index + 1}`);
  assertKeys(raw, ALLOWED_STEP_KEYS, `jobs step ${index + 1}`);
  const run = literalString(raw.run, `jobs step ${index + 1}.run`);
  const name =
    raw.name === undefined ? `Step ${index + 1}` : literalString(raw.name, "step.name", 100);
  const shell = raw.shell === undefined ? "sh" : raw.shell;
  if (shell !== "sh" && shell !== "bash") {
    throw new WorkflowValidationError(`Step "${name}" shell must be sh or bash.`);
  }
  const workingDirectory =
    raw["working-directory"] === undefined
      ? null
      : parseWorkingDirectory(raw["working-directory"], `Step "${name}" working-directory`);
  const env = raw.env === undefined ? {} : record(raw.env, `Step "${name}" env`);
  const literalEnv: Record<string, string> = {};
  for (const [key, entry] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new WorkflowValidationError(`Step "${name}" has an invalid environment variable name.`);
    }
    literalEnv[key] = literalString(entry, `Step "${name}" env.${key}`, 4096);
  }
  return { name, run, shell, workingDirectory, env: literalEnv };
}

function parseJob(id: string, value: unknown): ActionJob {
  const raw = record(value, `job "${id}"`);
  assertKeys(raw, ALLOWED_JOB_KEYS, `job "${id}"`);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
    throw new WorkflowValidationError(`Job id "${id}" is invalid.`);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > 10) {
    throw new WorkflowValidationError(`Job "${id}" must contain between 1 and 10 steps.`);
  }
  const name = raw.name === undefined ? id : literalString(raw.name, `job "${id}" name`, 100);
  return { id, name, steps: raw.steps.map(parseStep) };
}

export function parseWorkflow(path: string, source: string): ActionWorkflow {
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.(?:yml|yaml)$/.test(path)) {
    throw new WorkflowValidationError("Workflow files must be directly inside .github/workflows.");
  }
  if (new TextEncoder().encode(source).byteLength > MAX_WORKFLOW_BYTES) {
    throw new WorkflowValidationError("Workflow file exceeds 64 KiB.");
  }
  let parsed: unknown;
  try {
    const document = parseDocument(source, { schema: "core", uniqueKeys: true, strict: true });
    if (document.errors.length > 0) throw new WorkflowValidationError("Workflow YAML is invalid.");
    rejectAliases(document.contents);
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    if (cause instanceof WorkflowValidationError) throw cause;
    throw new WorkflowValidationError("Workflow YAML is invalid.");
  }
  const raw = record(parsed, "Workflow");
  assertKeys(raw, ALLOWED_WORKFLOW_KEYS, "Workflow");
  const name = literalString(raw.name, "Workflow name", 100);
  const triggers = parseTriggers(raw.on);
  const rawJobs = record(raw.jobs, "jobs");
  const jobEntries = Object.entries(rawJobs);
  if (jobEntries.length === 0 || jobEntries.length > 3) {
    throw new WorkflowValidationError("A workflow must contain between 1 and 3 jobs.");
  }
  const workflow = ActionWorkflowSchema.safeParse({
    path,
    name,
    triggers,
    jobs: jobEntries.map(([id, value]) => parseJob(id, value)),
  });
  if (!workflow.success) throw new WorkflowValidationError("Workflow structure is invalid.");
  return workflow.data;
}
