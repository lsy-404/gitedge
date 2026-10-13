import { z } from "zod";

export const DashboardAttentionKindSchema = z.enum([
  "review_requested",
  "changes_requested",
  "failed_check",
  "blocked_task",
  "expiring_session",
]);
export type DashboardAttentionKind = z.infer<typeof DashboardAttentionKindSchema>;

export const DashboardAttentionItemSchema = z.object({
  id: z.string(),
  kind: DashboardAttentionKindSchema,
  title: z.string(),
  detail: z.string(),
  owner: z.string(),
  repository: z.string(),
  number: z.number().nullable(),
  updatedAt: z.number(),
  url: z.string(),
});
export type DashboardAttentionItem = z.infer<typeof DashboardAttentionItemSchema>;

export const DashboardAttentionPageSchema = z.object({
  items: z.array(DashboardAttentionItemSchema),
  counts: z.record(DashboardAttentionKindSchema, z.number()),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
});
export type DashboardAttentionPage = z.infer<typeof DashboardAttentionPageSchema>;
