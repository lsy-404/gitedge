import { z } from "zod";
import type { TrustedUser } from "../../../packages/contracts/src/index";
import { parseJobClaim } from "../../../packages/contracts/runner-scheduling.mjs";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { GithubApiError, githubRepoPath, githubRequest } from "./github-client";
import { githubCredentials, type GithubConnectionRow } from "./github-sync-store";
import type { ForgeEnv } from "./common";

const NAME = "gitedge-emergency-runners";
const FILE = ".github/workflows/hosted-runner.yml";
const GitHubUser = z.object({ id: z.number().int().positive(), login: z.string().min(1) });
const GitHubRepo = z.object({
  id: z.number().int().positive(),
  full_name: z.string(),
  private: z.literal(true),
  archived: z.literal(false),
  default_branch: z.string(),
  owner: GitHubUser,
});
const SettingsInput = z
  .object({ connectionId: z.string().min(1).max(100), includedOnlyConfirmed: z.literal(true) })
  .strict();
const Operation = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("dispatch"),
      reservationId: z.string().min(1),
      bootstrapToken: z.string().min(1).max(256),
    })
    .strict(),
  z.object({ operation: z.literal("cancel"), reservationId: z.string().min(1) }).strict(),
]);
type Settings = {
  owner_id: string;
  connection_id: string;
  github_owner_id: number;
  github_repository_id: number;
  github_repository: string;
  enabled_at: number;
};
type Reservation = {
  id: string;
  job_kind: "gitedge" | "github";
  job_id: string;
  repository_id: string;
  owner_id: string;
  connection_id: string;
  status: string;
  expires_at: number;
  github_run_id: string | null;
  github_repository_id: string | null;
  github_repository: string | null;
};
const WORKFLOW = [
  "name: GitEdge emergency runner",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      bootstrap: { required: true, type: string }",
  "      origin: { required: true, type: string }",
  "      revision: { required: true, type: string }",
  "      image: { required: true, type: string }",
  "permissions:",
  "  contents: read",
  "  id-token: write",
  "jobs:",
  "  runner:",
  "    runs-on: ${{ inputs.image }}",
  "    timeout-minutes: 360",
  "    steps:",
  "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "        with:",
  "          node-version: '24'",
  "      - shell: bash",
  "        env:",
  "          ORIGIN: ${{ inputs.origin }}",
  "          REVISION: ${{ inputs.revision }}",
  "        run: |",
  "          set -euo pipefail",
  `          BOOTSTRAP=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).inputs.bootstrap)')`,
  '          echo "::add-mask::$BOOTSTRAP"',
  "          git clone --filter=blob:none --no-checkout https://github.com/lsy-404/gitedge.git runtime",
  '          git -C runtime checkout --detach "$REVISION"',
  "          cd runtime",
  "          corepack enable",
  "          pnpm install --frozen-lockfile",
  "          pnpm --dir scripts/signing install --frozen-lockfile",
  '          case "$RUNNER_OS-$RUNNER_ARCH" in',
  "            Linux-X64) asset=linux-x64; ext=tar.gz ;;",
  "            macOS-ARM64) asset=osx-arm64; ext=tar.gz ;;",
  "            macOS-X64) asset=osx-x64; ext=tar.gz ;;",
  "            Windows-X64) asset=win-x64; ext=zip ;;",
  "            *) exit 1 ;;",
  "          esac",
  '          mkdir -p "$RUNNER_TEMP/official-runner" "$RUNNER_TEMP/gitedge-state"',
  '          curl -fsSL -o "$RUNNER_TEMP/runner.$ext" "https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-$asset-2.338.2.$ext"',
  '          tar -xf "$RUNNER_TEMP/runner.$ext" -C "$RUNNER_TEMP/official-runner"',
  '          export GITEDGE_HOSTED_BOOTSTRAP_TOKEN="$BOOTSTRAP"',
  "          unset BOOTSTRAP",
  '          export GITEDGE_HOSTED_OIDC_TOKEN=$(curl -fsSL -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=gitedge-hosted-runner" | node -e \'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>process.stdout.write(JSON.parse(s).value))\')',
  '          echo "::add-mask::$GITEDGE_HOSTED_OIDC_TOKEN"',
  '          node scripts/runner-broker.mjs hosted --origin "$ORIGIN" --runner-path "$RUNNER_TEMP/official-runner" --state-dir "$RUNNER_TEMP/gitedge-state"',
  "",
].join("\n");

