import * as git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import { z } from "zod";
import {
  GitHubSyncTransferSchema,
  type GitHubSyncTransfer,
  type GitHubSyncTransferResult,
} from "../../../packages/contracts/src/github-sync";
import {
  branchRules, protectedBranch, tagChangeForbidden,
} from "../../../src/worker/common/branch-protection";
import { acquireRefWrites } from "../../../src/worker/common/ref-writes";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole } from "../../../src/worker/common/repositories";
import type { GitEnv } from "./access";
import { gitHttpClient } from "./http";
import { ZERO_OID, revokeWriteToken } from "./write";

interface SyncRepository {
  repository_id: string;
  owner: string;
  name: string;
  created_by: string;
  artifact_name: string;
  default_branch: string;
}
const CredentialsSchema = GitHubSyncTransferSchema.pick({ connectionId: true, jobId: true, lease: true, token: true });
type SyncCredentials = z.infer<typeof CredentialsSchema>;

async function authorizedSync(env: GitEnv, input: SyncCredentials): Promise<SyncRepository | null> {
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT c.repository_id, c.owner, c.name, c.created_by, r.artifact_name, r.default_branch FROM forge_github_connections c JOIN repositories r ON r.id=c.repository_id AND r.archived=0 AND r.deleted_at IS NULL JOIN users u ON u.id=c.created_by AND u.disabled_at IS NULL AND u.deleted_at IS NULL JOIN forge_github_jobs j ON j.connection_id=c.id AND j.id=? AND j.status='running' AND j.lease=? AND j.lease_expires_at>? WHERE c.id=? AND c.enabled=1 AND c.lease=? AND c.lease_expires_at>? AND r.artifact_name IS NOT NULL"
  ).bind(input.jobId, input.lease, now, input.connectionId, input.lease, now).first<SyncRepository>();
  return row && await repositoryRole(env.DB, row.repository_id, row.created_by) === "admin" ? row : null;
}

