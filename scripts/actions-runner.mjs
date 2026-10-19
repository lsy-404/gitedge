import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseDocument, stringify } from "yaml";

const VERSION = "3.14.0";
const RELEASE = `https://github.com/ChristopherHX/runner.server/releases/download/v${VERSION}`;
const ASSETS = {
  "darwin-arm64": [
    "osx-arm64.tar.gz",
    "e31fa749cb5ed1b2f16905946dc1c5feb34ae76b3ae33e1cead5b018980fed9e",
  ],
  "darwin-x64": [
    "osx-x64.tar.gz",
    "ef9dd1a68dc8183218087454491aa656074811ebf24cf901c92cb39cae5a95d8",
  ],
  "linux-arm64": [
    "linux-arm64.tar.gz",
    "07e7e8b5b2e97663ba819416544b424909b57440305bb25694604c9cc2688aa6",
  ],
  "linux-x64": [
    "linux-x64.tar.gz",
    "602434400ca09af9ea94c5351bd4b97bf40dcda66142fa2e0e9180c63ec239ca",
  ],
  "win32-arm64": [
    "win-arm64.zip",
    "90af04004fcb06d4e49ffd8dca92c7697ef44efb1a8010fa453f23689d34b2f3",
  ],
  "win32-x64": ["win-x64.zip", "a34da19e8a00e1914728ab2c68a0f0b9c3c54dbd68b92bd8c633f153bc9d1c32"],
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = (name) => `${name}${process.platform === "win32" ? ".exe" : ""}`;
const children = new Set();
const controller = new AbortController();
let stopping;

function launch(command, args, options = {}) {
  controller.signal.throwIfAborted();
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    ...options,
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
  child.completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  });
  child.completion.catch(() => {});
  return child;
}

async function command(command, args, options) {
  const child = launch(command, args, options);
  let timer;
  let onAbort;
  try {
    const code = await Promise.race([
      child.completion,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${path.basename(command)} timed out.`)), 60_000);
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (code !== 0) throw new Error(`${path.basename(command)} exited with status ${code}.`);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

async function stopChildren() {
  if (stopping) return stopping;
  stopping = (async () => {
    for (const child of [...children].reverse()) {
      if (!child.pid || !children.has(child)) continue;
      try {
        if (process.platform === "win32") {
          await new Promise((resolve) => {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
            });
            killer.once("error", resolve);
            killer.once("close", resolve);
          });
        } else process.kill(-child.pid, "SIGINT");
      } catch {}
      await Promise.race([
        child.completion.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000).unref()),
      ]);
      if (children.has(child) && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        await child.completion.catch(() => {});
      }
    }
  })();
  try {
    await stopping;
  } finally {
    stopping = undefined;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    controller.abort();
    void stopChildren();
  });
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function installRuntime(state) {
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error("This operating system or CPU has no pinned runtime package.");
  const [suffix, expected] = asset;
  const destination = path.join(state, "runtime", VERSION, `${process.platform}-${process.arch}`);
  const receipt = path.join(destination, "gitedge-runtime.json");
  try {
    const installed = JSON.parse(await readFile(receipt, "utf8"));
    if (installed.sha256 !== expected)
      throw new Error("The runtime receipt does not match the pinned package.");
    await access(path.join(destination, executable("Runner.Client")), constants.X_OK);
    return destination;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(destination), ".install-"));
  try {
    const archive = path.join(staging, "package");
    const response = await fetch(`${RELEASE}/runner.server-${suffix}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok || !response.body)
      throw new Error(`Runtime download failed: HTTP ${response.status}.`);
    let received = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, done) {
          received += chunk.length;
          done(
            received > 128 * 1024 * 1024 ? new Error("Runtime package exceeds 128 MiB.") : null,
            chunk
          );
        },
      }),
      createWriteStream(archive, { flags: "wx", mode: 0o600 })
    );
    if ((await digest(archive)) !== expected)
      throw new Error("Runtime SHA-256 verification failed.");
    const extracted = path.join(staging, "runtime");
    await mkdir(extracted);
    await command("tar", ["-xf", archive, "-C", extracted]);
    await access(path.join(extracted, executable("Runner.Client")), constants.X_OK);
    await writeFile(
      path.join(extracted, "gitedge-runtime.json"),
      JSON.stringify({ version: VERSION, sha256: expected }) + "\n"
    );
    await rename(extracted, destination);
    console.log(`Installed Runner.Server ${VERSION}; SHA-256 verified.`);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function originValue(value) {
  const url = new URL(value);
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.hostname.endsWith(".localhost");
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("--origin must be an HTTPS origin, or an HTTP loopback origin.");
  return url;
}

