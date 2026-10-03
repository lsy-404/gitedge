import { DurableObject } from "cloudflare:workers";
import { createLogger } from "../../../src/worker/common/logger";
import type {
  ActionJob,
  ActionRun as ActionRunDetails,
  ActionRunConclusion,
  ActionRunJob,
  ActionRunStep,
} from "../../../packages/contracts/src/actions";
import type { RepositorySnapshotFile } from "../../../packages/contracts/src/repository-controls";

const RUN_KEY = "run";
const INPUT_CHUNK_PREFIX = "input:";
const MAX_INPUT_CHUNKS = 160;
const INPUT_CHUNK_SIZE = 48 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const RUN_TIMEOUT_MS = 120_000;

interface ActionRunEnv {
  readonly LOG_LEVEL?: string;
}

export interface ActionRunInput {
  readonly id: string;
  readonly repositoryId: string;
  readonly commitOid: string;
  readonly workflowPath: string;
  readonly workflowName: string;
  readonly ref: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly enableInternet: boolean;
  readonly jobs: readonly ActionJob[];
  readonly fileCount: number;
}

interface StoredRun extends ActionRunDetails {
  readonly enableInternet: boolean;
  readonly fileCount: number;
  readonly cancelRequested: boolean;
  readonly startedAt: number | null;
  readonly updatedAt: number;
}

interface OutputBudget {
  used: number;
  truncated: boolean;
}

function initialJobs(jobs: readonly ActionJob[]): ActionRunJob[] {
  return jobs.map((job) => ({
    id: job.id,
    name: job.name,
    status: "queued",
    conclusion: null,
    steps: job.steps.map((step) => ({
      name: step.name,
      status: "queued",
      conclusion: null,
      exitCode: null,
      log: "",
      outputTruncated: false,
    })),
  }));
}

function isStoredRun(value: unknown): value is StoredRun {
  return typeof value === "object" && value !== null && "id" in value && "jobs" in value;
}

function appendBounded(target: string, text: string, budget: OutputBudget): string {
  const encoded = new TextEncoder().encode(text);
  const remaining = MAX_OUTPUT_BYTES - budget.used;
  if (remaining <= 0) {
    if (text) budget.truncated = true;
    return target;
  }
  if (encoded.byteLength <= remaining) {
    budget.used += encoded.byteLength;
    return target + text;
  }
  budget.truncated = true;
  const accepted = encoded.subarray(0, remaining);
  budget.used += accepted.byteLength;
  return target + new TextDecoder().decode(accepted);
}

function safeRepositoryPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 2000 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