function githubRemote(row: SyncRepository): string {
  return `https://github.com/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.name)}.git`;
}
function githubAuthorization(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` };
}
async function advertised(remote: string, headers: Record<string, string>, prefix?: string) {
  return git.listServerRefs({ http: gitHttpClient(remote, 1_048_576), url: remote, headers, prefix });
}
async function exactRef(remote: string, headers: Record<string, string>, ref: string): Promise<string> {
  const refs = await advertised(remote, headers, ref);
  return refs.find((item) => item.ref === ref)?.oid ?? ZERO_OID;
}
async function selectedArtifact(env: GitEnv, row: SyncRepository, input: GitHubSyncTransfer): Promise<string | null> {
  if (!input.pullRequestId) return row.artifact_name;
  if (input.direction !== "outbound") return null;
  const pull = await env.DB.prepare(
    "SELECT p.head_ref, p.head_session_id, p.head_repository_id, s.workspace_name, r.artifact_name FROM forge_pull_requests p LEFT JOIN auth_agent_sessions s ON s.id=p.head_session_id AND s.repository_id=p.repository_id LEFT JOIN repositories r ON r.id=p.head_repository_id AND r.fork_of=p.repository_id AND r.deleted_at IS NULL WHERE p.id=? AND p.repository_id=? AND p.state IN ('open','merged')"
  ).bind(input.pullRequestId, row.repository_id).first<{
    head_ref: string; head_session_id: string | null; head_repository_id: string | null;
    workspace_name: string | null; artifact_name: string | null;
  }>();
  if (!pull || input.ref !== `refs/heads/${pull.head_ref}`) return null;
  if (pull.head_session_id) return pull.workspace_name;
  if (pull.head_repository_id) return pull.artifact_name;
  return row.artifact_name;
}

async function importAllowed(env: GitEnv, row: SyncRepository, input: GitHubSyncTransfer, before: string): Promise<boolean> {
  if (!(await authorizedSync(env, input))) return false;
  const ref = input.targetRef;
  if (ref.startsWith("refs/heads/")) {
    if (input.after === ZERO_OID && ref === `refs/heads/${row.default_branch}`) return false;
    return !(await protectedBranch(env.DB, row.repository_id, ref.slice(11)));
  }
  if (input.after === ZERO_OID)
    return !tagChangeForbidden(await branchRules(env.DB, row.repository_id), ref.slice(10), "delete");
  return before === ZERO_OID || before === input.after;
}

export async function handleGithubGitSync(request: Request, env: GitEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== "git.internal" || request.method !== "POST")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const raw = await readJsonLimited(request, 16_384);
  if (url.pathname === "/internal/github-sync/refs") {
    const parsed = CredentialsSchema.strict().safeParse(raw);
    if (!parsed.success) return errorResponse(400, "bad_request", "Invalid synchronization request.");
    const row = await authorizedSync(env, parsed.data);
    if (!row) return errorResponse(403, "sync_ineligible", "Synchronization is not authorized.");
    using repo = await env.ARTIFACTS.get(row.artifact_name);
    const token = await repo.createToken("read", 60);
    const logger = createLogger(env.LOG_LEVEL, { service: "github-git-sync", repoId: row.repository_id });
    try {
      const info = await repo.info();
      const local = (await advertised(info.remote, { Authorization: `Bearer ${token.plaintext}` }))
        .filter((r) => /^refs\/(heads|tags)\//.test(r.ref) && !r.ref.endsWith("^{}"));
      const remote = (await advertised(githubRemote(row), githubAuthorization(parsed.data.token)))
        .filter((r) => /^refs\/(heads|tags)\//.test(r.ref) && !r.ref.endsWith("^{}"));
      if (local.length > 1000 || remote.length > 1000)
        return errorResponse(413, "sync_ref_limit", "Synchronization supports at most 1,000 branches and tags on each side.");
      return dataResponse({ local: local.map((r) => ({ ref: r.ref, oid: r.oid })), remote: remote.map((r) => ({ ref: r.ref, oid: r.oid })) });
    } finally { await revokeWriteToken(repo, token.id, logger); }
  }
  const parsed = GitHubSyncTransferSchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid synchronization request.");
  const input = parsed.data;
  const row = await authorizedSync(env, input);
  if (!row) return errorResponse(403, "sync_ineligible", "Synchronization is not authorized.");
  const artifactName = await selectedArtifact(env, row, input);
  if (!artifactName) return errorResponse(403, "sync_head_unpublished", "The selected pull request head is unavailable.");
  using repo = await env.ARTIFACTS.get(artifactName);
  const info = await repo.info();
  const inbound = input.direction === "inbound";
  const token = await repo.createToken(inbound ? "write" : "read", 120);
  const logger = createLogger(env.LOG_LEVEL, { service: "github-git-sync", repoId: row.repository_id });
  try {
    const edgeHeaders = { Authorization: `Bearer ${token.plaintext}` };
    const githubHeaders = githubAuthorization(input.token);
    const source = inbound ? githubRemote(row) : info.remote;
    const destination = inbound ? info.remote : githubRemote(row);
    const sourceHeaders = inbound ? githubHeaders : edgeHeaders;
    const destinationHeaders = inbound ? edgeHeaders : githubHeaders;
    const sourceOid = await exactRef(source, sourceHeaders, input.ref);
    const before = await exactRef(destination, destinationHeaders, input.targetRef);
    const result = (status: GitHubSyncTransferResult["status"]): Response => dataResponse({ status, ref: input.targetRef, before, after: input.after } satisfies GitHubSyncTransferResult);
    if (sourceOid !== input.after) return result("stale");
    if (before === input.after) return result("unchanged");
    if (input.targetRef.startsWith("refs/tags/") && before !== ZERO_OID && input.after !== ZERO_OID)
      return errorResponse(409, "sync_tag_conflict", "Existing tags cannot be moved by synchronization.");
    if (input.after === ZERO_OID && (input.before === null || before !== input.before))
      return errorResponse(409, "sync_delete_conflict", "The destination changed before deletion.");
    if (inbound && !(await importAllowed(env, row, input, before)))
      return errorResponse(409, "sync_protected_ref", "The destination ref is protected.");
    await using lease = inbound ? await acquireRefWrites(env.DB, row.artifact_name, [input.targetRef]) : null;
    void lease;
    const fs = createFsFromVolume(new Volume());
    const dir = "/sync";
    await git.init({ fs, dir });
    await git.addRemote({ fs, dir, remote: "origin", url: destination });
    if (input.after !== ZERO_OID) {
      await git.addRemote({ fs, dir, remote: "source", url: source });
      const fetched = await git.fetch({ fs, dir, http: gitHttpClient(source, 12 * 1024 * 1024), url: source, remote: "source", ref: input.ref, singleBranch: true, tags: input.ref.startsWith("refs/tags/"), headers: sourceHeaders });
      const fetchedOid = input.ref.startsWith("refs/tags/")
        ? await git.resolveRef({ fs, dir, ref: input.ref }) : fetched.fetchHead;
      if (fetchedOid !== input.after) return result("stale");
      await git.writeRef({ fs, dir, ref: input.targetRef, value: input.after, force: true });
    }
    if (!(await authorizedSync(env, input)) || (inbound && !(await importAllowed(env, row, input, before))))
      return errorResponse(409, "sync_ineligible", "Synchronization eligibility changed.");
    try {
      const pushed = await git.push({
        fs, dir, http: gitHttpClient(destination, 12 * 1024 * 1024), url: destination,
        ref: input.targetRef, remoteRef: input.targetRef, force: false, delete: input.after === ZERO_OID,
        headers: destinationHeaders, onPrePush: (refs) => refs.remoteRef.oid === before,
      });
      if (!pushed.ok) return errorResponse(409, "sync_ref_conflict", "The destination rejected the ref update.");
    } catch (cause) {
      if (cause instanceof git.Errors.PushRejectedError || cause instanceof git.Errors.UserCanceledError)
        return errorResponse(409, "sync_ref_conflict", "The destination changed or histories diverged.");
      throw cause;
    }
    if (await exactRef(destination, destinationHeaders, input.targetRef) !== input.after)
      return errorResponse(409, "sync_ref_changed", "The destination changed after synchronization.");
    logger.info("github-sync:ref-updated", { direction: input.direction, ref: input.targetRef });
    return result("synced");
  } finally { await revokeWriteToken(repo, token.id, logger); }
}
