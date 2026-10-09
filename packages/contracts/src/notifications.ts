import { z } from "zod";

export const NotificationReasons = [
  "assigned",
  "review_requested",
  "mentioned",
  "comment",
  "check_failed",
  "merged",
  "invited",
  "watching",
  "auto_merge_disabled",
  "queue_ejected",
] as const;
export const NotificationReasonSchema = z.enum(NotificationReasons);
export type NotificationReason = z.infer<typeof NotificationReasonSchema>;

export const NotificationSubjectKinds = [
  "issue",
  "pull_request",
  "discussion",
  "repository",
] as const;
export const NotificationSubjectKindSchema = z.enum(NotificationSubjectKinds);
export type NotificationSubjectKind = z.infer<typeof NotificationSubjectKindSchema>;

export const NOTIFICATION_PAGE_SIZE = 25;
export const NOTIFICATION_MAX_PAGE_SIZE = 50;
export const NOTIFICATION_MARK_LIMIT = 100;
export const NOTIFICATION_UNREAD_COUNT_CAP = 100;
export const NOTIFICATION_RETENTION_MS = 90 * 86_400_000;

export const ListNotificationsQuerySchema = z.object({
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  repositoryId: z.string().min(1).max(64).optional(),
  reason: NotificationReasonSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(NOTIFICATION_MAX_PAGE_SIZE)
    .default(NOTIFICATION_PAGE_SIZE),
  before: z
    .string()
    .regex(/^\d{1,16}:[A-Za-z0-9-]{1,64}$/)
    .optional(),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuerySchema>;

export const MarkNotificationsReadInputSchema = z.union([
  z
    .object({
      ids: z.array(z.string().min(1).max(64)).min(1).max(NOTIFICATION_MARK_LIMIT),
    })
    .strict(),
  z.object({ all: z.literal(true), repositoryId: z.string().min(1).max(64).optional() }).strict(),
]);
export type MarkNotificationsReadInput = z.infer<typeof MarkNotificationsReadInputSchema>;

export const NotificationPreferencesSchema = z
  .object({
    mutedReasons: z
      .array(NotificationReasonSchema)
      .max(NotificationReasons.length)
      .refine((reasons) => new Set(reasons).size === reasons.length),
  })
  .strict();
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export interface Notification {
  id: string;
  reason: NotificationReason;
  subjectKind: NotificationSubjectKind;
  subjectNumber: number | null;
  title: string | null;
  repository: { id: string; owner: string; name: string };
  actor: string | null;
  createdAt: number;
  readAt: number | null;
}
export interface NotificationPage {
  items: Notification[];
  nextCursor: string | null;
}
export interface NotificationUnreadCount {
  unread: number;
  capped: boolean;
}
