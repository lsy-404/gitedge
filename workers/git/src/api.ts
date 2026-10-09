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
  editRepositoryFile,
  createRepositoryBranch,
  deleteRepositoryBranch,
  GitWriteConflict,
  GitWriteInputError,
  ZERO_OID,
} from "./write";
import { repositorySnapshot } from "./snapshot";
import { GitTagExists, createRepositoryTag, deleteRepositoryTag, listRepositoryTags } from "./tags";
import { serveRaw, splitRawSpec } from "./raw";
import {
  ArchiveError,
  archiveContentType,
  archiveStream,
  planArchive,
  type ArchiveFormat,
} from "./archive";
import { contentDisposition } from "../../../src/worker/common/content-disposition";
import { createLogger } from "../../../src/worker/common/logger";
import {
  GitMergeInputSchema,
  GitOidSchema,
  accessTokenAllows,
  requiredAccessTokenScope,
  sha256Hex,
} from "../../../packages/contracts/src/index";
import { listRepositorySessions, resolveGitAccess, resolveWorkspace, type GitEnv } from "./access";
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
import { readCommitSignature, verifyCommitSignature } from "./signatures";
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
/**
 * Responses addressed by a full commit id never change; others must be revalidated. Private
 * entries vary by credentials so a browser never replays them after sign-out or to another user.
 */
