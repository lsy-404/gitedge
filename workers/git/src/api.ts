import { createLogger } from "../../../src/worker/common/logger";
import { listRepositorySessions, resolveGitAccess, resolveWorkspace, type GitEnv } from "./access";
import {
  artifactGraph,
  commitResponse,
  listArtifactRefs,
  readArtifactFile,
  readArtifactTree,
  orderCommits,
} from "./read";
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
export async function handleGitApi(request: Request, env: GitEnv): Promise<Response> {
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
  using repo = await env.ARTIFACTS.get(
    proposalComparison
      ? access.repository.artifactName
      : (session?.workspaceName ?? access.repository.artifactName)
  );
  const logger = createLogger(env.LOG_LEVEL, { service: "artifacts-git", repoId: repositoryId });
  const ref = url.searchParams.get("ref") ?? access.repository.defaultBranch;
  const path = url.searchParams.get("path") ?? "";
  if (!validPath(path) || ref.length > 255 || !ref.length)
    return fail(400, "bad_request", "Invalid ref or path.");
  logger.debug("artifacts:request", { resource, sessionId: session?.id });
  if (resource === "merge" && request.method === "POST") {
    if (!access.user || !access.repository.canWrite || userSession)
      return fail(403, "forbidden", "A repository member must merge proposals.");
    const input = GitMergeInputSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) return fail(400, "bad_request", "Invalid merge request.");
    const headSession = input.data.headSessionId
      ? await resolveWorkspace(env, access, input.data.headSessionId)
      : null;
    if (input.data.headSessionId && !headSession)
      return fail(404, "not_found", "Head session was not found.");
    using headRepo = await env.ARTIFACTS.get(
      headSession?.workspaceName ?? access.repository.artifactName
    );
    const result = await mergeArtifacts(repo, headRepo, input.data);
    if (!result.ok) {
      logger.warn("artifacts:merge-rejected", { reason: result.reason });
      return fail(
        409,
        result.reason,
        "Merge was rejected; refresh refs and resolve conflicts before retrying."
      );
    }
    logger.info("artifacts:merged", { oid: result.oid });
    return json({ oid: result.oid });
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return fail(405, "method_not_allowed", "Method is not allowed.");
  if (resource === "refs") return json(await listArtifactRefs(repo, env.LOG_LEVEL));
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