const WRITE_FILES_PROGRAM = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const root = '/workspace';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  try {
    const files = JSON.parse(input);
    for (const file of files) {
      if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.includes('\\') || file.path.includes('\0')) throw Error('Invalid path');
      const segments = file.path.split('/');
      if (segments.some(part => !part || part === '.' || part === '..')) throw Error('Invalid path');
      if (file.mode !== '100644' && file.mode !== '100755') throw Error('Unsupported file mode');
      const target = path.resolve(root, file.path);
      if (!target.startsWith(root + path.sep)) throw Error('Path escapes workspace');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(file.contentBase64, 'base64'), { mode: file.mode === '100755' ? 0o755 : 0o644 });
    }
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
`;

export class ActionRun extends DurableObject<ActionRunEnv> {
  private activeAbort: AbortController | null = null;
  private activeProcess: ExecProcess | null = null;
  private timeoutExpired = false;

  async isContainerConfigured(): Promise<boolean> {
    return Boolean(this.ctx.container);
  }

  async initialize(input: ActionRunInput, chunks: number): Promise<void> {
    if (!Number.isSafeInteger(chunks) || chunks < 1 || chunks > MAX_INPUT_CHUNKS) {
      throw new Error("Action run input is too large.");
    }
    const existing = await this.readRun();
    if (existing) return;
    const now = Date.now();
    const run: StoredRun = {
      ...input,
      status: "queued",
      conclusion: null,
      outputTruncated: false,
      jobs: initialJobs(input.jobs),
      cancelRequested: false,
      startedAt: null,
      updatedAt: now,
    };
    await this.ctx.storage.put(RUN_KEY, run);
    await this.ctx.storage.put("inputChunkCount", chunks);
    await this.ctx.storage.put("runPlan", input.jobs);
  }

  async writeInputChunk(index: number, chunk: string): Promise<void> {
    const count = await this.ctx.storage.get<number>("inputChunkCount");
    if (
      count === undefined ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= count ||
      chunk.length > INPUT_CHUNK_SIZE
    ) {
      throw new Error("Action run input chunk is invalid.");
    }
    await this.ctx.storage.put(`${INPUT_CHUNK_PREFIX}${index}`, chunk);
  }

  async schedule(): Promise<void> {
    const count = await this.ctx.storage.get<number>("inputChunkCount");
    if (count === undefined) throw new Error("Action run is not initialized.");
    for (let index = 0; index < count; index += 1) {
      if ((await this.ctx.storage.get<string>(`${INPUT_CHUNK_PREFIX}${index}`)) === undefined) {
        throw new Error("Action run input is incomplete.");
      }
    }
    await this.ctx.storage.setAlarm(Date.now());
  }

  async getRun(): Promise<ActionRunDetails | null> {
    return this.readRun();
  }

  async cancel(): Promise<ActionRunDetails | null> {
    const run = await this.readRun();
    if (!run || run.status === "completed") return run;
    await this.saveRun({ ...run, cancelRequested: true, updatedAt: Date.now() });
    this.activeAbort?.abort();
    if (this.activeProcess) {
      try {
        this.activeProcess.kill(9);
      } catch {
        // The process may have exited between the state read and the signal.
      }
    }
    const container = this.ctx.container;
    if (container?.running) await container.destroy("Action run cancelled");
    const current = await this.readRun();
    if (current?.status === "queued") {
      const cancelled = await this.saveRun({
        ...current,
        status: "completed",
        conclusion: "cancelled",
        updatedAt: Date.now(),
      });
      await this.clearRunInput();
      return cancelled;
    }
    return current;
  }

  async failStaleRun(): Promise<ActionRunDetails | null> {
    const run = await this.readRun();
    if (
      !run ||
      (run.status !== "queued" && run.status !== "running") ||
      Date.now() - (run.startedAt ?? run.createdAt) < RUN_TIMEOUT_MS + 30_000
    ) {
      return run;
    }
    const container = this.ctx.container;
    if (container?.running) await container.destroy("Stale action run exceeded its timeout");
    const cancelled = run.cancelRequested;
    const failed = await this.saveRun({
      ...run,
      status: "completed",
      conclusion: cancelled ? "cancelled" : "failure",
      jobs: run.jobs.map((job) => {
        if (job.status === "completed") return job;
        return {
          ...job,
          status: "completed",
          conclusion: cancelled ? "cancelled" : "failure",
          steps: job.steps.map((step) => {
            if (step.status === "completed") return step;
            const stepConclusion = cancelled ? "cancelled" : "failure";
            const message = cancelled
              ? "Action run was cancelled."
              : run.status === "queued"
                ? "Action run did not start within its timeout."
                : "Action run exceeded 120 seconds.";
            return {
              ...step,
              status: "completed",
              conclusion: stepConclusion,
              log: message,
            };
          }),
        };
      }),
      outputTruncated: run.outputTruncated,
      updatedAt: Date.now(),
    });
    await this.clearRunInput();
    return failed;
  }

  async alarm(): Promise<void> {
    const queued = await this.readRun();
    if (!queued || queued.status !== "queued" || queued.cancelRequested) {
      if (queued?.cancelRequested && queued.status === "queued") {
        await this.saveRun({
          ...queued,
          status: "completed",
          conclusion: "cancelled",
          updatedAt: Date.now(),
        });
        await this.clearRunInput();
      }
      return;
    }

    const started: StoredRun = {
      ...queued,
      status: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.saveRun(started);
    this.timeoutExpired = false;
    const timeout = setTimeout(() => {
      this.timeoutExpired = true;
      this.activeAbort?.abort();
      const container = this.ctx.container;
      if (container?.running) void container.destroy("Action run exceeded 120 seconds");
    }, RUN_TIMEOUT_MS);
    const budget: OutputBudget = { used: 0, truncated: false };

    try {
      const container = this.ctx.container;
      if (!container) throw new Error("Action container binding is unavailable.");
      const plan = await this.ctx.storage.get<ActionJob[]>("runPlan");
      if (!plan || plan.length !== started.jobs.length)
        throw new Error("Action run plan is missing.");
      container.start({
        image: "cloudflare/debian-trixie",
        instance: "lite",
        enableInternet: started.enableInternet,
        entrypoint: ["sleep", "infinity"],
      });

      const input = await this.readInput();
      if (input.length !== started.fileCount)
        throw new Error("Action run file count did not match its snapshot.");
      const inputJson = JSON.stringify(input);
      const inputResult = await this.execBounded(
        ["node", "-e", WRITE_FILES_PROGRAM],
        { stdin: inputJson, stdout: "ignore", stderr: "pipe" },
        budget,
        "",
        undefined
      );
      if (inputResult.exitCode !== 0) {
        const failed = await this.readRun();
        if (failed) {
          const message = inputResult.stderr || "Workspace preparation failed.";
          const jobs: ActionRunJob[] = failed.jobs.map((job, jobIndex): ActionRunJob => ({
            ...job,
            status: "completed",
            conclusion: jobIndex === 0 ? "failure" : "cancelled",
            steps: job.steps.map((step, stepIndex) => ({
              ...step,
              status: "completed",
              conclusion: jobIndex === 0 && stepIndex === 0 ? "failure" : "cancelled",
              log:
                jobIndex === 0 && stepIndex === 0
                  ? message
                  : "Not run because workspace preparation failed.",
            })),
          }));
          await this.saveRun({
            ...failed,
            jobs,
            status: "completed",
            conclusion: "failure",
            outputTruncated: budget.truncated,
            updatedAt: Date.now(),
          });
          await this.clearRunInput();
        }
        return;
      }

      for (const job of plan) {
        if (await this.isCancellationRequested()) break;
        let jobConclusion: ActionRunConclusion = "success";
        await this.updateJob(job.id, (current) => ({ ...current, status: "running" }));
        for (let index = 0; index < job.steps.length; index += 1) {
          if (await this.isCancellationRequested()) break;
          const step = job.steps[index];
          const current = await this.readRun();
          const currentStep = current?.jobs.find((candidate) => candidate.id === job.id)?.steps[
            index
          ];
          if (!current || !step || !currentStep) break;
          await this.updateStep(job.id, index, { ...currentStep, status: "running" });
          const cwd =
            step.workingDirectory === null ? "/workspace" : `/workspace/${step.workingDirectory}`;
          if (step.workingDirectory !== null && !safeRepositoryPath(step.workingDirectory)) {
            await this.updateStep(job.id, index, {
              ...currentStep,
              status: "completed",
              conclusion: "failure",
              log: "Invalid working-directory.",
              exitCode: null,
            });
            jobConclusion = "failure";
            break;
          }
          const result = await this.execBounded(
            [step.shell, "-c", step.run],
            { cwd, env: step.env, stdout: "pipe", stderr: "pipe" },
            budget,
            job.id,
            index
          );
          const conclusion = result.cancelled
            ? "cancelled"
            : result.exitCode === 0
              ? "success"
              : "failure";
          await this.updateStep(job.id, index, {
            name: step.name,
            status: "completed",
            conclusion,
            exitCode: result.exitCode,
            log: result.log,
            outputTruncated: result.outputTruncated,
          });
          if (conclusion !== "success") {
            jobConclusion = conclusion;
            break;
          }
        }
        const cancelled = await this.isCancellationRequested();
        await this.updateJob(job.id, (current) => ({
          ...current,
          status: "completed",
          conclusion: cancelled ? "cancelled" : jobConclusion,
          steps: current.steps.map((step) =>
            step.status === "queued" && cancelled
              ? { ...step, status: "completed", conclusion: "cancelled" }
              : step
          ),
        }));
        if (jobConclusion !== "success" || cancelled) break;
      }

      const current = await this.readRun();
      if (!current) return;
      const cancelled = current.cancelRequested;
      const conclusion: ActionRunConclusion = cancelled
        ? "cancelled"
        : this.timeoutExpired
          ? "failure"
          : current.jobs.some((job) => job.conclusion === "failure")
            ? "failure"
            : "success";
      await this.saveRun({
        ...current,
        status: "completed",
        conclusion,
        jobs: current.jobs.map((job) =>
          job.status === "queued"
            ? {
                ...job,
                status: "completed",
                conclusion: cancelled ? "cancelled" : "failure",
                steps: job.steps.map((step) =>
                  step.status === "queued"
                    ? {
                        ...step,
                        status: "completed",
                        conclusion: cancelled ? "cancelled" : "failure",
                        log: cancelled
                          ? "Not run because the run was cancelled."
                          : "Not run because an earlier step failed.",
                      }
                    : step
                ),
              }
            : job
        ),
        outputTruncated: budget.truncated,
        updatedAt: Date.now(),
      });
      await this.clearRunInput();
    } catch (cause) {
      const logger = createLogger(this.env.LOG_LEVEL, {
        service: "actions",
        repoId: started.repositoryId,
        doId: started.id,
      });
      logger.error("actions:container-run-failed", {
        reason: cause instanceof Error ? cause.message : "unknown",
      });
      const current = await this.readRun();
      if (current) {
        const cancelled = current.cancelRequested;
        await this.saveRun({
          ...current,
          status: "completed",
          conclusion: cancelled ? "cancelled" : "failure",
          outputTruncated: budget.truncated,
          jobs: current.jobs.map((job) =>
            job.status === "running"
              ? {
                  ...job,
                  status: "completed",
                  conclusion: cancelled ? "cancelled" : "failure",
                  steps: job.steps.map((step) =>
                    step.status === "running"
                      ? {
                          ...step,
                          status: "completed",
                          conclusion: cancelled ? "cancelled" : "failure",
                          log: appendBounded(
                            step.log,
                            cause instanceof Error ? cause.message : "Action execution failed.",
                            budget
                          ),
                        }
                      : step
                  ),
                }
              : job
          ),
          updatedAt: Date.now(),
        });
        await this.clearRunInput();
      }
    } finally {
      clearTimeout(timeout);
      this.activeAbort = null;
      this.activeProcess = null;
      const container = this.ctx.container;
      if (container?.running) {
        await container.destroy("Action run finished").catch((cause: unknown) => {
          const logger = createLogger(this.env.LOG_LEVEL, {
            service: "actions",
            repoId: started.repositoryId,
            doId: started.id,
          });
          logger.warn("actions:container-cleanup-failed", {
            reason: cause instanceof Error ? cause.message : "unknown",
          });
        });
      }
    }
  }

  private async execBounded(
    argv: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      stdout: "pipe" | "ignore";
      stderr: "pipe";
    },
    budget: OutputBudget,
    jobId: string,
    stepIndex: number | undefined
  ): Promise<{
    exitCode: number;
    stderr: string;
    log: string;
    outputTruncated: boolean;
    cancelled: boolean;
  }> {
    const container = this.ctx.container;
    if (!container?.running) throw new Error("Action container is not running.");
    const controller = new AbortController();
    this.activeAbort = controller;
    const process = await container.exec(argv, {
      stdin: options.stdin === undefined ? undefined : "pipe",
      stdout: options.stdout,
      stderr: options.stderr,
      cwd: options.cwd,
      env: options.env,
      signal: controller.signal,
    });
    this.activeProcess = process;
    void process.exitCode.then(() => {
      if (this.activeProcess === process) {
        this.activeAbort = null;
        this.activeProcess = null;
      }
    });
    if (options.stdin !== undefined && process.stdin) {
      const writer = process.stdin.getWriter();
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
    }
    let log = "";
    let stderr = "";
    let unflushedBytes = 0;
    let lastFlush = Date.now();
    const channel = async (
      stream: ReadableStream<Uint8Array> | null,
      label: string
    ): Promise<void> => {
      if (!stream) return;
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          if (!value) continue;
          const text = new TextDecoder().decode(value, { stream: true });
          const formatted = label ? `${label}${text}` : text;
          const next = appendBounded(log, formatted, budget);
          const delta = next.slice(log.length);
          log = next;
          unflushedBytes += new TextEncoder().encode(delta).byteLength;
          if (label === "stderr: ") stderr += delta.replace(/^stderr: /, "");
          if (
            jobId &&
            stepIndex !== undefined &&
            (unflushedBytes >= 8 * 1024 || Date.now() - lastFlush >= 1000)
          ) {
            const current = await this.readRun();
            const step = current?.jobs.find((item) => item.id === jobId)?.steps[stepIndex];
            if (step)
              await this.updateStep(jobId, stepIndex, {
                ...step,
                log,
                outputTruncated: budget.truncated,
              });
            unflushedBytes = 0;
            lastFlush = Date.now();
          }
        }
      } finally {
        reader.releaseLock();
      }
    };
    await Promise.all([channel(process.stdout, ""), channel(process.stderr, "stderr: ")]);
    const exitCode = await process.exitCode;
    this.activeAbort = null;
    this.activeProcess = null;
    if (this.timeoutExpired && !(await this.isCancellationRequested())) {
      log = appendBounded(log, "\nAction run exceeded 120 seconds.", budget);
    }
    return {
      exitCode,
      stderr,
      log,
      outputTruncated: budget.truncated,
      cancelled: (await this.isCancellationRequested()) && !this.timeoutExpired,
    };
  }

  private async readInput(): Promise<RepositorySnapshotFile[]> {
    const count = await this.ctx.storage.get<number>("inputChunkCount");
    if (count === undefined || count > MAX_INPUT_CHUNKS)
      throw new Error("Action run input is missing.");
    const chunks: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const chunk = await this.ctx.storage.get<string>(`${INPUT_CHUNK_PREFIX}${index}`);
      if (chunk === undefined) throw new Error("Action run input is incomplete.");
      chunks.push(chunk);
    }
    const parsed: unknown = JSON.parse(chunks.join(""));
    await this.ctx.storage.delete(
      Array.from({ length: count }, (_unused, index) => `${INPUT_CHUNK_PREFIX}${index}`)
    );
    if (!Array.isArray(parsed)) throw new Error("Action run input is invalid.");
    for (const value of parsed) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("path" in value) ||
        typeof value.path !== "string" ||
        !safeRepositoryPath(value.path) ||
        !("contentBase64" in value) ||
        typeof value.contentBase64 !== "string" ||
        !("mode" in value) ||
        (value.mode !== "100644" && value.mode !== "100755")
      )
        throw new Error("Action run contains an unsupported repository file.");
    }
    const files = parsed.filter(
      (value): value is RepositorySnapshotFile =>
        typeof value === "object" &&
        value !== null &&
        "path" in value &&
        typeof value.path === "string" &&
        "contentBase64" in value &&
        typeof value.contentBase64 === "string" &&
        "mode" in value &&
        typeof value.mode === "string"
    );
    if (files.length !== parsed.length) throw new Error("Action run input is invalid.");
    return files;
  }

  private async isCancellationRequested(): Promise<boolean> {
    return (await this.readRun())?.cancelRequested ?? false;
  }

  private async clearRunInput(): Promise<void> {
    const count = await this.ctx.storage.get<number>("inputChunkCount");
    if (count !== undefined && count > 0) {
      await this.ctx.storage.delete(
        Array.from({ length: count }, (_unused, index) => `${INPUT_CHUNK_PREFIX}${index}`)
      );
    }
    await this.ctx.storage.delete(["inputChunkCount", "runPlan"]);
  }

  private async readRun(): Promise<StoredRun | null> {
    const value: unknown = await this.ctx.storage.get(RUN_KEY);
    return isStoredRun(value) ? value : null;
  }

  private async saveRun(run: StoredRun): Promise<StoredRun> {
    await this.ctx.storage.put(RUN_KEY, { ...run, updatedAt: Date.now() });
    return run;
  }

  private async updateJob(id: string, update: (job: ActionRunJob) => ActionRunJob): Promise<void> {
    const run = await this.readRun();
    if (!run) return;
    await this.saveRun({
      ...run,
      jobs: run.jobs.map((job) => (job.id === id ? update(job) : job)),
    });
  }

  private async updateStep(id: string, index: number, step: ActionRunStep): Promise<void> {
    const run = await this.readRun();
    if (!run) return;
    await this.saveRun({
      ...run,
      jobs: run.jobs.map((job) =>
        job.id === id
          ? { ...job, steps: job.steps.map((item, i) => (i === index ? step : item)) }
          : job
      ),
    });
  }
}
