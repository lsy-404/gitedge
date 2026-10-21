import {
  trustedHeaders,
  type Repository,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { activeImportPath } from "./imports";
import { parseJson, repoResponse, type ForgeEnv, type RepositoryRow } from "./common";

const README = `# Account Runner\n\nThis private repository is the account-owned source for workflows and service configuration. GitEdge Actions workflows in this repository can coordinate the account's services. Edit files and commit them to configure services.\n`;
const WORKFLOW = `name: Runner\non:\n  workflow_dispatch: {}\njobs:\n  node:\n    runs-on:\n      - self-hosted\n      - need-tool-node\n      - need-time-5m\n    timeout-minutes: 5\n    steps:\n      - name: Show Node.js version\n        run: node --version\n      - name: Confirm runner is available\n        run: echo "Runner job succeeded."\n`;

function unavailable(message: string): Response {
  return errorResponse(503, "provisioning_pending", message);
}

async function responseFor(row: RepositoryRow): Promise<Response> {
  if (!row.artifact_name || !row.remote)
    return unavailable("Runner provisioning is still pending. Retry shortly.");
  return dataResponse(repoResponse(row, "admin", true) satisfies Repository);
}

async function accountRunnerRow(env: ForgeEnv, namespaceId: string): Promise<RepositoryRow | null> {
  return env.DB.prepare(
    "SELECT r.*, n.slug AS owner FROM repositories r JOIN namespaces n ON n.id = r.namespace_id WHERE r.namespace_id = ? AND r.system_kind = 'account_runner' AND r.deleted_at IS NULL"
  )
    .bind(namespaceId)
    .first<RepositoryRow>();
}

async function initializeFile(
  env: ForgeEnv,
  request: Request,
  user: TrustedUser,
  repositoryId: string,
  path: string,
  content: string,
  message: string
): Promise<boolean> {
  const fileUrl = new URL(`/repositories/${repositoryId}/file`, request.url);
  fileUrl.searchParams.set("ref", "main");
  fileUrl.searchParams.set("path", path);
  const checkFile = async () => {
    const response = await env.GIT.fetch(new Request(fileUrl, { headers: trustedHeaders(user) }));
    const exists = response.ok;
    await response.body?.cancel();
    return exists;
  };
  if (await checkFile()) return true;
  const refsUrl = new URL(`/repositories/${repositoryId}/refs`, request.url);
  const refsResponse = await env.GIT.fetch(new Request(refsUrl, { headers: trustedHeaders(user) }));
  if (!refsResponse.ok) {
    await refsResponse.body?.cancel();
    return false;
  }
  const refsBody: unknown = await refsResponse.json().catch(() => null);
  const refs =
    refsBody && typeof refsBody === "object" && "data" in refsBody && Array.isArray(refsBody.data)
      ? refsBody.data
      : [];
  const mainRef = refs.find(
    (ref): ref is { name: string; oid: string } =>
      typeof ref === "object" &&
      ref !== null &&
      "name" in ref &&
      ref.name === "refs/heads/main" &&
      "oid" in ref &&
      typeof ref.oid === "string"
  );
  const url = new URL(`/repositories/${repositoryId}/edit`, request.url);
  const headers = trustedHeaders(user);
  headers.set("Content-Type", "application/json");
  const response = await env.GIT.fetch(
    new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        branch: "main",
        expectedOid: mainRef?.oid ?? null,
        path,
        content,
        message,
      }),
    })
  );
  const written = response.ok;
  await response.body?.cancel();
  return written || (response.status === 409 && (await checkFile()));
}

