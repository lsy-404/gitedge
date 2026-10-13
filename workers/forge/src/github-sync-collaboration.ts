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

const GithubActor = z.object({ id: z.number().int().positive(), login: z.string().min(1) });
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
  body: z.string().nullable(),
  draft: z.boolean(),
  merged: z.boolean().default(false),
  merge_commit_sha: GitOidSchema.nullable().optional(),
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
    state: z.enum(["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"]),
    commit_id: GitOidSchema,
    submitted_at: z.string().datetime({ offset: true }).nullable(),
    user: GithubActor,
  })
  .passthrough();
const GithubReviewComment = GithubComment.extend({
  commit_id: GitOidSchema,
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
const PullRowSchema = IssueRowSchema.extend({
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
function githubPath(connection: GithubConnectionRow): string {
  return githubRepoPath(connection.owner, connection.name);
}
function conflict(code: string): never {
  throw new GithubSyncConflict(code);
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
  remoteUpdatedAt: number
): Promise<void> {
  const local = await localFingerprint(env, connection.repository_id, kind, localId);
  await githubMappingStatement(env.DB, {
    connection_id: connection.id,
    kind,
    local_id: localId,
    remote_id: remoteId,
    remote_number: remoteNumber,
    remote_fingerprint: fingerprint(remoteValue),
    local_fingerprint: local,
    remote_updated_at: remoteUpdatedAt,
  }).run();
}

async function assertNoConcurrentEdit(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  mapping: GithubMappingRow | null
): Promise<void> {
  if (!mapping) return;
  const current = await localFingerprint(
    env,
    connection.repository_id,
    mapping.kind,
    mapping.local_id
  );
  if (current !== mapping.local_fingerprint) conflict("concurrent_local_edit");
}

async function remoteObject(token: string, path: string): Promise<unknown> {
  return githubRequest(token, path);
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
  const remoteValue = [
    current.title,
    current.body ?? "",
    current.state,
    current.labels.map((label) => label.name),
  ];
  const remoteFp = fingerprint(remoteValue);
  if (existing && existing.remote_fingerprint === remoteFp) return;
  await assertNoConcurrentEdit(env, connection, existing);
  const now = millis(current.updated_at);
  const labels = JSON.stringify(current.labels.map((label) => label.name));
  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(
      env.DB.prepare(
        "UPDATE forge_issues SET title=?, body=?, state=?, labels_json=?, updated_at=? WHERE id=? AND repository_id=?"
      ).bind(
        current.title,
        current.body ?? "",
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
        fingerprint([current.title, current.body ?? "", current.state, labels]),
        now
      )
    );
  }
  if (existing)
    statements.push(
      env.DB.prepare(
        "UPDATE forge_github_mappings SET remote_fingerprint=?,local_fingerprint=?,remote_updated_at=? WHERE connection_id=? AND kind='issue' AND local_id=?"
      ).bind(
        remoteFp,
        fingerprint([current.title, current.body ?? "", current.state, labels]),
        now,
        connection.id,
        existing.local_id
      )
    );
  await applyGithubInbound(env.DB, connection.id, statements);
  await enqueueThreadBackfill(env, connection, "issue", current.number);
}

async function enqueueThreadBackfill(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  kind: "issue" | "pull_request",
  number: number
): Promise<void> {
  const categories = kind === "issue" ? ["comment"] : ["comment", "review", "review_comment"];
  for (const category of categories)
    await enqueueGithubJob(
      env.DB,
      connection.id,
      "inbound",
      "bootstrap",
      { phase: "thread", kind, number, category, page: 1 },
      `github-thread:${connection.id}:${kind}:${number}:${category}:1`
    );
}

async function inboundPull(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  credentials: GithubCredentials,
  job: GithubJobRow,
  raw: z.infer<typeof GithubPull>
): Promise<"success" | "ignored"> {
  const current = GithubPull.parse(
    await remoteObject(credentials.token, `${githubPath(connection)}/pulls/${raw.number}`)
  );
  const repo = await env.DB.prepare("SELECT id,default_branch FROM repositories WHERE id=?")
    .bind(connection.repository_id)
    .first<RepoRow>();
  if (!repo) conflict("repository_missing");
  const existing = await githubMapping(env.DB, connection.id, "pull_request", {
    remoteId: String(current.id),
  });
  const state = current.merged ? "merged" : current.state;
  const remoteValue = [
    current.title,
    current.body ?? "",
    state,
    current.draft,
    current.base.ref,
    current.head.ref,
    current.head.sha,
    current.merge_commit_sha ?? null,
  ];
  const remoteFp = fingerprint(remoteValue);
  if (existing && existing.remote_fingerprint === remoteFp) return "success";
  await assertNoConcurrentEdit(env, connection, existing);
  const localId = existing?.local_id ?? crypto.randomUUID();
  const now = millis(current.updated_at);
  const prior = existing
    ? await env.DB.prepare(
        "SELECT state,merged_oid,locked_at,locked_head_oid FROM forge_pull_requests WHERE id=?"
      )
        .bind(localId)
        .first<{
          state: string;
          merged_oid: string | null;
          locked_at: number | null;
          locked_head_oid: string | null;
        }>()
    : null;
  const mergeOid = current.merge_commit_sha;
  if (current.merged && !mergeOid) conflict("github_merge_oid_missing");
  if (current.merged && prior?.state === "merged" && prior.merged_oid !== mergeOid)
    conflict("github_merged_oid_not_imported");
  if (
    prior?.locked_at !== null &&
    prior?.locked_at !== undefined &&
    prior.locked_head_oid !== current.head.sha
  )
    conflict("locked_pull_source_changed");
  const baseTransfer = await syncGithubRef(env, connection, credentials, job, {
    ref: `refs/heads/${current.base.ref}`,
    targetRef: `refs/heads/${current.base.ref}`,
    before: null,
    after: current.base.sha,
  });
  if (baseTransfer.status === "stale") return "ignored";
  if (current.merged) {
    const exactMergeOid = mergeOid ?? conflict("github_merge_oid_missing");
    if (
      !(await localRefContains(env, connection, credentials, job, current.base.ref, exactMergeOid))
    )
      conflict("github_merge_oid_not_in_target");
  }
  const headTransfer = await syncGithubRef(env, connection, credentials, job, {
    ref: `refs/pull/${current.number}/head`,
    targetRef: `refs/heads/github/pr/${current.number}`,
    before: null,
    after: current.head.sha,
  });
  if (headTransfer.status === "stale") return "ignored";
  const safeState = current.merged ? "merged" : current.state;
  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(
      env.DB.prepare(
        "UPDATE forge_pull_requests SET title=?,body=?,state=?,draft=?,base_ref=?,head_ref=?,merged_oid=COALESCE(merged_oid,?),updated_at=? WHERE id=? AND repository_id=? AND (locked_at IS NULL OR locked_head_oid=?)"
      ).bind(
        current.title,
        current.body ?? "",
        safeState,
        current.draft ? 1 : 0,
        current.base.ref,
        `github/pr/${current.number}`,
        current.merged ? mergeOid : null,
        now,
        localId,
        repo.id,
        current.head.sha
      )
    );
  } else {
    const localNumber = await nextNumber(env, "forge_pull_requests", repo.id);
    statements.push(
      env.DB.prepare(
        "INSERT INTO forge_pull_requests (id,repository_id,number,author_id,actor_json,title,body,base_ref,head_ref,head_session_id,head_repository_id,draft,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?)"
      ).bind(
        localId,
        repo.id,
        localNumber,
        connection.created_by,
        JSON.stringify(externalActor(current.user)),
        current.title,
        current.body ?? "",
        current.base.ref,
        `github/pr/${current.number}`,
        current.draft ? 1 : 0,
        safeState,
        now,
        now
      )
    );
  }
  const localValue = [
    current.title,
    current.body ?? "",
    safeState,
    current.draft ? 1 : 0,
    current.base.ref,
    `github/pr/${current.number}`,
  ];
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
      fingerprint(localValue),
      now
    )
  );
  await applyGithubInbound(env.DB, connection.id, statements);
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
    if (!existing) return;
    await applyGithubInbound(env.DB, connection.id, [
      env.DB.prepare("DELETE FROM forge_comments WHERE id=?").bind(existing.local_id),
      env.DB.prepare(
        "UPDATE forge_github_mappings SET remote_fingerprint='deleted',local_fingerprint=NULL WHERE connection_id=? AND kind='comment' AND local_id=?"
      ).bind(connection.id, existing.local_id),
    ]);
    return;
  }
  if (existing?.remote_fingerprint === "deleted") return;
  const current = GithubComment.parse(
    await remoteObject(credentials.token, `${githubPath(connection)}/issues/comments/${raw.id}`)
  );
  const kind: GithubResourceKind = "comment";
  const remoteFp = fingerprint([current.body]);
  if (existing && existing.remote_fingerprint === remoteFp) return;
  await assertNoConcurrentEdit(env, connection, existing);
  const parentKind = issue.pull_request ? "pull_request" : "issue";
  let parent = await githubMapping(env.DB, connection.id, parentKind, {
    remoteId: String(issue.id),
  });
  if (!parent && parentKind === "pull_request") {
    const pull = GithubPull.parse(
      await remoteObject(credentials.token, `${githubPath(connection)}/pulls/${issue.number}`)
    );
    if ((await inboundPull(env, connection, credentials, job, pull)) === "ignored")
      throw new Error("github_parent_pending");
    parent = await githubMapping(env.DB, connection.id, parentKind, { remoteId: String(issue.id) });
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
        current.body,
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
        current.body,
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
        fingerprint([current.body]),
        now
      )
    );
  }
  if (existing)
    statements.push(
      env.DB.prepare(
        "UPDATE forge_github_mappings SET remote_fingerprint=?,local_fingerprint=?,remote_updated_at=? WHERE connection_id=? AND kind='comment' AND local_id=?"
      ).bind(remoteFp, fingerprint([current.body]), now, connection.id, existing.local_id)
    );
  await applyGithubInbound(env.DB, connection.id, statements);
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
  const body =
    `${current.body ?? ""}\n\nGitHub review verdict: ${verdict}. Imported as an external comment; it does not approve this pull request.`.trim();
  const remoteFp = fingerprint([current.body, verdict, current.commit_id]);
  if (old && old.remote_fingerprint === remoteFp) return;
  await assertNoConcurrentEdit(env, connection, old);
  const now = millis(current.submitted_at);
  const statements: D1PreparedStatement[] = [];
  if (old)
    statements.push(
      env.DB.prepare(
        "UPDATE forge_reviews SET state='commented',body=?,commit_oid=?,created_at=? WHERE id=?"
      ).bind(body, current.commit_id, now, old.local_id)
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
        "commented",
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
        fingerprint(["commented", body, current.commit_id]),
        now
      )
    );
  }
  if (old)
    statements.push(
      env.DB.prepare(
        "UPDATE forge_github_mappings SET remote_fingerprint=?,local_fingerprint=?,remote_updated_at=? WHERE connection_id=? AND kind='review' AND local_id=?"
      ).bind(
        remoteFp,
        fingerprint(["commented", body, current.commit_id]),
        now,
        connection.id,
        old.local_id
      )
    );
  await applyGithubInbound(env.DB, connection.id, statements);
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
  const remoteFp = fingerprint([
    current.body,
    current.commit_id,
    current.path,
    current.side,
    current.line,
    current.in_reply_to_id,
  ]);
  if (old && old.remote_fingerprint === remoteFp) return;
  await assertNoConcurrentEdit(env, connection, old);
  const now = millis(current.updated_at);
  const line = current.line ?? current.original_line;
  if (!line) conflict("github_review_comment_line_missing");
  const review = current.pull_request_review_id
    ? await githubMapping(env.DB, connection.id, "review", {
        remoteId: String(current.pull_request_review_id),
      })
    : null;
  const statements: D1PreparedStatement[] = [];
  if (old)
    statements.push(
      env.DB.prepare("UPDATE forge_review_comments SET body=?,updated_at=? WHERE id=?").bind(
        current.body,
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
        current.commit_id,
        current.path,
        current.side,
        line,
        current.start_line ?? current.original_start_line ?? null,
        current.diff_hunk,
        current.body,
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
        fingerprint([current.body, current.commit_id, current.path, current.side, line]),
        now
      )
    );
  }
  if (old)
    statements.push(
      env.DB.prepare(
        "UPDATE forge_github_mappings SET remote_fingerprint=?,local_fingerprint=?,remote_updated_at=? WHERE connection_id=? AND kind='review_comment' AND local_id=?"
      ).bind(
        remoteFp,
        fingerprint([current.body, current.commit_id, current.path, current.side, line]),
        now,
        connection.id,
        old.local_id
      )
    );
  await applyGithubInbound(env.DB, connection.id, statements);
}

