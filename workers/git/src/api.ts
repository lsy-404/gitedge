import { trustedHeaders } from "../../../packages/contracts/src/trust";
import { recordGitWrite } from "./events";
import { repositoryCommunity } from "./community";
import {
  EditRepositoryFileSchema,
  CreateBranchInputSchema,
  DeleteBranchInputSchema,
} from "../../../packages/contracts/src/repository-controls";
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
} from "./write";
import { repositorySnapshot } from "./snapshot";
import { createLogger } from "../../../src/worker/common/logger";
import { GitOidSchema, sha256Hex } from "../../../packages/contracts/src/index";
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
import { GitMergeInputSchema, mergeArtifacts } from "./merge";

export function json(data: unknown, status = 200): Response {
  return Response.json({ data }, { status, headers: { "Cache-Control": "no-store" } });
}
export function fail(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}
function pageNumber(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return value !== null && Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, maximum)
    : fallback;
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
    return fail(404, "not_found", "Endpoint was not found.");
  const access = await resolveGitAccess(request, env, repositoryId);
  if (!access) return fail(404, "not_found", "Repository was not found.");
  if (!access.repository.artifactName)
    return fail(
      409,
      "repository_storage_unavailable",
      "Repository must be imported into Artifacts before it can be used."
    );
  const userSession = access.user?.agentSession;
  const sessionId = url.searchParams.get("sessionId") ?? userSession?.id;
  const session = sessionId ? await resolveWorkspace(env, access, sessionId) : null;
  if (sessionId && !session) return fail(404, "not_found", "Session workspace was not found.");
  const resource = parts[2];
  const proposalComparison = resource === "compare" && url.searchParams.has("headSessionId");
  // Commit lookups answer whether the repository itself holds a commit, never a private fork.
  const repositoryScoped =
    proposalComparison ||
    resource === "commit" ||
    resource === "signature" ||
    resource === "snapshot";
  using repo = await env.ARTIFACTS.get(
    repositoryScoped
      ? access.repository.artifactName
      : (session?.workspaceName ?? access.repository.artifactName)
  );
  const logger = createLogger(env.LOG_LEVEL, { service: "artifacts-git", repoId: repositoryId });
  const ref = url.searchParams.get("ref") ?? session?.baseRef ?? access.repository.defaultBranch;
  const path = url.searchParams.get("path") ?? "";
  if (!validPath(path) || ref.length > 255 || !ref.length)
    return fail(400, "bad_request", "Invalid ref or path.");
  logger.debug("artifacts:request", { resource, sessionId: session?.id });
  if (resource === "graph" && access.repository.graphEnabled === 0)
    return fail(404, "feature_disabled", "Commit graph is disabled.");
  if ((resource === "edit" || resource === "branches") && request.method !== "GET") {
    if (!access.user || !access.repository.canWrite || userSession?.permission === "read")
      return fail(403, "forbidden", "Repository write access is required.");
    if (access.repository.archived)
      return fail(409, "repository_archived", "Archived repositories are read-only.");
    if (resource === "edit" && access.repository.onlineEditingEnabled === 0)
      return fail(404, "feature_disabled", "Online editing is disabled.");
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
      return fail(400, "bad_request", "Invalid Git mutation.");
    if (!session && (await protectedBranch(env.DB, repositoryId, target)))
      return fail(
        403,
        "protected_branch",
        "Protected branches require a pull request. Choose a new branch."
      );
    if (remove?.success && remove.data.name === access.repository.defaultBranch)
      return fail(409, "default_branch", "The default branch cannot be deleted.");
    const beforeWrite = async () => {
      const latest = await resolveGitAccess(request, env, repositoryId);
      if (
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
    const written = async (branch: string, oid: string) => {
      if (session || !access.user) return;
      const operation = recordGitWrite(
        env,
        repositoryId,
        access.repository.artifactName!,
        access.user,
        branch,
        oid
      );
      if (ctx) ctx.waitUntil(operation);
      else await operation;
    };
    try {
      if (edit?.success) {
        const result = await editRepositoryFile(repo, edit.data, access.user, beforeWrite);
        await written(result.branch, result.oid);
        logger.info("git:file-committed", { branch: result.branch, oid: result.oid });
        return json(result, 201);
      }
      if (create?.success) {
        const result = await createRepositoryBranch(
          repo,
          create.data.name,
          create.data.source,
          create.data.expectedOid,
          beforeWrite
        );
        await written(result.name, result.oid);
        logger.info("git:branch-created", { branch: result.name });
        return json(result, 201);
      }
      if (remove?.success) {
        await deleteRepositoryBranch(repo, remove.data.name, remove.data.expectedOid, beforeWrite);
        logger.info("git:branch-deleted", { branch: remove.data.name });
        return json({ deleted: true });
      }
    } catch (cause) {
      if (cause instanceof GitWriteConflict) return fail(409, "refs_changed", cause.message);
      if (cause instanceof GitWriteInputError) return fail(400, "bad_request", cause.message);
      throw cause;
    }
  }
  if (resource === "merge" && request.method === "POST") {
    if (access.repository.archived)
      return fail(409, "repository_archived", "Archived repositories are read-only.");
    if (!access.user || !access.repository.canWrite || userSession)
      return fail(403, "forbidden", "A repository member must merge proposals.");
    const input = GitMergeInputSchema.safeParse(await readJsonLimited(request));
    if (!input.success || !input.data.pullRequestId || !input.data.leaseAt)
      return fail(400, "bad_request", "Invalid merge request.");
    const headSession = input.data.headSessionId
      ? await resolveWorkspace(env, access, input.data.headSessionId)
      : null;
    if (input.data.headSessionId && !headSession)
      return fail(404, "not_found", "Head session was not found.");
    using headRepo = await env.ARTIFACTS.get(
      headSession?.workspaceName ?? access.repository.artifactName
    );
    const rules = matchingBranchRules(await branchRules(env.DB, repositoryId), input.data.baseRef);
    if (rules.some((rule) => rule.locked))
      return fail(403, "protected_branch", "This branch is locked.");
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
      if (receipt) return json({ oid: receipt.oid });
    }
    const result = await mergeArtifacts(repo, headRepo, input.data, {
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
            body: JSON.stringify(input.data),
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
    });
    if (!result.ok) {
      logger.warn("artifacts:merge-rejected", { reason: result.reason });
      return fail(
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
    const operation = recordGitWrite(
      env,
      repositoryId,
      access.repository.artifactName,
      access.user,
      input.data.baseRef,
      result.oid
    );
    if (ctx) ctx.waitUntil(operation);
    else await operation;
    logger.info("artifacts:merged", { oid: result.oid });
    return json({ oid: result.oid });
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return fail(405, "method_not_allowed", "Method is not allowed.");
  if (resource === "community")
    return json(await repositoryCommunity(env, access.repository, repo, ref));
  if (resource === "refs") return json(await listArtifactRefs(repo, env.LOG_LEVEL));
  if (resource === "branches") {
    const rules = await branchRules(env.DB, repositoryId),
      refs = await listArtifactRefs(repo, env.LOG_LEVEL);
    return json(
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
    const oid = url.searchParams.get("oid") ?? "";
    if (!GitOidSchema.safeParse(oid).success || !(await refContainsCommit(repo, ref, oid)))
      return fail(404, "not_found", "The selected commit is unavailable.");
    return json(await repositorySnapshot(repo, oid));
  }
  if (resource === "signature") {
    const oid = url.searchParams.get("oid") ?? "";
    const commitRef = url.searchParams.get("ref");
    if (!GitOidSchema.safeParse(oid).success || !commitRef)
      return fail(400, "bad_request", "Invalid commit oid or ref.");
    if (!(await refContainsCommit(repo, commitRef, oid)))
      return fail(404, "not_found", "Commit was not found in this repository ref.");
    return json(await readCommitSignature(repo, env.DB, oid, env.LOG_LEVEL));
  }
  if (resource === "commit") {
    const oid = url.searchParams.get("oid") ?? "";
    const commitRef = url.searchParams.get("ref");
    if (!GitOidSchema.safeParse(oid).success || !commitRef)
      return fail(400, "bad_request", "Invalid commit oid or ref.");
    const commit = (await refContainsCommit(repo, commitRef, oid))
      ? await repo.readCommit(oid)
      : null;
    logger.debug("artifacts:commit-lookup", { oid, ref: commitRef, found: commit !== null });
    return commit ? json(commitResponse(commit)) : fail(404, "not_found", "Commit was not found.");
  }
  if (resource === "commits")
    return json(
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
    return tree ? json(tree) : fail(404, "not_found", "Directory was not found.");
  }
  if (resource === "file") {
    const file = path ? await readArtifactFile(repo, ref, path) : null;
    return file ? json(file) : fail(404, "not_found", "File was not found.");
  }
  if (resource === "raw") {
    const blob = path ? await repo.readFile({ ref, path }) : null;
    return blob
      ? new Response(request.method === "HEAD" ? null : blob.stream(), {
          headers: {
            "Content-Type": blob.type || "application/octet-stream",
            "Content-Length": String(blob.size),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
            "Content-Disposition": "attachment",
          },
        })
      : fail(404, "not_found", "File was not found.");
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
    return json(graph);
  }
  if (resource === "compare") {
    const headSessionId = url.searchParams.get("headSessionId");
    const head = url.searchParams.get("head") ?? "HEAD";
    const headSession = headSessionId
      ? await resolveWorkspace(env, access, headSessionId, head)
      : null;
    if (headSessionId && !headSession) return fail(404, "not_found", "Head session was not found.");
    using headRepo = await env.ARTIFACTS.get(
      headSession?.workspaceName ?? access.repository.artifactName
    );
    const comparison = await compareArtifacts(
      repo,
      headRepo,
      url.searchParams.get("base") ?? access.repository.defaultBranch,
      head
    );
    return comparison ? json(comparison) : fail(404, "not_found", "Comparison ref was not found.");
  }
  return fail(404, "not_found", "Endpoint was not found.");
}