async function connectionFor(
  env: ForgeEnv,
  ownerId: string,
  connectionId: string
): Promise<GithubConnectionRow | null> {
  const connection = await env.DB.prepare(
    `SELECT c.* FROM forge_github_connections c JOIN repositories p ON p.id=c.repository_id JOIN users u ON u.id=c.created_by WHERE c.id=? AND c.created_by=? AND c.enabled=1 AND p.deleted_at IS NULL AND p.archived=0 AND u.disabled_at IS NULL`
  )
    .bind(connectionId, ownerId)
    .first<GithubConnectionRow>();
  return connection && (await repositoryRole(env.DB, connection.repository_id, ownerId)) === "admin"
    ? connection
    : null;
}

async function remoteRepository(token: string, owner: string) {
  return GitHubRepo.parse(await githubRequest(token, githubRepoPath(owner, NAME)));
}

export async function hostedRunnerSettings(
  env: ForgeEnv,
  request: Request,
  user: TrustedUser
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/hosted-runner-settings") return null;
  if (user.token || user.agentSession || user.job)
    return errorResponse(403, "forbidden", "A personal session is required.");
  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM forge_hosted_runner_settings WHERE owner_id=?")
      .bind(user.id)
      .first<Settings>();
    return dataResponse({
      settings: row
        ? {
            connectionId: row.connection_id,
            repository: row.github_repository,
            repositoryId: String(row.github_repository_id),
            enabledAt: row.enabled_at,
          }
        : null,
    });
  }
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM forge_hosted_runner_settings WHERE owner_id=?")
      .bind(user.id)
      .run();
    return dataResponse({ enabled: false });
  }
  if (request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  const parsed = SettingsInput.safeParse(await readJsonLimited(request, 4096));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid hosted runner settings.");
  const connection = await connectionFor(env, user.id, parsed.data.connectionId);
  if (!connection)
    return errorResponse(
      404,
      "github_connection_not_found",
      "An enabled connection owned by this account is required."
    );
  try {
    const { token } = await githubCredentials(env, connection);
    const githubUser = GitHubUser.parse(await githubRequest(token, "/user"));
    let repo: z.infer<typeof GitHubRepo>;
    try {
      repo = await remoteRepository(token, githubUser.login);
    } catch (cause) {
      if (!(cause instanceof GithubApiError) || cause.status !== 404) throw cause;
      try {
        repo = GitHubRepo.parse(
          await githubRequest(token, "/user/repos", "POST", {
            name: NAME,
            private: true,
            auto_init: true,
          })
        );
      } catch (createCause) {
        if (!(createCause instanceof GithubApiError) || createCause.status !== 422)
          throw createCause;
        return errorResponse(
          409,
          "hosted_runner_repository_access",
          "GitHub could not create the emergency repository. If the private emergency repository already exists, include it in this GitHub connection’s repository access."
        );
      }
    }
    if (
      repo.owner.id !== githubUser.id ||
      repo.owner.login.toLowerCase() !== githubUser.login.toLowerCase() ||
      repo.full_name.toLowerCase() !== `${githubUser.login}/${NAME}`.toLowerCase()
    )
      throw new Error("github_repository_identity_mismatch");
    await env.DB.prepare(
      `INSERT INTO forge_hosted_runner_settings (owner_id,connection_id,github_owner_id,github_repository_id,github_repository,enabled_at) VALUES (?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET connection_id=excluded.connection_id,github_owner_id=excluded.github_owner_id,github_repository_id=excluded.github_repository_id,github_repository=excluded.github_repository,enabled_at=excluded.enabled_at`
    )
      .bind(user.id, connection.id, githubUser.id, repo.id, repo.full_name, Date.now())
      .run();
    return dataResponse({
      enabled: true,
      repository: repo.full_name,
      repositoryId: String(repo.id),
    });
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "hosted-runner" }).warn("hosted-runner:setup-failed", {
      status: cause instanceof GithubApiError ? cause.status : null,
    });
    return errorResponse(
      503,
      "hosted_runner_setup_failed",
      "GitHub could not provision the private runner repository."
    );
  }
}

