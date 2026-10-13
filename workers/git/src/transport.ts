import { acquireRefWrites, holdRefWrites } from "../../../src/worker/common/ref-writes";
import { repositoryNotFound } from "../../../src/worker/common/repository-response";
import { recordGitWrite, reportPushEvent } from "./events";
import { ReceiveReport, type RefUpdate } from "./receive-commands";
import { resolveRepositoryPath } from "../../../src/worker/common/repositories";
import {
  branchRules,
  matchingBranchRules,
  reservedRef,
  tagChangeForbidden,
} from "../../../src/worker/common/branch-protection";
import { readReceiveCommands, InvalidReceiveCommands, rejectionReport } from "./receive-commands";
import { z } from "zod";
import { accessTokenAllows } from "../../../packages/contracts/src/access-tokens";
import { resolveGitAccess, type GitEnv } from "./access";
import { errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";

const GitGrantSchema = z.object({
  repositoryId: z.string(),
  permission: z.enum(["read", "write"]),
});
export async function proxyGitTransport(
  request: Request,
  env: GitEnv,
  ctx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
    url.pathname
  );
  if (!match) return errorResponse(404, "not_found", "Git endpoint was not found.");
  const repository = await resolveRepositoryPath(env.DB, match[1], match[2]);
  if (!repository) return repositoryNotFound();
  const access = await resolveGitAccess(request, env, repository.id);
  if (access instanceof Response) return access;
  if (!access) return repositoryNotFound();
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
    return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
  if (match[3] === "info/refs" ? request.method !== "GET" : request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Invalid Git method.");
  if (
    match[3] === "info/refs" &&
    !["git-upload-pack", "git-receive-pack"].includes(url.searchParams.get("service") ?? "")
  )
    return errorResponse(400, "bad_request", "Invalid Git service.");
  const rawGrant = request.headers.get("X-GitEdge-Git-Grant");
  const grant = rawGrant ? GitGrantSchema.safeParse(JSON.parse(rawGrant)) : null;
  if (
    write &&
    (!access.repository.canWrite ||
      !grant?.success ||
      grant.data.repositoryId !== repository.id ||
      grant.data.permission !== "write" ||
      access.user?.agentSession?.permission === "read" ||
      (access.user?.token && !accessTokenAllows(access.user.token, "repo:write")))
  )
    // Authenticated callers get 403 so Git keeps their read credential in its helper.
    return access.user
      ? new Response("Git push requires a repository write credential.\n", {
          status: 403,
          headers: { "Cache-Control": "no-store" },
        })
      : new Response("Git push requires a repository write credential.\n", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="GitEdge"', "Cache-Control": "no-store" },
        });
  let upstreamBody = request.body;
  let updates: RefUpdate[] = [];
  if (match[3] === "git-receive-pack") {
    if (
      request.headers.has("Content-Encoding") &&
      request.headers.get("Content-Encoding") !== "identity"
    )
      return errorResponse(
        415,
        "unsupported_encoding",
        "Compressed receive-pack envelopes are unsupported."
      );
    try {
      const parsed = await readReceiveCommands(request.body);
      const defaultRef = `refs/heads/${access.repository.defaultBranch}`;
      const rules = await branchRules(env.DB, repository.id);
      const reasons = new Map<string, string>();
      for (const update of parsed.updates) {
        const created = /^0{40}$/.test(update.oldOid);
        const removal = /^0{40}$/.test(update.newOid);
        const tag = update.ref.startsWith("refs/tags/") ? update.ref.slice(10) : null;
        if (reservedRef(update.ref)) reasons.set(update.ref, "reserved namespace");
        else if (tag && removal && tagChangeForbidden(rules, tag, "delete"))
          reasons.set(update.ref, "protected tag cannot be deleted");
        else if (
          tag &&
          update.oldOid !== update.newOid &&
          !created &&
          !removal &&
          tagChangeForbidden(rules, tag, "update")
        )
          reasons.set(update.ref, "protected tag cannot be moved");
      }
      if (reasons.size) {
        await parsed.cancel();
        createLogger(env.LOG_LEVEL, { service: "git-proxy", repoId: repository.id }).warn(
          "git:ref-update-denied",
          { count: reasons.size, refs: [...reasons.keys()].slice(0, 10) }
        );
        const report = rejectionReport(parsed.updates, parsed.capabilities, reasons);
        return report
          ? new Response(report, {
              headers: {
                "Content-Type": "application/x-git-receive-pack-result",
                "Cache-Control": "no-store",
              },
            })
          : errorResponse(403, "protected_ref", [...reasons.values()][0]);
      }
      if (
        parsed.updates.some((update) => update.ref === defaultRef && /^0{40}$/.test(update.newOid))
      ) {
        await parsed.cancel();
        return errorResponse(409, "default_branch", "The default branch cannot be deleted.");
      }
      if (!access.user?.agentSession) {
        const denied = parsed.updates.some(
          (update) =>
            update.ref.startsWith("refs/heads/") &&
            matchingBranchRules(rules, update.ref.slice(11)).length > 0
        );
        if (denied) {
          await parsed.cancel();
          return errorResponse(
            403,
            "protected_branch",
            "Protected branches must be updated through an approved pull request."
          );
        }
      }
      updates = parsed.updates;
      upstreamBody = parsed.body;
    } catch (cause) {
      if (cause instanceof InvalidReceiveCommands)
        return errorResponse(400, "bad_request", cause.message);
      throw cause;
    }
  }
  const artifactName = access.user?.agentSession?.workspaceName ?? access.repository.artifactName;
  if (!artifactName)
    return errorResponse(
      409,
      "repository_storage_unavailable",
      "Repository must be imported to Artifacts."
    );
  const writeLease = updates.length
    ? await acquireRefWrites(
        env.DB,
        artifactName,
        updates.map((update) => update.ref)
      )
    : null;
  let streamOwnsLease = false;
  try {
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
        return errorResponse(502, "upstream_redirect", "Artifacts redirected the Git request.");
      logger.debug("artifacts:git-transport", {
        operation: match[3],
        status: response.status,
        sessionId: access.user?.agentSession?.id,
      });
      if (response.status === 401 || response.status === 403)
        return errorResponse(
          502,
          "upstream_auth_failed",
          "Artifacts rejected the scoped credential."
        );
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("Cache-Control", "no-store");
      const writer = access.user;
      const report = new ReceiveReport();
      const body =
        response.ok && writer && updates.length && response.body
          ? response.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  report.feed(chunk);
                  controller.enqueue(chunk);
                },
                async flush() {
                  const accepted = report.accepted();
                  if (!accepted)
                    logger.warn("git:receive-report-unparsed", { count: updates.length });
                  const applied = accepted
                    ? updates.filter((update) => accepted.has(update.ref))
                    : [];
                  const changed = applied.filter(
                    (update) =>
                      update.ref.startsWith("refs/heads/") && update.newOid !== "0".repeat(40)
                  );
                  const notify = async () => {
                    await reportPushEvent(
                      env,
                      repository.id,
                      writer,
                      applied.map((update) => ({
                        ref: update.ref,
                        before: update.oldOid,
                        after: update.newOid,
                      }))
                    );
                    if (!writer.agentSession)
                      for (const update of changed.slice(0, 3))
                        await recordGitWrite(
                          env,
                          repository.id,
                          artifactName,
                          writer,
                          update.ref.slice(11),
                          update.newOid
                        );
                    if (!writer.agentSession && changed.length > 3)
                      logger.warn("actions:push-branches-truncated", { count: changed.length });
                  };
                  if (ctx) ctx.waitUntil(notify());
                  else await notify();
                },
              })
            )
          : response.body;
      const guardedBody = body && writeLease ? holdRefWrites(body, writeLease) : body;
      streamOwnsLease = Boolean(writeLease && guardedBody);
      return new Response(guardedBody, { status: response.status, headers: responseHeaders });
    } finally {
      try {
        await repo.revokeToken(token.id);
      } catch {
        logger.warn("artifacts:transport-token-revoke-failed", {});
      }
    }
  } finally {
    if (writeLease && !streamOwnsLease) await writeLease.release();
  }
}
