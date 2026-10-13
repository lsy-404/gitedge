import { isAlias, isMap, isSeq, parseDocument } from "yaml";
import picomatch from "picomatch";
import {
  ActionWorkflowSchema,
  ActionEventTypeSchema,
  ActionTriggerFilterSchema,
  ActionArtifactSchema,
  ActionCacheSchema,
  type ActionJob,
  type ActionStep,
  type ActionWorkflow,
  type ActionEventType,
} from "../../../packages/contracts/src/actions";

export class WorkflowValidationError extends Error {}

const MAX_WORKFLOW_BYTES = 64 * 1024;
const ALLOWED_WORKFLOW_KEYS = new Set(["name", "on", "jobs", "cache"]);
const ALLOWED_JOB_KEYS = new Set(["name", "steps", "artifacts"]);
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

function triggerKeys(value: unknown): { keys: string[]; config: Record<string, unknown> } {
  if (typeof value === "string") return { keys: [value], config: { [value]: null } };
  if (Array.isArray(value)) {
    if (value.length === 0 || value.some((entry) => typeof entry !== "string")) {
      throw new WorkflowValidationError("on must list at least one trigger name.");
    }
    const keys: string[] = value;
    if (new Set(keys).size !== keys.length) {
      throw new WorkflowValidationError("on lists a trigger more than once.");
    }
    return { keys, config: Object.fromEntries(keys.map((key) => [key, null])) };
  }
  if (!isRecord(value)) {
    throw new WorkflowValidationError("on must be a trigger name, list or mapping.");
  }
  return { keys: Object.keys(value), config: value };
}

function parseTriggers(value: unknown): {
  events: ActionEventType[];
  filters: ActionWorkflow["triggerFilters"];
} {
  const { keys, config: triggers } = triggerKeys(value);
  const supported = new Set(["workflow_dispatch", "push", "pull_request", "merge_group"]);
  if (keys.length === 0 || keys.some((key) => !supported.has(key))) {
    throw new WorkflowValidationError(
      "Only workflow_dispatch, push, pull_request and merge_group triggers are supported."
    );
  }
  const filters: NonNullable<ActionWorkflow["triggerFilters"]> = {};
  for (const key of keys) {
    const config = triggers[key];
    if (config === null) continue;
    const values = record(config, `on.${key}`);
    if (key === "push" || key === "pull_request") {
      for (const option of Object.keys(values)) {
        if (option !== "branches" && option !== "branches-ignore")
          throw new WorkflowValidationError(`on.${key}.${option} is unsupported.`);
      }
      const normalized = {
        ...(values.branches === undefined
          ? {}
          : { branches: stringPatterns(values.branches, `on.${key}.branches`) }),
        ...(values["branches-ignore"] === undefined
          ? {}
          : {
              branchesIgnore: stringPatterns(
                values["branches-ignore"],
                `on.${key}.branches-ignore`
              ),
            }),
      };
      const parsed = ActionTriggerFilterSchema.safeParse(normalized);
      if (!parsed.success)
        throw new WorkflowValidationError(`on.${key} branch filters are invalid.`);
      filters[key] = parsed.data;
    } else if (Object.keys(values).length !== 0) {
      throw new WorkflowValidationError(`on.${key} options are unsupported.`);
    }
  }
  const parsed = keys.map((key) => ActionEventTypeSchema.parse(key));
  return { events: parsed, filters: Object.keys(filters).length ? filters : undefined };
}

