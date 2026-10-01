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
  const repository = await env.DB.prepare(
    "SELECT r.id FROM repositories r JOIN namespaces n ON n.id = r.namespace_id WHERE n.slug = ? AND r.slug = ?"
  )
    .bind(match[1], match[2])
    .first<{ id: string }>();
  if (!repository) return fail(404, "not_found", "Repository was not found.");
  const access = await resolveGitAccess(request, env, repository.id);
  if (!access) return fail(404, "not_found", "Repository was not found.");
  const write =
    match[3] === "git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";
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
      body: request.body,
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
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
