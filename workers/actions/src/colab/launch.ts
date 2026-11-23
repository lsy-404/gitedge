import { z } from "zod";
import { currentRunnerKit, type RunnerKitEnv } from "../runner-kit";

const NODE_VERSION = "v24.22.2";
const NODE_SHA256 = "48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75";
const ACTIONS_RUNNER_VERSION = "2.338.2";
const ACTIONS_RUNNER_SHA256 = "baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40";
const LAUNCHER_PATH = "scripts/runner-launcher.mjs";
export const STARTED_MARKER = "GITEDGE_RUNNER_STARTED";

const kitSchema = z.object({
  format: z.literal(1),
  files: z.array(z.object({ path: z.string(), data: z.string() })),
});

let cachedLauncher: { digest: string; data: string } | null = null;

/** Returns the current runner kit's launcher as base64, read once per kit digest per isolate. */
export async function currentLauncher(env: RunnerKitEnv): Promise<string> {
  const kit = await currentRunnerKit(env);
  if (!kit || !env.SIGNING_ARTIFACTS) throw new Error("No runner kit is published.");
  if (cachedLauncher?.digest === kit.digest) return cachedLauncher.data;
  const object = await env.SIGNING_ARTIFACTS.get(
    `runner-kit/${kit.digest.slice("sha256:".length)}`
  );
  if (!object) throw new Error("The runner kit object is missing.");
  const archive = kitSchema.parse(
    await new Response(object.body.pipeThrough(new DecompressionStream("gzip"))).json()
  );
  const launcher = archive.files.find((file) => file.path === LAUNCHER_PATH);
  if (!launcher) throw new Error("The runner kit has no launcher.");
  cachedLauncher = { digest: kit.digest, data: launcher.data };
  return launcher.data;
}

/** Python that installs Node and the official runner, then starts the launcher detached in Colab mode. */
export function launchCell({
  origin,
  bootstrapToken,
  launcher,
}: {
  origin: string;
  bootstrapToken: string;
  launcher: string;
}): string {
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
    "import base64, os, pathlib, subprocess",
    'root = pathlib.Path("/content/gitedge")',
    "root.mkdir(parents=True, exist_ok=True)",
    `(root / "runner-launcher.mjs").write_bytes(base64.b64decode("${launcher}"))`,
    `(root / "start.sh").write_text(${JSON.stringify(script)})`,
    `_gitedge_env = dict(os.environ, GITEDGE_COLAB_BOOTSTRAP_TOKEN="${bootstrapToken}")`,
    '_gitedge_log = open(root / "runner.log", "ab")',
    '_gitedge_runner = subprocess.Popen(["bash", str(root / "start.sh")], cwd=root, env=_gitedge_env, stdout=_gitedge_log, stderr=subprocess.STDOUT, start_new_session=True)',
    "del _gitedge_env",
    `print("${STARTED_MARKER}", _gitedge_runner.pid)`,
  ].join("\n");
}
