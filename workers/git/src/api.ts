import { repositoryNotFound } from "../../../src/worker/common/repository-response";
import { trustedHeaders } from "../../../packages/contracts/src/trust";
import { recordGitWrite, reportPushEvent } from "./events";
import { repositoryCommunity } from "./community";
import {
  EditRepositoryFileSchema,
  CreateBranchInputSchema,
  DeleteBranchInputSchema,
} from "../../../packages/contracts/src/repository-controls";
import {
  CreateTagInputSchema,
  DeleteTagInputSchema,
  GitTagNameSchema,
} from "../../../packages/contracts/src/releases";
import {
  branchRules,
  matchingBranchRules,
  protectedBranch,
} from "../../../src/worker/common/branch-protection";
import { readJsonLimited } from "../../../src/worker/common/readText";
import {
  commitRepositoryChanges,
  createRepositoryBranch,
  deleteRepositoryBranch,
  GitWriteConflict,
  ZERO_OID,
  type RepositoryCommitInput,
} from "./write";
import { GitWriteInputError } from "./changes";
import { CommitRequestError, commitFromEdit, readCommitRequest } from "./commit-request";
import { repositorySnapshot } from "./snapshot";
import { GitTagExists, createRepositoryTag, deleteRepositoryTag, listRepositoryTags } from "./tags";
import { serveRaw, splitRawSpec } from "./raw";
import { edgeAddress, edgeReference } from "./edge-reference";
import {
  edgeDownloadHeaders,
  matchesEtag,
  repositoryCacheScope,
  serveEdgeRead,
} from "./edge-cache";
import {
  ArchiveError,
  archiveContentType,
  archiveStream,
  planArchive,
  type ArchiveFormat,
} from "./archive";
import { contentDisposition } from "../../../src/worker/common/content-disposition";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { syncForkBranch } from "./fork-sync";
import { GitResourceLimitError } from "./http";
import {
  ForkSyncInputSchema,
  GitMergeInputSchema,
  GitOidSchema,
  accessTokenAllows,
  accessTokenAllowsRepository,
  requiredAccessTokenScope,
  sha256Hex,
} from "../../../packages/contracts/src/index";
import {
  listRepositorySessions,
  resolveGitAccess,
  resolveProposalHead,
  resolveWorkspace,
  type GitEnv,
} from "./access";
import {
  artifactGraph,
  commitResponse,
  listArtifactRefs,
  readArtifactFile,
  readArtifactTree,
  orderCommits,
  refContainsCommit,
  resolveCommit,
} from "./read";
import { readObjectSignature, verifyObjectSignature } from "./signatures";
import type { GitSignature } from "../../../packages/contracts/src/signatures";
import { compareArtifacts } from "./compare";
import { blameFile } from "./blame";
import { commitDetail } from "./commit-diff";
import { listFiles, pathHistory } from "./navigation";
import { mergeArtifacts } from "./merge";
import { dataResponse, errorResponse, jsonResponse } from "../../../src/worker/common/http";

