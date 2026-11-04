import { z } from "zod";
import { readTextLimited } from "../../../src/worker/common/readText";

export const GithubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
});
export const GithubRepositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
  archived: z.boolean(),
});
export type GithubRepository = z.infer<typeof GithubRepositorySchema>;

export class GithubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfter: number = 0
  ) {
    super(`github_http_${status}`);
  }
}

export async function githubRequest(
  token: string,
  path: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  const url = new URL(path, "https://api.github.com");
  if (
    (!path.startsWith("/repos/") && !(path === "/graphql" && method === "POST")) ||
    url.pathname !== path.split("?")[0] ||
    path.includes("\\")
  )
    throw new Error("invalid_github_path");
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "GitEdge-Sync",
      "X-GitHub-Api-Version": "2026-03-10",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const reset =
      response.headers.get("X-RateLimit-Remaining") === "0"
        ? Number(response.headers.get("X-RateLimit-Reset")) - Math.floor(Date.now() / 1000)
        : 0;
    const retry = Math.max(
      0,
      Number(response.headers.get("Retry-After") ?? 0),
      Number.isFinite(reset) ? reset : 0
    );
    await response.body?.cancel();
    throw new GithubApiError(response.status, Number.isFinite(retry) ? Math.min(retry, 3600) : 0);
  }
  if (response.status === 204) {
    await response.body?.cancel();
    return null;
  }
  const text = await readTextLimited(response.body, 1_048_576);
  if (text === null) throw new Error("github_response_limit");
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("github_invalid_response");
  }
}

export async function githubJobLog(
  token: string,
  owner: string,
  repository: string,
  jobId: number
): Promise<string | null> {
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Error("invalid_github_job");
  const response = await fetch(
    `https://api.github.com${githubRepoPath(owner, repository)}/actions/jobs/${jobId}/logs`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "GitEdge-Sync",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    }
  );
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 302) {
    await response.body?.cancel();
    throw new GithubApiError(response.status);
  }
  const location = response.headers.get("Location");
  await response.body?.cancel();
  if (!location || location.length > 8192) throw new Error("github_log_location_invalid");
  const url = new URL(location);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    ![".blob.core.windows.net", ".actions.githubusercontent.com"].some((suffix) =>
      url.hostname.endsWith(suffix)
    )
  )
    throw new Error("github_log_location_invalid");
  const log = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
  if (!log.ok) {
    await log.body?.cancel();
    throw new GithubApiError(log.status);
  }
  return readTextLimited(log.body, 1_048_576);
}

export function githubRepoPath(owner: string, repository: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}