async function imageFor(env: ForgeEnv, row: Reservation): Promise<string> {
  const job =
    row.job_kind === "github"
      ? await env.DB.prepare(
          "SELECT j.labels_json, NULL AS platform FROM actions_github_runner_jobs j JOIN forge_github_connections c ON c.id=j.connection_id WHERE j.id=? AND c.created_by=? AND c.repository_id=? AND c.enabled=1 AND c.runner_enabled=1 AND j.status='queued'"
        )
          .bind(row.job_id, row.owner_id, row.repository_id)
          .first<{ labels_json: string; platform: string | null }>()
      : await env.DB.prepare(
          "SELECT r.labels_json, s.platform FROM actions_runner_runs r LEFT JOIN actions_signing_runs s ON s.run_id=r.run_id WHERE r.run_id=? AND r.status='queued'"
        )
          .bind(row.job_id)
          .first<{ labels_json: string; platform: string | null }>();
  if (!job) throw new Error("hosted_job_unavailable");
  const labels = z
    .array(z.string())
    .parse(JSON.parse(job.labels_json))
    .map((label) => label.toLowerCase());
  const systems = labels.filter((label) => ["linux", "macos", "windows"].includes(label));
  const arches = labels.filter((label) =>
    ["x64", "amd64", "x86_64", "arm64", "aarch64", "arm"].includes(label)
  );
  const claim = parseJobClaim(labels);
  if (!claim.valid || claim.gpuVendor || claim.vramMb) throw new Error("hosted_labels_unsupported");
  const platform = job.platform === "ios" ? "macos" : job.platform;
  if (new Set(systems).size > 1 || (platform && systems.some((system) => system !== platform)))
    throw new Error("hosted_platform_conflict");
  const os = platform ?? systems[0];
  const arm = arches.some((arch) => ["arm64", "aarch64"].includes(arch));
  const x64 = arches.some((arch) => ["x64", "amd64", "x86_64"].includes(arch));
  if ((arm && x64) || arches.includes("arm")) throw new Error("hosted_arch_unsupported");
  if (os === "macos") return x64 ? "macos-26-intel" : "macos-26";
  if (os === "windows" && !arm) return "windows-2025";
  if (os === "linux" && !arm) return "ubuntu-24.04";
  throw new Error("hosted_platform_unsupported");
}