async function deleteInboundReviewComment(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  remoteId: number
): Promise<void> {
  const existing = await githubMapping(env.DB, connection.id, "review_comment", {
    remoteId: String(remoteId),
  });
  if (!existing) return;
  await applyGithubInbound(env.DB, connection.id, [
    env.DB.prepare("DELETE FROM forge_review_comments WHERE id=?").bind(existing.local_id),
    env.DB.prepare(
      "UPDATE forge_github_mappings SET remote_fingerprint='deleted',local_fingerprint=NULL WHERE connection_id=? AND kind='review_comment' AND local_id=?"
    ).bind(connection.id, existing.local_id),
  ]);
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
      if (kind === "comment")
        await githubRequest(
          credentials.token,
          `${path}/issues/comments/${mapping.remote_id}`,
          "DELETE"
        );
      else if (kind === "review_comment")
        await githubRequest(
          credentials.token,
          `${path}/pulls/comments/${mapping.remote_id}`,
          "DELETE"
        );
      else conflict("github_resource_delete_unsupported");
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
    if (mapping)
      result = await githubRequest(
        credentials.token,
        `${path}/issues/${mapping.remote_number}`,
        "PATCH",
        { title, body, state: issue.state, labels: JSON.parse(issue.labels_json) }
      );
    else {
      const existing = z
        .array(GithubIssue)
        .parse(
          await githubRequest(credentials.token, `${path}/issues?state=all&per_page=100&page=1`)
        )
        .find((candidate) => candidate.body?.includes(originMarker(connection, kind, issue.id)));
      result =
        existing ??
        (await githubRequest(credentials.token, `${path}/issues`, "POST", {
          title,
          body,
          state: issue.state,
          labels: JSON.parse(issue.labels_json),
        }));
    }
    const parsed = GithubIssue.parse(result);
    await saveMapping(
      env,
      connection,
      kind,
      issue.id,
      String(parsed.id),
      parsed.number,
      [parsed.title, parsed.body ?? "", parsed.state, parsed.labels.map((label) => label.name)],
      millis(parsed.updated_at)
    );
    return;
  }
  if (kind === "pull_request") {
    const pull = PullRowSchema.parse(row);
    const headRepositoryId = pull.head_repository_id ?? connection.repository_id;
    const headRef = `refs/heads/${pull.head_ref}`;
    const head = await env.DB.prepare(
      "SELECT new_oid AS oid FROM forge_pull_head_updates WHERE pull_request_id=? ORDER BY created_at DESC,id DESC LIMIT 1"
    )
      .bind(pull.id)
      .first<{ oid: string }>();
    const published =
      head ??
      (await env.DB.prepare(
        "SELECT oid FROM forge_ref_pushers WHERE repository_id=? AND session_id=? AND ref=?"
      )
        .bind(headRepositoryId, pull.head_session_id ?? "", headRef)
        .first<{ oid: string }>());
    if (!published) conflict("pull_head_unavailable");
    if (pull.locked_at !== null && pull.locked_head_oid !== published.oid)
      conflict("locked_pull_source_changed");
    const refs = await githubSyncRefs(env, connection, credentials, job);
    if (
      !refs.local.some((ref) => ref.ref === `refs/heads/${pull.base_ref}`) ||
      !refs.remote.some((ref) => ref.ref === `refs/heads/${pull.base_ref}`)
    )
      conflict("pull_target_branch_unavailable");
    if (pull.merged_oid) {
      if (mapping?.remote_number) {
        const remote = GithubPull.parse(
          await githubRequest(credentials.token, `${path}/pulls/${mapping.remote_number}`)
        );
        if (!remote.merged) conflict("github_merge_requires_distinct_merge");
      }
      return;
    }
    if (pull.state === "closed" && !mapping) conflict("closed_pull_without_remote_mapping");
    if (pull.state === "open") {
      const headSync = await syncGithubRef(env, connection, credentials, job, {
        ref: headRef,
        targetRef: `refs/heads/gitedge/pr/${pull.number}`,
        before: null,
        after: published.oid,
        pullRequestId: pull.id,
      });
      if (headSync.status === "stale") conflict("pull_head_changed_during_publish");
    }
    const body = outboundBody(
      connection,
      kind,
      pull.id,
      pull.body,
      pull.actor_json,
      pull.author_id
    );
    const input = {
      title: pull.title,
      body,
      head: `gitedge/pr/${pull.number}`,
      base: pull.base_ref,
      draft: pull.draft === 1,
      state: pull.state,
    };
    let result: unknown;
    if (mapping)
      result = await githubRequest(
        credentials.token,
        `${path}/pulls/${mapping.remote_number}`,
        "PATCH",
        input
      );
    else {
      const existing = z
        .array(GithubPull)
        .parse(
          await githubRequest(credentials.token, `${path}/pulls?state=all&per_page=100&page=1`)
        )
        .find(
          (candidate) =>
            candidate.head.ref === `gitedge/pr/${pull.number}` &&
            candidate.head.repo?.full_name.toLowerCase() ===
              `${connection.owner}/${connection.name}`.toLowerCase()
        );
      result = existing ?? (await githubRequest(credentials.token, `${path}/pulls`, "POST", input));
    }
    const parsed = GithubPull.parse(result);
    await saveMapping(
      env,
      connection,
      kind,
      pull.id,
      String(parsed.id),
      parsed.number,
      [
        parsed.title,
        parsed.body ?? "",
        parsed.merged ? "merged" : parsed.state,
        parsed.draft,
        parsed.base.ref,
        parsed.head.ref,
        parsed.head.sha,
        parsed.merge_commit_sha ?? null,
      ],
      millis(parsed.updated_at)
    );
    return;
  }
  if (kind === "comment") {
    const comment = CommentRowSchema.parse(row);
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
    if (mapping)
      result = await githubRequest(
        credentials.token,
        `${path}/issues/comments/${mapping.remote_id}`,
        "PATCH",
        { body }
      );
    else {
      const existing = z
        .array(GithubComment)
        .parse(
          await githubRequest(
            credentials.token,
            `${path}/issues/${parent.remote_number}/comments?per_page=100&page=1`
          )
        )
        .find((candidate) => candidate.body.includes(originMarker(connection, kind, comment.id)));
      result =
        existing ??
        (await githubRequest(
          credentials.token,
          `${path}/issues/${parent.remote_number}/comments`,
          "POST",
          { body }
        ));
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
      millis(parsed.updated_at)
    );
    return;
  }
  if (kind === "review") {
    const review = ReviewRowSchema.parse(row);
    const parent = await githubMapping(env.DB, connection.id, "pull_request", {
      localId: review.pull_request_id,
    });
    if (!parent) throw new Error("github_parent_pending");
    const remote = GithubPull.parse(
      await githubRequest(credentials.token, `${path}/pulls/${parent.remote_number}`)
    );
    const body = `Original GitEdge verdict: ${review.state}.\n\n${outboundBody(connection, kind, review.id, review.body, review.actor_json, review.author_id)}`;
    const reviewsPath = `${path}/pulls/${parent.remote_number}/reviews`;
    const existing = mapping
      ? null
      : z
          .array(GithubReview)
          .parse(await githubRequest(credentials.token, `${reviewsPath}?per_page=100&page=1`))
          .find((candidate) => candidate.body?.includes(originMarker(connection, kind, review.id)));
    const result = mapping
      ? await githubRequest(
          credentials.token,
          `${path}/pulls/${parent.remote_number}/reviews/${mapping.remote_id}`,
          "PUT",
          { body }
        )
      : (existing ??
        (await githubRequest(credentials.token, reviewsPath, "POST", {
          commit_id: remote.head.sha,
          event: "COMMENT",
          body,
        })));
    const parsed = GithubReview.parse(result);
    await saveMapping(
      env,
      connection,
      kind,
      review.id,
      String(parsed.id),
      null,
      [parsed.body, "COMMENTED", parsed.commit_id],
      millis(parsed.submitted_at)
    );
    return;
  }
  const comment = ReviewCommentRowSchema.parse(row);
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
  const input = {
    body,
    commit_id: comment.commit_oid,
    path: comment.path,
    side: comment.side,
    line: comment.line,
    start_line: comment.start_line,
    in_reply_to: replyMapping ? Number(replyMapping.remote_id) : undefined,
  };
  const commentsPath = `${path}/pulls/${parent.remote_number}/comments`;
  const existing = mapping
    ? null
    : z
        .array(GithubReviewComment)
        .parse(await githubRequest(credentials.token, commentsPath))
        .find((candidate) => candidate.body.includes(originMarker(connection, kind, comment.id)));
  const result = existing ?? (await githubRequest(credentials.token, commentsPath, "POST", input));
  const parsed = GithubReviewComment.parse(result);
  await saveMapping(
    env,
    connection,
    kind,
    comment.id,
    String(parsed.id),
    null,
    [parsed.body, parsed.commit_id, parsed.path, parsed.side, parsed.line, parsed.in_reply_to_id],
    millis(parsed.updated_at)
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
      const pull = GithubPull.parse(
        await remoteObject(credentials.token, `${githubPath(connection)}/pulls/${snapshot.number}`)
      );
      if ((await inboundPull(env, connection, credentials, job, pull)) === "ignored")
        return "ignored";
    }
    await enqueueThreadBackfill(env, connection, snapshot.kind, snapshot.number);
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
