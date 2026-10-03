import { resolveRepositoryPath } from "../../../src/worker/common/repositories";
import { branchRules, matchingBranchRules } from "../../../src/worker/common/branch-protection";
import { readReceiveCommands, InvalidReceiveCommands } from "./receive-commands";
import { z } from "zod";
import { resolveGitAccess, type GitEnv } from "./access";
import { fail } from "./api";
import { createLogger } from "../../../src/worker/common/logger";

const GitGrantSchema = z.object({
  repositoryId: z.string(),
  permission: z.enum(["read", "write"]),
});
export async function proxyGitTransport(request: Request, env: GitEnv): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
    url.pathname
  );
  if (!match) return fail(404, "not_found", "Git endpoint was not found.");
  const repository = await resolveRepositoryPath(env.DB, match[1], match[2]);
  if (!repository) return fail(404, "not_found", "Repository was not found.");
  const access = await resolveGitAccess(request, env, repository.id);
  if (!access) return fail(404, "not_found", "Repository was not found.");
  if (repository.owner !== match[1] || repository.slug !== match[2]) {
    const redirect = new URL(request.url);
    redirect.pathname = `/${repository.owner}/${repository.slug}.git/${match[3]}`;
    return new Response(null, {
      status: 308,
      headers: { Location: redirect.toString(), "Cache-Control": "no-store" },
    });
  }
  const write =
    match[3] === "git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";
  if (write && access.repository.archived === 1)
    return fail(409, "repository_archived", "Archived repositories are read-only.");
  if (match[3] === "info/refs" ? request.method !== "GET" : request.method !== "POST")
    return fail(405, "method_not_allowed", "Invalid Git method.");
  if (
    match[3] === "info/refs" &&
    !["git-upload-pack", "git-receive-pack"].includes(url.searchParams.get("service") ?? "")
  )
    return fail(400, "bad_request", "Invalid Git service.");
  const rawGrant = request.headers.get("X-GitEdge-Git-Grant");
  const grant = rawGrant ? GitGrantSchema.safeParse(JSON.parse(rawGrant)) : null;
  if (
    write &&
    (!access.repository.canWrite ||
      !grant?.success ||
      grant.data.repositoryId !== repository.id ||
      grant.data.permission !== "write" ||
      access.user?.agentSession?.permission === "read")
  )
    return new Response("Git push requires a repository write credential.\n", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="GitEdge"', "Cache-Control": "no-store" },
    });
  let upstreamBody = request.body;
  if (match[3] === "git-receive-pack") {
    if (
      request.headers.has("Content-Encoding") &&
      request.headers.get("Content-Encoding") !== "identity"
    )
      return fail(
        415,
        "unsupported_encoding",
        "Compressed receive-pack envelopes are unsupported."
      );
    try {
      const parsed = await readReceiveCommands(request.body);
      if (!access.user?.agentSession) {
        const rules = await branchRules(env.DB, repository.id);
        const denied = parsed.updates.some(
          (update) =>
            update.ref.startsWith("refs/heads/") &&
            matchingBranchRules(rules, update.ref.slice(11)).length > 0
        );
        if (denied) {
          await parsed.cancel();
          return fail(
            403,
            "protected_branch",
            "Protected branches must be updated through an approved pull request."
          );
        }
      }
      upstreamBody = parsed.body;
    } catch (cause) {
      if (cause instanceof InvalidReceiveCommands) return fail(400, "bad_request", cause.message);
      throw cause;
    }
  }
  const artifactName = access.user?.agentSession?.workspaceName ?? access.repository.artifactName;
  if (!artifactName)
    return fail(409, "repository_storage_unavailable", "Repository must be imported to Artifacts.");
  using repo = await env.ARTIFACTS.get(artifactName);
  const info = await repo.info();
  const token = await repo.createToken(write ? "write" : "read", 60);
  const target = new URL(`${info.remote}/${match[3]}`);
  target.search = url.search;
  const headers = new Headers();
  for (const name of ["Content-Type", "Accept", "Git-Protocol", "Content-Encoding"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Authorization", `Bearer ${token.plaintext}`);
  const logger = createLogger(env.LOG_LEVEL, { service: "git-proxy", repoId: repository.id });
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: upstreamBody,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status >= 300 && response.status < 400)
      return fail(502, "upstream_redirect", "Artifacts redirected the Git request.");
    logger.debug("artifacts:git-transport", {
      operation: match[3],
      status: response.status,
      sessionId: access.user?.agentSession?.id,
    });
    if (response.status === 401 || response.status === 403)
      return fail(502, "upstream_auth_failed", "Artifacts rejected the scoped credential.");
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } finally {
    try {
      await repo.revokeToken(token.id);
    } catch {
      logger.warn("artifacts:transport-token-revoke-failed", {});
    }
  }
}
