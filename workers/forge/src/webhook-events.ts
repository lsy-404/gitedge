import {
  WEBHOOK_PAYLOAD_TEXT_LIMIT,
  type RepositoryWebhookEvent,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import type { RepositoryRow } from "./common";
import type { StatementCondition } from "./notifications";

const MAX_PENDING_PER_WEBHOOK = 1_000;

export interface WebhookEvent {
  readonly event: RepositoryWebhookEvent;
  readonly action: string | null;
  readonly body: Record<string, unknown>;
}

export function clipText(value: string): string {
  return value.length > WEBHOOK_PAYLOAD_TEXT_LIMIT
    ? value.slice(0, WEBHOOK_PAYLOAD_TEXT_LIMIT)
    : value;
}

export function repositoryPayload(repository: RepositoryRow): Record<string, unknown> {
  return {
    id: repository.id,
    name: repository.slug,
    full_name: `${repository.owner}/${repository.slug}`,
    private: repository.visibility === "private",
    owner: { login: repository.owner },
    default_branch: repository.default_branch ?? "main",
  };
}

function senderPayload(user: Pick<TrustedUser, "id" | "identifier">): Record<string, unknown> {
  return { id: user.id, login: user.identifier };
}

function envelope(
  repository: RepositoryRow,
  user: Pick<TrustedUser, "id" | "identifier">,
  action: string | null,
  fields: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(action ? { action } : {}),
    ...fields,
    repository: repositoryPayload(repository),
    sender: senderPayload(user),
  };
}

export interface ConversationFields {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly author: string;
}

export function issueWebhook(
  repository: RepositoryRow,
  user: TrustedUser,
  action: "opened" | "edited" | "closed" | "reopened",
  issue: ConversationFields
): WebhookEvent {
  return {
    event: "issues",
    action,
    body: envelope(repository, user, action, {
      issue: {
        number: issue.number,
        title: clipText(issue.title),
        body: clipText(issue.body),
        state: issue.state,
        user: { login: issue.author },
      },
    }),
  };
}

export interface PullRequestFields extends ConversationFields {
  readonly baseRef: string;
  readonly headRef: string;
  readonly draft: boolean;
  readonly merged: boolean;
  readonly mergedOid: string | null;
}

function pullRequestFields(pull: PullRequestFields): Record<string, unknown> {
  return {
    number: pull.number,
    title: clipText(pull.title),
    body: clipText(pull.body),
    state: pull.state === "open" ? "open" : "closed",
    draft: pull.draft,
    merged: pull.merged,
    merge_commit_sha: pull.mergedOid,
    user: { login: pull.author },
    base: { ref: pull.baseRef },
    head: { ref: pull.headRef },
  };
}

export function pullRequestWebhook(
  repository: RepositoryRow,
  user: TrustedUser,
  action: "opened" | "edited" | "closed" | "reopened",
  pull: PullRequestFields
): WebhookEvent {
  return {
    event: "pull_request",
    action,
    body: envelope(repository, user, action, {
      number: pull.number,
      pull_request: pullRequestFields(pull),
    }),
  };
}

export function commentWebhook(
  repository: RepositoryRow,
  user: TrustedUser,
  action: "created" | "edited" | "deleted",
  thread: {
    readonly kind: "issue" | "pull_request";
    readonly number: number;
    readonly title: string;
  },
  comment: { readonly id: string; readonly body: string }
): WebhookEvent {
  return {
    event: "issue_comment",
    action,
    body: envelope(repository, user, action, {
      [thread.kind === "issue" ? "issue" : "pull_request"]: {
        number: thread.number,
        title: clipText(thread.title),
      },
      comment: { id: comment.id, body: clipText(comment.body), user: { login: user.identifier } },
    }),
  };
}

export function reviewWebhook(
  repository: RepositoryRow,
  user: TrustedUser,
  pull: { readonly number: number; readonly title: string },
  review: {
    readonly id: string;
    readonly state: string;
    readonly body: string;
    readonly commitOid: string;
  }
): WebhookEvent {
  return {
    event: "pull_request_review",
    action: "submitted",
    body: envelope(repository, user, "submitted", {
      pull_request: { number: pull.number, title: clipText(pull.title) },
      review: {
        id: review.id,
        state: review.state,
        body: clipText(review.body),
        commit_id: review.commitOid,
        user: { login: user.identifier },
      },
    }),
  };
}

export function checkRunWebhook(
  repository: RepositoryRow,
  user: Pick<TrustedUser, "id" | "identifier">,
  check: {
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly commitOid: string;
    readonly summary: string;
    readonly pullRequestNumber: number;
  }
): WebhookEvent {
  const action = check.status === "completed" ? "completed" : "created";
  return {
    event: "check_run",
    action,
    body: envelope(repository, user, action, {
      check_run: {
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        head_sha: check.commitOid,
        output: { summary: clipText(check.summary) },
        pull_requests: [{ number: check.pullRequestNumber }],
      },
    }),
  };
}

export function pushWebhook(
  repository: RepositoryRow,
  user: Pick<TrustedUser, "id" | "identifier">,
  update: { readonly ref: string; readonly before: string; readonly after: string }
): WebhookEvent {
  const zero = "0".repeat(40);
  return {
    event: "push",
    action: null,
    body: envelope(repository, user, null, {
      ref: update.ref,
      before: update.before,
      after: update.after,
      created: update.before === zero,
      deleted: update.after === zero,
      pusher: { name: user.identifier },
    }),
  };
}

/** Queues one pending delivery per active webhook subscribed to the event, in the caller's batch. */
export function queueWebhookEvent(
  db: D1Database,
  repositoryId: string,
  webhookEvent: WebhookEvent,
  when?: StatementCondition
): D1PreparedStatement {
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO forge_webhook_deliveries (id, webhook_id, repository_id, event, action, payload, status, attempt_count, next_attempt_at, created_at) SELECT lower(hex(randomblob(16))), w.id, w.repository_id, ?, ?, ?, 'pending', 0, ?, ? FROM forge_webhooks w WHERE w.repository_id = ? AND w.active = 1 AND EXISTS (SELECT 1 FROM json_each(w.events_json) j WHERE j.value = ?) AND (SELECT COUNT(*) FROM forge_webhook_deliveries x WHERE x.webhook_id = w.id AND x.status IN ('pending', 'processing')) < ${MAX_PENDING_PER_WEBHOOK}${when ? ` AND (${when.sql})` : ""}`
    )
    .bind(
      webhookEvent.event,
      webhookEvent.action,
      JSON.stringify(webhookEvent.body),
      now,
      now,
      repositoryId,
      webhookEvent.event,
      ...(when?.binds ?? [])
    );
}
