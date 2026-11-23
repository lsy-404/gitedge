import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

export const COLAB_MCP_SPEC = "git+https://github.com/googlecolab/colab-mcp@v1.0.2";
export const KIT_UPDATE_EXIT_STATUS = 75;
const NODE_VERSION = "v24.22.2";
const NODE_SHA256 = "48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75";
const ACTIONS_RUNNER_VERSION = "2.338.2";
const ACTIONS_RUNNER_SHA256 = "baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40";
const POLL_MS = 10_000;
const UNAUTHORIZED_RETRY_MS = 60_000;
const WATCH_MS = 60_000;
const CONNECT_ATTEMPTS = 3;
// colab-mcp waits 60 seconds for the page; allow for uvx resolving the server first.
const CONNECT_TIMEOUT_MS = 180_000;
const TOOLS_READY_MS = 30_000;
const CELL_TIMEOUT_MS = 120_000;
const STATUS_FAILURE_LIMIT = 3;
const TERMINAL_STATES = new Set(["finished", "failed", "cancelled"]);
// Notebook tools are served by the Colab page once it connects; they are not part of colab-mcp itself.
const REQUIRED_TOOLS = ["add_code_cell", "run_code_cell", "get_cells"];
const STARTED_MARKER = "GITEDGE_RUNNER_STARTED";
const EXIT_MARKER = /GITEDGE_RUNNER_EXIT=(-?\d+)/;
const launcherPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "runner-launcher.mjs");

const log = (message) => console.error(`[colab-waker] ${message}`);

export class ColabError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

async function api(profile, route, body, signal) {
  const response = await fetch(new URL(route, profile.origin), {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${profile.credential}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)].filter(Boolean)),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`GitEdge returned HTTP ${response.status} for ${route}.`);
    error.status = response.status;
    throw error;
  }
  return payload?.data;
}

function toolText(result) {
  return (result?.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function waitForTools(client, signal) {
  const deadline = Date.now() + TOOLS_READY_MS;
  while (Date.now() < deadline && !signal?.aborted) {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    if (REQUIRED_TOOLS.every((name) => byName.has(name))) return byName;
    await sleep(1_000, signal);
  }
  throw new ColabError("colab_tool_missing", REQUIRED_TOOLS.join(","));
}

// Starts colab-mcp, opens the Colab page in the host's signed-in browser and waits for its notebook tools.
export async function openColabSession({ uvx = "uvx", spec = COLAB_MCP_SPEC, logDir, signal }) {
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS && !signal?.aborted; attempt++) {
    const client = new Client({ name: "gitedge-colab-waker", version: "1.0.0" });
    let changed;
    const toolsChanged = new Promise((resolve) => (changed = resolve));
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => changed());
    const transport = new StdioClientTransport({
      command: uvx,
      args: [spec, ...(logDir ? ["--log", logDir] : [])],
      stderr: "ignore",
    });
    try {
      await client.connect(transport);
      const result = await client.callTool(
        { name: "open_colab_browser_connection", arguments: {} },
        undefined,
        { timeout: CONNECT_TIMEOUT_MS, signal }
      );
      const connected =
        result.structuredContent?.result === true || toolText(result).trim() === "true";
      if (connected) {
        await Promise.race([toolsChanged, sleep(5_000, signal)]);
        const tools = await waitForTools(client, signal);
        log(
          `connected to Colab on attempt ${attempt}; notebook tools: ${[...tools.keys()].join(", ")}.`
        );
        return { client, tools, close: () => client.close() };
      }
      log(`the Colab page did not connect (attempt ${attempt} of ${CONNECT_ATTEMPTS}).`);
    } catch (error) {
      await client.close().catch(() => {});
      if (error instanceof ColabError) throw error;
      log(`colab-mcp attempt ${attempt} failed: ${error.message}`);
      continue;
    }
    await client.close().catch(() => {});
  }
  throw new ColabError("colab_connection_failed");
}

async function callTool(session, name, args, timeout = CELL_TIMEOUT_MS) {
  const result = await session.client.callTool({ name, arguments: args }, undefined, { timeout });
  const text = toolText(result);
  if (result.isError) throw new ColabError("colab_tool_failed", `${name}: ${text.slice(0, 200)}`);
  return text;
}

