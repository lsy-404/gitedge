import { describe, expect, it } from "vitest";
import type { ActionJob } from "../../packages/contracts/src/actions";
import { ActionRun } from "../../workers/actions/src/run";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(keys: string | string[]): Promise<boolean> {
    const list = Array.isArray(keys) ? keys : [keys];
    let deleted = false;
    for (const key of list) deleted = this.values.delete(key) || deleted;
    return deleted;
  }

  async setAlarm(_timestamp: number): Promise<void> {}
}

function readable(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (value) controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function workflowJobs(run = "printf action-ok"): ActionJob[] {
  return [
    {
      id: "verify",
      name: "Verify",
      steps: [{ name: "Run", run, shell: "sh", workingDirectory: null, env: {} }],
    },
  ];
}

function actionInput(jobs = workflowJobs()) {
  return {
    id: "run-1",
    repositoryId: "repo-1",
    commitOid: "a".repeat(40),
    workflowPath: ".github/workflows/verify.yml",
    workflowName: "Verify",
    ref: "refs/heads/main",
    createdBy: "user-1",
    createdAt: Date.now(),
    enableInternet: false,
    jobs,
    fileCount: 1,
  };
}

function makeAction(options: { blockStep?: boolean } = {}) {
  const storage = new MemoryStorage();
  let running = false;
  let currentInput = "";
  let startedResolve = (): void => {};
  const stepStarted = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let stepExitResolve: (code: number) => void = () => {};
  let stepOutputController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const closeStepOutput = (): void => {
    if (!stepOutputController) return;
    try {
      stepOutputController.close();
    } catch {
      // The stream can close before a cancellation reaches the mock container.
    }
    stepOutputController = null;
  };
  const starts: Array<Record<string, unknown>> = [];
  const container = {
    get running() {
      return running;
    },
    start(startOptions: Record<string, unknown>) {
      starts.push(startOptions);
      running = true;
    },
    async exec(argv: string[]) {
      if (argv[0] === "node") {
        const stdin = new WritableStream<Uint8Array>({
          write(chunk) {
            currentInput += new TextDecoder().decode(chunk);
          },
        });
        return {
          stdin,
          stdout: null,
          stderr: readable(""),
          exitCode: Promise.resolve(0),
          kill() {},
        };
      }
      startedResolve();
      const stdout = options.blockStep
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              stepOutputController = controller;
            },
          })
        : readable("action-ok");
      const exitCode = options.blockStep
        ? new Promise<number>((resolve) => {
            stepExitResolve = resolve;
          })
        : Promise.resolve(0);
      return {
        stdin: null,
        stdout,
        stderr: readable(""),
        exitCode,
        kill() {
          closeStepOutput();
          stepExitResolve(137);
        },
      };
    },
    async destroy() {
      running = false;
      closeStepOutput();
      stepExitResolve(137);
    },
  };
  const context = { storage, container } as unknown as DurableObjectState;
  const action = new ActionRun(context, {} as Cloudflare.Env);
  return { action, starts, stepStarted, storage, getInput: () => currentInput };
}

describe("ActionRun Durable Object lifecycle", () => {
  it("runs a bounded step in an isolated managed container and persists its log", async () => {
    const fixture = makeAction();
    const files = [{ path: "package.json", contentBase64: "e30=", mode: "100644" }];
    const chunks = [JSON.stringify(files)];
    await fixture.action.initialize(actionInput(), chunks.length);
    await fixture.action.writeInputChunk(0, chunks[0] ?? "");
    await fixture.action.schedule();
    await fixture.action.alarm();

    const run = await fixture.action.getRun();
    expect(run?.status).toBe("completed");
    expect(run?.conclusion).toBe("success");
    expect(run?.jobs[0]?.steps[0]?.log).toContain("action-ok");
    expect(JSON.parse(fixture.getInput())).toEqual(files);
    expect(fixture.starts[0]).toMatchObject({
      image: "cloudflare/debian-trixie",
      instance: "lite",
      enableInternet: false,
    });
  });

  it("cancels the active command and records a cancelled run", async () => {
    const fixture = makeAction({ blockStep: true });
    const chunks = [JSON.stringify([{ path: "entry.js", contentBase64: "", mode: "100644" }])];
    await fixture.action.initialize(actionInput(workflowJobs("sleep 600")), chunks.length);
    await fixture.action.writeInputChunk(0, chunks[0] ?? "");
    await fixture.action.schedule();

    const executing = fixture.action.alarm();
    await fixture.stepStarted;
    await fixture.action.cancel();
    await executing;

    const run = await fixture.action.getRun();
    expect(run?.status).toBe("completed");
    expect(run?.conclusion).toBe("cancelled");
    expect(run?.jobs[0]?.steps[0]?.conclusion).toBe("cancelled");
  });

  it("finishes a run whose alarm state outlives the hard timeout", async () => {
    const fixture = makeAction();
    const chunks = [JSON.stringify([{ path: "entry.js", contentBase64: "", mode: "100644" }])];
    await fixture.action.initialize(actionInput(), chunks.length);
    await fixture.action.writeInputChunk(0, chunks[0] ?? "");
    const queued = await fixture.action.getRun();
    if (!queued) throw new Error("Expected a queued run.");
    await fixture.storage.put("run", {
      ...queued,
      status: "running",
      startedAt: Date.now() - 150_001,
      jobs: queued.jobs.map((job) => ({
        ...job,
        status: "running",
        steps: job.steps.map((step) => ({ ...step, status: "running" })),
      })),
    });

    const run = await fixture.action.failStaleRun();

    expect(run?.status).toBe("completed");
    expect(run?.conclusion).toBe("failure");
    expect(run?.jobs[0]?.steps[0]?.log).toContain("120 seconds");
  });

  it("terminates a queued run that never starts", async () => {
    const fixture = makeAction();
    const chunks = [JSON.stringify([{ path: "entry.js", contentBase64: "", mode: "100644" }])];
    await fixture.action.initialize(
      { ...actionInput(), createdAt: Date.now() - 150_001 },
      chunks.length
    );
    await fixture.action.writeInputChunk(0, chunks[0] ?? "");

    const run = await fixture.action.failStaleRun();

    expect(run?.status).toBe("completed");
    expect(run?.conclusion).toBe("failure");
    expect(run?.jobs[0]?.steps[0]?.log).toContain("did not start");
  });
});
