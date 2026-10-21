import {
  trustedHeaders,
  type Repository,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { readTextLimited } from "../../../src/worker/common/readText";
import { activeImportPath } from "./imports";
import { repoResponse, type ForgeEnv, type RepositoryRow } from "./common";

const README = `# Account Runner\n\nThis private repository is the account-owned source for workflows and service configuration. GitEdge Actions workflows in this repository can coordinate the account's services. Edit files and commit them to configure services.\n`;
const WORKFLOW = `name: Runner\non:\n  workflow_dispatch: {}\njobs:\n  node:\n    runs-on:\n      - self-hosted\n      - need-tool-node\n      - need-time-5m\n    timeout-minutes: 5\n    steps:\n      - name: Show Node.js version\n        run: node --version\n      - name: Confirm runner is available\n        run: echo "Runner job succeeded."\n`;
const PROVISIONING_LEASE_MS = 30_000;

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

function artifactsErrorCode(cause: unknown): string {
  return cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : "UNKNOWN";
}

function logProvisionFailure(
  env: ForgeEnv,
  repositoryId: string,
  phase: string,
  cause: unknown
): void {
  createLogger(env.LOG_LEVEL, { service: "forge", repoId: repositoryId }).error(
    "forge:account-runner-provision-failed",
    { phase, code: artifactsErrorCode(cause) }
  );
}

async function provisionArtifact(
  env: ForgeEnv,
  repositoryId: string,
  leaseAt: number
): Promise<{ name: string; remote: string } | null> {
  const name = `repo-${repositoryId}`;
  let handle: ArtifactsRepo;
  try {
    handle = await env.ARTIFACTS.get(name);
  } catch (cause) {
    if (artifactsErrorCode(cause) !== "NOT_FOUND") {
      logProvisionFailure(env, repositoryId, "lookup", cause);
      return null;
    }
    try {
      await env.ARTIFACTS.create(name, {
        setDefaultBranch: "main",
        description: "Private account workflows and service configuration",
      });
      handle = await env.ARTIFACTS.get(name);
    } catch (createCause) {
      logProvisionFailure(env, repositoryId, "create-or-attach", createCause);
      return null;
    }
  }

  using repository = handle;
  try {
    const info = await repository.info();
    if (info.name !== name || !info.remote) throw new Error("Artifacts metadata is incomplete.");
    const listed = await repository.listTokens();
    if (listed.tokens.length < listed.total)
      throw new Error("Artifacts bootstrap token list is incomplete.");
    for (const token of listed.tokens) {
      if (token.state === "active" && !(await repository.revokeToken(token.id)))
        throw new Error("Artifacts bootstrap token revocation failed.");
    }
    const published = await env.DB.prepare(
      "UPDATE repositories SET artifact_name = ?, remote = ?, updated_at = ? WHERE id = ? AND system_kind = 'account_runner' AND artifact_name IS NULL AND updated_at = ?"
    )
      .bind(info.name, info.remote, leaseAt, repositoryId, leaseAt)
      .run();
    if (!published.meta.changes) return null;
    await env.DB.prepare("INSERT OR IGNORE INTO forge_counters (repository_id) VALUES (?)")
      .bind(repositoryId)
      .run();
    return { name: info.name, remote: info.remote };
  } catch (cause) {
    logProvisionFailure(env, repositoryId, "finalize", cause);
    return null;
  }
}

async function finishProvision(
  env: ForgeEnv,
  request: Request,
  user: TrustedUser,
  row: RepositoryRow,
  leaseAt: number,
  status: 200 | 201
): Promise<Response> {
  const storage = await provisionArtifact(env, row.id, leaseAt);
  if (!storage) return unavailable("Runner storage provisioning is pending. Retry shortly.");
  const repository: RepositoryRow = {
    ...row,
    artifact_name: storage.name,
    remote: storage.remote,
    updated_at: leaseAt,
  };
  if (
    !(await initializeFile(
      env,
      request,
      user,
      row.id,
      "README.md",
      README,
      "Initialize Runner README"
    ))
  )
    return unavailable("Runner was created but README initialization is pending. Retry shortly.");
  if (
    !(await initializeFile(
      env,
      request,
      user,
      row.id,
      ".github/workflows/runner.yml",
      WORKFLOW,
      "Initialize Runner workflow"
    ))
  )
    return unavailable("Runner was created but workflow initialization is pending. Retry shortly.");
  return dataResponse(repoResponse(repository, "admin", true) satisfies Repository, status);
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
    if (!current.artifact_name || !current.remote) {
      if (current.artifact_name) return responseFor(current);
      const now = Date.now();
      if (current.updated_at > now - PROVISIONING_LEASE_MS) return responseFor(current);
      const claim = await env.DB.prepare(
        "UPDATE repositories SET updated_at = ? WHERE id = ? AND system_kind = 'account_runner' AND artifact_name IS NULL AND updated_at <= ?"
      )
        .bind(now, current.id, now - PROVISIONING_LEASE_MS)
        .run();
      if (!claim.meta.changes)
        return responseFor((await accountRunnerRow(env, namespace.id)) ?? current);
      return finishProvision(env, request, user, { ...current, updated_at: now }, now, 200);
    }
    try {
      await env.DB.prepare("INSERT OR IGNORE INTO forge_counters (repository_id) VALUES (?)")
        .bind(current.id)
        .run();
    } catch (cause) {
      logProvisionFailure(env, current.id, "counter-repair", cause);
      return unavailable("Runner repository is ready but setup is still pending. Retry shortly.");
    }
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
    artifact_name: null,
    remote: null,
    created_at: now,
    updated_at: now,
  };
  return finishProvision(env, request, user, repository, now, 201);
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
    const text = await readTextLimited(request.body, 1024);
    let payload: unknown;
    try {
      payload = text?.trim() ? JSON.parse(text) : {};
    } catch {
      payload = null;
    }
    if (
      text === null ||
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      Object.keys(payload).length > 0
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
