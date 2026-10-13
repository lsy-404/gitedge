import { DurableObject } from "cloudflare:workers";
import { createLogger } from "../../../src/worker/common/logger";
import type {
  ActionArtifact,
  ActionCacheOutcome,
  ActionEventType,
  ActionJob,
  ActionRunArtifact,
  ActionRun as ActionRunDetails,
  ActionRunConclusion,
  ActionRunJob,
  ActionRunStep,
} from "../../../packages/contracts/src/actions";
import type { RepositorySnapshotFile } from "../../../packages/contracts/src/repository-controls";
import { bytesToBase64, base64ToBytes } from "../../../src/worker/common/encoding";

const RUN_KEY = "run";
const INPUT_CHUNK_PREFIX = "input:";
const MAX_INPUT_CHUNKS = 1024;
const INPUT_CHUNK_SIZE = 48 * 1024;
const CACHE_CHUNK_PREFIX = "cache:";
const OUTPUT_CHUNK_PREFIX = "output:";
const OUTPUT_CHUNK_SIZE = 48 * 1024;
const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;
const MAX_ARCHIVE_CHUNKS = Math.ceil(MAX_ARCHIVE_BYTES / OUTPUT_CHUNK_SIZE);
const MAX_OUTPUT_BYTES = 16 * 1024;
const RUN_TIMEOUT_MS = 10 * 60_000;

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
  readonly eventType: ActionEventType;
  readonly cacheKey: string | null;
  readonly cacheOutcome: ActionCacheOutcome;
  readonly cachePaths: readonly string[];
  readonly cachedArchiveSha256: string | null;
  readonly artifactsToCapture: readonly ActionArtifact[];
  readonly jobs: readonly ActionJob[];
  readonly fileCount: number;
}

export interface ActionOutputMetadata {
  readonly name: string;
  readonly kind: "artifact" | "cache";
  readonly size: number;
  readonly sha256: string;
  readonly chunks: number;
}