function validateWorkflow(source, origin) {
  const document = parseDocument(source, { schema: "core", uniqueKeys: true });
  if (document.errors.length) throw new Error("The workflow is not valid YAML.");
  const workflow = document.toJS({ maxAliasCount: 100 });
  if (
    !workflow ||
    typeof workflow !== "object" ||
    !workflow.jobs ||
    typeof workflow.jobs !== "object"
  )
    throw new Error("The workflow must define jobs.");
  const github = origin.hostname === "github.com" || origin.hostname.endsWith(".ghe.com");
  if (!github) {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of Array.isArray(job?.steps) ? job.steps : []) {
        if (
          typeof step?.uses === "string" &&
          /^actions\/(?:upload|download)-artifact@/.test(step.uses)
        )
          throw new Error(
            `Unsupported action on this origin: ${step.uses}. The unmodified artifact package rejects custom GitHub hosts; artifact host compatibility is not yet verified.`
          );
      }
    }
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function ready(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted();
    if (child.exitCode !== null)
      throw new Error("The local execution service stopped before it was ready.");
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch (error) {
      if (controller.signal.aborted) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The local execution service did not become ready within 60 seconds.");
}

async function runWorkflow(values, state) {
  if (
    !values.origin ||
    !values.repository ||
    !values.workflow ||
    !values["runner-path"] ||
    !values.sha ||
    !values.ref
  )
    throw new Error(
      "run requires --origin, --repository, --workflow, --runner-path, --sha and --ref."
    );
  const origin = originValue(values.origin);
  if (
    !/^[^/\\\s]+\/[^/\\\s]+$/.test(values.repository) ||
    values.repository.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("--repository must be owner/name.");
  if (!/^[0-9a-f]{40}$/.test(values.sha) || !/^refs\/(?:heads|tags)\/.+/.test(values.ref))
    throw new Error("--sha must be a complete commit ID and --ref must be a branch or tag ref.");
  const timeout = Number(values["timeout-minutes"] ?? "60");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 360)
    throw new Error("--timeout-minutes must be between 1 and 360.");
  const workflowPath = path.resolve(values.workflow);
  if ((await stat(workflowPath)).size > 1024 * 1024)
    throw new Error("Workflow files are limited to 1 MiB.");
  const source = await readFile(workflowPath, "utf8");
  if (Buffer.byteLength(source) > 1024 * 1024)
    throw new Error("Workflow files are limited to 1 MiB.");
  validateWorkflow(source, origin);
  const native = path.resolve(values["runner-path"]);
  await access(path.join(native, "bin", executable("Runner.Listener")), constants.X_OK);
  await mkdir(path.join(state, "runs"), { recursive: true });
  const run = await mkdtemp(path.join(state, "runs", "run-"));
  const runner = path.join(run, "runner");
  const backend = `http://127.0.0.1:${await freePort()}`;
  const runnerName = `gitedge-${randomUUID().slice(0, 8)}`;
  const registrationToken = randomBytes(32).toString("hex");
  const api =
    origin.hostname === "github.com" ? "https://api.github.com" : `${origin.origin}/api/v3`;
  const graph =
    origin.hostname === "github.com"
      ? "https://api.github.com/graphql"
      : `${origin.origin}/api/graphql`;
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /^(?:gh_token|github_token|gh_enterprise_token|github_enterprise_token|gitedge_token)$/i.test(
        key
      )
    )
      delete environment[key];
  }
  const token = process.env.GITEDGE_TOKEN;
  if (token && /\s/.test(token)) throw new Error("GITEDGE_TOKEN must not contain whitespace.");
  const ghConfig = path.join(run, "gh-config");
  environment.GH_CONFIG_DIR = ghConfig;
  environment.GH_HOST = origin.host;
  if (token) environment.github_token = token;
  const secretDocument = parseDocument(
    values["secret-file"] ? await readFile(path.resolve(values["secret-file"]), "utf8") : "{}",
    { uniqueKeys: true }
  );
  if (secretDocument.errors.length) throw new Error("--secret-file is not valid YAML.");
  const secrets = secretDocument.toJS({ maxAliasCount: 100 });
  if (
    !secrets ||
    typeof secrets !== "object" ||
    Array.isArray(secrets) ||
    Object.values(secrets).some((value) => typeof value !== "string")
  )
    throw new Error("--secret-file must contain a YAML mapping of string values.");
  if (token) secrets.GITHUB_TOKEN = token;
  const secretFile = path.join(run, "secrets.yml");
  const envFile = path.join(run, "environment");
  const configFile = path.join(run, "server.json");
  try {
    const runtime = await installRuntime(state);
    await mkdir(ghConfig, { mode: 0o700 });
    await cp(path.join(native, "bin"), path.join(runner, "bin"), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
    await symlink(
      path.join(native, "externals"),
      path.join(runner, "externals"),
      process.platform === "win32" ? "junction" : "dir"
    );
    for (const name of ["Runner.Client", "Runner.Server", "Runner.Listener"]) {
      await writeFile(
        path.join(runtime, `${executable(name)}.portable.config`),
        JSON.stringify({ StoragePath: path.join(state, "backend") })
      );
    }
    await writeFile(secretFile, stringify(secrets), { mode: 0o600 });
    const variables = {
      GH_HOST: origin.host,
      GITHUB_API_URL: api,
      ...(token
        ? { [origin.hostname === "github.com" ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN"]: token }
        : {}),
    };
    await writeFile(
      envFile,
      Object.entries(variables)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
      { mode: 0o600 }
    );
    await writeFile(
      configFile,
      JSON.stringify({
        Logging: { LogLevel: { Default: "Warning", "Microsoft.Hosting.Lifetime": "Information" } },
        Kestrel: { Endpoints: { Http: { Url: backend } } },
        ConnectionStrings: { sqlite: `Data Source=${path.join(state, "backend", "runs.sqlite")}` },
        "Runner.Server": {
          GitServerUrl: origin.origin,
          GitApiServerUrl: api,
          GitGraphQlServerUrl: graph,
          RUNNER_TOKEN: registrationToken,
          QueueJobsWithoutRunnerAvailable: true,
          ActionDownloadUrls: [
            {
              TarballUrl: "https://api.github.com/repos/{0}/tarball/{1}",
              ZipballUrl: "https://api.github.com/repos/{0}/zipball/{1}",
              GitApiServerUrl: "https://api.github.com",
              GITHUB_TOKEN: "",
            },
          ],
        },
      }),
      { mode: 0o600 }
    );
    await mkdir(path.join(state, "backend"), { recursive: true, mode: 0o700 });
    const service = launch(path.join(runtime, executable("Runner.Server")), [], {
      cwd: runtime,
      env: { ...environment, RUNNER_SERVER_APP_JSON_SETTINGS_FILE: configFile },
    });
    await ready(backend, service);
    await command(
      path.join(runtime, executable("Runner.Listener")),
      ["configure", "--unattended", "--disableupdate"],
      {
        cwd: runner,
        env: {
          ...environment,
          RUNNER_SERVER_CONFIG_ROOT: runner,
          ACTIONS_RUNNER_INPUT_URL: `${backend}/runner/server`,
          ACTIONS_RUNNER_INPUT_TOKEN: registrationToken,
          ACTIONS_RUNNER_INPUT_NAME: runnerName,
          ACTIONS_RUNNER_INPUT_WORK: "_work",
          ...(values.label?.length ? { ACTIONS_RUNNER_INPUT_LABELS: values.label.join(",") } : {}),
        },
      }
    );
    const listener = launch(path.join(runner, "bin", executable("Runner.Listener")), ["run"], {
      cwd: runner,
      env: environment,
    });
    await ready(
      `${backend}/_apis/v1/Message/isagentonline?name=${encodeURIComponent(runnerName)}`,
      listener
    );
    const args = [
      "--server",
      backend,
      "--workflow",
      workflowPath,
      "--event",
      values.event ?? "push",
      "--repository",
      values.repository,
      "--sha",
      values.sha,
      "--ref",
      values.ref,
      "--remote-checkout",
      "--secret-file",
      secretFile,
      "--env-file",
      envFile,
      "--log-output-dir",
      path.join(run, "logs"),
      "--artifact-output-dir",
      path.join(run, "artifacts"),
    ];
    if (token) args.push("--secret", "github_token");
    if (values.job) args.push("--job", values.job);
    const client = launch(path.join(runtime, executable("Runner.Client")), args, {
      cwd: process.cwd(),
      env: environment,
    });
    const watchdog = setTimeout(
      () => controller.abort(new Error("The workflow exceeded --timeout-minutes.")),
      timeout * 60_000
    );
    const abort = new Promise((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      })
    );
    try {
      const code = await Promise.race([
        client.completion,
        abort,
        service.completion.then(() => {
          throw new Error("The execution service stopped during the workflow.");
        }),
        listener.completion.then(() => {
          throw new Error("The runner stopped during the workflow.");
        }),
      ]);
      process.exitCode = code;
      console.log(`Workflow finished with status ${code}. Logs and artifacts: ${run}`);
    } finally {
      clearTimeout(watchdog);
    }
  } finally {
    await stopChildren();
    await Promise.all(
      [runner, secretFile, envFile, configFile, ghConfig].map((file) =>
        rm(file, { recursive: true, force: true })
      )
    );
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      origin: { type: "string" },
      repository: { type: "string" },
      workflow: { type: "string" },
      "runner-path": { type: "string" },
      sha: { type: "string" },
      ref: { type: "string" },
      event: { type: "string" },
      job: { type: "string" },
      label: { type: "string", multiple: true },
      "secret-file": { type: "string" },
      "state-dir": { type: "string" },
      "timeout-minutes": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const action = positionals[0];
  if (values.help || !action) {
    console.log(
      "Usage: pnpm run actions setup|run [options]\n\nrun --origin <origin> --repository <owner/name> --workflow <file>\n    --runner-path <official-runner-directory> --sha <commit> --ref <refs/heads/main>\n    [--label <label>] [--event push] [--job <id>] [--secret-file <yaml>]\n    [--state-dir <directory>] [--timeout-minutes 60]\n\nGITEDGE_TOKEN supplies the scoped access token. Execution uses the current host.\nThe official runner is copied into an isolated directory; existing services are untouched."
    );
    return;
  }
  if (positionals.length !== 1 || !["setup", "run"].includes(action))
    throw new Error("Expected setup or run.");
  const state = path.resolve(values["state-dir"] ?? path.join(root, "work", "actions"));
  await mkdir(state, { recursive: true, mode: 0o700 });
  const lockPath = path.join(state, "active.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST")
      throw new Error(
        `This state directory is already in use. Inspect ${lockPath} before removing a stale lock.`
      );
    throw error;
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    if (action === "setup") console.log(`Runtime ready: ${await installRuntime(state)}`);
    else await runWorkflow(values, state);
  } finally {
    await stopChildren();
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Actions execution failed.");
  process.exitCode = controller.signal.aborted ? 130 : 1;
});
