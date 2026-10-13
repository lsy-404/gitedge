import { z } from "zod";

export const RepositoryWebhookEvents = [
  "push",
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "check_run",
  "release",
] as const;
export const RepositoryWebhookEventSchema = z.enum(RepositoryWebhookEvents);
export type RepositoryWebhookEvent = z.infer<typeof RepositoryWebhookEventSchema>;

export const REPOSITORY_WEBHOOK_LIMIT = 20;
export const WEBHOOK_PAYLOAD_TEXT_LIMIT = 8_192;
export const WEBHOOK_PUSH_REFS_LIMIT = 20;

const events = z
  .array(RepositoryWebhookEventSchema)
  .min(1)
  .max(RepositoryWebhookEvents.length)
  .refine((value) => new Set(value).size === value.length);

export const CreateRepositoryWebhookInputSchema = z
  .object({
    url: z.string().trim().url().max(2048),
    contentType: z.literal("json").default("json"),
    secret: z.string().min(16).max(128).optional(),
    events,
    active: z.boolean().default(true),
  })
  .strict();
export type CreateRepositoryWebhookInput = z.infer<typeof CreateRepositoryWebhookInputSchema>;

export const UpdateRepositoryWebhookInputSchema = z
  .object({
    url: z.string().trim().url().max(2048),
    secret: z.string().min(16).max(128),
    rotateSecret: z.boolean(),
    events,
    active: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export type UpdateRepositoryWebhookInput = z.infer<typeof UpdateRepositoryWebhookInputSchema>;

export interface RepositoryWebhook {
  id: string;
  url: string;
  contentType: "json";
  events: RepositoryWebhookEvent[];
  active: boolean;
  createdAt: number;
  updatedAt: number;
}
/** `secret` is the plaintext of a generated secret, shown once; null when the caller supplied it or it is unchanged. */
export interface SavedRepositoryWebhook extends RepositoryWebhook {
  secret: string | null;
}

export type WebhookDeliveryStatus = "pending" | "success" | "failed";
export interface RepositoryWebhookDelivery {
  id: string;
  event: RepositoryWebhookEvent | "ping";
  action: string | null;
  status: WebhookDeliveryStatus;
  responseStatus: number | null;
  errorCode: string | null;
  attemptCount: number;
  nextAttemptAt: number | null;
  redeliveryOf: string | null;
  createdAt: number;
  deliveredAt: number | null;
}
export interface RepositoryWebhookDeliveryDetail extends RepositoryWebhookDelivery {
  payload: unknown;
}

export const PushEventInputSchema = z.object({
  eventId: z.uuid(),
  occurredAt: z.number().int().nonnegative(),
  repositoryId: z.string().min(1),
  pusherId: z.string().min(1),
  externalPusher: z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(100) }).optional(),
  /** Set when the refs live in an agent session fork rather than in the repository itself. */
  agentSessionId: z.string().min(1).optional(),
  updates: z
    .array(
      z.object({
        ref: z.string().min(1).max(512),
        before: z.string().regex(/^[0-9a-f]{40}$/),
        after: z.string().regex(/^[0-9a-f]{40}$/),
      })
    )
    .min(1)
    .max(128),
});
export type PushEventInput = z.infer<typeof PushEventInputSchema>;

export const PushEventRefHeadInputSchema = z.object({
  repositoryId: z.string().min(1),
  pusherId: z.string().min(1),
  agentSessionId: z.string().min(1).optional(),
  updates: z
    .array(
      z.object({
        ref: z.string().min(1).max(512),
        after: z.string().regex(/^[0-9a-f]{40}$/),
      })
    )
    .min(1)
    .max(WEBHOOK_PUSH_REFS_LIMIT),
});
export type PushEventRefHeadInput = z.infer<typeof PushEventRefHeadInputSchema>;

export const PushEventRefHeadsSchema = z.object({
  heads: z
    .array(
      z.object({
        ref: z.string(),
        oid: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .nullable(),
      })
    )
    .max(WEBHOOK_PUSH_REFS_LIMIT),
});
export type PushEventRefHeads = z.infer<typeof PushEventRefHeadsSchema>;
