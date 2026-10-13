import { z } from "zod";
import { GitOidSchema } from "../../../packages/contracts/src/forge";
import type { GitHubSyncTransferResult } from "../../../packages/contracts/src/github-sync";
import { readJsonLimited } from "../../../src/worker/common/readText";
import type { ForgeEnv } from "./common";
import { GithubSyncConflict, type GithubConnectionRow, type GithubCredentials, type GithubJobRow } from "./github-sync-store";

const RefSchema = z.object({ ref: z.string(), oid: GitOidSchema });
const RefListSchema = z.object({ data: z.object({ local: z.array(RefSchema).max(1000), remote: z.array(RefSchema).max(1000) }) });
const ResultSchema = z.object({ data: z.object({ status: z.enum(["synced", "unchanged", "stale"]), ref: z.string(), before: GitOidSchema, after: GitOidSchema }) });
const FailureSchema = z.object({ error: z.object({ code: z.string() }) });
async function gitRequest(env: ForgeEnv, path: string, body: unknown): Promise<unknown> {
  const response = await env.GIT.fetch(new Request(`https://git.internal/internal/github-sync${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  const payload = await readJsonLimited(response, 262_144);
  if (!response.ok) {
    const failure = FailureSchema.safeParse(payload);
    const code = failure.success ? failure.data.error.code : "github_git_unavailable";
    if ([403, 409, 413].includes(response.status)) throw new GithubSyncConflict(code);
    throw new Error(code);
  }
  return payload;
}
export async function syncGithubRef(
  env: ForgeEnv, connection: GithubConnectionRow, credentials: GithubCredentials, job: GithubJobRow,
  input: { ref: string; targetRef: string; before: string | null; after: string; pullRequestId?: string }
): Promise<GitHubSyncTransferResult> {
  if (!job.lease) throw new Error("github_job_unclaimed");
  return ResultSchema.parse(await gitRequest(env, "", {
    connectionId: connection.id, jobId: job.id, lease: job.lease, token: credentials.token,
    direction: job.direction, ...input,
  })).data;
}
export async function githubSyncRefs(env: ForgeEnv, connection: GithubConnectionRow, credentials: GithubCredentials, job: GithubJobRow) {
  return RefListSchema.parse(await gitRequest(env, "/refs", {
    connectionId: connection.id, jobId: job.id, lease: job.lease, token: credentials.token,
  })).data;
}