interface StoredRun extends ActionRunDetails {
  readonly enableInternet: boolean;
  readonly fileCount: number;
  readonly cacheKey: string | null;
  readonly cachePaths: readonly string[];
  readonly cachedArchiveSha256: string | null;
  readonly artifactsToCapture: readonly ActionArtifact[];
  readonly outputs: readonly ActionOutputMetadata[];
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
  let acceptedLength = Math.min(encoded.byteLength, remaining);
  let acceptedText = "";
  while (acceptedLength > 0) {
    try {
      acceptedText = new TextDecoder("utf-8", { fatal: true }).decode(
        encoded.subarray(0, acceptedLength)
      );
      break;
    } catch {
      acceptedLength -= 1;
    }
  }
  const accepted = encoded.subarray(0, acceptedLength);
  budget.used += accepted.byteLength;
  return target + acceptedText;
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

const SCAN_OUTPUT_PATHS_PROGRAM = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const root = '/workspace';
const maxFiles = 2048;
const maxBytes = 24 * 1024 * 1024;
function safe(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..');
}
async function walk(target, relative, result) {
  const info = await fs.lstat(target);
  if (info.isSymbolicLink()) throw Error('Output paths cannot contain symbolic links.');
  if (info.isDirectory()) {
    for (const name of await fs.readdir(target)) await walk(path.join(target, name), relative + '/' + name, result);
  } else if (info.isFile() && info.nlink === 1) {
    result.files += 1;
    result.bytes += info.size;
    if (result.files > maxFiles || result.bytes > maxBytes) throw Error('Output archive exceeds 2,048 files or 24 MiB.');
  } else throw Error('Output paths may contain only regular files and directories.');
}
async function inspectDeclared(value, result) {
  let target = root;
  for (const part of value.split('/')) {
    target = path.join(target, part);
    const info = await fs.lstat(target);
    if (info.isSymbolicLink()) throw Error('Output paths cannot contain symbolic links.');
  }
  await walk(target, value, result);
}
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  try {
    const paths = JSON.parse(input);
    const result = { files: 0, bytes: 0, paths: [] };
    for (const value of paths) {
      if (!safe(value)) throw Error('Invalid output path.');
      const target = path.resolve(root, value);
      if (!target.startsWith(root + path.sep)) throw Error('Output path escapes workspace.');
      try {
        await inspectDeclared(value, result);
        result.paths.push(value);
      } catch (error) {
        if (error && error.code === 'ENOENT') continue;
        throw error;
      }
    }
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
`;

const RESTORE_CACHE_PROGRAM = String.raw`
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const archive = '/tmp/gitedge-cache.tar.gz';
const expectedHash = process.argv[1];
const root = '/workspace';
const safe = value => { const normalized = value.replace(/\/+$/, ''); return normalized && !normalized.startsWith('/') && !normalized.includes('\\') && normalized.split('/').every(part => part && part !== '.' && part !== '..'); };
(async () => {
  const file = await fs.open(archive, 'w');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 24 * 1024 * 1024) throw Error('Cache archive exceeds 24 MiB.');
    hash.update(chunk);
    await file.write(chunk);
  }
  await file.close();
  if (hash.digest('hex') !== expectedHash) throw Error('Cache archive integrity check failed.');
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\n').filter(Boolean);
  const modes = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\n').filter(Boolean);
  if (names.length > 2048 || modes.length !== names.length || names.some(name => !safe(name)) || modes.some(line => !['-', 'd'].includes(line[0]))) throw Error('Cache archive contains unsafe paths or file types.');
  execFileSync('tar', ['--no-same-owner', '--no-same-permissions', '--no-overwrite-dir', '-xzf', archive, '-C', root], { maxBuffer: 1024 * 1024 });
  await fs.rm(archive, { force: true });
})().catch(error => { process.stderr.write(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
`;

export class ActionRun extends DurableObject<ActionRunEnv> {
  private activeAbort: AbortController | null = null;
  private activeProcess: ExecProcess | null = null;
  private timeoutExpired = false;

  async isContainerConfigured(): Promise<boolean> {
    return Boolean(this.ctx.container);
  }

  async initialize(input: ActionRunInput, chunks: number, cacheChunks: number): Promise<void> {
    if (
      !Number.isSafeInteger(chunks) ||
      chunks < 0 ||
      chunks > MAX_INPUT_CHUNKS ||
      !Number.isSafeInteger(cacheChunks) ||
      cacheChunks < 0 ||
      cacheChunks > MAX_ARCHIVE_CHUNKS
    ) {
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
      eventType: input.eventType,
      cacheOutcome: input.cacheOutcome,
      artifacts: [],
      artifactOutcomes: input.artifactsToCapture.map((artifact) => ({
        name: artifact.name,
        status: "pending",
        message: null,
      })),
      jobs: initialJobs(input.jobs),
      cacheKey: input.cacheKey,
      cachePaths: input.cachePaths,
      cachedArchiveSha256: input.cachedArchiveSha256,
      artifactsToCapture: input.artifactsToCapture,
      outputs: [],
      cancelRequested: false,
      startedAt: null,
      updatedAt: now,
    };
    await this.ctx.storage.transaction(async (txn) => {
      if ((await txn.get(RUN_KEY)) !== undefined) return;
      await txn.put(RUN_KEY, run);
      await txn.put("inputChunkCount", chunks);
      await txn.put("cacheChunkCount", cacheChunks);
      await txn.put("runPlan", input.jobs);
    });
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

  async writeCacheChunk(index: number, chunk: string): Promise<void> {
    const count = await this.ctx.storage.get<number>("cacheChunkCount");
    if (
      count === undefined ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= count ||
      chunk.length > Math.ceil(OUTPUT_CHUNK_SIZE / 3) * 4
    )
      throw new Error("Action cache chunk is invalid.");
    await this.ctx.storage.put(`${CACHE_CHUNK_PREFIX}${index}`, chunk);
  }

  async discardCacheInput(): Promise<void> {
    const count = await this.ctx.storage.get<number>("cacheChunkCount");
    if (count !== undefined && count > 0)
      await this.ctx.storage.delete(
        Array.from({ length: count }, (_unused, index) => `${CACHE_CHUNK_PREFIX}${index}`)
      );
    await this.ctx.storage.put("cacheChunkCount", 0);
  }

  async schedule(): Promise<void> {
    const count = await this.ctx.storage.get<number>("inputChunkCount");
    if (count === undefined) throw new Error("Action run is not initialized.");
    for (let index = 0; index < count; index += 1) {
      if ((await this.ctx.storage.get<string>(`${INPUT_CHUNK_PREFIX}${index}`)) === undefined) {
        throw new Error("Action run input is incomplete.");
      }
    }
    const cacheCount = await this.ctx.storage.get<number>("cacheChunkCount");
    if (cacheCount === undefined) throw new Error("Action run cache input is not initialized.");
    for (let index = 0; index < cacheCount; index += 1) {
      if ((await this.ctx.storage.get<string>(`${CACHE_CHUNK_PREFIX}${index}`)) === undefined)
        throw new Error("Action run cache input is incomplete.");
    }
    await this.ctx.storage.setAlarm(Date.now());
  }

  async getRun(): Promise<ActionRunDetails | null> {
    return this.readRun();
  }

  async getOutputMetadata(): Promise<readonly ActionOutputMetadata[]> {
    return (await this.readRun())?.outputs ?? [];
  }

  async readOutputChunk(name: string, index: number): Promise<string | null> {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || !Number.isSafeInteger(index) || index < 0)
      throw new Error("Action output chunk request is invalid.");
    const output = (await this.readRun())?.outputs.find((item) => item.name === name);
    if (!output || index >= output.chunks) return null;
    return (await this.ctx.storage.get<string>(`${OUTPUT_CHUNK_PREFIX}${name}:${index}`)) ?? null;
  }

  async markOutputPublished(name: string, artifact: ActionRunArtifact | null): Promise<void> {
    const run = await this.readRun();
    if (!run) throw new Error("Action run was not found.");
    const output = run.outputs.find((item) => item.name === name);
    if (!output) return;
    await this.ctx.storage.delete(
      Array.from(
        { length: output.chunks },
        (_unused, index) => `${OUTPUT_CHUNK_PREFIX}${name}:${index}`
      )
    );
    const next: StoredRun = {
      ...run,
      outputs: run.outputs.filter((item) => item.name !== name),
      ...(artifact
        ? { artifacts: [...run.artifacts.filter((item) => item.name !== name), artifact] }
        : {}),
      artifactOutcomes: run.artifactOutcomes.map((item) =>
        item.name === name && artifact ? { name, status: "ready", message: null } : item
      ),
      updatedAt: Date.now(),
    };
    await this.saveRun(next);
  }

  async markArtifactFailed(name: string, message: string): Promise<void> {
    const run = await this.readRun();
    if (!run) return;
    const output = run.outputs.find((item) => item.name === name);
    if (output) {
      await this.ctx.storage.delete(
        Array.from(
          { length: output.chunks },
          (_unused, index) => `${OUTPUT_CHUNK_PREFIX}${name}:${index}`
        )
      );
    }
    await this.saveRun({
      ...run,
      outputs: run.outputs.filter((item) => item.name !== name),
      artifactOutcomes: run.artifactOutcomes.map((item) =>
        item.name === name ? { name, status: "failed", message: message.slice(0, 200) } : item
      ),
      updatedAt: Date.now(),
    });
  }

  async markArtifactSkipped(name: string): Promise<void> {
    const run = await this.readRun();
    if (!run) return;
    await this.saveRun({
      ...run,
      artifactOutcomes: run.artifactOutcomes.map((item) =>
        item.name === name
          ? { name, status: "skipped", message: "No matching files were produced." }
          : item
      ),
      updatedAt: Date.now(),
    });
  }

  async setCacheOutcome(outcome: ActionCacheOutcome): Promise<void> {
    const run = await this.readRun();
    if (run) await this.saveRun({ ...run, cacheOutcome: outcome, updatedAt: Date.now() });
  }

  async markCacheSaved(): Promise<void> {
    const run = await this.readRun();
    const output = run?.outputs.find((item) => item.kind === "cache");
    if (!run || !output) return;
    await this.ctx.storage.delete(
      Array.from(
        { length: output.chunks },
        (_unused, index) => `${OUTPUT_CHUNK_PREFIX}${output.name}:${index}`
      )
    );
    await this.saveRun({
      ...run,
      outputs: run.outputs.filter((item) => item.name !== output.name),
      cacheOutcome: "saved",
      updatedAt: Date.now(),
    });
  }

  async markCacheFailed(): Promise<void> {
    const run = await this.readRun();
    const output = run?.outputs.find((item) => item.kind === "cache");
    if (!run) return;
    if (output) {
      await this.ctx.storage.delete(
        Array.from(
          { length: output.chunks },
          (_unused, index) => `${OUTPUT_CHUNK_PREFIX}${output.name}:${index}`
        )
      );
    }
    await this.saveRun({
      ...run,
      outputs: output ? run.outputs.filter((item) => item.name !== output.name) : run.outputs,
      cacheOutcome: "failed",
      updatedAt: Date.now(),
    });
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
                : "Action run exceeded 10 minutes.";
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
      if (container?.running) {
        this.ctx.waitUntil(
          container.destroy("Action run exceeded 10 minutes").catch((cause: unknown) => {
            const logger = createLogger(this.env.LOG_LEVEL, {
              service: "actions",
              repoId: started.repositoryId,
              doId: started.id,
            });
            logger.warn("actions:container-timeout-cleanup-failed", {
              reason: cause instanceof Error ? cause.message : "unknown",
            });
          })
        );
      }
    }, RUN_TIMEOUT_MS);
    const budget: OutputBudget = { used: 0, truncated: false };

    try {
      const container = this.ctx.container;
      if (!container) throw new Error("Action container binding is unavailable.");
      const plan = await this.ctx.storage.get<ActionJob[]>("runPlan");
      if (!plan || plan.length !== started.jobs.length)
        throw new Error("Action run plan is missing.");
      container.start({
        image: container.images.runtime,
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
      if (((await this.ctx.storage.get<number>("cacheChunkCount")) ?? 0) > 0) {
        try {
          await this.restoreCachedFiles(started.cachedArchiveSha256 ?? "");
          await this.setCacheOutcome("hit");
        } catch (cause) {
          const logger = createLogger(this.env.LOG_LEVEL, {
            service: "actions",
            repoId: started.repositoryId,
            doId: started.id,
          });
          logger.warn("actions:cache-restore-failed", {
            reason: cause instanceof Error ? cause.message : "unknown",
          });
          await this.setCacheOutcome("failed");
        }
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
            step.status === "completed"
              ? step
              : {
                  ...step,
                  status: "completed",
                  conclusion:
                    step.conclusion ??
                    (cancelled || jobConclusion === "success" ? "cancelled" : "failure"),
                  log:
                    step.status === "queued"
                      ? appendBounded(
                          "",
                          cancelled
                            ? "Not run because the run was cancelled."
                            : "Not run because an earlier step failed.",
                          budget
                        )
                      : step.log,
                }
          ),
        }));
        if (jobConclusion !== "success" || cancelled) break;
      }

      const beforeOutputCapture = await this.readRun();
      if (beforeOutputCapture && !beforeOutputCapture.cancelRequested)
        await this.captureOutputs(beforeOutputCapture, budget);
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
                        log: appendBounded(
                          "",
                          cancelled
                            ? "Not run because the run was cancelled."
                            : "Not run because an earlier step failed.",
                          budget
                        ),
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
            job.status !== "completed"
              ? {
                  ...job,
                  status: "completed",
                  conclusion: cancelled ? "cancelled" : "failure",
                  steps: job.steps.map((step) =>
                    step.status !== "completed"
                      ? {
                          ...step,
                          status: "completed",
                          conclusion: cancelled ? "cancelled" : "failure",
                          log:
                            step.status === "running"
                              ? appendBounded(
                                  step.log,
                                  cause instanceof Error
                                    ? cause.message
                                    : "Action execution failed.",
                                  budget
                                )
                              : appendBounded(
                                  "",
                                  cancelled
                                    ? "Not run because the run was cancelled."
                                    : "Not run because the run failed before this step started.",
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
    void process.exitCode
      .then(() => {
        if (this.activeProcess === process) {
          this.activeAbort = null;
          this.activeProcess = null;
        }
      })
      .catch((cause: unknown) => {
        const logger = createLogger(this.env.LOG_LEVEL, {
          service: "actions",
          doId: jobId || "run",
        });
        logger.warn("actions:process-exit-status-failed", {
          reason: cause instanceof Error ? cause.message : "unknown",
        });
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
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = decoder.decode();
            if (tail) {
              const formattedTail = label ? `${label}${tail}` : tail;
              const next = appendBounded(log, formattedTail, budget);
              const delta = next.slice(log.length);
              log = next;
              unflushedBytes += new TextEncoder().encode(delta).byteLength;
              if (label === "stderr: ") stderr += delta.replace(/^stderr: /, "");
            }
            return;
          }
          if (!value) continue;
          const text = decoder.decode(value, { stream: true });
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
      log = appendBounded(log, "\nAction run exceeded 10 minutes.", budget);
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

  private async restoreCachedFiles(expectedHash: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(expectedHash))
      throw new Error("Cache integrity metadata is invalid.");
    const container = this.ctx.container;
    if (!container?.running) throw new Error("Action container is not running.");
    const process = await container.exec(["node", "-e", RESTORE_CACHE_PROGRAM, expectedHash], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    const writer = process.stdin?.getWriter();
    if (!writer) throw new Error("Action cache input stream is unavailable.");
    const count = await this.ctx.storage.get<number>("cacheChunkCount");
    if (count === undefined) throw new Error("Action cache input is missing.");
    try {
      for (let index = 0; index < count; index += 1) {
        const value = await this.ctx.storage.get<string>(`${CACHE_CHUNK_PREFIX}${index}`);
        if (value === undefined) throw new Error("Action cache input is incomplete.");
        await writer.write(base64ToBytes(value));
      }
      await writer.close();
    } catch (cause) {
      await writer.abort(cause);
      throw cause;
    }
    let errorText = "";
    if (process.stderr) {
      const reader = process.stderr.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          errorText += new TextDecoder().decode(value);
          if (errorText.length > 4096) errorText = errorText.slice(-4096);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const exitCode = await process.exitCode;
    await this.ctx.storage.delete(
      Array.from({ length: count }, (_unused, index) => `${CACHE_CHUNK_PREFIX}${index}`)
    );
    await this.ctx.storage.delete("cacheChunkCount");
    if (exitCode !== 0) throw new Error(errorText || "Cache archive could not be restored safely.");
  }

  private async captureOutputs(run: StoredRun, budget: OutputBudget): Promise<void> {
    if (run.cachePaths.length && run.cacheKey) {
      try {
        await this.captureArchive("cache", "cache", run.cachePaths, budget);
      } catch (cause) {
        await this.setCacheOutcome("failed");
        createLogger(this.env.LOG_LEVEL, {
          service: "actions",
          repoId: run.repositoryId,
          doId: run.id,
        }).warn("actions:cache-capture-failed", {
          reason: cause instanceof Error ? cause.message : "unknown",
        });
      }
    }
    for (const artifact of run.artifactsToCapture) {
      try {
        await this.captureArchive(artifact.name, "artifact", artifact.paths, budget);
      } catch (cause) {
        await this.markArtifactFailed(
          artifact.name,
          cause instanceof Error ? cause.message : "Artifact capture failed."
        );
      }
    }
  }

  private async captureArchive(
    name: string,
    kind: ActionOutputMetadata["kind"],
    paths: readonly string[],
    budget: OutputBudget
  ): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running) throw new Error("Action container is not running.");
    const scan = await this.execBounded(
      ["node", "-e", SCAN_OUTPUT_PATHS_PROGRAM],
      { stdin: JSON.stringify(paths), stdout: "pipe", stderr: "pipe" },
      budget,
      "",
      undefined
    );
    if (scan.exitCode !== 0) throw new Error(scan.stderr || "Output paths could not be inspected.");
    let scanResult: { files: number; bytes: number; paths: string[] };
    try {
      scanResult = JSON.parse(scan.log) as { files: number; bytes: number; paths: string[] };
    } catch {
      throw new Error("Output path inspection returned invalid data.");
    }
    if (scanResult.files === 0) {
      if (kind === "artifact") await this.markArtifactSkipped(name);
      else await this.setCacheOutcome("miss");
      return;
    }
    const existing = (await this.readRun())?.outputs ?? [];
    const outputBytes = existing.reduce((total, item) => total + item.size, 0);
    if (outputBytes + scanResult.bytes > MAX_ARCHIVE_BYTES)
      throw new Error("Combined Action output exceeds 24 MiB.");
    const archivePath = `/tmp/gitedge-${crypto.randomUUID()}.tar.gz`;
    try {
      const tar = await this.execBounded(
        ["tar", "-czf", archivePath, "-C", "/workspace", "--", ...scanResult.paths],
        { stdout: "ignore", stderr: "pipe" },
        budget,
        "",
        undefined
      );
      if (tar.exitCode !== 0) throw new Error(tar.stderr || "Output archive could not be created.");
      const sizeResult = await this.execBounded(
        ["stat", "-c", "%s", archivePath],
        { stdout: "pipe", stderr: "pipe" },
        budget,
        "",
        undefined
      );
      if (sizeResult.exitCode !== 0) throw new Error("Output archive size could not be read.");
      const size = Number(sizeResult.log.trim());
      if (!Number.isSafeInteger(size) || size <= 0 || outputBytes + size > MAX_ARCHIVE_BYTES)
        throw new Error("Combined Action output exceeds 24 MiB.");
      const digestResult = await this.execBounded(
        ["sha256sum", archivePath],
        { stdout: "pipe", stderr: "pipe" },
        budget,
        "",
        undefined
      );
      const sha256 = digestResult.log.trim().split(/\s+/)[0] ?? "";
      if (digestResult.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(sha256))
        throw new Error("Output archive integrity could not be computed.");
      const metadata = await this.storeArchive(name, kind, archivePath, size, sha256);
      const current = await this.readRun();
      if (current)
        await this.saveRun({
          ...current,
          outputs: [...current.outputs, metadata],
          updatedAt: Date.now(),
        });
    } finally {
      const cleanup = await container.exec(["rm", "-f", archivePath], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await cleanup.exitCode;
    }
  }

  private async storeArchive(
    name: string,
    kind: ActionOutputMetadata["kind"],
    archivePath: string,
    expectedSize: number,
    sha256: string
  ): Promise<ActionOutputMetadata> {
    const container = this.ctx.container;
    if (!container?.running) throw new Error("Action container is not running.");
    const chunks = Math.ceil(expectedSize / OUTPUT_CHUNK_SIZE);
    if (chunks < 1 || chunks > MAX_ARCHIVE_CHUNKS)
      throw new Error("Output archive exceeds 24 MiB.");
    const process = await container.exec(["cat", archivePath], { stdout: "pipe", stderr: "pipe" });
    if (!process.stdout) throw new Error("Output archive stream is unavailable.");
    const reader = process.stdout.getReader();
    let carry = new Uint8Array(0);
    let total = 0;
    let index = 0;
    const save = async (bytes: Uint8Array): Promise<void> => {
      if (bytes.length === 0) return;
      await this.ctx.storage.put(`${OUTPUT_CHUNK_PREFIX}${name}:${index}`, bytesToBase64(bytes));
      index += 1;
      total += bytes.length;
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        let offset = 0;
        if (carry.length) {
          const take = Math.min(OUTPUT_CHUNK_SIZE - carry.length, value.length);
          const combined = new Uint8Array(carry.length + take);
          combined.set(carry);
          combined.set(value.subarray(0, take), carry.length);
          offset = take;
          carry = new Uint8Array(0);
          if (combined.length === OUTPUT_CHUNK_SIZE) await save(combined);
          else carry = combined;
        }
        while (offset + OUTPUT_CHUNK_SIZE <= value.length) {
          await save(value.subarray(offset, offset + OUTPUT_CHUNK_SIZE));
          offset += OUTPUT_CHUNK_SIZE;
        }
        if (offset < value.length) carry = value.slice(offset);
        if (total > expectedSize) throw new Error("Output archive exceeded its reported size.");
      }
      if (carry.length) await save(carry);
    } catch (cause) {
      await reader.cancel();
      await this.ctx.storage.delete(
        Array.from(
          { length: index },
          (_unused, chunkIndex) => `${OUTPUT_CHUNK_PREFIX}${name}:${chunkIndex}`
        )
      );
      throw cause;
    } finally {
      reader.releaseLock();
    }
    const exitCode = await process.exitCode;
    if (exitCode !== 0 || total !== expectedSize || index !== chunks) {
      await this.ctx.storage.delete(
        Array.from(
          { length: index },
          (_unused, chunkIndex) => `${OUTPUT_CHUNK_PREFIX}${name}:${chunkIndex}`
        )
      );
      throw new Error("Output archive stream was incomplete.");
    }
    return { name, kind, size: total, sha256, chunks };
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
    const cacheCount = await this.ctx.storage.get<number>("cacheChunkCount");
    if (cacheCount !== undefined && cacheCount > 0) {
      await this.ctx.storage.delete(
        Array.from({ length: cacheCount }, (_unused, index) => `${CACHE_CHUNK_PREFIX}${index}`)
      );
    }
    await this.ctx.storage.delete(["inputChunkCount", "cacheChunkCount", "runPlan"]);
  }

  private async readRun(): Promise<StoredRun | null> {
    const value: unknown = await this.ctx.storage.get(RUN_KEY);
    return isStoredRun(value) ? value : null;
  }

  private async saveRun(run: StoredRun): Promise<StoredRun> {
    return this.ctx.storage.transaction(async (txn) => {
      const currentValue: unknown = await txn.get(RUN_KEY);
      const current = isStoredRun(currentValue) ? currentValue : null;
      const saved: StoredRun = {
        ...(current?.status === "completed" ? current : run),
        cancelRequested: Boolean(current?.cancelRequested || run.cancelRequested),
        updatedAt: Date.now(),
      };
      await txn.put(RUN_KEY, saved);
      return saved;
    });
  }

  private async updateJob(id: string, update: (job: ActionRunJob) => ActionRunJob): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const value: unknown = await txn.get(RUN_KEY);
      if (!isStoredRun(value) || value.status === "completed") return;
      await txn.put(RUN_KEY, {
        ...value,
        jobs: value.jobs.map((job) => (job.id === id ? update(job) : job)),
        updatedAt: Date.now(),
      });
    });
  }

  private async updateStep(id: string, index: number, step: ActionRunStep): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const value: unknown = await txn.get(RUN_KEY);
      if (!isStoredRun(value) || value.status === "completed") return;
      await txn.put(RUN_KEY, {
        ...value,
        jobs: value.jobs.map((job) =>
          job.id === id
            ? { ...job, steps: job.steps.map((item, i) => (i === index ? step : item)) }
            : job
        ),
        updatedAt: Date.now(),
      });
    });
  }
}
