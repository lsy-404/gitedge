import { afterEach, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { GIT_TRANSFER_PROGRAM } from "../../workers/actions/src/git-transfer-program";
import { GitTransfer, handleGitTransfer } from "../../workers/actions/src/git-transfer";

const resources: Array<{ root: string; server: Server }> = [];
const environment = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(directory: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], {
    env: environment,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

afterEach(async () => {
  for (const { root, server } of resources.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(large = false) {
  const temporary = path.resolve(import.meta.dirname, "../tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "git-transfer-"));
  const source = path.join(root, "source.git"),
    destination = path.join(root, "destination.git"),
    local = path.join(root, "local"),
    execution = path.join(root, "execution");
  for (const directory of [source, destination, local, execution]) await mkdir(directory);
  git(source, "init", "--bare", "--initial-branch=main");
  git(destination, "init", "--bare", "--initial-branch=main");
  git(destination, "config", "http.receivepack", "true");
  git(local, "init", "--initial-branch=main");
  git(local, "config", "user.name", "Author");
  git(local, "config", "user.email", "author@example.test");
  await writeFile(path.join(local, "input.bin"), large ? randomBytes(13 * 1024 * 1024) : "base");
  git(local, "add", ".");
  git(local, "commit", "-m", "Base");
  const base = git(local, "rev-parse", "HEAD");
  git(local, "push", destination, "HEAD:refs/heads/main");
  const history = [base];
  for (const name of ["middle", "head"]) {
    await writeFile(path.join(local, name), name);
    git(local, "add", ".");
    git(local, "commit", "-m", name);
    history.push(git(local, "rev-parse", "HEAD"));
  }
  git(local, "tag", "-a", "release", "-m", "Release");
  git(local, "push", source, "HEAD:refs/heads/main", "refs/tags/release:refs/tags/release");
  let rejectedSecret: string | undefined;
  let sourceDelay = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (sourceDelay && url.pathname.startsWith("/source.git/")) {
      const delay = sourceDelay;
      sourceDelay = 0;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        response.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (response.destroyed) return;
    }
    if (rejectedSecret && url.pathname.startsWith("/source.git/")) {
      const pkt = (text: string) => (text.length + 4).toString(16).padStart(4, "0") + text;
      response.setHeader("Content-Type", "application/x-git-upload-pack-advertisement");
      response.end(
        pkt("# service=git-upload-pack\n") + "0000" + pkt(`ERR ${rejectedSecret}\n`) + "0000"
      );
      return;
    }
    const backend = spawn("git", ["http-backend"], {
      env: {
        ...environment,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: request.headers["content-length"] ?? "",
        REMOTE_ADDR: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    request.pipe(backend.stdin);
    const chunks: Buffer[] = [];
    backend.stdout.on("data", (chunk) => chunks.push(chunk));
    backend.on("close", () => {
      const bytes = Buffer.concat(chunks),
        split = bytes.indexOf("\r\n\r\n");
      if (split < 0) {
        response.writeHead(500);
        response.end();
        return;
      }
      for (const header of bytes.subarray(0, split).toString().split("\r\n")) {
        const colon = header.indexOf(":");
        const name = header.slice(0, colon),
          value = header.slice(colon + 1).trim();
        if (name === "Status") response.statusCode = Number(value.slice(0, 3));
        else response.setHeader(name, value);
      }
      response.end(bytes.subarray(split + 4));
    });
  });
  resources.push({ root, server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener is missing.");
  const origin = `http://127.0.0.1:${address.port}`;
  const plan = {
    source: { url: `${origin}/source.git`, authorization: "Bearer fixture" },
    destination: { url: `${origin}/destination.git`, authorization: "Bearer fixture" },
    ref: "refs/heads/main",
    targetRef: "refs/heads/main",
    before: base,
    after: history[2]!,
  };
  async function execute(operation: "prepare" | "push", selected = plan) {
    const process = spawn(globalThis.process.execPath, ["-e", GIT_TRANSFER_PROGRAM], {
      cwd: execution,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    process.stdout.on("data", (chunk) => chunks.push(chunk));
    process.stderr.on("data", (chunk) => errors.push(chunk));
    process.stdin.end(JSON.stringify({ operation, plan: selected }));
    const code = await new Promise<number | null>((resolve, reject) => {
      process.once("error", reject);
      process.once("close", resolve);
    });
    if (code !== 0) throw new Error(Buffer.concat(errors).toString());
    return JSON.parse(Buffer.concat(chunks).toString()) as { status: string; diagnostic?: string };
  }
  return {
    source,
    destination,
    local,
    execution,
    history,
    plan,
    execute,
    rejectSource(secret: string) {
      rejectedSecret = secret;
    },
    delaySource(milliseconds: number) {
      sourceDelay = milliseconds;
    },
  };
}

it("transfers full history when upstream Git negotiation takes one minute", async () => {
  const f = await fixture();
  f.delaySource(60_000);
  expect(await f.execute("prepare")).toEqual({ status: "ready" });
  expect(await f.execute("push")).toEqual({ status: "synced" });
  expect(git(f.destination, "rev-list", "main").split("\n")).toEqual([...f.history].reverse());
}, 75_000);

it("transfers complete history containing an incompressible blob above 12 MiB", async () => {
  const f = await fixture(true);
  expect(await f.execute("prepare")).toEqual({ status: "ready" });
  expect(await f.execute("push")).toEqual({ status: "synced" });
  expect(git(f.destination, "rev-list", "main").split("\n")).toEqual([...f.history].reverse());
  expect(git(f.destination, "cat-file", "-s", "main:input.bin")).toBe(String(13 * 1024 * 1024));
  expect(git(f.destination, "fsck", "--full")).toBe("");
}, 30_000);

it("preserves the annotated tag object and its reachable history", async () => {
  const f = await fixture();
  const tag = git(f.source, "rev-parse", "refs/tags/release");
  const plan = {
    ...f.plan,
    ref: "refs/tags/release",
    targetRef: "refs/tags/release",
    before: "0".repeat(40),
    after: tag,
  };
  expect(await f.execute("prepare", plan)).toEqual({ status: "ready" });
  expect(await f.execute("push", plan)).toEqual({ status: "synced" });
  expect(git(f.destination, "rev-parse", "refs/tags/release")).toBe(tag);
  expect(git(f.destination, "cat-file", "-t", tag)).toBe("tag");
  expect(git(f.destination, "rev-list", "release").split("\n")).toEqual([...f.history].reverse());
});

it("rejects a destination changed after prepare even when the proposed push would fast-forward", async () => {
  const f = await fixture();
  expect(await f.execute("prepare")).toEqual({ status: "ready" });
  git(f.local, "push", f.destination, `${f.history[1]}:refs/heads/main`);
  expect(await f.execute("push")).toEqual({ status: "conflict" });
  expect(git(f.destination, "rev-parse", "main")).toBe(f.history[1]);
});

it("refuses divergent histories without overwriting the destination", async () => {
  const f = await fixture();
  git(f.local, "checkout", "--detach", f.history[0]!);
  await writeFile(path.join(f.local, "destination-only"), "keep");
  git(f.local, "add", ".");
  git(f.local, "commit", "-m", "Destination change");
  const destination = git(f.local, "rev-parse", "HEAD");
  git(f.local, "push", f.destination, "HEAD:refs/heads/main");
  const plan = { ...f.plan, before: destination };
  expect(await f.execute("prepare", plan)).toEqual({ status: "ready" });
  expect(await f.execute("push", plan)).toEqual({ status: "conflict" });
  expect(git(f.destination, "rev-parse", "main")).toBe(destination);
});

it("reports a source ref that no longer names the requested commit as stale", async () => {
  const f = await fixture();
  expect(await f.execute("prepare", { ...f.plan, after: f.history[1]! })).toEqual({
    status: "stale",
  });
  expect(git(f.destination, "rev-parse", "main")).toBe(f.history[0]);
});

it("redacts the decoded HTTP credential from bounded native Git failure diagnostics", async () => {
  const f = await fixture();
  const secret = "never-print-this-password";
  f.rejectSource(secret + "x".repeat(2000));
  const result = await f.execute("prepare", {
    ...f.plan,
    source: {
      ...f.plan.source,
      authorization: `Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`,
    },
  });
  expect(result.status).toBe("failed");
  expect(result.diagnostic).toContain("[REDACTED]");
  expect(result.diagnostic).not.toContain(secret);
  expect(Buffer.byteLength(result.diagnostic!)).toBeLessThanOrEqual(1024);
});

it("rejects access to the internal transfer service through a public hostname", async () => {
  const response = await handleGitTransfer(
    new Request("https://public.example.test/internal/git-transfer", {
      method: "POST",
      body: "{}",
    }),
    {} as Parameters<typeof handleGitTransfer>[1]
  );
  expect(response.status).toBe(404);
});

it("keeps credentials out of durable state and destroys completed or abandoned transfers", async () => {
  const values = new Map<string, unknown>();
  let alarm: number | null = null,
    running = false,
    executions = 0,
    destructions = 0;
  const ctx = {
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      setAlarm: async (time: number) => {
        alarm = time;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
      deleteAll: async () => {
        values.clear();
      },
    },
    container: {
      images: { runtime: "fixture" },
      get running() {
        return running;
      },
      start() {
        running = true;
      },
      async setInactivityTimeout() {},
      async destroy() {
        running = false;
        destructions++;
      },
      async exec() {
        executions++;
        let controller: ReadableStreamDefaultController<Uint8Array>;
        let input = "";
        return {
          stdin: new WritableStream<Uint8Array>({
            write(chunk) {
              input += new TextDecoder().decode(chunk);
            },
            close() {
              const { operation } = JSON.parse(input);
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({ status: operation === "prepare" ? "ready" : "synced" })
                )
              );
              controller.close();
            },
          }),
          stdout: new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          }),
          stderr: null,
          exitCode: Promise.resolve(0),
        };
      },
    },
  } as unknown as DurableObjectState;
  const plan = {
    source: {
      url: "https://source.example.test/repo.git",
      authorization: "Bearer fixture-secret-source",
    },
    destination: {
      url: "https://destination.example.test/repo.git",
      authorization: "Bearer fixture-secret-destination",
    },
    ref: "refs/heads/main",
    targetRef: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
  };
  const transfer = new GitTransfer(ctx, {});
  expect(await transfer.prepare(plan)).toEqual({ status: "ready" });
  expect(JSON.stringify([...values.values()])).not.toContain("fixture-secret");
  expect(alarm).toBeGreaterThan(Date.now());
  await expect(transfer.push({ ...plan, targetRef: "refs/heads/other" })).rejects.toThrow(
    "does not match"
  );
  expect(executions).toBe(1);
  expect(await transfer.push(plan)).toEqual({ status: "synced" });
  expect({ running, alarm, entries: values.size, destructions }).toEqual({
    running: false,
    alarm: null,
    entries: 0,
    destructions: 1,
  });
  await transfer.prepare(plan);
  await transfer.alarm();
  expect({ running, alarm, entries: values.size, destructions }).toEqual({
    running: false,
    alarm: null,
    entries: 0,
    destructions: 2,
  });
});