async function readCells(session) {
  const cells = parseJson(await callTool(session, "get_cells", {}));
  return Array.isArray(cells) ? cells : (cells?.cells ?? []);
}

// Builds add_code_cell arguments from the schema the Colab page advertises.
async function cellArguments(session, code) {
  const schema = session.tools.get("add_code_cell")?.inputSchema ?? {};
  const properties = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return {
    code,
    ...("language" in properties ? { language: "python" } : {}),
    ...(required.includes("cellIndex") ? { cellIndex: (await readCells(session)).length } : {}),
  };
}

async function addCell(session, code) {
  const text = await callTool(session, "add_code_cell", await cellArguments(session, code));
  const added = parseJson(text);
  const id = added?.newCellId ?? added?.cellId ?? added?.id;
  if (typeof id === "string" && id) return id;
  const match = (await readCells(session)).find((cell) => cell?.code === code);
  if (typeof match?.cellId === "string") return match.cellId;
  throw new ColabError("colab_cell_unavailable");
}

// Returns the cell's output text, from the run result or from the notebook state.
async function runCell(session, cellId, marker) {
  const text = await callTool(session, "run_code_cell", { cellId });
  if (marker.test(text)) return text;
  const cell = (await readCells(session)).find((entry) => entry?.cellId === cellId);
  return JSON.stringify(cell?.outputs ?? []);
}

function launchCell({ origin, bootstrapToken, launcher }) {
  const script = [
    "set -euo pipefail",
    "cd /content/gitedge",
    "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
    `curl -fsSL -o node.tar.xz https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz`,
    `echo '${NODE_SHA256}  node.tar.xz' | sha256sum -c -`,
    "mkdir -p node official-runner state",
    "tar -xJf node.tar.xz -C node --strip-components=1",
    'export PATH="$PWD/node/bin:$PATH"',
    "corepack enable",
    `curl -fsSL -o runner.tar.gz https://github.com/actions/runner/releases/download/v${ACTIONS_RUNNER_VERSION}/actions-runner-linux-x64-${ACTIONS_RUNNER_VERSION}.tar.gz`,
    `echo '${ACTIONS_RUNNER_SHA256}  runner.tar.gz' | sha256sum -c -`,
    "tar -xzf runner.tar.gz -C official-runner",
    `exec node runner-launcher.mjs colab --origin '${origin}' --runner-path "$PWD/official-runner" --state-dir "$PWD/state"`,
    "",
  ].join("\n");
  return [
    "import base64, gzip, os, pathlib, subprocess",
    'root = pathlib.Path("/content/gitedge")',
    "root.mkdir(parents=True, exist_ok=True)",
    `(root / "runner-launcher.mjs").write_bytes(gzip.decompress(base64.b64decode("${launcher}")))`,
    `(root / "start.sh").write_text(${JSON.stringify(script)})`,
    `_gitedge_env = dict(os.environ, GITEDGE_COLAB_BOOTSTRAP_TOKEN="${bootstrapToken}")`,
    '_gitedge_log = open(root / "runner.log", "ab")',
    '_gitedge_runner = subprocess.Popen(["bash", str(root / "start.sh")], cwd=root, env=_gitedge_env, stdout=_gitedge_log, stderr=subprocess.STDOUT, start_new_session=True)',
    "del _gitedge_env",
    `print("${STARTED_MARKER}", _gitedge_runner.pid)`,
  ].join("\n");
}

const STATUS_CELL = [
  "_gitedge_code = _gitedge_runner.poll()",
  'print(open("/content/gitedge/runner.log", errors="replace").read()[-1500:])',
  'print("GITEDGE_RUNNER_RUNNING" if _gitedge_code is None else f"GITEDGE_RUNNER_EXIT={_gitedge_code}")',
].join("\n");

// Releases the Colab VM so a finished job stops consuming compute units.
const RELEASE_CELL = "from google.colab import runtime\nruntime.unassign()";

