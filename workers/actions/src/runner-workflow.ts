import { z } from "zod";
import { parseDocument } from "yaml";
import {
  isActionWorkflowPath,
  ActionDispatchInputSchema,
  type ActionEventType,
  type ActionWorkflow,
} from "../../../packages/contracts/src/actions";
import { RunnerLabelsSchema } from "../../../packages/contracts/src/runners";
import { WorkflowValidationError } from "./workflow";
import { parseCronSchedules } from "./cron";

const RecordSchema = z.record(z.string(), z.unknown());
const FilterSchema = z
  .object({
    branches: z.array(z.string().min(1).max(256)).max(32).optional(),
    "branches-ignore": z.array(z.string().min(1).max(256)).max(32).optional(),
  })
  .strict();
export interface RunnerWorkflow {
  workflow: ActionWorkflow;
  source: string;
  labels: string[];
  permission: "read" | "write";
  timeoutMinutes: number;
  inputs: NonNullable<ActionWorkflow["dispatchInputs"]>;
}

function fail(message: string): never {
  throw new WorkflowValidationError(message);
}

export function parseRunnerWorkflow(path: string, source: string): RunnerWorkflow {
  if (!isActionWorkflowPath(path) || !path.startsWith(".github/"))
    fail("Runner workflows must be in .github/workflows.");
  if (new TextEncoder().encode(source).byteLength > 65_536) fail("Runner workflow exceeds 64 KiB.");
  const document = parseDocument(source, { schema: "core", uniqueKeys: true, strict: true });
  if (document.errors.length) fail("Workflow YAML is invalid.");
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    fail("Workflow aliases are unsupported.");
  }
  const parsed = RecordSchema.safeParse(value);
  if (!parsed.success) fail("Workflow must be a mapping.");
  const raw = parsed.data;
  const unknown = Object.keys(raw).find(
    (key) => !["name", "run-name", "on", "jobs", "permissions", "env", "defaults"].includes(key)
  );
  if (unknown) fail(`Runner workflow field '${unknown}' is not supported.`);
  const permissions = z
    .object({ contents: z.enum(["read", "write"]) })
    .strict()
    .safeParse(raw.permissions === undefined ? { contents: "read" } : raw.permissions);
  if (!permissions.success)
    fail("Runner permissions currently support only contents: read or write.");
  const triggers: ActionEventType[] = [];
  const filters: NonNullable<ActionWorkflow["triggerFilters"]> = {};
  let inputs: RunnerWorkflow["inputs"] = {};
  let schedules: string[] | undefined;
  const events =
    typeof raw.on === "string"
      ? { [raw.on]: {} }
      : Array.isArray(raw.on) && raw.on.every((event) => typeof event === "string")
        ? Object.fromEntries(raw.on.map((event) => [event, {}]))
        : raw.on;
  const eventRecord = RecordSchema.safeParse(events);
  if (!eventRecord.success) fail("Workflow must declare triggers.");
  for (const [event, options] of Object.entries(eventRecord.data)) {
    if (event !== "push" && event !== "workflow_dispatch" && event !== "schedule")
      fail(`Runner trigger '${event}' is not supported; use push, workflow_dispatch or schedule.`);
    triggers.push(event);
    if (event === "schedule") {
      try {
        schedules = parseCronSchedules(options);
      } catch (cause) {
        fail(
          `Schedule must declare one to five valid five-field cron expressions in UTC: ${cause instanceof Error ? cause.message : "invalid schedule"}`
        );
      }
    } else if (event === "push") {
      const filter = FilterSchema.safeParse(options ?? {});
      if (!filter.success) fail("Runner push triggers currently support branch filters only.");
      filters.push = {
        branches: filter.data.branches,
        branchesIgnore: filter.data["branches-ignore"],
      };
    } else {
      const dispatch = z
        .object({
          inputs: z.record(z.string().min(1).max(100), ActionDispatchInputSchema).optional(),
        })
        .strict()
        .safeParse(options ?? {});
      if (!dispatch.success || Object.keys(dispatch.data.inputs ?? {}).length > 20)
        fail("Workflow dispatch inputs are unsupported or exceed 20 fields.");
      inputs = dispatch.data.inputs ?? {};
    }
  }
  if (!triggers.length) fail("Workflow must declare at least one trigger.");
  const jobs = RecordSchema.safeParse(raw.jobs);
  if (!jobs.success || Object.keys(jobs.data).length < 1 || Object.keys(jobs.data).length > 16)
    fail("Runner workflows require between 1 and 16 jobs.");
  const labels = new Set<string>();
  let timeoutMinutes = 0;
  for (const [id, item] of Object.entries(jobs.data)) {
    const job = RecordSchema.safeParse(item);
    if (!job.success) fail(`Job '${id}' must be a mapping.`);
    if (
      job.data.permissions !== undefined ||
      job.data.environment !== undefined ||
      job.data.concurrency !== undefined
    )
      fail(
        "Job permissions, environments and concurrency are not supported by the shared runner queue."
      );
    const requested =
      typeof job.data["runs-on"] === "string" ? [job.data["runs-on"]] : job.data["runs-on"];
    const required = RunnerLabelsSchema.safeParse(requested);
    if (!required.success)
      fail(`Job '${id}' requires literal runs-on labels for one matching host.`);
    if (!required.data.some((label) => label.toLowerCase() === "self-hosted"))
      fail(`Job '${id}' must explicitly target self-hosted runners.`);
    for (const label of required.data) labels.add(label.toLowerCase());
    const timeout = z
      .number()
      .int()
      .min(1)
      .max(360)
      .safeParse(job.data["timeout-minutes"] ?? 60);
    if (!timeout.success) fail("Job timeout-minutes must be between 1 and 360.");
    timeoutMinutes += timeout.data;
    if (!Array.isArray(job.data.steps) || job.data.steps.length < 1 || job.data.steps.length > 128)
      fail(`Job '${id}' requires between 1 and 128 steps.`);
    for (const step of job.data.steps) {
      const entry = RecordSchema.safeParse(step);
      if (!entry.success) fail("Workflow steps must be mappings.");
      if (
        typeof entry.data.uses === "string" &&
        /^actions\/(upload|download)-artifact@/i.test(entry.data.uses)
      )
        fail("Original artifact actions reject custom GitHub hosts and are unsupported.");
    }
  }
  if (labels.size > 40) fail("The workflow requires too many runner labels.");
  const name = z
    .string()
    .min(1)
    .max(100)
    .safeParse(raw.name ?? path.split("/").pop());
  if (!name.success) fail("Workflow name exceeds 100 characters.");
  return {
    workflow: {
      path,
      name: name.data,
      triggers,
      triggerFilters: filters,
      jobs: [],
      executor: "runner",
      dispatchInputs: inputs,
      ...(schedules ? { schedules } : {}),
    },
    source,
    labels: [...labels],
    permission: permissions.data.contents,
    timeoutMinutes: Math.min(360, timeoutMinutes),
    inputs,
  };
}

