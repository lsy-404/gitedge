import { z } from "zod";

export const AgentHandleSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
export const AgentWebhookEventSchema = z.enum([
  "agent.assigned",
  "agent.mentioned",
  "pull_request.updated",
  "review.requested",
  "review.submitted",
  "check.completed",
  "comment.created",
]);
export type AgentWebhookEvent = z.infer<typeof AgentWebhookEventSchema>;
export const AgentDeliveryModeSchema = z.enum(["webhook", "pull", "both"]);
export type AgentDeliveryMode = z.infer<typeof AgentDeliveryModeSchema>;

export const AgentEventSchema = z
  .object({
    id: z.string(),
    event: AgentWebhookEventSchema,
    createdAt: z.number(),
    data: z.record(z.string(), z.unknown()),
  })
  .describe("Event envelope shared by signed webhook bodies and pull-feed items.");
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** Event data as delivered: the producer's fields plus the scoping identifiers. */
export function agentEventData(
  data: Record<string, unknown>,
  repositoryId: string,
  agentId: string
): Record<string, unknown> {
  return { ...data, repositoryId, agentId };
}
export const RevokeAgentSessionsInputSchema = z.union([
  z.object({ repositoryId: z.string().min(1), userId: z.string().min(1).optional() }),
  z.object({ namespaceId: z.string().min(1), userId: z.string().min(1) }),
]);
export type RevokeAgentSessionsInput = z.infer<typeof RevokeAgentSessionsInputSchema>;
export const AgentSchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  handle: AgentHandleSchema,
  profilePath: z.string().min(1),
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  profilePublic: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  disabledAt: z.number().nullable(),
  deliveryMode: AgentDeliveryModeSchema,
});
export type Agent = z.infer<typeof AgentSchema>;

export const AgentProfileSchema = z.object({
  owner: z.string(),
  handle: AgentHandleSchema,
  name: z.string(),
  description: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const CreateAgentInputSchema = z.object({
  handle: AgentHandleSchema.optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
});
export const UpdateAgentInputSchema = z
  .object({
    handle: AgentHandleSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    profilePublic: z.boolean().optional(),
    deliveryMode: AgentDeliveryModeSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const AgentWebhookSettingsSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(AgentWebhookEventSchema).min(1).max(AgentWebhookEventSchema.options.length),
  enabled: z.boolean(),
});
export type AgentWebhookSettings = z.infer<typeof AgentWebhookSettingsSchema>;
export interface AgentWebhookDelivery {
  id: string;
  event: AgentWebhookEvent;
  status: "success" | "failed";
  responseStatus: number | null;
  errorCode: string | null;
  attemptCount: number;
  createdAt: number;
  deliveredAt: number | null;
}