function oidCacheHeaders(
  ref: string,
  access: { repository: { visibility: string } },
  scopedToSession: boolean
): HeadersInit | undefined {
  if (!GitOidSchema.safeParse(ref).success) return undefined;
  return scopedToSession || access.repository.visibility !== "public"
    ? { "Cache-Control": "private, max-age=3600", Vary: "Cookie, Authorization" }
    : { "Cache-Control": "public, max-age=3600, immutable" };
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
    (resource === "compare" || resource === "pull-head") && url.searchParams.has("headSessionId");
  // Commit lookups answer whether the repository itself holds a commit, never a private fork.
  const repositoryScoped =
    proposalComparison ||
    resource === "pull-head" ||
    resource === "commit" ||
    resource === "commit-diff" ||
    resource === "signature" ||
    resource === "snapshot" ||
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
  if ((resource === "edit" || resource === "branches") && request.method !== "GET") {
    if (!access.user || !access.repository.canWrite || userSession?.permission === "read")
      return errorResponse(403, "forbidden", "Repository write access is required.");
    if (access.repository.archived)
      return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
    if (resource === "edit" && access.repository.onlineEditingEnabled === 0)
      return errorResponse(404, "feature_disabled", "Online editing is disabled.");
    if (session && !userSession && session.userId !== access.user.id)
      return errorResponse(404, "not_found", "Session workspace was not found.");
    const value = await readJsonLimited(request, 2_100_000);
    const edit =
      resource === "edit" && request.method === "POST"
        ? EditRepositoryFileSchema.safeParse(value)
        : null;
    const create =
      resource === "branches" && request.method === "POST"
        ? CreateBranchInputSchema.safeParse(value)
        : null;
    const remove =
      resource === "branches" && request.method === "DELETE"
        ? DeleteBranchInputSchema.safeParse(value)
        : null;
    const target = edit?.success
      ? (edit.data.newBranch ?? edit.data.branch)
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
        (resource === "edit" && latest.repository.onlineEditingEnabled === 0) ||
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
      if (edit?.success) {
        const result = await editRepositoryFile(
          repo,
          edit.data,
          access.user,
          beforeWrite,
          env.LOG_LEVEL
        );
        await written(
          result.branch,
          result.oid,
          edit.data.newBranch ? ZERO_OID : (edit.data.expectedOid ?? ZERO_OID)
        );
        logger.info("git:file-committed", { branch: result.branch, oid: result.oid });
        return dataResponse(result, 201);
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
  if (resource === "merge" && request.method === "POST") {
    if (access.repository.archived)
      return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
    if (!access.user || !access.repository.canWrite || userSession)
      return errorResponse(403, "forbidden", "A repository member must merge proposals.");
    const input = GitMergeInputSchema.safeParse(await readJsonLimited(request));
    if (!input.success || !input.data.pullRequestId || !input.data.leaseAt)
      return errorResponse(400, "bad_request", "Invalid merge request.");
    const headSession = input.data.headSessionId
      ? await resolveWorkspace(env, access, input.data.headSessionId)
      : null;
    if (input.data.headSessionId && !headSession)
      return errorResponse(404, "not_found", "Head session was not found.");
    using headRepo = await env.ARTIFACTS.get(
      headSession?.workspaceName ?? access.repository.artifactName
    );
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
        verifySignature: async (payload, signature) =>
          (await verifyCommitSignature(env.DB, payload, signature)).status === "valid",
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
    const oid = url.searchParams.get("oid") ?? "";
    const commitRef = url.searchParams.get("ref");
    if (!GitOidSchema.safeParse(oid).success || !commitRef)
      return errorResponse(400, "bad_request", "Invalid commit oid or ref.");
    if (!(await refContainsCommit(repo, commitRef, oid)))
      return errorResponse(404, "not_found", "Commit was not found in this repository ref.");
    return dataResponse(await readCommitSignature(repo, env.DB, oid, env.LOG_LEVEL));
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
      ? dataResponse(detail, 200, oidCacheHeaders(oid, access, false))
      : errorResponse(404, "not_found", "Commit was not found.");
  }
  if (resource === "files") {
    const list = await listFiles(repo, ref);
    if (!list) return errorResponse(404, "not_found", "Ref was not found.");
    if (list.truncated) logger.warn("artifacts:file-list-truncated", { paths: list.paths.length });
    return dataResponse(list, 200, oidCacheHeaders(ref, access, session !== null));
  }
  if (resource === "history") {
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !GitOidSchema.safeParse(cursor).success)
      return errorResponse(400, "bad_request", "Invalid history cursor.");
    if (!path) return errorResponse(400, "bad_request", "A file or directory path is required.");
    const history = await pathHistory(repo, cursor ?? ref, path);
    logger.debug("artifacts:path-history", {
      inspected: history.inspected,
      matches: history.commits.length,
      truncated: history.truncated,
    });
    return dataResponse(history, 200, oidCacheHeaders(cursor ?? ref, access, session !== null));
  }
  if (resource === "blame") {
    const result = path ? await blameFile(repo, ref, path) : { status: "not_found" as const };
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
    return dataResponse(result.blame, 200, oidCacheHeaders(ref, access, session !== null));
  }
  if (resource === "commits")
    return dataResponse(
      (
        await repo.log({
          ref,
          limit: Math.max(1, pageNumber(url.searchParams.get("limit"), 30, 100)),
          offset: pageNumber(url.searchParams.get("offset"), 0, 10000),
        })
      ).map(commitResponse)
    );
  if (resource === "tree") {
    const tree = await readArtifactTree(repo, ref, path);
    return tree ? dataResponse(tree) : errorResponse(404, "not_found", "Directory was not found.");
  }
  if (resource === "file") {
    const file = path ? await readArtifactFile(repo, ref, path) : null;
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
    if (!format) return errorResponse(400, "bad_request", "Archive format must be zip or tar.gz.");
    const commit = await resolveCommit(repo, ref);
    if (!commit) return errorResponse(404, "not_found", "The selected ref was not found.");
    const label = GitOidSchema.safeParse(ref).success ? ref.slice(0, 7) : ref;
    const name = `${access.repository.slug}-${label.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
    const etag = `"${commit.hash}-${format}"`;
    const publicRepository = access.repository.visibility === "public";
    const headers = {
      ETag: etag,
      "Cache-Control": publicRepository
        ? GitOidSchema.safeParse(ref).success
          ? "public, max-age=300"
          : "public, max-age=0, must-revalidate"
        : "private, no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (
      request.headers
        .get("If-None-Match")
        ?.split(",")
        .some((value) => value.trim() === etag)
    )
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
          : releaseWhenSettled(await env.ARTIFACTS.get(access.repository.artifactName), (handle) =>
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
      publicRepository: access.repository.visibility === "public" && !session,
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
    const headSessionId = url.searchParams.get("headSessionId");
    const head = url.searchParams.get("head") ?? "HEAD";
    const headSession = headSessionId
      ? await resolveWorkspace(env, access, headSessionId, head)
      : null;
    if (headSessionId && !headSession)
      return errorResponse(404, "not_found", "Head session was not found.");
    using headRepo = await env.ARTIFACTS.get(
      headSession?.workspaceName ?? access.repository.artifactName
    );
    const commit = await resolveCommit(headRepo, head);
    return commit
      ? dataResponse({ oid: commit.hash })
      : errorResponse(404, "not_found", "Head ref was not found.");
  }
  if (resource === "compare") {
    const headSessionId = url.searchParams.get("headSessionId");
    const head = url.searchParams.get("head") ?? "HEAD";
    const headSession = headSessionId
      ? await resolveWorkspace(env, access, headSessionId, head)
      : null;
    if (headSessionId && !headSession)
      return errorResponse(404, "not_found", "Head session was not found.");
    using headRepo = await env.ARTIFACTS.get(
      headSession?.workspaceName ?? access.repository.artifactName
    );
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
}