export function validateSingleSigningJob(path: string, source: string): RunnerWorkflow {
  if (new TextEncoder().encode(source).byteLength > 65_536) fail("Runner workflow exceeds 64 KiB.");
  const document = parseDocument(source, { schema: "core", uniqueKeys: true, strict: true });
  if (document.errors.length) fail("Workflow YAML is invalid.");
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    fail("Workflow aliases are unsupported.");
  }
  const parsed = RecordSchema.safeParse(value);
  const jobs = parsed.success ? RecordSchema.safeParse(parsed.data.jobs) : undefined;
  if (!jobs?.success || Object.keys(jobs.data).length !== 1)
    fail("Signing workflows must contain exactly one job.");
  const job = RecordSchema.safeParse(Object.values(jobs.data)[0]);
  const strategy =
    job?.success && job.data.strategy !== undefined
      ? RecordSchema.safeParse(job.data.strategy)
      : undefined;
  if (
    !job?.success ||
    (job.data.strategy !== undefined &&
      (!strategy?.success || strategy.data.matrix !== undefined)) ||
    job.data.if !== undefined
  )
    fail("Signing workflows cannot use matrix jobs or conditional jobs.");
  return parseRunnerWorkflow(path, source);
}

export function runnerDispatchInputs(
  definition: RunnerWorkflow,
  supplied: unknown
): Record<string, string | number | boolean> {
  const parsed = z
    .record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()]))
    .safeParse(supplied ?? {});
  if (!parsed.success) fail("Dispatch inputs must contain scalar values.");
  for (const key of Object.keys(parsed.data))
    if (!(key in definition.inputs)) fail(`Unknown dispatch input '${key}'.`);
  const values: Record<string, string | number | boolean> = {};
  for (const [key, input] of Object.entries(definition.inputs)) {
    const value = parsed.data[key] ?? input.default;
    if (value === undefined) {
      if (input.required) fail(`Dispatch input '${key}' is required.`);
      continue;
    }
    const type = input.type ?? "string";
    if (
      (input.required && value === "") ||
      (type === "boolean" && typeof value !== "boolean") ||
      (type === "number" && typeof value !== "number") ||
      ((type === "string" || type === "choice") && typeof value !== "string") ||
      (type === "choice" && !input.options?.includes(String(value)))
    )
      fail(`Invalid dispatch input '${key}'.`);
    values[key] = value;
  }
  return values;
}
