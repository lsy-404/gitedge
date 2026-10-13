import * as git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import { z } from "zod";
import {
  GitHubSyncTransferSchema,
  type GitHubSyncTransfer,
  type GitHubSyncTransferResult,
} from "../../../packages/contracts/src/github-sync";
import {
  branchRules,
  protectedBranch,
  tagChangeForbidden,
} from "../../../src/worker/common/branch-protection";
import { acquireRefWrites } from "../../../src/worker/common/ref-writes";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole, writableRole } from "../../../src/worker/common/repositories";
import type { GitEnv } from "./access";
import { gitHttpClient } from "./http";
import { ZERO_OID, revokeWriteToken } from "./write";
import { refContainsCommit } from "./read";
import { GitBranchSchema, GitOidSchema } from "../../../packages/contracts/src/forge";
import { sha256Hex, type PushEventInput } from "../../../packages/contracts/src/index";
import { recordGitWrite } from "./events";

interface SyncRepository {
  repository_id: string;
  owner: string;
  name: string;
  created_by: string;
  artifact_name: string;
  default_branch: string;
}
const CredentialsSchema = GitHubSyncTransferSchema.pick({
  connectionId: true,
  jobId: true,
  lease: true,
  token: true,
});
type SyncCredentials = z.infer<typeof CredentialsSchema>;

async function authorizedSync(env: GitEnv, input: SyncCredentials): Promise<SyncRepository | null> {
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT c.repository_id, c.owner, c.name, c.created_by, r.artifact_name, r.default_branch FROM forge_github_connections c JOIN repositories r ON r.id=c.repository_id AND r.archived=0 AND r.deleted_at IS NULL JOIN users u ON u.id=c.created_by AND u.disabled_at IS NULL AND u.deleted_at IS NULL JOIN forge_github_jobs j ON j.connection_id=c.id AND j.id=? AND j.status='running' AND j.lease=? AND j.lease_expires_at>? WHERE c.id=? AND c.enabled=1 AND c.lease=? AND c.lease_expires_at>? AND r.artifact_name IS NOT NULL"
  )
    .bind(input.jobId, input.lease, now, input.connectionId, input.lease, now)
    .first<SyncRepository>();
  return row && (await repositoryRole(env.DB, row.repository_id, row.created_by)) === "admin"
    ? row
    : null;
}

