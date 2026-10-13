import { z } from "zod";
import { ActorSchema, GitOidSchema } from "../../../packages/contracts/src/forge";
import { reviewActorKey } from "../../../packages/contracts/src/review-comments";
import { GithubApiError, githubRepoPath, githubRequest } from "./github-client";
import {
  applyGithubInbound,
  githubMapping,
  githubMappingStatement,
  GithubSyncConflict,
  enqueueGithubJob,
  type GithubConnectionRow,
  type GithubCredentials,
  type GithubJobRow,
  type GithubMappingRow,
  type GithubResourceKind,
} from "./github-sync-store";
import { nextNumber, parseActor, type ForgeEnv } from "./common";
import { githubSyncRefs, localRefContains, syncGithubRef } from "./github-sync-git";
import type { StatementCondition } from "./notifications";

const GithubActor = z.object({ id: z.number().int().positive(), login: z.string().min(1) });
const GithubLabel = z
  .object({ name: z.string().min(1), color: z.string().regex(/^[0-9a-f]{6}$/i) })
  .passthrough();
const GithubIssue = z
  .object({
    id: z.number().int().positive(),
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(["open", "closed"]),
    updated_at: z.string().datetime({ offset: true }),
    user: GithubActor,
    pull_request: z.unknown().optional(),
    labels: z.array(z.object({ name: z.string() }).passthrough()).default([]),
  })
  .passthrough();
const GithubPull = GithubIssue.extend({
  node_id: z.string().optional(),
  body: z.string().nullable(),
  draft: z.boolean(),
  merged: z.boolean().default(false),
  mergeOid: GitOidSchema.nullable().default(null),
  base: z.object({ ref: z.string(), sha: GitOidSchema }).passthrough(),
  head: z
    .object({
      ref: z.string(),
      sha: GitOidSchema,
      repo: z.object({ full_name: z.string() }).nullable(),
    })
    .passthrough(),
}).passthrough();
const GithubComment = z
  .object({
    id: z.number().int().positive(),
    body: z.string(),
    updated_at: z.string().datetime({ offset: true }),
    user: GithubActor,
    in_reply_to_id: z.number().int().positive().optional(),
  })
  .passthrough();
const GithubReview = z
  .object({
    id: z.number().int().positive(),
    body: z.string().nullable(),
    state: z.preprocess(
      (value) => (typeof value === "string" ? value.toUpperCase() : value),
      z.enum(["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"])
    ),
    commit_id: GitOidSchema,
    submitted_at: z.string().datetime({ offset: true }).nullable(),
    user: GithubActor,
  })
  .passthrough();
const GithubCommit = z
  .object({
    sha: GitOidSchema,
    parents: z.array(z.object({ sha: GitOidSchema }).passthrough()).min(1),
  })
  .passthrough();
const GithubReviewComment = GithubComment.extend({
  commit_id: GitOidSchema,
  original_commit_id: GitOidSchema,
  path: z.string(),
  side: z.enum(["LEFT", "RIGHT"]),
  line: z.number().int().positive().nullable(),
  original_line: z.number().int().positive().nullable(),
  start_line: z.number().int().positive().nullable().optional(),
  original_start_line: z.number().int().positive().nullable().optional(),
  diff_hunk: z.string(),
  pull_request_review_id: z.number().int().positive().nullable(),
  in_reply_to_id: z.number().int().positive().optional(),
}).passthrough();
const Webhook = z
  .object({
    action: z.string().optional(),
    issue: GithubIssue.optional(),
    pull_request: GithubPull.optional(),
    comment: GithubComment.optional(),
    review: GithubReview.optional(),
    changes: z.unknown().optional(),
  })
  .passthrough();
const Outbound = z.object({
  kind: z.enum(["issue", "pull_request", "comment", "review", "review_comment"]),
  action: z.enum(["upsert", "delete"]),
  id: z.string().min(1),
});
const Snapshot = z.object({
  kind: z.enum(["issue", "pull_request"]),
  number: z.number().int().positive(),
});

