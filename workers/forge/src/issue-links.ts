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

const NOT_MERGED =
  "NOT EXISTS (SELECT 1 FROM forge_pull_requests WHERE id = ? AND state = 'merged')";

/**
 * Replaces the issue links derived from a pull request title and body. One statement covers all
 * references, and both are skipped once the pull request is merged so merge links stay intact.
 */
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
    env.DB.prepare(
      `DELETE FROM forge_pull_request_links WHERE pull_request_id = ? AND ${NOT_MERGED}`
    ).bind(pullRequestId, pullRequestId),
    ...(references.length
      ? [
          env.DB.prepare(
            `INSERT INTO forge_pull_request_links (pull_request_id, issue_id, closes, created_at) SELECT ?, issue.id, json_extract(reference.value, '$.closes'), ? FROM json_each(?) AS reference JOIN forge_issues AS issue ON issue.repository_id = ? AND issue.number = json_extract(reference.value, '$.number') WHERE ${NOT_MERGED} ON CONFLICT(pull_request_id, issue_id) DO UPDATE SET closes = MAX(closes, excluded.closes)`
          ).bind(
            pullRequestId,
            now,
            JSON.stringify(
              references.map((reference) => ({
                number: reference.number,
                closes: reference.closes ? 1 : 0,
              }))
            ),
            repository.id,
            pullRequestId
          ),
        ]
      : []),
  ];
}

/**
 * Statements that close the issues a merged pull request references and record the timeline
 * events. Only merges into the default branch close issues. The statement count is constant,
 * and each is gated on the pull request being merged at the given commit, so it is safe to
 * batch after the merge update.
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
  if (!numbers.length) return [];
  const targets = JSON.stringify(numbers);
  const merged =
    "EXISTS (SELECT 1 FROM forge_pull_requests WHERE id = ? AND state = 'merged' AND merged_oid = ?)";
  const selected = "repository_id = ? AND number IN (SELECT value FROM json_each(?))";
  return [
    env.DB.prepare(
      `INSERT INTO forge_pull_request_links (pull_request_id, issue_id, closes, created_at) SELECT ?, id, 1, ? FROM forge_issues WHERE ${selected} AND ${merged} ON CONFLICT(pull_request_id, issue_id) DO UPDATE SET closes = 1`
    ).bind(pull.id, now, repository.id, targets, pull.id, pull.mergedOid),
    env.DB.prepare(
      `INSERT INTO forge_issue_events (id, repository_id, issue_id, kind, pull_request_id, actor_json, created_at) SELECT lower(hex(randomblob(16))), repository_id, id, 'closed_by_pull_request', ?, ?, ? FROM forge_issues WHERE ${selected} AND state = 'open' AND ${merged}`
    ).bind(pull.id, JSON.stringify(actor), now, repository.id, targets, pull.id, pull.mergedOid),
    env.DB.prepare(
      `UPDATE forge_issues SET state = 'closed', updated_at = ? WHERE ${selected} AND state = 'open' AND ${merged}`
    ).bind(now, repository.id, targets, pull.id, pull.mergedOid),
  ];
}

export async function issueReferences(env: ForgeEnv, issueId: string): Promise<Response> {
  const [pullRows, eventRows] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      "SELECT p.number, p.title, p.state, l.closes FROM forge_pull_request_links l JOIN forge_pull_requests p ON p.id = l.pull_request_id WHERE l.issue_id = ? ORDER BY p.number DESC LIMIT ?"
    ).bind(issueId, MAX_LINK_ROWS + 1),
    env.DB.prepare(
      "SELECT e.id, e.kind, e.actor_json, e.created_at, p.number AS pull_number FROM forge_issue_events e JOIN forge_pull_requests p ON p.id = e.pull_request_id WHERE e.issue_id = ? ORDER BY e.created_at ASC LIMIT ?"
    ).bind(issueId, MAX_LINK_ROWS + 1),
  ]);
  const result: IssueReferences = {
    pullRequests: pullRows.results.slice(0, MAX_LINK_ROWS).map((row) => ({
      number: Number(row.number),
      title: String(row.title),
      state: row.state === "merged" ? "merged" : row.state === "closed" ? "closed" : "open",
      closes: row.closes === 1,
    })),
    events: eventRows.results.slice(0, MAX_LINK_ROWS).map((row) => ({
      id: String(row.id),
      kind: "closed_by_pull_request",
      pullRequestNumber: Number(row.pull_number),
      actor: parseActor(row.actor_json, null),
      createdAt: Number(row.created_at),
    })),
    truncated: pullRows.results.length > MAX_LINK_ROWS || eventRows.results.length > MAX_LINK_ROWS,
  };
  return dataResponse(result);
}