export async function hostedRunnerOperation(request: Request, env: ForgeEnv): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).hostname !== "forge.internal")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const input = Operation.safeParse(await readJsonLimited(request, 4096));
  if (!input.success) return errorResponse(400, "bad_request", "Invalid hosted runner operation.");
  const row = await env.DB.prepare("SELECT * FROM actions_hosted_runner_dispatches WHERE id=?")
    .bind(input.data.reservationId)
    .first<Reservation>();
  if (!row) return errorResponse(404, "not_found", "Reservation was not found.");
  const connection = await connectionFor(env, row.owner_id, row.connection_id);
  if (!connection)
    return errorResponse(
      409,
      input.data.operation === "dispatch"
        ? "hosted_runner_unavailable"
        : "github_connection_unavailable",
      "The GitHub connection is unavailable."
    );
  const logger = createLogger(env.LOG_LEVEL, { service: "hosted-runner" });
  let dispatchAttempted = false;
  try {
    const { token } = await githubCredentials(env, connection);
    if (input.data.operation === "cancel") {
      if (!row.github_run_id || !row.github_repository || !row.github_repository_id)
        return dataResponse({ cancelled: false });
      const [owner, name] = row.github_repository.split("/");
      if (!owner || name !== NAME) throw new Error("hosted_repository_invalid");
      const repo = await remoteRepository(token, owner);
      if (
        String(repo.id) !== row.github_repository_id ||
        repo.full_name.toLowerCase() !== row.github_repository.toLowerCase()
      )
        throw new Error("hosted_repository_changed");
      const runPath = `${githubRepoPath(owner, name)}/actions/runs/${encodeURIComponent(row.github_run_id)}`;
      try {
        await githubRequest(token, `${runPath}/cancel`, "POST");
      } catch (cause) {
        if (!(cause instanceof GithubApiError) || cause.status !== 409) throw cause;
      }
      const run = z.object({ status: z.string() }).parse(await githubRequest(token, runPath));
      if (run.status !== "completed")
        return errorResponse(
          409,
          "hosted_runner_cancel_pending",
          "GitHub has not completed the runner cancellation."
        );
      return dataResponse({ cancelled: true });
    }
    if (row.status !== "dispatching" || row.expires_at <= Date.now())
      throw new Error("hosted_reservation_expired");
    const settings = await env.DB.prepare(
      "SELECT * FROM forge_hosted_runner_settings WHERE owner_id=? AND connection_id=?"
    )
      .bind(row.owner_id, row.connection_id)
      .first<Settings>();
    if (!settings) throw new Error("hosted_settings_unavailable");
    const user = GitHubUser.parse(await githubRequest(token, "/user"));
    const repo = await remoteRepository(token, user.login);
    if (
      user.id !== settings.github_owner_id ||
      repo.owner.id !== user.id ||
      repo.id !== settings.github_repository_id ||
      repo.full_name.toLowerCase() !== settings.github_repository.toLowerCase()
    )
      throw new Error("hosted_repository_changed");
    const sha = env.HOSTED_RUNNER_RUNTIME_SHA;
    const origin = env.PUBLIC_ORIGIN;
    if (
      !sha ||
      !/^[a-f0-9]{40}$/.test(sha) ||
      !origin ||
      new URL(origin).origin !== origin ||
      !origin.startsWith("https://")
    )
      throw new Error("hosted_runtime_unconfigured");
    const image = await imageFor(env, row);
    const path = githubRepoPath(user.login, NAME);
    const contentPath = `${path}/contents/${FILE}`;
    try {
      await githubRequest(token, contentPath);
    } catch (cause) {
      if (!(cause instanceof GithubApiError) || cause.status !== 404) throw cause;
      await githubRequest(token, contentPath, "PUT", {
        message: "Initialize hosted runner workflow",
        content: btoa(WORKFLOW),
        branch: repo.default_branch,
      });
    }
    const ref = z
      .object({ object: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) })
      .parse(
        await githubRequest(
          token,
          `${path}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`
        )
      ).object.sha;
    const file = z
      .object({ encoding: z.literal("base64"), content: z.string() })
      .parse(await githubRequest(token, `${contentPath}?ref=${ref}`));
    if (atob(file.content.replace(/\s/g, "")) !== WORKFLOW)
      throw new Error("hosted_workflow_changed");
    dispatchAttempted = true;
    const result = z.object({ workflow_run_id: z.number().int().positive() }).parse(
      await githubRequest(token, `${path}/actions/workflows/hosted-runner.yml/dispatches`, "POST", {
        ref: repo.default_branch,
        return_run_details: true,
        inputs: { bootstrap: input.data.bootstrapToken, origin, revision: sha, image },
      })
    );
    return dataResponse({
      runId: String(result.workflow_run_id),
      repositoryId: String(repo.id),
      repository: repo.full_name,
      workflowRef: `${repo.full_name}/${FILE}@refs/heads/${repo.default_branch}`,
      workflowSha: ref,
    });
  } catch (cause) {
    logger.warn("hosted-runner:operation-failed", {
      reservationId: row.id,
      operation: input.data.operation,
      code:
        cause instanceof GithubApiError
          ? `github_http_${cause.status}`
          : cause instanceof Error
            ? cause.message
            : "unknown",
    });
    return errorResponse(
      503,
      dispatchAttempted ? "hosted_runner_dispatch_outcome_unknown" : "hosted_runner_unavailable",
      "GitHub hosted runner operation failed."
    );
  }
}
