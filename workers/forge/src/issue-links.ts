import { z } from "zod";
import {
  closingIssueNumbers,
  parseIssueReferences,
  type Actor,
  type IssueReferences,
} from "../../../packages/contracts/src/index";
import { dataResponse } from "../../../src/worker/common/http";
import { parseActor, type ForgeEnv, type RepositoryRow } from "./common";

const MAX_COMMIT_MESSAGES = 250;
const MAX_LINK_ROWS = 100;

const ComparisonCommitsSchema = z.object({
  data: z.object({ commits: z.array(z.object({ message: z.string() })) }),
});

/** Commit messages of a Git comparison payload; empty when the payload is not a comparison. */
export function comparisonMessages(payload: unknown): string[] {
  const parsed = ComparisonCommitsSchema.safeParse(payload);
  return parsed.success
    ? parsed.data.data.commits.slice(0, MAX_COMMIT_MESSAGES).map((commit) => commit.message)
    : [];
}

function repositoryIdentity(repository: RepositoryRow) {
  return { owner: repository.owner, slug: repository.slug };
}

function upsertLink(
  env: ForgeEnv,
  repository: RepositoryRow,
  pullRequestId: string,
  number: number,
  closes: boolean,
  now: number
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO forge_pull_request_links (pull_request_id, issue_id, closes, created_at) SELECT ?, id, ?, ? FROM forge_issues WHERE repository_id = ? AND number = ? ON CONFLICT(pull_request_id, issue_id) DO UPDATE SET closes = MAX(closes, excluded.closes)"
  ).bind(pullRequestId, closes ? 1 : 0, now, repository.id, number);
}

/** Replaces the issue links derived from a pull request title and body. */
export function syncLinkStatements(
  env: ForgeEnv,
  repository: RepositoryRow,
  pullRequestId: string,
  title: string,
  body: string,
  now: number
): D1PreparedStatement[] {
  const references = parseIssueReferences(`${title}\n${body}`, repositoryIdentity(repository));
  return [
    env.DB.prepare("DELETE FROM forge_pull_request_links WHERE pull_request_id = ?").bind(
      pullRequestId
    ),
    ...references.map((reference) =>
      upsertLink(env, repository, pullRequestId, reference.number, reference.closes, now)
    ),
  ];
}

/**
 * Statements that close the issues a merged pull request references and record the timeline
 * events. Only merges into the default branch close issues. Each statement is gated on the
 * pull request being merged at the given commit, so it is safe to batch after the merge update.
 */
export function mergeClosingStatements(
  env: ForgeEnv,
  repository: RepositoryRow,
  pull: { id: string; baseRef: string; title: string; body: string; mergedOid: string },
  commitMessages: readonly string[],
  actor: Actor,
  now: number
): D1PreparedStatement[] {
  if (pull.baseRef !== (repository.default_branch ?? "main")) return [];
  const numbers = closingIssueNumbers(
    [pull.title, pull.body, ...commitMessages],
    repositoryIdentity(repository)
  );
  const merged =
    "EXISTS (SELECT 1 FROM forge_pull_requests WHERE id = ? AND state = 'merged' AND merged_oid = ?)";
  return numbers.flatMap((number) => [
    upsertLink(env, repository, pull.id, number, true, now),
    env.DB.prepare(
      `INSERT INTO forge_issue_events (id, repository_id, issue_id, kind, pull_request_id, actor_json, created_at) SELECT ?, repository_id, id, 'closed_by_pull_request', ?, ?, ? FROM forge_issues WHERE repository_id = ? AND number = ? AND state = 'open' AND ${merged}`
    ).bind(
      crypto.randomUUID(),
      pull.id,
      JSON.stringify(actor),
      now,
      repository.id,
      number,
      pull.id,
      pull.mergedOid
    ),
    env.DB.prepare(
      `UPDATE forge_issues SET state = 'closed', updated_at = ? WHERE repository_id = ? AND number = ? AND state = 'open' AND ${merged}`
    ).bind(now, repository.id, number, pull.id, pull.mergedOid),
  ]);
}

export async function issueReferences(env: ForgeEnv, issueId: string): Promise<Response> {
  const [pullRows, eventRows] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      "SELECT p.number, p.title, p.state, l.closes FROM forge_pull_request_links l JOIN forge_pull_requests p ON p.id = l.pull_request_id WHERE l.issue_id = ? ORDER BY p.number DESC LIMIT ?"
    ).bind(issueId, MAX_LINK_ROWS),
    env.DB.prepare(
      "SELECT e.id, e.kind, e.actor_json, e.created_at, p.number AS pull_number FROM forge_issue_events e JOIN forge_pull_requests p ON p.id = e.pull_request_id WHERE e.issue_id = ? ORDER BY e.created_at ASC LIMIT ?"
    ).bind(issueId, MAX_LINK_ROWS),
  ]);
  const result: IssueReferences = {
    pullRequests: pullRows.results.map((row) => ({
      number: Number(row.number),
      title: String(row.title),
      state: row.state === "merged" ? "merged" : row.state === "closed" ? "closed" : "open",
      closes: row.closes === 1,
    })),
    events: eventRows.results.map((row) => ({
      id: String(row.id),
      kind: "closed_by_pull_request",
      pullRequestNumber: Number(row.pull_number),
      actor: parseActor(row.actor_json, null),
      createdAt: Number(row.created_at),
    })),
  };
  return dataResponse(result);
}