function githubRemote(row: SyncRepository): string {
  return `https://github.com/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.name)}.git`;
}
function githubAuthorization(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` };
}
async function advertised(remote: string, headers: Record<string, string>, prefix?: string) {
  return git.listServerRefs({
    http: gitHttpClient(remote, 1_048_576),
    url: remote,
    headers: { ...headers },
    prefix,
  });
}
async function exactRef(
  remote: string,
  headers: Record<string, string>,
  ref: string
): Promise<string> {
  const refs = await advertised(remote, headers, ref);
  return refs.find((item) => item.ref === ref)?.oid ?? ZERO_OID;
}
interface SelectedArtifact {
  artifactName: string;
  repositoryId: string;
  defaultBranch: string;
  sessionId?: string;
}
async function selectedArtifact(
  env: GitEnv,
  row: SyncRepository,
  input: GitHubSyncTransfer
): Promise<SelectedArtifact | null> {
  const base = {
    artifactName: row.artifact_name,
    repositoryId: row.repository_id,
    defaultBranch: row.default_branch,
  };
  if (!input.pullRequestId) return base;
  const pull = await env.DB.prepare(
    "SELECT p.head_ref, p.head_session_id, p.head_repository_id, s.workspace_name, r.artifact_name, r.default_branch, r.archived FROM forge_pull_requests p LEFT JOIN auth_agent_sessions s ON s.id=p.head_session_id AND s.repository_id=p.repository_id LEFT JOIN repositories r ON r.id=p.head_repository_id AND r.fork_of=p.repository_id AND r.deleted_at IS NULL WHERE p.id=? AND p.repository_id=? AND p.state IN ('open','merged')"
  )
    .bind(input.pullRequestId, row.repository_id)
    .first<{
      head_ref: string;
      head_session_id: string | null;
      head_repository_id: string | null;
      workspace_name: string | null;
      artifact_name: string | null;
      default_branch: string | null;
      archived: number | null;
    }>();
  if (
    !pull ||
    (input.direction === "outbound" ? input.ref : input.targetRef) !== `refs/heads/${pull.head_ref}`
  )
    return null;
  if (pull.head_session_id) {
    if (!pull.workspace_name) return null;
    if (input.direction === "inbound") {
      const active = await env.DB.prepare(
        "SELECT 1 AS active FROM auth_agent_sessions s JOIN auth_agents a ON a.id=s.agent_id AND a.disabled_at IS NULL JOIN repositories r ON r.id=s.repository_id AND r.agents_enabled=1 AND r.archived=0 AND r.deleted_at IS NULL WHERE s.id=? AND s.user_id=? AND s.status='active' AND s.permission='write' AND s.expires_at>?"
      )
        .bind(pull.head_session_id, row.created_by, Date.now())
        .first();
      if (!active) return null;
    }
    return { ...base, artifactName: pull.workspace_name, sessionId: pull.head_session_id };
  }
  if (pull.head_repository_id) {
    if (!pull.artifact_name || !pull.default_branch) return null;
    if (
      input.direction === "inbound" &&
      (pull.archived !== 0 ||
        !writableRole(await repositoryRole(env.DB, pull.head_repository_id, row.created_by)))
    )
      return null;
    return {
      artifactName: pull.artifact_name,
      repositoryId: pull.head_repository_id,
      defaultBranch: pull.default_branch,
    };
  }
  return base;
}

async function importAllowed(
  env: GitEnv,
  row: SyncRepository,
  input: GitHubSyncTransfer,
  selected: SelectedArtifact,
  before: string
): Promise<boolean> {
  if (!(await authorizedSync(env, input))) return false;
  if (!(await selectedArtifact(env, row, input))) return false;
  const ref = input.targetRef;
  if (ref.startsWith("refs/heads/")) {
    if (input.after === ZERO_OID && ref === `refs/heads/${selected.defaultBranch}`) return false;
    return (
      Boolean(selected.sessionId) ||
      !(await protectedBranch(env.DB, selected.repositoryId, ref.slice(11)))
    );
  }
  if (input.after === ZERO_OID)
    return !tagChangeForbidden(
      await branchRules(env.DB, selected.repositoryId),
      ref.slice(10),
      "delete"
    );
  return before === ZERO_OID || before === input.after;
}

export async function handleGithubGitSync(request: Request, env: GitEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== "git.internal" || request.method !== "POST")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const raw = await readJsonLimited(request, 16_384);
  if (url.pathname === "/internal/github-sync/report") {
    const parsed = CredentialsSchema.extend({
      ref: GitHubSyncTransferSchema.shape.targetRef,
      before: GitOidSchema,
      after: GitOidSchema,
      status: z.enum(["synced", "unchanged"]),
      pullRequestId: z.string().optional(),
    })
      .strict()
      .safeParse(raw);
    if (!parsed.success)
      return errorResponse(400, "bad_request", "Invalid synchronization report.");
    const row = await authorizedSync(env, parsed.data);
    if (!row || !env.FORGE)
      return errorResponse(403, "sync_ineligible", "Synchronization is not authorized.");
    const owner = await env.DB.prepare(
      "SELECT id,identifier,group_key AS groupKey FROM users WHERE id=? AND disabled_at IS NULL"
    )
      .bind(row.created_by)
      .first<{ id: string; identifier: string; groupKey: string }>();
    const job = await env.DB.prepare(
      "SELECT payload FROM forge_github_jobs WHERE id=? AND direction='inbound'"
    )
      .bind(parsed.data.jobId)
      .first<{ payload: string }>();
    if (!owner || !job)
      return errorResponse(403, "sync_ineligible", "Synchronization report is unavailable.");
    const selected = await selectedArtifact(env, row, {
      ...parsed.data,
      direction: "inbound",
      targetRef: parsed.data.ref,
    });
    if (!selected)
      return errorResponse(403, "sync_head_unavailable", "The selected head is unavailable.");
    const transfer = await env.DB.prepare(
      "SELECT artifact_name,repository_id,session_id,before_oid,after_oid,reported_at FROM forge_github_ref_transfers WHERE job_id=? AND artifact_name=? AND ref=? AND after_oid=?"
    )
      .bind(parsed.data.jobId, selected.artifactName, parsed.data.ref, parsed.data.after)
      .first<{
        artifact_name: string;
        repository_id: string;
        session_id: string | null;
        before_oid: string;
        after_oid: string;
        reported_at: number | null;
      }>();
    if (!transfer || transfer.reported_at !== null) return dataResponse({ reported: false });
    using artifact = await env.ARTIFACTS.get(transfer.artifact_name);
    const readToken = await artifact.createToken("read", 60);
    const reportLogger = createLogger(env.LOG_LEVEL, {
      service: "github-git-sync",
      repoId: transfer.repository_id,
    });
    try {
      if (
        (await exactRef(
          (await artifact.info()).remote,
          { Authorization: `Bearer ${readToken.plaintext}` },
          parsed.data.ref
        )) !== transfer.after_oid
      )
        return dataResponse({ reported: false });
    } finally {
      await revokeWriteToken(artifact, readToken.id, reportLogger);
    }
    const hash = await sha256Hex(
      `${parsed.data.jobId}:${transfer.artifact_name}:${parsed.data.ref}:${transfer.after_oid}`
    );
    const eventId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const update = { ref: parsed.data.ref, before: transfer.before_oid, after: transfer.after_oid };
    const source = z
      .object({
        sender: z.object({ id: z.number().int().positive(), login: z.string().max(80) }).optional(),
        before: GitOidSchema.nullable().optional(),
      })
      .safeParse(JSON.parse(job.payload));
    const input: PushEventInput = {
      eventId,
      occurredAt: Date.now(),
      repositoryId: transfer.repository_id,
      pusherId: owner.id,
      ...(transfer.session_id ? { agentSessionId: transfer.session_id } : {}),
      externalPusher: {
        id: source.success && source.data.sender ? `github:${source.data.sender.id}` : "github",
        name:
          source.success && source.data.sender ? `${source.data.sender.login} (GitHub)` : "GitHub",
      },
      updates: [update],
    };
    const response = await env.FORGE.fetch(
      new Request("https://forge.internal/internal/push-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
    );
    if (!response.ok) {
      await response.body?.cancel();
      return errorResponse(
        503,
        "github_push_report_failed",
        "Imported push could not be reported."
      );
    }
    await response.body?.cancel();
    await env.DB.prepare(
      "UPDATE forge_github_ref_transfers SET reported_at=? WHERE job_id=? AND artifact_name=? AND ref=? AND after_oid=?"
    )
      .bind(
        Date.now(),
        parsed.data.jobId,
        transfer.artifact_name,
        parsed.data.ref,
        transfer.after_oid
      )
      .run();
    if (update.after !== ZERO_OID && update.ref.startsWith("refs/heads/"))
      await recordGitWrite(
        env,
        transfer.repository_id,
        transfer.artifact_name,
        owner,
        update.ref.slice(11),
        update.after
      );
    return dataResponse({ reported: true });
  }
  if (url.pathname === "/internal/github-sync/contains") {
    const parsed = CredentialsSchema.extend({ ref: GitBranchSchema, oid: GitOidSchema })
      .strict()
      .safeParse(raw);
    if (!parsed.success) return errorResponse(400, "bad_request", "Invalid containment request.");
    const row = await authorizedSync(env, parsed.data);
    if (!row) return errorResponse(403, "sync_ineligible", "Synchronization is not authorized.");
    using repo = await env.ARTIFACTS.get(row.artifact_name);
    return dataResponse({
      contains: await refContainsCommit(repo, parsed.data.ref, parsed.data.oid),
    });
  }
  if (url.pathname === "/internal/github-sync/refs") {
    const parsed = CredentialsSchema.strict().safeParse(raw);
    if (!parsed.success)
      return errorResponse(400, "bad_request", "Invalid synchronization request.");
    const row = await authorizedSync(env, parsed.data);
    if (!row) return errorResponse(403, "sync_ineligible", "Synchronization is not authorized.");
    using repo = await env.ARTIFACTS.get(row.artifact_name);
    const token = await repo.createToken("read", 60);
    const logger = createLogger(env.LOG_LEVEL, {
      service: "github-git-sync",
      repoId: row.repository_id,
    });
    try {
      const info = await repo.info();
      const local = (
        await advertised(info.remote, { Authorization: `Bearer ${token.plaintext}` })
      ).filter((r) => /^refs\/(heads|tags)\//.test(r.ref) && !r.ref.endsWith("^{}"));
      const remote = (
        await advertised(githubRemote(row), githubAuthorization(parsed.data.token))
      ).filter((r) => /^refs\/(heads|tags)\//.test(r.ref) && !r.ref.endsWith("^{}"));
      if (local.length > 1000 || remote.length > 1000)
        return errorResponse(
          413,
          "sync_ref_limit",
          "Synchronization supports at most 1,000 branches and tags on each side."
        );
      return dataResponse({
        local: local.map((r) => ({ ref: r.ref, oid: r.oid })),
        remote: remote.map((r) => ({ ref: r.ref, oid: r.oid })),
      });
    } finally {
      await revokeWriteToken(repo, token.id, logger);
    }
  }
  const parsed = GitHubSyncTransferSchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid synchronization request.");
  const input = parsed.data;
  const row = await authorizedSync(env, input);
  if (!row) return errorResponse(403, "sync_ineligible", "Synchronization is not authorized.");
  const selected = await selectedArtifact(env, row, input);
  if (!selected)
    return errorResponse(
      403,
      "sync_head_unavailable",
      "The selected pull request head is unavailable or read-only."
    );
  using repo = await env.ARTIFACTS.get(selected.artifactName);
  const info = await repo.info();
  const inbound = input.direction === "inbound";
  const token = await repo.createToken(inbound ? "write" : "read", 120);
  const logger = createLogger(env.LOG_LEVEL, {
    service: "github-git-sync",
    repoId: row.repository_id,
  });
  try {
    const edgeHeaders = { Authorization: `Bearer ${token.plaintext}` };
    const githubHeaders = githubAuthorization(input.token);
    const source = inbound ? githubRemote(row) : info.remote;
    const destination = inbound ? info.remote : githubRemote(row);
    const sourceHeaders = inbound ? githubHeaders : edgeHeaders;
    const destinationHeaders = inbound ? edgeHeaders : githubHeaders;
    const sourceOid = await exactRef(source, sourceHeaders, input.ref);
    const before = await exactRef(destination, destinationHeaders, input.targetRef);
    const result = (status: GitHubSyncTransferResult["status"]): Response =>
      dataResponse({
        status,
        ref: input.targetRef,
        before,
        after: input.after,
      } satisfies GitHubSyncTransferResult);
    if (sourceOid !== input.after) return result("stale");
    if (before === input.after) return result("unchanged");
    if (input.targetRef.startsWith("refs/tags/") && before !== ZERO_OID && input.after !== ZERO_OID)
      return errorResponse(
        409,
        "sync_tag_conflict",
        "Existing tags cannot be moved by synchronization."
      );
    if (input.after === ZERO_OID && (input.before === null || before !== input.before))
      return errorResponse(409, "sync_delete_conflict", "The destination changed before deletion.");
    if (inbound && !(await importAllowed(env, row, input, selected, before)))
      return errorResponse(409, "sync_protected_ref", "The destination ref is protected.");
    await using lease = inbound
      ? await acquireRefWrites(env.DB, selected.artifactName, [input.targetRef])
      : null;
    void lease;
    const fs = createFsFromVolume(new Volume());
    const dir = "/sync";
    await git.init({ fs, dir });
    await git.addRemote({ fs, dir, remote: "origin", url: destination });
    if (input.after !== ZERO_OID) {
      await git.addRemote({ fs, dir, remote: "source", url: source });
      const fetched = await git.fetch({
        fs,
        dir,
        http: gitHttpClient(source, 12 * 1024 * 1024),
        url: source,
        remote: "source",
        ref: input.ref,
        singleBranch: true,
        tags: input.ref.startsWith("refs/tags/"),
        headers: sourceHeaders,
      });
      const fetchedOid = input.ref.startsWith("refs/tags/")
        ? await git.resolveRef({ fs, dir, ref: input.ref })
        : fetched.fetchHead;
      if (fetchedOid !== input.after) return result("stale");
    }
    await git.writeRef({
      fs,
      dir,
      ref: input.targetRef,
      value: input.after === ZERO_OID ? before : input.after,
      force: true,
    });
    if (
      !(await authorizedSync(env, input)) ||
      (inbound && !(await importAllowed(env, row, input, selected, before)))
    )
      return errorResponse(409, "sync_ineligible", "Synchronization eligibility changed.");
    if (inbound)
      await env.DB.prepare(
        "INSERT OR IGNORE INTO forge_github_ref_transfers (job_id,artifact_name,repository_id,session_id,ref,before_oid,after_oid) VALUES (?,?,?,?,?,?,?)"
      )
        .bind(
          input.jobId,
          selected.artifactName,
          selected.repositoryId,
          selected.sessionId ?? null,
          input.targetRef,
          before,
          input.after
        )
        .run();
    try {
      const pushed = await git.push({
        fs,
        dir,
        http: gitHttpClient(destination, 12 * 1024 * 1024),
        url: destination,
        ref: input.targetRef,
        remoteRef: input.targetRef,
        force: false,
        delete: input.after === ZERO_OID,
        headers: destinationHeaders,
        onPrePush: (refs) => refs.remoteRef.oid === before,
      });
      if (!pushed.ok)
        return errorResponse(409, "sync_ref_conflict", "The destination rejected the ref update.");
    } catch (cause) {
      if (
        cause instanceof git.Errors.PushRejectedError ||
        cause instanceof git.Errors.UserCanceledError
      )
        return errorResponse(
          409,
          "sync_ref_conflict",
          "The destination changed or histories diverged."
        );
      throw cause;
    }
    if ((await exactRef(destination, destinationHeaders, input.targetRef)) !== input.after)
      return errorResponse(
        409,
        "sync_ref_changed",
        "The destination changed after synchronization."
      );
    logger.info("github-sync:ref-updated", { direction: input.direction, ref: input.targetRef });
    return result("synced");
  } finally {
    await revokeWriteToken(repo, token.id, logger);
  }
}