type RepoRow = { id: string; default_branch: string };
const IssueRowSchema = z.object({
  id: z.string(),
  number: z.number(),
  author_id: z.string(),
  actor_json: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.enum(["open", "closed"]),
  labels_json: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
const PullRowSchema = IssueRowSchema.omit({ labels_json: true }).extend({
  base_ref: z.string(),
  head_ref: z.string(),
  head_repository_id: z.string().nullable(),
  head_session_id: z.string().nullable(),
  draft: z.number(),
  state: z.enum(["open", "closed", "merged"]),
  merged_oid: z.string().nullable(),
  locked_at: z.number().nullable(),
  locked_head_oid: z.string().nullable(),
});
const CommentRowSchema = z.object({
  id: z.string(),
  target_kind: z.string(),
  target_id: z.string(),
  author_id: z.string(),
  actor_json: z.string(),
  body: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
const ReviewRowSchema = z.object({
  id: z.string(),
  pull_request_id: z.string(),
  author_id: z.string(),
  actor_json: z.string(),
  state: z.enum(["commented", "approved", "changes_requested"]),
  body: z.string(),
  commit_oid: z.string(),
  created_at: z.number(),
});
const ReviewCommentRowSchema = z.object({
  id: z.string(),
  pull_request_id: z.string(),
  review_id: z.string().nullable(),
  in_reply_to: z.string().nullable(),
  author_id: z.string(),
  actor_json: z.string(),
  commit_oid: z.string(),
  path: z.string(),
  side: z.enum(["LEFT", "RIGHT"]),
  line: z.number(),
  start_line: z.number().nullable(),
  diff_hunk: z.string(),
  body: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}
function normalizeLabels(labels: string[]): string[] {
  const unique = new Map(labels.map((label) => [label.toLowerCase(), label]));
  return [...unique.values()].sort((left, right) =>
    left.toLowerCase().localeCompare(right.toLowerCase())
  );
}
function pullRemoteValue(pull: z.infer<typeof GithubPull>): unknown[] {
  const value: unknown[] = [
    pull.title,
    pull.body ?? "",
    pull.merged ? "merged" : pull.state,
    pull.draft,
    pull.base.ref,
    pull.head.ref,
  ];
  if (pull.merged) value.push(pull.mergeOid ?? null);
  return value;
}
function reviewCommentRemoteValue(comment: z.infer<typeof GithubReviewComment>): unknown[] {
  return [
    comment.body,
    comment.original_commit_id,
    comment.path,
    comment.side,
    comment.original_line ?? comment.line,
    comment.in_reply_to_id,
  ];
}
function millis(value: string | null): number {
  return value ? Date.parse(value) : 0;
}
function externalActor(user: z.infer<typeof GithubActor>) {
  return ActorSchema.parse({
    kind: "external",
    id: `github:${user.id}`,
    name: `${user.login} (GitHub)`,
  });
}
function attribution(actorJson: string, fallback: string): string {
  const actor = parseActor(actorJson, fallback);
  return `\n\n---\nGitEdge origin: ${actor.name} (${actor.kind})`;
}
function originMarker(
  connection: GithubConnectionRow,
  kind: GithubResourceKind,
  localId: string
): string {
  return `<!-- gitedge-origin:${connection.id}:${kind}:${localId} -->`;
}
function mergedStateMarker(
  connection: GithubConnectionRow,
  pullRequestId: string,
  mergeOid: string
): string {
  return `<!-- gitedge-merged:${connection.id}:${pullRequestId}:${mergeOid} -->`;
}
function mergedStateNote(mergeOid: string): string {
  return `Merged on GitEdge at ${mergeOid}.`;
}
function stripMergedStateNote(
  body: string,
  connection: GithubConnectionRow,
  pullRequestId: string
): string {
  const markerPrefix = `<!-- gitedge-merged:${connection.id}:${pullRequestId}:`;
  const markerIndex = body.lastIndexOf(markerPrefix);
  if (markerIndex < 0) return body;
  const oid = GitOidSchema.safeParse(
    body.slice(markerIndex + markerPrefix.length, markerIndex + markerPrefix.length + 40)
  );
  if (!oid.success) return body;
  const suffix = `${mergedStateNote(oid.data)}\n${mergedStateMarker(connection, pullRequestId, oid.data)}`;
  if (body === suffix) return "";
  if (body.endsWith(`\n\n${suffix}`)) return body.slice(0, -suffix.length - 2);
  return body;
}
function outboundBody(
  connection: GithubConnectionRow,
  kind: GithubResourceKind,
  localId: string,
  body: string,
  actorJson: string,
  authorId: string
): string {
  return `${body}${attribution(actorJson, authorId)}\n${originMarker(connection, kind, localId)}`;
}
function stripOrigin(body: string): string {
  return body.replace(/\n\n---\nGitEdge origin: [^\n]*\n<!-- gitedge-origin:[^>]+ -->$/, "");
}
function githubPath(connection: GithubConnectionRow): string {
  return githubRepoPath(connection.owner, connection.name);
}
function conflict(code: string): never {
  throw new GithubSyncConflict(code);
}

function localRowGuard(
  connection: GithubConnectionRow,
  kind: GithubResourceKind,
  localId: string,
  expectedFingerprint: string | null,
  extraSql = "",
  extraBinds: readonly unknown[] = []
): StatementCondition {
  const [table, fields] =
    kind === "issue"
      ? ["forge_issues", "title,body,state,labels_json"]
      : kind === "pull_request"
        ? ["forge_pull_requests", "title,body,state,draft,base_ref,head_ref"]
        : kind === "comment"
          ? ["forge_comments", "body"]
          : kind === "review"
            ? ["forge_reviews", "state,body,commit_oid"]
            : ["forge_review_comments", "body,commit_oid,path,side,line"];
  if (expectedFingerprint === null)
    return {
      sql: `NOT EXISTS (SELECT 1 FROM ${table} WHERE repository_id=? AND id=?)`,
      binds: [connection.repository_id, localId],
    };
  return {
    sql: `EXISTS (SELECT 1 FROM ${table} WHERE repository_id=? AND id=? AND json_array(${fields})=? ${extraSql})`,
    binds: [connection.repository_id, localId, expectedFingerprint, ...extraBinds],
  };
}

function assertRemoteUnchanged(mapping: GithubMappingRow, remoteValue: unknown): void {
  if (mapping.remote_fingerprint !== fingerprint(remoteValue)) conflict("concurrent_remote_edit");
}

async function findMarked<T>(
  token: string,
  path: string,
  parseRows: (value: unknown) => T[],
  matches: (row: T) => boolean
): Promise<T | null> {
  for (let page = 1; page <= 10; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const rows = parseRows(
      await githubRequest(token, `${path}${separator}per_page=100&page=${page}`)
    );
    const match = rows.find(matches);
    if (match) return match;
    if (rows.length < 100) return null;
  }
  conflict("github_origin_scan_limit");
}

async function ensureGithubLabels(
  token: string,
  repositoryPath: string,
  requested: string[]
): Promise<string[]> {
  const labels = normalizeLabels(requested);
  if (labels.length > 20) conflict("github_label_limit");
  const known = new Map<string, string>();
  for (let page = 1; page <= 10; page++) {
    const rows = z
      .array(GithubLabel)
      .parse(await githubRequest(token, `${repositoryPath}/labels?per_page=100&page=${page}`));
    for (const label of rows) known.set(label.name.toLowerCase(), label.name);
    if (labels.every((label) => known.has(label.toLowerCase()))) break;
    if (rows.length < 100) break;
    if (page === 10) conflict("github_label_inventory_limit");
  }
  for (const name of labels) {
    if (known.has(name.toLowerCase())) continue;
    try {
      const created = GithubLabel.parse(
        await githubRequest(token, `${repositoryPath}/labels`, "POST", {
          name,
          color: "ededed",
        })
      );
      known.set(created.name.toLowerCase(), created.name);
    } catch (error) {
      if (!(error instanceof GithubApiError) || error.status !== 422) throw error;
      const existing = GithubLabel.parse(
        await githubRequest(token, `${repositoryPath}/labels/${encodeURIComponent(name)}`)
      );
      known.set(existing.name.toLowerCase(), existing.name);
    }
  }
  return normalizeLabels(labels.map((label) => known.get(label.toLowerCase()) ?? label));
}

async function localFingerprint(
  env: ForgeEnv,
  repositoryId: string,
  kind: GithubResourceKind,
  localId: string
): Promise<string | null> {
  const table =
    kind === "issue"
      ? "forge_issues"
      : kind === "pull_request"
        ? "forge_pull_requests"
        : kind === "comment"
          ? "forge_comments"
          : kind === "review"
            ? "forge_reviews"
            : "forge_review_comments";
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? AND repository_id = ?`)
    .bind(localId, repositoryId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const selected =
    kind === "issue"
      ? [row.title, row.body, row.state, row.labels_json]
      : kind === "pull_request"
        ? [row.title, row.body, row.state, row.draft, row.base_ref, row.head_ref]
        : kind === "comment"
          ? [row.body]
          : kind === "review"
            ? [row.state, row.body, row.commit_oid]
            : [row.body, row.commit_oid, row.path, row.side, row.line];
  return fingerprint(selected);
}

async function saveMapping(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  kind: GithubResourceKind,
  localId: string,
  remoteId: string,
  remoteNumber: number | null,
  remoteValue: unknown,
  remoteUpdatedAt: number,
  localSnapshot: string
): Promise<void> {
  await githubMappingStatement(env.DB, {
    connection_id: connection.id,
    kind,
    local_id: localId,
    remote_id: remoteId,
    remote_number: remoteNumber,
    remote_fingerprint: fingerprint(remoteValue),
    local_fingerprint: localSnapshot,
    remote_updated_at: remoteUpdatedAt,
  }).run();
}

async function inboundExpectedFingerprint(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  mapping: GithubMappingRow,
  desiredFingerprint: string
): Promise<string> {
  const current = await localFingerprint(
    env,
    connection.repository_id,
    mapping.kind,
    mapping.local_id
  );
  if (current === null) conflict("github_local_resource_missing");
  if (current !== mapping.local_fingerprint && current !== desiredFingerprint)
    conflict("concurrent_local_edit");
  return current;
}

async function remoteObject(token: string, path: string): Promise<unknown> {
  return githubRequest(token, path);
}

async function hydrateGithubPull(token: string, raw: unknown) {
  const pull = GithubPull.parse(raw);
  pull.mergeOid = null;
  if (!pull.merged) return pull;
  if (!pull.node_id) throw new Error("github_merge_metadata_pending");
  const result = z
    .object({
      data: z
        .object({
          node: z
            .object({
              id: z.string(),
              merged: z.boolean(),
              mergeCommit: z.object({ oid: GitOidSchema }).nullable(),
            })
            .nullable(),
        })
        .nullable()
        .optional(),
      errors: z.array(z.unknown()).optional(),
    })
    .parse(
      await githubRequest(token, "/graphql", "POST", {
        query: "query($id:ID!){node(id:$id){... on PullRequest{id merged mergeCommit{oid}}}}",
        variables: { id: pull.node_id },
      })
    );
  const node = result.data?.node;
  if (result.errors?.length || node?.id !== pull.node_id || !node?.merged || !node.mergeCommit)
    throw new Error("github_merge_metadata_pending");
  pull.mergeOid = node.mergeCommit.oid;
  return pull;
}

async function inboundIssue(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  token: string,
  raw: z.infer<typeof GithubIssue>
): Promise<void> {
  const current = GithubIssue.parse(
    await remoteObject(token, `${githubPath(connection)}/issues/${raw.number}`)
  );
  if (current.pull_request) return;
  const existing = await githubMapping(env.DB, connection.id, "issue", {
    remoteId: String(current.id),
  });
  const remoteLabels = normalizeLabels(current.labels.map((label) => label.name));
  const remoteValue = [current.title, current.body ?? "", current.state, remoteLabels];
  const remoteFp = fingerprint(remoteValue);
  if (existing && existing.remote_fingerprint === remoteFp) return;
  const now = millis(current.updated_at);
  const labels = JSON.stringify(remoteLabels);
  const body = existing ? stripOrigin(current.body ?? "") : (current.body ?? "");
  const desiredLocalFingerprint = fingerprint([current.title, body, current.state, labels]);
  const expectedLocalFingerprint = existing
    ? await inboundExpectedFingerprint(env, connection, existing, desiredLocalFingerprint)
    : null;
  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(
      env.DB.prepare(
        "UPDATE forge_issues SET title=?, body=?, state=?, labels_json=?, updated_at=? WHERE id=? AND repository_id=?"
      ).bind(
        current.title,
        body,
        current.state,
        labels,
        now,
        existing.local_id,
        connection.repository_id
      )
    );
  } else {
    const localId = crypto.randomUUID();
    const localNumber = await nextNumber(env, "forge_issues", connection.repository_id);
    statements.push(
      env.DB.prepare(
        "INSERT INTO forge_issues (id,repository_id,number,author_id,actor_json,title,body,state,labels_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        localId,
        connection.repository_id,
        localNumber,
        connection.created_by,
        JSON.stringify(externalActor(current.user)),
        current.title,
        current.body ?? "",
        current.state,
        labels,
        now,
        now
      )
    );
    statements.push(
      env.DB.prepare(
        "INSERT INTO forge_github_mappings (connection_id,kind,local_id,remote_id,remote_number,remote_fingerprint,local_fingerprint,remote_updated_at) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(
        connection.id,
        "issue",
        localId,
        String(current.id),
        current.number,
        remoteFp,
        desiredLocalFingerprint,
        now
      )
    );
  }
  if (existing)
    statements.push(
      env.DB.prepare(
        "UPDATE forge_github_mappings SET remote_fingerprint=?,local_fingerprint=?,remote_updated_at=? WHERE connection_id=? AND kind='issue' AND local_id=?"
      ).bind(remoteFp, desiredLocalFingerprint, now, connection.id, existing.local_id)
    );
  await applyGithubInbound(
    env.DB,
    connection.id,
    statements,
    existing
      ? localRowGuard(connection, "issue", existing.local_id, expectedLocalFingerprint)
      : undefined
  );
  await enqueueThreadBackfill(env, connection, "issue", current.number);
}

async function enqueueThreadBackfill(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  kind: "issue" | "pull_request",
  number: number,
  forceSuffix?: string
): Promise<void> {
  const categories = kind === "issue" ? ["comment"] : ["comment", "review", "review_comment"];
  const suffix = forceSuffix ? `:reconcile:${forceSuffix}` : "";
  for (const category of categories)
    await enqueueGithubJob(
      env.DB,
      connection.id,
      "inbound",
      "bootstrap",
      { phase: "thread", kind, number, category, page: 1 },
      `github-thread:${connection.id}:${kind}:${number}:${category}:1${suffix}`
    );
}

async function inboundPull(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  credentials: GithubCredentials,
  job: GithubJobRow,
  raw: z.infer<typeof GithubPull>
): Promise<"success" | "ignored"> {
  const current = await hydrateGithubPull(
    credentials.token,
    await remoteObject(credentials.token, `${githubPath(connection)}/pulls/${raw.number}`)
  );
  const repo = await env.DB.prepare("SELECT id,default_branch FROM repositories WHERE id=?")
    .bind(connection.repository_id)
    .first<RepoRow>();
  if (!repo) conflict("repository_missing");
  const existing = await githubMapping(env.DB, connection.id, "pull_request", {
    remoteId: String(current.id),
  });
  const remoteValue = pullRemoteValue(current);
  const remoteFp = fingerprint(remoteValue);
  const remoteDataChanged = !existing || existing.remote_fingerprint !== remoteFp;
  const localId = existing?.local_id ?? crypto.randomUUID();
  const now = millis(current.updated_at);
  const prior = existing
    ? await env.DB.prepare(
        "SELECT state,merged_oid,locked_at,locked_by,locked_head_oid,actor_json,author_id,head_ref,head_session_id,head_repository_id,merge_base_oid,merge_head_oid FROM forge_pull_requests WHERE id=?"
      )
        .bind(localId)
        .first<{
          state: string;
          merged_oid: string | null;
          locked_at: number | null;
          locked_by: string | null;
          locked_head_oid: string | null;
          actor_json: string;
          author_id: string;
          head_ref: string;
          head_session_id: string | null;
          head_repository_id: string | null;
          merge_base_oid: string | null;
          merge_head_oid: string | null;
        }>()
    : null;
  const mergeOid = current.mergeOid;
  if (current.merged && !mergeOid) conflict("github_merge_oid_missing");
  const localAlreadyMerged = prior?.state === "merged";
  if (localAlreadyMerged && !prior.merge_head_oid) conflict("github_merged_head_unpinned");
  if (localAlreadyMerged && prior.merge_head_oid !== current.head.sha)
    conflict("github_merged_head_changed");
  if (current.merged && localAlreadyMerged && prior.merged_oid !== mergeOid)
    conflict("github_merged_oid_not_imported");
  if (
    prior?.locked_at !== null &&
    prior?.locked_at !== undefined &&
    !localAlreadyMerged &&
    !current.merged &&
    current.state !== "open"
  )
    conflict("pull_locked");
  const nativeOrigin = Boolean(
    prior && parseActor(prior.actor_json, prior.author_id).kind !== "external"
  );
  const sameRepositoryHead =
    current.head.repo?.full_name.toLowerCase() ===
    `${connection.owner}/${connection.name}`.toLowerCase();
  const targetHeadRef =
    nativeOrigin && prior
      ? `refs/heads/${prior.head_ref}`
      : sameRepositoryHead && !current.merged
        ? `refs/heads/${current.head.ref}`
        : `refs/heads/github/pr/${current.number}`;
  if (
    prior?.locked_at !== null &&
    prior?.locked_at !== undefined &&
    prior.locked_head_oid !== current.head.sha
  )
    conflict("locked_pull_source_changed");
  const safeState = localAlreadyMerged || current.merged ? "merged" : current.state;
  const body = existing
    ? stripMergedStateNote(stripOrigin(current.body ?? ""), connection, existing.local_id)
    : (current.body ?? "");
  const targetHeadName = targetHeadRef.slice("refs/heads/".length);
  const localValue = [
    current.title,
    body,
    safeState,
    current.draft ? 1 : 0,
    current.base.ref,
    targetHeadName,
  ];
  const desiredLocalFingerprint = fingerprint(localValue);
  const expectedLocalFingerprint =
    existing && remoteDataChanged
      ? await inboundExpectedFingerprint(env, connection, existing, desiredLocalFingerprint)
      : null;
  const baseRef = z
    .object({ object: z.object({ sha: GitOidSchema }) })
    .parse(
      await githubRequest(
        credentials.token,
        `${githubPath(connection)}/git/ref/heads/${encodeURIComponent(current.base.ref)}`
      )
    );
  const baseTransfer = await syncGithubRef(env, connection, credentials, job, {
    ref: `refs/heads/${current.base.ref}`,
    targetRef: `refs/heads/${current.base.ref}`,
    before: null,
    after: baseRef.object.sha,
  });
  if (baseTransfer.status === "stale") return "ignored";
  if (current.merged) {
    const exactMergeOid = mergeOid ?? conflict("github_merge_oid_missing");
    if (
      !(await localRefContains(env, connection, credentials, job, current.base.ref, exactMergeOid))
    )
      conflict("github_merge_oid_not_in_target");
  }
  if (!localAlreadyMerged) {
    const headTransfer = await syncGithubRef(env, connection, credentials, job, {
      ref: `refs/pull/${current.number}/head`,
      targetRef: targetHeadRef,
      before: null,
      after: current.head.sha,
      ...(nativeOrigin ? { pullRequestId: localId } : {}),
    });
    if (headTransfer.status === "stale") return "ignored";
  }
  let mergeBaseOid: string | null = null;
  if (current.merged) {
    const mergeCommit = GithubCommit.parse(
      await githubRequest(credentials.token, `${githubPath(connection)}/commits/${mergeOid}`)
    );
    mergeBaseOid = mergeCommit.parents[0]?.sha ?? null;
    if (!mergeBaseOid) conflict("github_merge_parent_missing");
  }
  const statements: D1PreparedStatement[] = [];
  if (existing && remoteDataChanged) {
    statements.push(
      env.DB.prepare(
        "UPDATE forge_pull_requests SET title=?,body=?,state=?,draft=?,base_ref=?,head_ref=?,merged_oid=COALESCE(merged_oid,?),merge_base_oid=COALESCE(merge_base_oid,?),merge_head_oid=COALESCE(merge_head_oid,?),locked_at=CASE WHEN ?3='merged' THEN NULL ELSE locked_at END,locked_by=CASE WHEN ?3='merged' THEN NULL ELSE locked_by END,locked_head_oid=CASE WHEN ?3='merged' THEN NULL ELSE locked_head_oid END,updated_at=? WHERE id=? AND repository_id=? AND (locked_at IS NULL OR locked_head_oid=?)"
      ).bind(
        current.title,
        body,
        safeState,
        current.draft ? 1 : 0,
        current.base.ref,
        targetHeadName,
        current.merged ? mergeOid : null,
        mergeBaseOid,
        current.merged ? current.head.sha : null,
        now,
        localId,
        repo.id,
        current.head.sha
      )
    );
  } else if (!existing) {
    const localNumber = await nextNumber(env, "forge_pull_requests", repo.id);
    statements.push(
      env.DB.prepare(
        "INSERT INTO forge_pull_requests (id,repository_id,number,author_id,actor_json,title,body,base_ref,head_ref,head_session_id,head_repository_id,draft,state,merged_oid,merge_base_oid,merge_head_oid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?)"
      ).bind(
        localId,
        repo.id,
        localNumber,
        connection.created_by,
        JSON.stringify(externalActor(current.user)),
        current.title,
        body,
        current.base.ref,
        targetHeadRef.slice("refs/heads/".length),
        current.draft ? 1 : 0,
        safeState,
        current.merged ? mergeOid : null,
        mergeBaseOid,
        current.merged ? current.head.sha : null,
        now,
        now
      )
    );
  }
  if (!existing || remoteDataChanged)
    statements.push(
      env.DB.prepare(
        "INSERT INTO forge_github_mappings (connection_id,kind,local_id,remote_id,remote_number,remote_fingerprint,local_fingerprint,remote_updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,kind,local_id) DO UPDATE SET remote_id=excluded.remote_id,remote_number=excluded.remote_number,remote_fingerprint=excluded.remote_fingerprint,local_fingerprint=excluded.local_fingerprint,remote_updated_at=excluded.remote_updated_at"
      ).bind(
        connection.id,
        "pull_request",
        localId,
        String(current.id),
        current.number,
        remoteFp,
        desiredLocalFingerprint,
        now
      )
    );
  else
    statements.push(
      env.DB.prepare(
        "UPDATE forge_github_mappings SET remote_updated_at=? WHERE connection_id=? AND kind='pull_request' AND local_id=?"
      ).bind(now, connection.id, localId)
    );
  const guard =
    existing && prior && remoteDataChanged
      ? localRowGuard(
          connection,
          "pull_request",
          localId,
          expectedLocalFingerprint,
          "AND head_ref IS ? AND head_session_id IS ? AND head_repository_id IS ? AND locked_at IS ? AND locked_by IS ? AND locked_head_oid IS ?",
          [
            prior.head_ref,
            prior.head_session_id,
            prior.head_repository_id,
            prior.locked_at,
            prior.locked_by,
            prior.locked_head_oid,
          ]
        )
      : undefined;
  await applyGithubInbound(env.DB, connection.id, statements, guard);
  await enqueueThreadBackfill(env, connection, "pull_request", current.number);
  return "success";
}

async function inboundComment(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  credentials: GithubCredentials,
  job: GithubJobRow,
  issue: z.infer<typeof GithubIssue>,
  raw: z.infer<typeof GithubComment>,
  action: string | undefined
): Promise<void> {
  const existing = await githubMapping(env.DB, connection.id, "comment", {
    remoteId: String(raw.id),
  });
  if (action === "deleted") {
    if (!existing || existing.remote_fingerprint === "deleted") return;
    const currentLocal = await localFingerprint(
      env,
      connection.repository_id,
      "comment",
      existing.local_id
    );
    if (currentLocal !== null && currentLocal !== existing.local_fingerprint)
      conflict("concurrent_local_edit");
    await applyGithubInbound(
      env.DB,
      connection.id,
      [
        env.DB.prepare("DELETE FROM forge_comments WHERE id=?").bind(existing.local_id),
        env.DB.prepare(
          "UPDATE forge_github_mappings SET remote_fingerprint='deleted',local_fingerprint=NULL WHERE connection_id=? AND kind='comment' AND local_id=?"
        ).bind(connection.id, existing.local_id),
      ],
      localRowGuard(connection, "comment", existing.local_id, currentLocal)
    );
    return;
  }
  if (existing?.remote_fingerprint === "deleted") return;
  const current = GithubComment.parse(
    await remoteObject(credentials.token, `${githubPath(connection)}/issues/comments/${raw.id}`)
  );
  const kind: GithubResourceKind = "comment";
  const remoteFp = fingerprint([current.body]);
  if (existing && existing.remote_fingerprint === remoteFp) return;
  const body = existing ? stripOrigin(current.body) : current.body;
  const desiredLocalFingerprint = fingerprint([body]);
  const expectedLocalFingerprint = existing
    ? await inboundExpectedFingerprint(env, connection, existing, desiredLocalFingerprint)
    : null;
  const parentKind = issue.pull_request ? "pull_request" : "issue";
  const canonicalPull =
    parentKind === "pull_request"
      ? await hydrateGithubPull(
          credentials.token,
          await remoteObject(credentials.token, `${githubPath(connection)}/pulls/${issue.number}`)
        )
      : null;
  let parent = await githubMapping(env.DB, connection.id, parentKind, {
    remoteId: String(canonicalPull?.id ?? issue.id),
  });
  if (!parent && canonicalPull) {
    if ((await inboundPull(env, connection, credentials, job, canonicalPull)) === "ignored")
      throw new Error("github_parent_pending");
    parent = await githubMapping(env.DB, connection.id, parentKind, {
      remoteId: String(canonicalPull.id),
    });
  } else if (!parent) {
    await inboundIssue(env, connection, credentials.token, issue);
    parent = await githubMapping(env.DB, connection.id, parentKind, { remoteId: String(issue.id) });
  }
  if (!parent) throw new Error("github_parent_pending");
  const now = millis(current.updated_at);
  const statements: D1PreparedStatement[] = [];
  if (existing)
    statements.push(
      env.DB.prepare("UPDATE forge_comments SET body=?,updated_at=? WHERE id=?").bind(
        body,
        now,
        existing.local_id
      )
    );
  else {
    const localId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        "INSERT INTO forge_comments (id,repository_id,target_kind,target_id,actor_json,author_id,body,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
      ).bind(
        localId,
        connection.repository_id,
        parentKind,
        parent.local_id,
        JSON.stringify(externalActor(current.user)),
        connection.created_by,
        body,
        now,
        now
      )
    );
    statements.push(
      env.DB.prepare(
        "INSERT INTO forge_github_mappings (connection_id,kind,local_id,remote_id,remote_number,remote_fingerprint,local_fingerprint,remote_updated_at) VALUES (?,?,?,?,NULL,?,?,?)"
      ).bind(
        connection.id,
        kind,
        localId,
        String(current.id),
        remoteFp,
        desiredLocalFingerprint,
        now
      )
    );
  }
  if (existing)
    statements.push(
      env.DB.prepare(
        "UPDATE forge_github_mappings SET remote_fingerprint=?,local_fingerprint=?,remote_updated_at=? WHERE connection_id=? AND kind='comment' AND local_id=?"
      ).bind(remoteFp, desiredLocalFingerprint, now, connection.id, existing.local_id)
    );
  await applyGithubInbound(
    env.DB,
    connection.id,
    statements,
    existing
      ? localRowGuard(connection, "comment", existing.local_id, expectedLocalFingerprint)
      : undefined
  );
}

async function inboundReview(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  credentials: GithubCredentials,
  job: GithubJobRow,
  pull: z.infer<typeof GithubPull>,
  raw: z.infer<typeof GithubReview>
): Promise<void> {
  const current = GithubReview.parse(
    await remoteObject(
      credentials.token,
      `${githubPath(connection)}/pulls/${pull.number}/reviews/${raw.id}`
    )
  );
  let parent = await githubMapping(env.DB, connection.id, "pull_request", {
    remoteId: String(pull.id),
  });
  if (!parent) {
    if ((await inboundPull(env, connection, credentials, job, pull)) === "ignored")
      throw new Error("github_parent_pending");
    parent = await githubMapping(env.DB, connection.id, "pull_request", {
      remoteId: String(pull.id),
    });
  }
  if (!parent) throw new Error("github_parent_pending");
  const old = await githubMapping(env.DB, connection.id, "review", {
    remoteId: String(current.id),
  });
  const verdict = current.state;
  if (verdict === "PENDING") return;
  const state =
    verdict === "APPROVED"
      ? "approved"
      : verdict === "CHANGES_REQUESTED"
        ? "changes_requested"
        : "commented";
  let importedBody = old ? stripOrigin(current.body ?? "") : (current.body ?? "");
  if (old && current.body?.includes("<!-- gitedge-origin:"))
    importedBody = importedBody.replace(/^Original GitEdge verdict:[^\n]*\n\n/, "");
  const body =
    verdict === "DISMISSED" ? `${importedBody}\n\nGitHub review dismissed.`.trim() : importedBody;
  const remoteFp = fingerprint([current.body, verdict, current.commit_id]);
  if (old && old.remote_fingerprint === remoteFp) return;
  const desiredLocalFingerprint = fingerprint([state, body, current.commit_id]);
  const expectedLocalFingerprint = old
    ? await inboundExpectedFingerprint(env, connection, old, desiredLocalFingerprint)
    : null;
  const now = millis(current.submitted_at);
  const statements: D1PreparedStatement[] = [];
  if (old)
    statements.push(
      env.DB.prepare(
        "UPDATE forge_reviews SET actor_json=?,actor_key=?,state=?,body=?,commit_oid=? WHERE id=?"
      ).bind(
        JSON.stringify(externalActor(current.user)),
        reviewActorKey(externalActor(current.user)),
        state,
        body,
        current.commit_id,
        old.local_id
      )
    );
  else {
    const localId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        "INSERT INTO forge_reviews (id,repository_id,pull_request_id,actor_json,author_id,actor_key,state,body,commit_oid,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        localId,
        connection.repository_id,
        parent.local_id,
        JSON.stringify(externalActor(current.user)),
        connection.created_by,
        reviewActorKey(externalActor(current.user)),
        state,
        body,
        current.commit_id,
        now
      )
    );
    statements.push(
      env.DB.prepare(
        "INSERT INTO forge_github_mappings (connection_id,kind,local_id,remote_id,remote_number,remote_fingerprint,local_fingerprint,remote_updated_at) VALUES (?,?,?, ?,NULL,?,?,?)"
      ).bind(
        connection.id,
        "review",
        localId,
        String(current.id),
        remoteFp,
        desiredLocalFingerprint,
        now
      )
    );
  }
  if (old)
    statements.push(
      env.DB.prepare(
        "UPDATE forge_github_mappings SET remote_fingerprint=?,local_fingerprint=?,remote_updated_at=? WHERE connection_id=? AND kind='review' AND local_id=?"
      ).bind(remoteFp, desiredLocalFingerprint, now, connection.id, old.local_id)
    );
  await applyGithubInbound(
    env.DB,
    connection.id,
    statements,
    old ? localRowGuard(connection, "review", old.local_id, expectedLocalFingerprint) : undefined
  );
}

async function inboundReviewComment(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  credentials: GithubCredentials,
  job: GithubJobRow,
  pull: z.infer<typeof GithubPull>,
  raw: z.infer<typeof GithubReviewComment>
): Promise<void> {
  const old = await githubMapping(env.DB, connection.id, "review_comment", {
    remoteId: String(raw.id),
  });
  if (old?.remote_fingerprint === "deleted") return;
  const current = GithubReviewComment.parse(
    await remoteObject(credentials.token, `${githubPath(connection)}/pulls/comments/${raw.id}`)
  );
  let parent = await githubMapping(env.DB, connection.id, "pull_request", {
    remoteId: String(pull.id),
  });
  if (!parent) {
    if ((await inboundPull(env, connection, credentials, job, pull)) === "ignored")
      throw new Error("github_parent_pending");
    parent = await githubMapping(env.DB, connection.id, "pull_request", {
      remoteId: String(pull.id),
    });
  }
  if (!parent) throw new Error("github_parent_pending");
  const previous = current.in_reply_to_id
    ? await githubMapping(env.DB, connection.id, "review_comment", {
        remoteId: String(current.in_reply_to_id),
      })
    : null;
  if (current.in_reply_to_id && !previous) throw new Error("github_parent_pending");
  const remoteFp = fingerprint(reviewCommentRemoteValue(current));
  if (old && old.remote_fingerprint === remoteFp) return;
  const now = millis(current.updated_at);
  const body = old ? stripOrigin(current.body) : current.body;
  const line = current.original_line ?? current.line;
  if (!line) conflict("github_review_comment_line_missing");
  const desiredLocalFingerprint = fingerprint([
    body,
    current.original_commit_id,
    current.path,
    current.side,
    line,
  ]);
  const expectedLocalFingerprint = old
    ? await inboundExpectedFingerprint(env, connection, old, desiredLocalFingerprint)
    : null;
  const review = current.pull_request_review_id
    ? await githubMapping(env.DB, connection.id, "review", {
        remoteId: String(current.pull_request_review_id),
      })
    : null;
  const statements: D1PreparedStatement[] = [];
  if (old)
    statements.push(
      env.DB.prepare(
        "UPDATE forge_review_comments SET body=?,commit_oid=?,path=?,side=?,line=?,start_line=?,diff_hunk=?,updated_at=? WHERE id=?"
      ).bind(
        body,
        current.original_commit_id,
        current.path,
        current.side,
        line,
        current.original_start_line ?? current.start_line ?? null,
        current.diff_hunk,
        now,
        old.local_id
      )
    );
  else {
    const localId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        "INSERT INTO forge_review_comments (id,repository_id,pull_request_id,review_id,in_reply_to,actor_json,actor_key,author_id,commit_oid,path,side,line,start_line,diff_hunk,body,pending,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)"
      ).bind(
        localId,
        connection.repository_id,
        parent.local_id,
        review?.local_id ?? null,
        previous?.local_id ?? null,
        JSON.stringify(externalActor(current.user)),
        reviewActorKey(externalActor(current.user)),
        connection.created_by,
        current.original_commit_id,
        current.path,
        current.side,
        line,
        current.original_start_line ?? current.start_line ?? null,
        current.diff_hunk,
        body,
        now,
        now
      )
    );
    statements.push(
      env.DB.prepare(
        "INSERT INTO forge_github_mappings (connection_id,kind,local_id,remote_id,remote_number,remote_fingerprint,local_fingerprint,remote_updated_at) VALUES (?,?,?, ?,NULL,?,?,?)"
      ).bind(
        connection.id,
        "review_comment",
        localId,
        String(current.id),
        remoteFp,
        desiredLocalFingerprint,
        now
      )
    );
  }
  if (old)
    statements.push(
      env.DB.prepare(
        "UPDATE forge_github_mappings SET remote_fingerprint=?,local_fingerprint=?,remote_updated_at=? WHERE connection_id=? AND kind='review_comment' AND local_id=?"
      ).bind(remoteFp, desiredLocalFingerprint, now, connection.id, old.local_id)
    );
  await applyGithubInbound(
    env.DB,
    connection.id,
    statements,
    old
      ? localRowGuard(connection, "review_comment", old.local_id, expectedLocalFingerprint)
      : undefined
  );
}

async function deleteInboundReviewComment(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  remoteId: number
): Promise<void> {
  const existing = await githubMapping(env.DB, connection.id, "review_comment", {
    remoteId: String(remoteId),
  });
  if (!existing || existing.remote_fingerprint === "deleted") return;
  const currentLocal = await localFingerprint(
    env,
    connection.repository_id,
    "review_comment",
    existing.local_id
  );
  if (currentLocal !== null && currentLocal !== existing.local_fingerprint)
    conflict("concurrent_local_edit");
  await applyGithubInbound(
    env.DB,
    connection.id,
    [
      env.DB.prepare("DELETE FROM forge_review_comments WHERE id=?").bind(existing.local_id),
      env.DB.prepare(
        "UPDATE forge_github_mappings SET remote_fingerprint='deleted',local_fingerprint=NULL WHERE connection_id=? AND kind='review_comment' AND local_id=?"
      ).bind(connection.id, existing.local_id),
    ],
    localRowGuard(connection, "review_comment", existing.local_id, currentLocal)
  );
}

async function outbound(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  credentials: GithubCredentials,
  job: GithubJobRow
): Promise<void> {
  const data = Outbound.parse(JSON.parse(job.payload));
  const kind = data.kind;
  const table =
    kind === "issue"
      ? "forge_issues"
      : kind === "pull_request"
        ? "forge_pull_requests"
        : kind === "comment"
          ? "forge_comments"
          : kind === "review"
            ? "forge_reviews"
            : "forge_review_comments";
  const row =
    data.action === "delete"
      ? null
      : await env.DB.prepare(`SELECT * FROM ${table} WHERE id=? AND repository_id=?`)
          .bind(data.id, connection.repository_id)
          .first<Record<string, unknown>>();
  const mapping = await githubMapping(env.DB, connection.id, kind, { localId: data.id });
  const path = githubPath(connection);
  if (data.action === "delete") {
    if (!mapping) return;
    if (mapping.remote_fingerprint === "deleted") return;
    try {
      if (kind === "comment") {
        const remote = GithubComment.parse(
          await githubRequest(credentials.token, `${path}/issues/comments/${mapping.remote_id}`)
        );
        assertRemoteUnchanged(mapping, [remote.body]);
        await githubRequest(
          credentials.token,
          `${path}/issues/comments/${mapping.remote_id}`,
          "DELETE"
        );
      } else if (kind === "review_comment") {
        const remote = GithubReviewComment.parse(
          await githubRequest(credentials.token, `${path}/pulls/comments/${mapping.remote_id}`)
        );
        assertRemoteUnchanged(mapping, [
          remote.body,
          remote.commit_id,
          remote.path,
          remote.side,
          remote.line,
          remote.in_reply_to_id,
        ]);
        await githubRequest(
          credentials.token,
          `${path}/pulls/comments/${mapping.remote_id}`,
          "DELETE"
        );
      } else conflict("github_resource_delete_unsupported");
    } catch (error) {
      if (!(error instanceof GithubApiError) || error.status !== 404) throw error;
    }
    await env.DB.prepare(
      "UPDATE forge_github_mappings SET remote_fingerprint='deleted',local_fingerprint=NULL WHERE connection_id=? AND kind=? AND local_id=?"
    )
      .bind(connection.id, kind, data.id)
      .run();
    return;
  }
  if (!row) return;
  if (kind === "issue") {
    const issue = IssueRowSchema.parse(row);
    const requestedLabels = normalizeLabels(
      z.array(z.string()).parse(JSON.parse(issue.labels_json))
    );
    const labels = await ensureGithubLabels(credentials.token, path, requestedLabels);
    const localSnapshot = fingerprint([issue.title, issue.body, issue.state, issue.labels_json]);
    const title = issue.title;
    const body = outboundBody(
      connection,
      kind,
      issue.id,
      issue.body,
      issue.actor_json,
      issue.author_id
    );
    let result: unknown;
    if (mapping) {
      const remote = GithubIssue.parse(
        await githubRequest(credentials.token, `${path}/issues/${mapping.remote_number}`)
      );
      const remoteValue = [
        remote.title,
        remote.body ?? "",
        remote.state,
        normalizeLabels(remote.labels.map((label) => label.name)),
      ];
      const intendedValue = [title, body, issue.state, labels];
      if (fingerprint(remoteValue) === fingerprint(intendedValue)) {
        await saveMapping(
          env,
          connection,
          kind,
          issue.id,
          String(remote.id),
          remote.number,
          remoteValue,
          millis(remote.updated_at),
          localSnapshot
        );
        return;
      }
      assertRemoteUnchanged(mapping, remoteValue);
      if (mapping.local_fingerprint === localSnapshot) return;
      result = await githubRequest(
        credentials.token,
        `${path}/issues/${mapping.remote_number}`,
        "PATCH",
        { title, body, state: issue.state, labels }
      );
    } else {
      const existing = await findMarked(
        credentials.token,
        `${path}/issues?state=all`,
        (value) => z.array(GithubIssue).parse(value),
        (candidate) => candidate.body?.includes(originMarker(connection, kind, issue.id)) ?? false
      );
      if (existing) {
        if (
          existing.title !== title ||
          existing.body !== body ||
          (issue.state === "open" && existing.state !== "open")
        )
          conflict("remote_create_discovery_mismatch");
        const remoteLabels = normalizeLabels(existing.labels.map((label) => label.name));
        result =
          fingerprint(remoteLabels) === fingerprint(labels)
            ? existing
            : await githubRequest(credentials.token, `${path}/issues/${existing.number}`, "PATCH", {
                labels,
                state: issue.state,
              });
      } else {
        result = await githubRequest(credentials.token, `${path}/issues`, "POST", {
          title,
          body,
          labels,
        });
      }
    }
    let parsed = GithubIssue.parse(result);
    if (issue.state === "closed" && parsed.state !== "closed")
      parsed = GithubIssue.parse(
        await githubRequest(credentials.token, `${path}/issues/${parsed.number}`, "PATCH", {
          state: "closed",
        })
      );
    await saveMapping(
      env,
      connection,
      kind,
      issue.id,
      String(parsed.id),
      parsed.number,
      [
        parsed.title,
        parsed.body ?? "",
        parsed.state,
        normalizeLabels(parsed.labels.map((label) => label.name)),
      ],
      millis(parsed.updated_at),
      localSnapshot
    );
    return;
  }
  if (kind === "pull_request") {
    const pull = PullRowSchema.parse(row);
    if (pull.state === "merged" && !pull.merged_oid) conflict("pull_merge_oid_missing");
    const localSnapshot = fingerprint([
      pull.title,
      pull.body,
      pull.state,
      pull.draft,
      pull.base_ref,
      pull.head_ref,
    ]);
    const refs = await githubSyncRefs(env, connection, credentials, job);
    const localBase = refs.local.find((ref) => ref.ref === `refs/heads/${pull.base_ref}`);
    const remoteBase = refs.remote.find((ref) => ref.ref === `refs/heads/${pull.base_ref}`);
    if (!localBase || !remoteBase) conflict("pull_target_branch_unavailable");
    let mappedRemote: z.infer<typeof GithubPull> | null = null;
    let mappedRemoteBaseline: unknown[] | null = null;
    const desiredBody = outboundBody(
      connection,
      kind,
      pull.id,
      pull.body,
      pull.actor_json,
      pull.author_id
    );
    if (mapping) {
      mappedRemote = await hydrateGithubPull(
        credentials.token,
        await githubRequest(credentials.token, `${path}/pulls/${mapping.remote_number}`)
      );
      mappedRemoteBaseline = pullRemoteValue(mappedRemote);
      const intendedRemoteValue = [
        pull.title,
        desiredBody,
        pull.state,
        Boolean(pull.draft),
        pull.base_ref,
        mappedRemote.head.ref,
      ];
      const draftAdjustedBaseline = [...mappedRemoteBaseline];
      draftAdjustedBaseline[3] = Boolean(pull.draft);
      const alreadyMirroredMerge =
        pull.merged_oid !== null &&
        ((mappedRemote.merged && mappedRemote.mergeOid === pull.merged_oid) ||
          (mappedRemote.state === "closed" &&
            mappedRemote.body?.includes(mergedStateMarker(connection, pull.id, pull.merged_oid))));
      if (
        fingerprint(mappedRemoteBaseline) !== mapping.remote_fingerprint &&
        fingerprint(mappedRemoteBaseline) !== fingerprint(intendedRemoteValue) &&
        fingerprint(mappedRemoteBaseline) !== fingerprint(draftAdjustedBaseline) &&
        !alreadyMirroredMerge
      )
        conflict("concurrent_remote_edit");
      if (!pull.merged_oid && mappedRemote.draft !== Boolean(pull.draft)) {
        if (!mappedRemote.node_id || mappedRemote.state !== "open")
          conflict("github_draft_change_unavailable");
        const mutation = pull.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
        const inputType = pull.draft
          ? "ConvertPullRequestToDraftInput"
          : "MarkPullRequestReadyForReviewInput";
        const result = z
          .object({
            data: z
              .object({ result: z.object({ pullRequest: z.object({ isDraft: z.boolean() }) }) })
              .nullable()
              .optional(),
            errors: z.array(z.unknown()).optional(),
          })
          .parse(
            await githubRequest(credentials.token, "/graphql", "POST", {
              query: `mutation($input:${inputType}!){result:${mutation}(input:$input){pullRequest{isDraft}}}`,
              variables: { input: { pullRequestId: mappedRemote.node_id } },
            })
          );
        if (
          result.errors?.length ||
          result.data?.result.pullRequest.isDraft !== Boolean(pull.draft)
        )
          conflict("github_draft_change_failed");
        mappedRemote.draft = Boolean(pull.draft);
      }
    }
    if (pull.merged_oid) {
      if (!mapping?.remote_number) conflict("github_merged_pull_unmapped");
      const baseSync = await syncGithubRef(env, connection, credentials, job, {
        ref: `refs/heads/${pull.base_ref}`,
        targetRef: `refs/heads/${pull.base_ref}`,
        before: remoteBase.oid,
        after: localBase.oid,
      });
      if (baseSync.status === "stale") conflict("pull_target_changed_during_merge_publish");
      let remote = await hydrateGithubPull(
        credentials.token,
        await githubRequest(credentials.token, `${path}/pulls/${mapping.remote_number}`)
      );
      if (remote.merged) {
        if (remote.mergeOid !== pull.merged_oid) conflict("github_merge_oid_conflict");
      } else {
        const marker = mergedStateMarker(connection, pull.id, pull.merged_oid);
        const annotatedBody = `${pull.body}${pull.body ? "\n\n" : ""}${mergedStateNote(pull.merged_oid)}\n${marker}`;
        const body = outboundBody(
          connection,
          kind,
          pull.id,
          annotatedBody,
          pull.actor_json,
          pull.author_id
        );
        const remoteValue = pullRemoteValue(remote);
        const intendedClosedValue = [
          pull.title,
          body,
          "closed",
          remote.draft,
          pull.base_ref,
          remote.head.ref,
        ];
        if (
          remote.state === "closed" &&
          remote.body?.includes(marker) &&
          fingerprint(remoteValue) === fingerprint(intendedClosedValue)
        ) {
          await saveMapping(
            env,
            connection,
            kind,
            pull.id,
            String(remote.id),
            remote.number,
            pullRemoteValue(remote),
            millis(remote.updated_at),
            localSnapshot
          );
          return;
        }
        if (remote.state !== "open" && !remote.body?.includes(marker))
          conflict("github_closed_pull_without_gitedge_merge_marker");
        assertRemoteUnchanged(mapping, remoteValue);
        remote = await hydrateGithubPull(
          credentials.token,
          await githubRequest(
            credentials.token,
            `${path}/pulls/${mapping.remote_number}`,
            "PATCH",
            { title: pull.title, body, base: pull.base_ref, state: "closed" }
          )
        );
        if (remote.merged || remote.state !== "closed" || !remote.body?.includes(marker))
          conflict("github_gitedge_merge_annotation_failed");
      }
      await saveMapping(
        env,
        connection,
        kind,
        pull.id,
        String(remote.id),
        remote.number,
        pullRemoteValue(remote),
        millis(remote.updated_at),
        localSnapshot
      );
      return;
    }
    if (pull.state === "closed" && !mapping) conflict("closed_pull_without_remote_mapping");
    const headRef = `refs/heads/${pull.head_ref}`;
    let published: { oid: string } | null = null;
    const remoteHeadRepository = mappedRemote?.head.repo?.full_name.toLowerCase();
    const isMappedExternalFork = Boolean(
      mappedRemote &&
      remoteHeadRepository !== `${connection.owner}/${connection.name}`.toLowerCase()
    );
    if (pull.state === "open") {
      if (isMappedExternalFork && mappedRemote) {
        published = refs.local.find((ref) => ref.ref === headRef) ?? null;
        if (!published || published.oid !== mappedRemote.head.sha)
          conflict("github_external_head_readonly");
      } else {
        const headRepositoryId = pull.head_repository_id ?? connection.repository_id;
        const head = await env.DB.prepare(
          "SELECT new_oid AS oid FROM forge_pull_head_updates WHERE pull_request_id=? ORDER BY created_at DESC,id DESC LIMIT 1"
        )
          .bind(pull.id)
          .first<{ oid: string }>();
        published =
          head ??
          (await env.DB.prepare(
            "SELECT oid FROM forge_ref_pushers WHERE repository_id=? AND session_id=? AND ref=?"
          )
            .bind(headRepositoryId, pull.head_session_id ?? "", headRef)
            .first<{ oid: string }>()) ??
          refs.local.find((ref) => ref.ref === headRef) ??
          null;
      }
      if (!published) conflict("pull_head_unavailable");
    }
    if (published && pull.locked_at !== null && pull.locked_head_oid !== published.oid)
      conflict("locked_pull_source_changed");
    if (pull.state === "open") {
      const publishedOid = published?.oid ?? conflict("pull_head_unavailable");
      if (!isMappedExternalFork) {
        const targetHeadRef = mappedRemote
          ? `refs/heads/${mappedRemote.head.ref}`
          : `refs/heads/gitedge/pr/${pull.number}`;
        const headSync = await syncGithubRef(env, connection, credentials, job, {
          ref: headRef,
          targetRef: targetHeadRef,
          before: mappedRemote?.head.sha ?? null,
          after: publishedOid,
          pullRequestId: pull.id,
        });
        if (headSync.status === "stale") conflict("pull_head_changed_during_publish");
      }
    }
    const createInput = {
      title: pull.title,
      body: desiredBody,
      head: `gitedge/pr/${pull.number}`,
      base: pull.base_ref,
      draft: pull.draft === 1,
    };
    let result: unknown;
    if (mapping) {
      if (!mappedRemote) conflict("github_remote_pull_missing");
      const currentRemote = await hydrateGithubPull(
        credentials.token,
        await githubRequest(credentials.token, `${path}/pulls/${mapping.remote_number}`)
      );
      const currentRemoteValue = pullRemoteValue(currentRemote);
      const intendedRemoteValue = [
        pull.title,
        desiredBody,
        pull.state,
        Boolean(pull.draft),
        pull.base_ref,
        mappedRemote.head.ref,
      ];
      const intendedRemoteMatches =
        fingerprint(currentRemoteValue) === fingerprint(intendedRemoteValue) &&
        (pull.state !== "open" || currentRemote.head.sha === published?.oid);
      if (intendedRemoteMatches) {
        await saveMapping(
          env,
          connection,
          kind,
          pull.id,
          String(currentRemote.id),
          currentRemote.number,
          currentRemoteValue,
          millis(currentRemote.updated_at),
          localSnapshot
        );
        return;
      }
      if (pull.state === "open" && currentRemote.head.sha !== published?.oid)
        conflict("pull_remote_head_not_published");
      const draftAdjustedBaseline = mappedRemoteBaseline ? [...mappedRemoteBaseline] : null;
      if (draftAdjustedBaseline && mappedRemoteBaseline?.[3] !== Boolean(pull.draft))
        draftAdjustedBaseline[3] = Boolean(pull.draft);
      if (
        fingerprint(currentRemoteValue) !== fingerprint(mappedRemoteBaseline) &&
        fingerprint(currentRemoteValue) !== fingerprint(draftAdjustedBaseline)
      )
        conflict("concurrent_remote_edit");
      if (mapping.local_fingerprint === localSnapshot && pull.state !== "open") return;
      result = await githubRequest(
        credentials.token,
        `${path}/pulls/${mapping.remote_number}`,
        "PATCH",
        { title: pull.title, body: desiredBody, base: pull.base_ref, state: pull.state }
      );
    } else if (pull.state === "closed") {
      conflict("closed_pull_without_remote_mapping");
    } else {
      const existing = await findMarked(
        credentials.token,
        `${path}/pulls?state=all`,
        (value) => z.array(GithubPull).parse(value),
        (candidate) =>
          candidate.head.ref === `gitedge/pr/${pull.number}` &&
          candidate.head.repo?.full_name.toLowerCase() ===
            `${connection.owner}/${connection.name}`.toLowerCase()
      );
      if (existing) {
        if (
          existing.title !== pull.title ||
          existing.body !== desiredBody ||
          existing.base.ref !== pull.base_ref ||
          existing.draft !== Boolean(pull.draft)
        )
          conflict("remote_create_discovery_mismatch");
        if (existing.head.sha !== published?.oid) conflict("pull_remote_head_not_published");
        result = existing;
      } else result = await githubRequest(credentials.token, `${path}/pulls`, "POST", createInput);
    }
    const parsed = await hydrateGithubPull(credentials.token, result);
    await saveMapping(
      env,
      connection,
      kind,
      pull.id,
      String(parsed.id),
      parsed.number,
      pullRemoteValue(parsed),
      millis(parsed.updated_at),
      localSnapshot
    );
    return;
  }
  if (kind === "comment") {
    const comment = CommentRowSchema.parse(row);
    const localSnapshot = fingerprint([comment.body]);
    const parent = await githubMapping(
      env.DB,
      connection.id,
      comment.target_kind === "issue" ? "issue" : "pull_request",
      { localId: comment.target_id }
    );
    if (!parent) throw new Error("github_parent_pending");
    const body = outboundBody(
      connection,
      kind,
      comment.id,
      comment.body,
      comment.actor_json,
      comment.author_id
    );
    let result: unknown;
    if (mapping) {
      const remote = GithubComment.parse(
        await githubRequest(credentials.token, `${path}/issues/comments/${mapping.remote_id}`)
      );
      const remoteValue = [remote.body];
      if (fingerprint(remoteValue) === fingerprint([body])) {
        await saveMapping(
          env,
          connection,
          kind,
          comment.id,
          String(remote.id),
          null,
          remoteValue,
          millis(remote.updated_at),
          localSnapshot
        );
        return;
      }
      assertRemoteUnchanged(mapping, remoteValue);
      if (mapping.local_fingerprint === localSnapshot) return;
      result = await githubRequest(
        credentials.token,
        `${path}/issues/comments/${mapping.remote_id}`,
        "PATCH",
        { body }
      );
    } else {
      const existing = await findMarked(
        credentials.token,
        `${path}/issues/${parent.remote_number}/comments`,
        (value) => z.array(GithubComment).parse(value),
        (candidate) => candidate.body.includes(originMarker(connection, kind, comment.id))
      );
      if (existing) {
        if (existing.body !== body) conflict("remote_create_discovery_mismatch");
        result = existing;
      } else
        result = await githubRequest(
          credentials.token,
          `${path}/issues/${parent.remote_number}/comments`,
          "POST",
          { body }
        );
    }
    const parsed = GithubComment.parse(result);
    await saveMapping(
      env,
      connection,
      kind,
      comment.id,
      String(parsed.id),
      null,
      [parsed.body],
      millis(parsed.updated_at),
      localSnapshot
    );
    return;
  }
  if (kind === "review") {
    const review = ReviewRowSchema.parse(row);
    const localSnapshot = fingerprint([review.state, review.body, review.commit_oid]);
    const parent = await githubMapping(env.DB, connection.id, "pull_request", {
      localId: review.pull_request_id,
    });
    if (!parent) throw new Error("github_parent_pending");
    const commitOid = GitOidSchema.parse(review.commit_oid);
    const body = `Original GitEdge verdict: ${review.state}.\n\n${outboundBody(connection, kind, review.id, review.body, review.actor_json, review.author_id)}`;
    const reviewsPath = `${path}/pulls/${parent.remote_number}/reviews`;
    let result: unknown;
    if (mapping) {
      const remote = GithubReview.parse(
        await githubRequest(
          credentials.token,
          `${path}/pulls/${parent.remote_number}/reviews/${mapping.remote_id}`
        )
      );
      const remoteValue = [remote.body, remote.state, remote.commit_id];
      const intendedValue = [body, "COMMENTED", commitOid];
      if (fingerprint(remoteValue) === fingerprint(intendedValue)) {
        await saveMapping(
          env,
          connection,
          kind,
          review.id,
          String(remote.id),
          null,
          remoteValue,
          millis(remote.submitted_at),
          localSnapshot
        );
        return;
      }
      assertRemoteUnchanged(mapping, remoteValue);
      if (mapping.local_fingerprint === localSnapshot) return;
      if (remote.commit_id !== commitOid) conflict("github_review_commit_immutable");
      result = await githubRequest(
        credentials.token,
        `${path}/pulls/${parent.remote_number}/reviews/${mapping.remote_id}`,
        "PUT",
        { body }
      );
    } else {
      const existing = await findMarked(
        credentials.token,
        reviewsPath,
        (value) => z.array(GithubReview).parse(value),
        (candidate) => candidate.body?.includes(originMarker(connection, kind, review.id)) ?? false
      );
      if (existing) {
        if (
          existing.body !== body ||
          existing.state !== "COMMENTED" ||
          existing.commit_id !== commitOid
        )
          conflict("remote_create_discovery_mismatch");
        result = existing;
      } else
        result = await githubRequest(credentials.token, reviewsPath, "POST", {
          commit_id: commitOid,
          event: "COMMENT",
          body,
        });
    }
    const parsed = GithubReview.parse(result);
    await saveMapping(
      env,
      connection,
      kind,
      review.id,
      String(parsed.id),
      null,
      [parsed.body, parsed.state, parsed.commit_id],
      millis(parsed.submitted_at),
      localSnapshot
    );
    return;
  }
  const comment = ReviewCommentRowSchema.parse(row);
  const localSnapshot = fingerprint([
    comment.body,
    comment.commit_oid,
    comment.path,
    comment.side,
    comment.line,
  ]);
  const parent = await githubMapping(env.DB, connection.id, "pull_request", {
    localId: comment.pull_request_id,
  });
  if (!parent) throw new Error("github_parent_pending");
  const body = outboundBody(
    connection,
    kind,
    comment.id,
    comment.body,
    comment.actor_json,
    comment.author_id
  );
  const replyMapping = comment.in_reply_to
    ? await githubMapping(env.DB, connection.id, "review_comment", { localId: comment.in_reply_to })
    : null;
  if (comment.in_reply_to && !replyMapping) throw new Error("github_parent_pending");
  const input = replyMapping
    ? { body, in_reply_to: Number(replyMapping.remote_id) }
    : {
        body,
        commit_id: comment.commit_oid,
        path: comment.path,
        side: comment.side,
        line: comment.line,
        ...(comment.start_line !== null && comment.start_line !== comment.line
          ? { start_line: comment.start_line, start_side: comment.side }
          : {}),
      };
  const commentsPath = `${path}/pulls/${parent.remote_number}/comments`;
  let result: unknown;
  if (mapping) {
    const remote = GithubReviewComment.parse(
      await githubRequest(credentials.token, `${path}/pulls/comments/${mapping.remote_id}`)
    );
    const remoteValue = reviewCommentRemoteValue(remote);
    const intendedValue = [
      body,
      comment.commit_oid,
      comment.path,
      comment.side,
      comment.line,
      replyMapping ? Number(replyMapping.remote_id) : undefined,
    ];
    if (fingerprint(remoteValue) === fingerprint(intendedValue)) {
      await saveMapping(
        env,
        connection,
        kind,
        comment.id,
        String(remote.id),
        null,
        remoteValue,
        millis(remote.updated_at),
        localSnapshot
      );
      return;
    }
    assertRemoteUnchanged(mapping, remoteValue);
    if (mapping.local_fingerprint === localSnapshot) return;
    result = await githubRequest(
      credentials.token,
      `${path}/pulls/comments/${mapping.remote_id}`,
      "PATCH",
      { body }
    );
  } else {
    const existing = await findMarked(
      credentials.token,
      commentsPath,
      (value) => z.array(GithubReviewComment).parse(value),
      (candidate) => candidate.body.includes(originMarker(connection, kind, comment.id))
    );
    if (existing) {
      if (
        existing.body !== body ||
        existing.original_commit_id !== comment.commit_oid ||
        existing.path !== comment.path ||
        existing.side !== comment.side ||
        (existing.original_line ?? existing.line) !== comment.line ||
        existing.in_reply_to_id !== (replyMapping ? Number(replyMapping.remote_id) : undefined)
      )
        conflict("remote_create_discovery_mismatch");
      result = existing;
    } else result = await githubRequest(credentials.token, commentsPath, "POST", input);
  }
  const parsed = GithubReviewComment.parse(result);
  await saveMapping(
    env,
    connection,
    kind,
    comment.id,
    String(parsed.id),
    null,
    reviewCommentRemoteValue(parsed),
    millis(parsed.updated_at),
    localSnapshot
  );
}

export async function syncGithubCollaboration(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  credentials: GithubCredentials,
  job: GithubJobRow
): Promise<"success" | "ignored"> {
  if (job.direction === "outbound") {
    await outbound(env, connection, credentials, job);
    return "success";
  }
  if (job.event === "snapshot") {
    const snapshot = Snapshot.parse(JSON.parse(job.payload));
    if (snapshot.kind === "issue") {
      const issue = GithubIssue.parse(
        await remoteObject(credentials.token, `${githubPath(connection)}/issues/${snapshot.number}`)
      );
      if (issue.pull_request) conflict("github_snapshot_kind_mismatch");
      await inboundIssue(env, connection, credentials.token, issue);
    } else {
      const pull = await hydrateGithubPull(
        credentials.token,
        await remoteObject(credentials.token, `${githubPath(connection)}/pulls/${snapshot.number}`)
      );
      if ((await inboundPull(env, connection, credentials, job, pull)) === "ignored")
        return "ignored";
    }
    await enqueueThreadBackfill(env, connection, snapshot.kind, snapshot.number, job.id);
    return "success";
  }
  const parsed = Webhook.safeParse(JSON.parse(job.payload));
  if (!parsed.success) conflict("invalid_github_event");
  const event = job.event;
  const payload = parsed.data;
  if (event === "issues" && payload.issue)
    await inboundIssue(env, connection, credentials.token, payload.issue);
  else if (event === "issue_comment" && payload.issue && payload.comment)
    await inboundComment(
      env,
      connection,
      credentials,
      job,
      payload.issue,
      payload.comment,
      payload.action
    );
  else if (event === "pull_request" && payload.pull_request)
    return await inboundPull(env, connection, credentials, job, payload.pull_request);
  else if (event === "pull_request_review" && payload.pull_request && payload.review)
    await inboundReview(env, connection, credentials, job, payload.pull_request, payload.review);
  else if (event === "pull_request_review_comment" && payload.pull_request && payload.comment) {
    if (payload.action === "deleted")
      await deleteInboundReviewComment(env, connection, payload.comment.id);
    else
      await inboundReviewComment(
        env,
        connection,
        credentials,
        job,
        payload.pull_request,
        GithubReviewComment.parse(payload.comment)
      );
  } else return "ignored";
  return "success";
}