async function releaseRuntime(session) {
  try {
    const id = await addCell(session, RELEASE_CELL);
    await session.client
      .callTool({ name: "run_code_cell", arguments: { cellId: id } }, undefined, {
        timeout: 20_000,
      })
      .catch(() => {});
  } catch (error) {
    log(`could not release the Colab runtime: ${error.message}`);
  }
}

async function runDispatch({ profile, dispatch, uvx, spec, logDir, signal }) {
  const route = `/api/actions/runner/colab/dispatches/${dispatch.id}`;
  const report = (body) => api(profile, route, body, signal);
  let reported = false;
  const finish = async (state, error) => {
    if (reported) return;
    reported = true;
    await report({ state, ...(error ? { error } : {}) }).catch((cause) =>
      log(`could not report dispatch ${dispatch.id}: ${cause.message}`)
    );
  };
  log(`dispatch ${dispatch.id} claimed for ${dispatch.jobKind} job ${dispatch.jobId}.`);
  let session;
  try {
    await report({ state: "starting" });
    session = await openColabSession({ uvx, spec, logDir, signal });
    const launcher = gzipSync(await readFile(launcherPath)).toString("base64");
    const launchId = await addCell(
      session,
      launchCell({ origin: profile.origin, bootstrapToken: dispatch.bootstrapToken, launcher })
    );
    const started = await runCell(session, launchId, new RegExp(STARTED_MARKER));
    if (!started.includes(STARTED_MARKER)) throw new ColabError("colab_launch_failed");
    log(`dispatch ${dispatch.id}: the Colab runner is starting.`);
    const statusId = await addCell(session, STATUS_CELL);
    let failures = 0;
    while (true) {
      await sleep(WATCH_MS, signal);
      if (signal?.aborted) throw new ColabError("colab_waker_stopped");
      const view = await report({});
      if (TERMINAL_STATES.has(view?.state)) {
        reported = true;
        log(`dispatch ${dispatch.id} is ${view.state}${view.error ? ` (${view.error})` : ""}.`);
        break;
      }
      let output;
      try {
        output = await runCell(session, statusId, EXIT_MARKER);
        failures = 0;
      } catch (error) {
        if (++failures >= STATUS_FAILURE_LIMIT)
          throw new ColabError("colab_connection_lost", error.message);
        continue;
      }
      const exit = EXIT_MARKER.exec(output);
      if (exit) {
        const code = Number(exit[1]);
        log(`dispatch ${dispatch.id}: the Colab runner exited with status ${code}.`);
        await finish(
          code === 0 ? "finished" : "failed",
          code === 0 ? undefined : `colab_runner_exit_${Math.abs(code)}`
        );
        break;
      }
      if (Date.now() > dispatch.expiresAt) throw new ColabError("colab_session_expired");
    }
  } catch (error) {
    const reason = error instanceof ColabError ? error.reason : "colab_session_failed";
    log(`dispatch ${dispatch.id} failed: ${error.message}`);
    await finish("failed", reason);
  } finally {
    if (session) {
      await releaseRuntime(session);
      await session.close().catch(() => {});
    }
  }
}

// Claims Colab dispatches for this host's account one at a time until stopped or a new kit is published.
export async function runColabWaker({ profile, kitDigest, uvx, spec, logDir, signal }) {
  log(`waiting for Colab dispatches from ${profile.origin}.`);
  while (!signal.aborted) {
    let claim;
    try {
      claim = await api(profile, "/api/actions/runner/colab/claim", {}, signal);
    } catch (error) {
      if (signal.aborted) break;
      log(error.message);
      await sleep(error.status === 401 ? UNAUTHORIZED_RETRY_MS : POLL_MS, signal);
      continue;
    }
    if (kitDigest && claim?.kit?.digest && claim.kit.digest !== kitDigest && !claim.dispatch) {
      log(`runner kit ${claim.kit.digest} is published; restarting.`);
      return KIT_UPDATE_EXIT_STATUS;
    }
    if (!claim?.dispatch) {
      await sleep(POLL_MS, signal);
      continue;
    }
    await runDispatch({ profile, dispatch: claim.dispatch, uvx, spec, logDir, signal });
  }
  return 0;
}