function pageNumber(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return value !== null && Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, maximum)
    : fallback;
}
/** Streams from a handle and disposes it once the consumer finishes, fails or cancels. */
function releaseWhenSettled(
  handle: ArtifactsRepo,
  open: (handle: ArtifactsRepo) => ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const reader = open(handle).getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    handle[Symbol.dispose]();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (cause) {
        release();
        throw cause;
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}
function validPath(path: string): boolean {
  return (
    path.length <= 2000 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== ".." && part !== ".")
  );
}
export async function handleGitApi(
  request: Request,
  env: GitEnv,
  ctx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const repositoryId = parts[1];
  if (parts[0] !== "repositories" || !repositoryId || parts.length !== 3)
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const access = await resolveGitAccess(request, env, repositoryId);
  if (access instanceof Response) return access;
  if (!access) return repositoryNotFound();
  const requiredScope = requiredAccessTokenScope("git", request.method, parts);
  if (access.user?.token && !accessTokenAllows(access.user.token, requiredScope))
    return errorResponse(
      403,
      "insufficient_scope",
      `Access token requires the ${requiredScope} scope.`
    );
  if (!access.repository.artifactName)
    return errorResponse(
      409,
      "repository_storage_unavailable",
      "Repository must be imported into Artifacts before it can be used."
    );
  const userSession = access.user?.agentSession;
  const sessionId = url.searchParams.get("sessionId") ?? userSession?.id;
  const session = sessionId ? await resolveWorkspace(env, access, sessionId) : null;
  if (sessionId && !session)
    return errorResponse(404, "not_found", "Session workspace was not found.");
  const resource = parts[2];
  const proposalComparison =
    (resource === "compare" || resource === "pull-head") &&
    (url.searchParams.has("headSessionId") || url.searchParams.has("headRepositoryId"));
  const committing = (resource === "edit" || resource === "commit") && request.method === "POST";
  // Commit lookups answer whether the repository itself holds a commit, never a private fork;
  // commit writes stay in the session workspace like every other mutation.
  const repositoryScoped =
    proposalComparison ||
    resource === "pull-head" ||
    (resource === "commit" && !committing) ||
    resource === "commit-diff" ||
    resource === "signature" ||
    resource === "snapshot" ||
    resource === "fork-sync" ||
    resource === "tags" ||
    resource === "archive";
  using repo = await env.ARTIFACTS.get(
    repositoryScoped
      ? access.repository.artifactName
      : (session?.workspaceName ?? access.repository.artifactName)
  );
  const logger = createLogger(env.LOG_LEVEL, { service: "artifacts-git", repoId: repositoryId });
  const ref = url.searchParams.get("ref") ?? session?.baseRef ?? access.repository.defaultBranch;
  const path = url.searchParams.get("path") ?? "";
  if (!validPath(path) || ref.length > 255 || !ref.length)
    return errorResponse(400, "bad_request", "Invalid ref or path.");
  logger.debug("artifacts:request", { resource, sessionId: session?.id });
  if (resource === "graph" && access.repository.graphEnabled === 0)
    return errorResponse(404, "feature_disabled", "Commit graph is disabled.");
  if (resource === "tags" && request.method !== "GET" && request.method !== "HEAD") {
    if (request.method !== "POST" && request.method !== "DELETE")
      return errorResponse(405, "method_not_allowed", "Method is not allowed.");
    if (!access.user || !access.repository.canWrite || userSession)
      return errorResponse(403, "forbidden", "Repository write access is required.");
    if (access.repository.archived)
      return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
    const value = await readJsonLimited(request, 20_000);
    const beforeWrite = async () => {
      const latest = await resolveGitAccess(request, env, repositoryId);
      if (latest instanceof Response || !latest?.repository.canWrite || latest.repository.archived)
        throw new GitWriteConflict("Repository permissions changed. Reload before retrying.");
    };
    try {
      if (request.method === "POST") {
        const input = CreateTagInputSchema.safeParse(value);
        if (!input.success) return errorResponse(400, "bad_request", "Invalid tag.");
        const tag = await createRepositoryTag(
          repo,
          input.data,
          access.repository.defaultBranch,
          access.user,
          beforeWrite,
          env.LOG_LEVEL
        );
        return dataResponse(tag, 201);
      }
      const input = DeleteTagInputSchema.safeParse(value);
      if (!input.success) return errorResponse(400, "bad_request", "Invalid tag.");
      await deleteRepositoryTag(
        repo,
        input.data.name,
        input.data.expectedOid,
        beforeWrite,
        env.LOG_LEVEL
      );
      return dataResponse({ deleted: true });
    } catch (cause) {
      if (cause instanceof GitTagExists) return errorResponse(409, "tag_exists", cause.message);
      if (cause instanceof GitWriteConflict)
        return errorResponse(409, "refs_changed", cause.message);
      if (cause instanceof GitWriteInputError)
        return errorResponse(400, "bad_request", cause.message);
      throw cause;
    }
  }
  if (
    (resource === "edit" || resource === "commit" || resource === "branches") &&
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    if (!access.user || !access.repository.canWrite || userSession?.permission === "read")
      return errorResponse(403, "forbidden", "Repository write access is required.");
    if (access.repository.archived)
      return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
    if (committing && access.repository.onlineEditingEnabled === 0)
      return errorResponse(404, "feature_disabled", "Online editing is disabled.");
    if (session && !userSession && session.userId !== access.user.id)
      return errorResponse(404, "not_found", "Session workspace was not found.");
    let commit: RepositoryCommitInput | null = null;
    let editedPath: string | null = null;
    try {
      if (resource === "commit" && request.method === "POST")
        commit = await readCommitRequest(request);
      else if (resource === "edit" && request.method === "POST") {
        const edit = EditRepositoryFileSchema.safeParse(await readJsonLimited(request, 2_100_000));
        if (edit.success) {
          commit = commitFromEdit(edit.data);
          editedPath = edit.data.path;
        }
      }
    } catch (cause) {
      if (!(cause instanceof CommitRequestError)) throw cause;
      logger.warn("git:commit-request-rejected", { resource, code: cause.code });
      return errorResponse(cause.status, cause.code, cause.message);
    }
    const value = committing ? null : await readJsonLimited(request, 2_100_000);
    const create =
      resource === "branches" && request.method === "POST"
        ? CreateBranchInputSchema.safeParse(value)
        : null;
    const remove =
      resource === "branches" && request.method === "DELETE"
        ? DeleteBranchInputSchema.safeParse(value)
        : null;
    const target = commit
      ? (commit.newBranch ?? commit.branch)
      : create?.success
        ? create.data.name
        : remove?.success
          ? remove.data.name
          : null;
    if (!target || target.startsWith("refs/"))
      return errorResponse(400, "bad_request", "Invalid Git mutation.");
    if (!session && (await protectedBranch(env.DB, repositoryId, target)))
      return errorResponse(
        403,
        "protected_branch",
        "Protected branches require a pull request. Choose a new branch."
      );
    if (remove?.success && remove.data.name === access.repository.defaultBranch)
      return errorResponse(409, "default_branch", "The default branch cannot be deleted.");
    const beforeWrite = async () => {
      const latest = await resolveGitAccess(request, env, repositoryId);
      if (
        latest instanceof Response ||
        !latest?.repository.canWrite ||
        latest.repository.archived ||
        (committing && latest.repository.onlineEditingEnabled === 0) ||
        (!session && (await protectedBranch(env.DB, repositoryId, target))) ||
        (remove?.success && latest.repository.defaultBranch === target)
      )
        throw new GitWriteConflict(
          "Repository permissions or protection changed. Reload before retrying."
        );
    };
    const written = async (branch: string, oid: string, before: string) => {
      if (session || !access.user) return;
      const operation = Promise.all([
        recordGitWrite(
          env,
          repositoryId,
          access.repository.artifactName!,
          access.user,
          branch,
          oid
        ),
        reportPushEvent(env, repositoryId, access.user, [
          { ref: `refs/heads/${branch}`, before, after: oid },
        ]),
      ]);
      if (ctx) ctx.waitUntil(operation);
      else await operation;
    };
    try {
      if (commit) {
        const result = await commitRepositoryChanges(
          repo,
          commit,
          access.user,
          beforeWrite,
          env.LOG_LEVEL
        );
        await written(
          result.branch,
          result.oid,
          commit.newBranch ? ZERO_OID : (commit.expectedOid ?? ZERO_OID)
        );
        logger.info("git:changes-committed", {
          branch: result.branch,
          oid: result.oid,
          changes: commit.changes.length,
        });
        return dataResponse(editedPath === null ? result : { ...result, path: editedPath }, 201);
      }
      if (create?.success) {
        const result = await createRepositoryBranch(
          repo,
          create.data.name,
          create.data.source,
          create.data.expectedOid,
          beforeWrite,
          env.LOG_LEVEL
        );
        await written(result.name, result.oid, ZERO_OID);
        logger.info("git:branch-created", { branch: result.name });
        return dataResponse(result, 201);
      }
      if (remove?.success) {
        await deleteRepositoryBranch(
          repo,
          remove.data.name,
          remove.data.expectedOid,
          beforeWrite,
          env.LOG_LEVEL
        );
        if (!session && access.user) {
          const reported = reportPushEvent(env, repositoryId, access.user, [
            {
              ref: `refs/heads/${remove.data.name}`,
              before: remove.data.expectedOid,
              after: ZERO_OID,
            },
          ]);
          if (ctx) ctx.waitUntil(reported);
          else await reported;
        }
        logger.info("git:branch-deleted", { branch: remove.data.name });
        return dataResponse({ deleted: true });
      }
    } catch (cause) {
      if (cause instanceof GitWriteConflict)
        return errorResponse(409, "refs_changed", cause.message);
      if (cause instanceof GitWriteInputError)
        return errorResponse(400, "bad_request", cause.message);
      throw cause;
    }
  }
  if (resource === "fork-sync") {
    if (request.method !== "POST")
      return errorResponse(405, "method_not_allowed", "Method is not allowed.");
    if (!access.user || !access.repository.canWrite || userSession)
      return errorResponse(403, "forbidden", "Repository write access is required.");
    if (access.repository.archived)
      return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
    const input = ForkSyncInputSchema.safeParse(await readJsonLimited(request, 20_000));
    if (!input.success) return errorResponse(400, "bad_request", "Invalid fork sync.");
    const parent = await env.DB.prepare(
      "SELECT p.id, p.artifact_name AS artifactName, p.visibility FROM repositories f JOIN repositories p ON p.id = f.fork_of WHERE f.id = ? AND p.deleted_at IS NULL AND p.artifact_name IS NOT NULL"
    )
      .bind(repositoryId)
      .first<{ id: string; artifactName: string; visibility: "public" | "private" }>();
    const mayDrawFromParent =
      parent &&
      (parent.visibility === "public" ||
        (access.repository.visibility === "private" &&
          (!access.user.token || accessTokenAllowsRepository(access.user.token, parent.id)) &&
          (await repositoryRole(env.DB, parent.id, access.user.id)) !== null));
    if (!parent || !mayDrawFromParent)
      return errorResponse(404, "upstream_unavailable", "The upstream repository is unavailable.");
    if (await protectedBranch(env.DB, repositoryId, input.data.branch))
      return errorResponse(403, "protected_branch", "Protected branches reject direct updates.");
    using upstream = await env.ARTIFACTS.get(parent.artifactName);
    try {
      const outcome = await syncForkBranch(
        repo,
        upstream,
        input.data.branch,
        async () => {
          const latest = await resolveGitAccess(request, env, repositoryId);
          if (
            latest instanceof Response ||
            !latest?.repository.canWrite ||
            latest.repository.archived ||
            (await protectedBranch(env.DB, repositoryId, input.data.branch))
          )
            throw new GitWriteConflict(
              "Repository permissions or protection changed. Reload before retrying."
            );
        },
        env.LOG_LEVEL
      );
      if (outcome.kind === "synced" && outcome.result.status === "fast_forwarded") {
        const operation = Promise.all([
          recordGitWrite(
            env,
            repositoryId,
            access.repository.artifactName,
            access.user,
            input.data.branch,
            outcome.result.oid
          ),
          reportPushEvent(env, repositoryId, access.user, [
            {
              ref: `refs/heads/${input.data.branch}`,
              before: outcome.before,
              after: outcome.result.oid,
            },
          ]),
        ]);
        if (ctx) ctx.waitUntil(operation);
        else await operation;
      }
      if (outcome.kind === "missing_upstream")
        return errorResponse(404, "branch_not_found", "The upstream has no branch of that name.");
      if (outcome.kind === "not_fast_forward")
        return errorResponse(
          409,
          "not_fast_forward",
          "The fork has diverged from upstream or is too far behind to fast-forward."
        );
      return dataResponse(outcome.result);
    } catch (cause) {
      if (cause instanceof GitWriteConflict)
        return errorResponse(409, "refs_changed", cause.message);
      if (cause instanceof GitWriteInputError)
        return errorResponse(404, "branch_not_found", cause.message);
      if (cause instanceof GitResourceLimitError)
        return errorResponse(413, "repository_too_large", cause.message);
      throw cause;
    }
  }
  if (resource === "merge" && request.method === "POST") {
    if (access.repository.archived)
      return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
    if (!access.user || !access.repository.canWrite || userSession)
      return errorResponse(403, "forbidden", "A repository member must merge proposals.");
    const input = GitMergeInputSchema.safeParse(await readJsonLimited(request));
    if (!input.success || !input.data.pullRequestId || !input.data.leaseAt)
      return errorResponse(400, "bad_request", "Invalid merge request.");
    const headArtifact = await resolveProposalHead(env, access, {
      sessionId: input.data.headSessionId,
      repositoryId: input.data.headRepositoryId,
      ref: input.data.headRef,
    });
    if (!headArtifact) return errorResponse(404, "not_found", "Head repository was not found.");
    using headRepo = await env.ARTIFACTS.get(headArtifact);
    const rules = matchingBranchRules(await branchRules(env.DB, repositoryId), input.data.baseRef);
    if (rules.some((rule) => rule.locked))
      return errorResponse(403, "protected_branch", "This branch is locked.");
    const operationKey = await sha256Hex(
      JSON.stringify([
        repositoryId,
        input.data.baseRef,
        input.data.headRef,
        input.data.expectedBaseOid,
        input.data.expectedHeadOid,
        input.data.method,
      ])
    );
    const current = await resolveCommit(repo, input.data.baseRef);
    if (current?.hash !== input.data.expectedBaseOid && current) {
      const receipt = await env.DB.prepare(
        "SELECT oid FROM git_merge_receipts WHERE operation_key=? AND oid=?"
      )
        .bind(operationKey, current.hash)
        .first<{ oid: string }>();
      if (receipt) return dataResponse({ oid: receipt.oid });
    }
    const result = await mergeArtifacts(
      repo,
      headRepo,
      input.data,
      {
        requireLinearHistory: rules.some((rule) => rule.requireLinearHistory),
        requireSignedCommits: rules.some((rule) => rule.requireSignedCommits),
        verifySignature: async (raw) =>
          (await verifyObjectSignature(env.DB, "commit", raw)).status === "valid",
        beforePush: async (oid) => {
          const latest = await resolveGitAccess(request, env, repositoryId);
          const latestRules = matchingBranchRules(
            await branchRules(env.DB, repositoryId),
            input.data.baseRef
          );
          if (
            latest instanceof Response ||
            !latest?.repository.canWrite ||
            latest.repository.archived ||
            JSON.stringify(latestRules) !== JSON.stringify(rules)
          )
            throw new GitWriteConflict("Repository access or branch rules changed during merge.");
          if (!env.FORGE) throw new Error("Merge authorization service is unavailable.");
          const headers = trustedHeaders(access.user ?? undefined);
          headers.set("Content-Type", "application/json");
          const authorization = await env.FORGE.fetch(
            new Request("https://forge.internal/internal/merge-authorization", {
              method: "POST",
              headers,
              body: JSON.stringify({ ...input.data, repositoryId }),
            })
          );
          await authorization.body?.cancel();
          if (!authorization.ok)
            throw new GitWriteConflict("Merge authorization changed; reload before retrying.");
          await env.DB.prepare(
            "INSERT OR IGNORE INTO git_merge_receipts(operation_key,oid,repository_id,created_at) VALUES(?,?,?,?)"
          )
            .bind(operationKey, oid, repositoryId, Date.now())
            .run();
        },
      },
      env.LOG_LEVEL
    );
    if (!result.ok) {
      logger.warn("artifacts:merge-rejected", { reason: result.reason });
      return errorResponse(
        409,
        result.reason,
        {
          refs_changed: "Git refs changed; reload before retrying.",
          merge_conflict: "The branches conflict. Resolve conflicts on the source branch.",
          already_merged: "These changes are already in the target branch.",
          nonlinear_history:
            "The branch requires linear history. Use squash or rebase, or update the source branch first.",
          unsigned_commits:
            "All introduced commits require valid registered signatures; use a fast-forward merge to preserve them.",
          commit_limit: "This operation exceeds the 100-commit limit.",
        }[result.reason]
      );
    }
    const operation = Promise.all([
      recordGitWrite(
        env,
        repositoryId,
        access.repository.artifactName,
        access.user,
        input.data.baseRef,
        result.oid
      ),
      reportPushEvent(env, repositoryId, access.user, [
        {
          ref: `refs/heads/${input.data.baseRef}`,
          before: current?.hash ?? ZERO_OID,
          after: result.oid,
        },
      ]),
    ]);
    if (ctx) ctx.waitUntil(operation);
    else await operation;
    logger.info("artifacts:merged", { oid: result.oid });
    return dataResponse({ oid: result.oid });
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  const artifactName = access.repository.artifactName;
  const dispatch = async (target = ref): Promise<Response> => {
    if (resource === "community")
      return dataResponse(await repositoryCommunity(env, access.repository, repo, ref));
    if (resource === "refs") return dataResponse(await listArtifactRefs(repo, env.LOG_LEVEL));
    if (resource === "branches") {
      const rules = await branchRules(env.DB, repositoryId),
        refs = await listArtifactRefs(repo, env.LOG_LEVEL);
      return dataResponse(
        refs
          .filter((item) => item.name.startsWith("refs/heads/"))
          .map((item) => {
            const name = item.name.slice(11),
              matching = session ? [] : matchingBranchRules(rules, name);
            return {
              name,
              oid: item.oid,
              protected: matching.length > 0,
              rules: matching.map((rule) => rule.pattern),
              isDefault: name === access.repository.defaultBranch,
            };
          })
      );
    }
    if (resource === "snapshot") {
      const oid = url.searchParams.get("oid") ?? (await resolveCommit(repo, ref))?.hash ?? "";
      if (!GitOidSchema.safeParse(oid).success || !(await refContainsCommit(repo, ref, oid)))
        return errorResponse(404, "not_found", "The selected commit is unavailable.");
      return dataResponse(await repositorySnapshot(repo, oid));
    }
    if (resource === "signature") {
      const tagName = url.searchParams.get("tag");
      if (tagName !== null) {
        if (!GitTagNameSchema.safeParse(tagName).success)
          return errorResponse(400, "bad_request", "Invalid tag name.");
        const tag = (await listArtifactRefs(repo, env.LOG_LEVEL)).find(
          (item) => item.name === `refs/tags/${tagName}`
        );
        if (!tag) return errorResponse(404, "not_found", "Tag was not found.");
        // Lightweight tags have no tag object and therefore no signature of their own.
        if (tag.peeledOid === undefined)
          return dataResponse({
            status: "unsigned",
            format: null,
            fingerprint: null,
            signer: null,
            verifiedAt: Date.now(),
          } satisfies GitSignature);
        return dataResponse(
          await readObjectSignature(repo, env.DB, "tag", tag.oid, env.LOG_LEVEL)
        );
      }
      const oid = url.searchParams.get("oid") ?? "";
      const commitRef = url.searchParams.get("ref");
      if (!GitOidSchema.safeParse(oid).success || !commitRef)
        return errorResponse(400, "bad_request", "Invalid commit oid or ref.");
      if (!(await refContainsCommit(repo, commitRef, oid)))
        return errorResponse(404, "not_found", "Commit was not found in this repository ref.");
      return dataResponse(await readObjectSignature(repo, env.DB, "commit", oid, env.LOG_LEVEL));
    }
    if (resource === "commit") {
      const oid = url.searchParams.get("oid") ?? "";
      const commitRef = url.searchParams.get("ref");
      if (!GitOidSchema.safeParse(oid).success || !commitRef)
        return errorResponse(400, "bad_request", "Invalid commit oid or ref.");
      const commit = (await refContainsCommit(repo, commitRef, oid))
        ? await repo.readCommit(oid)
        : null;
      logger.debug("artifacts:commit-lookup", { oid, ref: commitRef, found: commit !== null });
      return commit
        ? dataResponse(commitResponse(commit))
        : errorResponse(404, "not_found", "Commit was not found.");
    }
    if (resource === "commit-diff") {
      const oid = url.searchParams.get("oid") ?? "";
      if (!GitOidSchema.safeParse(oid).success)
        return errorResponse(400, "bad_request", "Invalid commit oid.");
      const detail = await commitDetail(repo, oid);
      logger.debug("artifacts:commit-diff", {
        oid,
        found: detail !== null,
        files: detail?.files.length,
        truncated: detail?.truncated,
      });
      return detail
        ? dataResponse(detail)
        : errorResponse(404, "not_found", "Commit was not found.");
    }
    if (resource === "files") {
      const list = await listFiles(repo, target);
      if (!list) return errorResponse(404, "not_found", "Ref was not found.");
      if (list.truncated)
        logger.warn("artifacts:file-list-truncated", { paths: list.paths.length });
      return dataResponse(list);
    }
    if (resource === "history") {
      const cursor = url.searchParams.get("cursor");
      if (cursor !== null && !GitOidSchema.safeParse(cursor).success)
        return errorResponse(400, "bad_request", "Invalid history cursor.");
      if (!path) return errorResponse(400, "bad_request", "A file or directory path is required.");
      const history = await pathHistory(repo, cursor ?? target, path);
      logger.debug("artifacts:path-history", {
        inspected: history.inspected,
        matches: history.commits.length,
        truncated: history.truncated,
      });
      return dataResponse(history);
    }
    if (resource === "blame") {
      const result = path ? await blameFile(repo, target, path) : { status: "not_found" as const };
      if (result.status === "not_found")
        return errorResponse(404, "not_found", "File was not found.");
      if (result.status === "unsupported")
        return errorResponse(
          422,
          result.reason === "binary" ? "binary_file" : "file_too_large",
          result.reason === "binary"
            ? "Blame is unavailable for binary files."
            : "File is too large to blame."
        );
      if (result.blame.partial)
        logger.warn("artifacts:blame-partial", { inspected: result.blame.inspected });
      return dataResponse(result.blame);
    }
    if (resource === "commits")
      return dataResponse(
        (
          await repo.log({
            ref: target,
            limit: Math.max(1, pageNumber(url.searchParams.get("limit"), 30, 100)),
            offset: pageNumber(url.searchParams.get("offset"), 0, 10000),
          })
        ).map(commitResponse)
      );
    if (resource === "tree") {
      const tree = await readArtifactTree(repo, target, path);
      return tree
        ? dataResponse({ ...tree, ref })
        : errorResponse(404, "not_found", "Directory was not found.");
    }
    if (resource === "file") {
      const file = path ? await readArtifactFile(repo, target, path) : null;
      return file ? dataResponse(file) : errorResponse(404, "not_found", "File was not found.");
    }
    if (resource === "tags") {
      const name = url.searchParams.get("name");
      if (name !== null && !GitTagNameSchema.safeParse(name).success)
        return errorResponse(400, "bad_request", "Invalid tag name.");
      const { tags, truncated } = await listRepositoryTags(repo, env.LOG_LEVEL, name);
      return jsonResponse({ data: tags, truncated });
    }
    if (resource === "archive") {
      const format: ArchiveFormat | null =
        url.searchParams.get("format") === "tar.gz"
          ? "tar.gz"
          : url.searchParams.get("format") === "zip"
            ? "zip"
            : null;
      if (!format)
        return errorResponse(400, "bad_request", "Archive format must be zip or tar.gz.");
      const commit = await resolveCommit(repo, ref);
      if (!commit) return errorResponse(404, "not_found", "The selected ref was not found.");
      const label = GitOidSchema.safeParse(ref).success ? ref.slice(0, 7) : ref;
      const name = `${access.repository.slug}-${label.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
      const etag = `"${commit.hash}-${format}"`;
      const headers = {
        ETag: etag,
        ...edgeDownloadHeaders(
          { kind: GitOidSchema.safeParse(ref).success ? "immutable" : "ref", oid: commit.hash },
          {
            shared: access.repository.visibility === "public" && !session,
            anonymous: !access.user,
          }
        ),
        "X-Content-Type-Options": "nosniff",
      };
      if (matchesEtag(request.headers.get("If-None-Match"), etag))
        return new Response(null, { status: 304, headers });
      try {
        const plan = await planArchive(repo, commit.treeHash);
        logger.info("git:archive-started", {
          format,
          files: plan.files.length,
          directories: plan.directories.length,
        });
        // HEAD must not start the producer, and the stream outlives this function's `repo`
        // handle, so it reads through its own handle that is released when the stream settles.
        const body =
          request.method === "HEAD"
            ? null
            : releaseWhenSettled(await env.ARTIFACTS.get(artifactName), (handle) =>
                archiveStream(handle, plan, format, {
                  root: name,
                  mtime: new Date(commit.committedAt * 1000),
                  onError: (cause) =>
                    logger.warn("git:archive-aborted", {
                      format,
                      code: cause instanceof ArchiveError ? cause.code : "stream_failed",
                      error: cause instanceof Error ? cause.message : "unknown",
                    }),
                })
              );
        return new Response(body, {
          headers: {
            ...headers,
            "Content-Type": archiveContentType(format),
            "Content-Disposition": contentDisposition("attachment", `${name}.${format}`),
            "Content-Security-Policy": "default-src 'none'; sandbox",
          },
        });
      } catch (cause) {
        if (!(cause instanceof ArchiveError)) throw cause;
        logger.warn("git:archive-refused", { format, code: cause.code });
        return errorResponse(
          cause.code === "archive_too_large" ? 413 : 422,
          cause.code,
          cause.message
        );
      }
    }
    if (resource === "raw") {
      const spec = url.searchParams.get("spec");
      const target = spec
        ? await splitRawSpec(spec, access.repository.defaultBranch, async () => {
            const names = new Set<string>();
            for (const item of await listArtifactRefs(repo, env.LOG_LEVEL))
              names.add(item.name.replace(/^refs\/(?:heads|tags)\//, ""));
            return names;
          })
        : { ref, path };
      if (!target?.path || !validPath(target.path) || target.ref.length > 255)
        return errorResponse(404, "not_found", "File was not found.");
      const served = await serveRaw(repo, target, {
        audience: {
          shared: access.repository.visibility === "public" && !session,
          anonymous: !access.user,
        },
        forceDownload: url.searchParams.get("download") === "1",
        head: request.method === "HEAD",
        ifNoneMatch: request.headers.get("If-None-Match"),
      });
      if (served.status === 413) logger.warn("git:raw-refused", { reason: "file_too_large" });
      return served;
    }
    if (resource === "graph") {
      const refs = await listArtifactRefs(repo, env.LOG_LEVEL);
      const sessions = await listRepositorySessions(env, access);
      const limit = Math.max(1, pageNumber(url.searchParams.get("limit"), 100, 250));
      const graph = await artifactGraph(repo, refs, sessions, limit);
      for (const workspace of sessions
        .filter((item) => item.id !== session?.id && item.status !== "revoked")
        .slice(0, 10)) {
        using fork = await env.ARTIFACTS.get(workspace.workspaceName);
        const forkRefs = await listArtifactRefs(fork, env.LOG_LEVEL);
        const forkGraph = await artifactGraph(fork, forkRefs, [], 30);
        const existing = new Set(graph.commits.map((commit) => commit.oid));
        graph.commits.push(...forkGraph.commits.filter((commit) => !existing.has(commit.oid)));
        graph.refs.push(
          ...forkRefs
            .filter((item) => item.name.startsWith("refs/heads/"))
            .map((item) => ({
              name: `session/${workspace.id}/${item.name.slice(11)}`,
              oid: item.oid,
            }))
        );
        graph.truncated ||= forkGraph.truncated;
      }
      graph.commits = orderCommits(graph.commits);
      logger.debug("artifacts:graph-read", {
        commits: graph.commits.length,
        sessions: sessions.length,
      });
      return dataResponse(graph);
    }
    if (resource === "pull-head") {
      const head = url.searchParams.get("head") ?? "HEAD";
      const headArtifact = await resolveProposalHead(env, access, {
        sessionId: url.searchParams.get("headSessionId"),
        repositoryId: url.searchParams.get("headRepositoryId"),
        ref: head,
      });
      if (!headArtifact) return errorResponse(404, "not_found", "Head repository was not found.");
      using headRepo = await env.ARTIFACTS.get(headArtifact);
      const commit = await resolveCommit(headRepo, head);
      return commit
        ? dataResponse({ oid: commit.hash })
        : errorResponse(404, "not_found", "Head ref was not found.");
    }
    if (resource === "compare") {
      const head = url.searchParams.get("head") ?? "HEAD";
      const headArtifact = await resolveProposalHead(env, access, {
        sessionId: url.searchParams.get("headSessionId"),
        repositoryId: url.searchParams.get("headRepositoryId"),
        ref: head,
      });
      if (!headArtifact) return errorResponse(404, "not_found", "Head repository was not found.");
      using headRepo = await env.ARTIFACTS.get(headArtifact);
      const comparison = await compareArtifacts(
        repo,
        headRepo,
        url.searchParams.get("base") ?? access.repository.defaultBranch,
        head
      );
      return comparison
        ? dataResponse(comparison)
        : errorResponse(404, "not_found", "Comparison ref was not found.");
    }
    return errorResponse(404, "not_found", "Endpoint was not found.");
  };
  const scope = repositoryCacheScope(access.repository);
  const reference = scope ? edgeReference(resource, url, ref, path) : null;
  if (!scope || !reference) return await dispatch();
  const audience = {
    shared: access.repository.visibility === "public" && !session,
    anonymous: !access.user,
  };
  const address = await edgeAddress(repo, reference, audience.shared);
  return await serveEdgeRead({
    request,
    cache: caches.default,
    waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
    logger,
    scope,
    resource,
    address,
    audience,
    params: reference.params,
    // A branch is read at the commit it resolved to, so a concurrent push cannot store newer
    // content under the older commit's key.
    compute: () => dispatch(address?.kind === "ref" ? address.oid : ref),
  });
}