async function provision(env: ForgeEnv, request: Request, user: TrustedUser): Promise<Response> {
  if (user.token || user.agentSession || user.job)
    return errorResponse(
      403,
      "forbidden",
      "Account Runner is available only to the account owner."
    );

  const namespace = await env.DB.prepare(
    "SELECT id, slug FROM namespaces WHERE created_by = ? AND kind = 'personal'"
  )
    .bind(user.id)
    .first<{ id: string; slug: string }>();
  if (!namespace) return errorResponse(404, "not_found", "Personal namespace was not found.");

  const current = await accountRunnerRow(env, namespace.id);
  if (current) {
    if (!current.artifact_name || !current.remote) return responseFor(current);
    const initialized = await initializeFile(
      env,
      request,
      user,
      current.id,
      "README.md",
      README,
      "Initialize Runner README"
    );
    if (!initialized)
      return unavailable("Runner storage exists but initialization is pending. Retry shortly.");
    const workflow = await initializeFile(
      env,
      request,
      user,
      current.id,
      ".github/workflows/runner.yml",
      WORKFLOW,
      "Initialize Runner workflow"
    );
    if (!workflow)
      return unavailable(
        "Runner storage exists but workflow initialization is pending. Retry shortly."
      );
    return responseFor(current);
  }

  if (
    (await env.DB.prepare(
      "SELECT 1 AS conflict FROM repositories WHERE namespace_id = ? AND slug = 'runner' AND deleted_at IS NULL UNION ALL SELECT 1 FROM repository_paths WHERE namespace_id = ? AND slug = 'runner' LIMIT 1"
    )
      .bind(namespace.id, namespace.id)
      .first()) ||
    (await activeImportPath(env, namespace.id, "runner"))
  )
    return errorResponse(
      409,
      "runner_path_conflict",
      "The personal runner path is already in use or reserved. Rename the existing repository and explicitly release its old runner route before provisioning."
    );

  const now = Date.now();
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO repositories (id, namespace_id, created_by, slug, do_name, visibility, description, default_branch, actions_enabled, actions_runner_enabled, system_kind, created_at, updated_at) VALUES (?, ?, ?, 'runner', ?, 'private', 'Private account workflows and service configuration', 'main', 1, 1, 'account_runner', ?, ?)"
    )
      .bind(id, namespace.id, user.id, `repo:${id}`, now, now)
      .run();
  } catch (cause) {
    const winner = await accountRunnerRow(env, namespace.id);
    if (winner) return responseFor(winner);
    if (
      cause instanceof Error &&
      (cause.message.includes("UNIQUE") || cause.message.includes("repository path"))
    )
      return errorResponse(
        409,
        "runner_path_conflict",
        "The personal runner path is already in use or reserved."
      );
    throw cause;
  }

  let created: { name: string; remote: string };
  try {
    const artifact = await env.ARTIFACTS.create(`repo-${id}`, {
      setDefaultBranch: "main",
      description: "Private account workflows and service configuration",
    });
    using handle = await env.ARTIFACTS.get(artifact.name);
    if (!(await handle.revokeToken(artifact.token)))
      throw new Error("Initial artifact token revocation failed.");
    created = { name: artifact.name, remote: artifact.remote };
    await env.DB.prepare(
      "UPDATE repositories SET artifact_name = ?, remote = ?, updated_at = ? WHERE id = ? AND system_kind = 'account_runner'"
    )
      .bind(created.name, created.remote, Date.now(), id)
      .run();
    await env.DB.prepare("INSERT INTO forge_counters (repository_id) VALUES (?)").bind(id).run();
  } catch {
    return unavailable("Runner storage provisioning is pending. Retry shortly.");
  }

  const repository: RepositoryRow = {
    id,
    namespace_id: namespace.id,
    owner: namespace.slug,
    slug: "runner",
    visibility: "private",
    description: "Private account workflows and service configuration",
    default_branch: "main",
    actions_enabled: 1,
    actions_runner_enabled: 1,
    system_kind: "account_runner",
    artifact_name: created.name,
    remote: created.remote,
    created_at: now,
    updated_at: Date.now(),
  };
  if (
    !(await initializeFile(env, request, user, id, "README.md", README, "Initialize Runner README"))
  )
    return unavailable("Runner was created but README initialization is pending. Retry shortly.");
  if (
    !(await initializeFile(
      env,
      request,
      user,
      id,
      ".github/workflows/runner.yml",
      WORKFLOW,
      "Initialize Runner workflow"
    ))
  )
    return unavailable("Runner was created but workflow initialization is pending. Retry shortly.");
  return dataResponse(repoResponse(repository, "admin", true) satisfies Repository, 201);
}

export async function handleAccountRunner(
  env: ForgeEnv,
  request: Request,
  user: TrustedUser
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/account-runner") return null;
  if (request.method !== "GET" && request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Method is not allowed for this endpoint.");
  if (user.token || user.agentSession || user.job)
    return errorResponse(
      403,
      "forbidden",
      "Account Runner is available only to the account owner."
    );
  if (request.method === "POST") {
    const hasBody = request.body !== null;
    const payload = await parseJson(request).catch(() => undefined);
    if (
      hasBody &&
      (typeof payload !== "object" || payload === null || Object.keys(payload).length > 0)
    )
      return errorResponse(
        400,
        "bad_request",
        "Account Runner provisioning does not accept configuration."
      );
    return provision(env, request, user);
  }
  const namespace = await env.DB.prepare(
    "SELECT id FROM namespaces WHERE created_by = ? AND kind = 'personal'"
  )
    .bind(user.id)
    .first<{ id: string }>();
  if (!namespace) return dataResponse({ repository: null });
  const repository = await accountRunnerRow(env, namespace.id);
  if (repository && (!repository.artifact_name || !repository.remote))
    return unavailable("Runner provisioning is pending. Retry shortly.");
  return dataResponse({ repository: repository ? repoResponse(repository, "admin", true) : null });
}