function stringPatterns(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !item || item.length > 256)
  )
    throw new WorkflowValidationError(`${label} must be a non-empty list of branch patterns.`);
  return value;
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
  let artifacts: ActionJob["artifacts"];
  if (raw.artifacts !== undefined) {
    if (!Array.isArray(raw.artifacts) || raw.artifacts.length > 10)
      throw new WorkflowValidationError(`Job "${id}" artifacts must contain at most 10 entries.`);
    const parsed = raw.artifacts.map((entry) => ActionArtifactSchema.safeParse(entry));
    if (parsed.some((entry) => !entry.success))
      throw new WorkflowValidationError(`Job "${id}" has an invalid artifact declaration.`);
    artifacts = parsed
      .map((entry) => (entry.success ? entry.data : undefined))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    if (new Set(artifacts.map((entry) => entry.name)).size !== artifacts.length)
      throw new WorkflowValidationError(`Job "${id}" artifact names must be unique.`);
  }
  return { id, name, steps: raw.steps.map(parseStep), ...(artifacts ? { artifacts } : {}) };
}

export function isActionWorkflowPath(path: string): boolean {
  return /^(?:\.github|\.gitedge)\/workflows\/[A-Za-z0-9_.-]+\.(?:yml|yaml)$/.test(path);
}

export function workflowFiles(
  files: readonly { readonly path: string }[]
): readonly { readonly path: string }[] {
  const native = files.filter(
    (file) => file.path.startsWith(".gitedge/workflows/") && isActionWorkflowPath(file.path)
  );
  return native.length
    ? native
    : files.filter(
        (file) => file.path.startsWith(".github/workflows/") && isActionWorkflowPath(file.path)
      );
}

export function parseWorkflow(path: string, source: string): ActionWorkflow {
  if (!isActionWorkflowPath(path)) {
    throw new WorkflowValidationError(
      "Workflow files must be directly inside .github/workflows or .gitedge/workflows."
    );
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
  const { events: triggers, filters: triggerFilters } = parseTriggers(raw.on);
  const rawJobs = record(raw.jobs, "jobs");
  const jobEntries = Object.entries(rawJobs);
  if (jobEntries.length === 0 || jobEntries.length > 3) {
    throw new WorkflowValidationError("A workflow must contain between 1 and 3 jobs.");
  }
  let cache: ActionWorkflow["cache"];
  if (raw.cache !== undefined) {
    const parsedCache = ActionCacheSchema.safeParse(raw.cache);
    if (!parsedCache.success)
      throw new WorkflowValidationError("Workflow cache must declare safe keyFiles and paths.");
    if (
      new Set(parsedCache.data.keyFiles).size !== parsedCache.data.keyFiles.length ||
      new Set(parsedCache.data.paths).size !== parsedCache.data.paths.length
    )
      throw new WorkflowValidationError("Workflow cache paths must be unique.");
    cache = parsedCache.data;
  }
  const workflow = ActionWorkflowSchema.safeParse({
    path,
    name,
    triggers,
    ...(triggerFilters ? { triggerFilters } : {}),
    jobs: jobEntries.map(([id, value]) => parseJob(id, value)),
    ...(cache ? { cache } : {}),
  });
  if (!workflow.success) throw new WorkflowValidationError("Workflow structure is invalid.");
  const artifactNames = workflow.data.jobs.flatMap(
    (job) => job.artifacts?.map((artifact) => artifact.name) ?? []
  );
  if (new Set(artifactNames).size !== artifactNames.length)
    throw new WorkflowValidationError("Artifact names must be unique across workflow jobs.");
  return workflow.data;
}

export function workflowMatchesEvent(
  workflow: ActionWorkflow,
  eventType: ActionEventType,
  ref: string
): boolean {
  if (!workflow.triggers.includes(eventType)) return false;
  const filter = workflow.triggerFilters?.[eventType];
  if (!filter) return true;
  const branches = filter.branches ?? [];
  const ignored = filter.branchesIgnore ?? [];
  if (ignored.some((pattern) => picomatch(pattern)(ref))) return false;
  let included = !branches.some((pattern) => !pattern.startsWith("!"));
  for (const pattern of branches) {
    const excluded = pattern.startsWith("!");
    if (picomatch(excluded ? pattern.slice(1) : pattern)(ref)) included = !excluded;
  }
  return included;
}
