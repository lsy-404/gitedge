export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGE_SIZE = 100;

export const AuditActions = [
  "repository.visibility_changed",
  "repository.renamed",
  "repository.archived",
  "repository.unarchived",
  "repository.ai_summaries_changed",
  "repository.deleted",
  "repository.restored",
  "repository.purge_requested",
  "repository.transferred",
  "repository.transfer_received",
  "branch_rule.created",
  "branch_rule.updated",
  "branch_rule.deleted",
  "collaborator.role_changed",
  "collaborator.removed",
  "member.role_changed",
  "member.removed",
  "invitation.created",
  "invitation.accepted",
  "invitation.declined",
  "invitation.cancelled",
  "pull_request.merged",
  "pull_request.auto_merge_enabled",
  "pull_request.auto_merge_disabled",
  "pull_request.queued",
  "pull_request.dequeued",
  "webhook.updated",
  "repository_webhook.created",
  "repository_webhook.deleted",
  "release.published",
  "pages.updated",
  "access_token.created",
  "access_token.revoked",
  "two_factor.totp_enabled",
  "two_factor.totp_disabled",
  "two_factor.passkey_added",
  "two_factor.passkey_removed",
  "two_factor.recovery_codes_regenerated",
  "account.password_changed",
  "account.exported",
  "account.deleted",
  "admin.user_disabled",
  "admin.user_enabled",
  "admin.user_group_changed",
  "admin.user_site_admin_changed",
] as const;
export type AuditAction = (typeof AuditActions)[number];

export type AuditActorKind = "user" | "agent" | "token" | "system";
export type AuditMetadataValue =
  string | number | boolean | null | readonly (string | number | boolean)[];
export type AuditMetadata = Readonly<Record<string, AuditMetadataValue>>;

export interface AuditEvent {
  id: string;
  createdAt: number;
  action: string;
  actor: {
    kind: AuditActorKind;
    id: string | null;
    name: string;
    /** Personal access token id or agent session id behind the action. */
    ref: string | null;
  };
  target: { type: string; id: string | null; label: string | null };
  repositoryId: string | null;
  metadata: AuditMetadata;
}

export interface AuditPage {
  events: AuditEvent[];
  /** Pass as `cursor` to read the next older page; null at the end of the log. */
  nextCursor: string | null;
}
