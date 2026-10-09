import { z } from "zod";
import { AgentEventSchema, type AgentDeliveryMode } from "./agents";

export const AGENT_FEED_RETENTION_MS = 7 * 86_400_000;
export const AGENT_FEED_MAX_EVENTS = 500;
export const AGENT_FEED_MAX_WAIT_SECONDS = 25;
export const AGENT_FEED_DEFAULT_PAGE = 50;
export const AGENT_FEED_MAX_PAGE = 100;

const cursor = z.coerce.number().int().nonnegative().safe();

/** Query of the poll endpoint; `wait` is the long-poll bound in seconds. */
export const AgentFeedQuerySchema = z.object({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(AGENT_FEED_MAX_PAGE).default(AGENT_FEED_DEFAULT_PAGE),
  wait: z.coerce.number().int().min(0).max(AGENT_FEED_MAX_WAIT_SECONDS).default(0),
});
export type AgentFeedQuery = z.infer<typeof AgentFeedQuerySchema>;

export const AgentFeedEventSchema = AgentEventSchema.extend({
  cursor: z
    .number()
    .describe("Monotonic position in the feed; pass the page cursor back to continue after it."),
});
export type AgentFeedEvent = z.infer<typeof AgentFeedEventSchema>;

export const AgentFeedPageSchema = z.object({
  events: z.array(AgentFeedEventSchema),
  cursor: z
    .number()
    .describe(
      "Cursor to send with the next request. Equals the request cursor when nothing is new."
    ),
  more: z.boolean().describe("True when more events are already available beyond this page."),
});
export type AgentFeedPage = z.infer<typeof AgentFeedPageSchema>;

/** Details of the `cursor_expired` error: events after the cursor were pruned. */
export interface AgentFeedExpiry {
  /** Oldest cursor that is still valid; resume from it after re-reading state. */
  oldestCursor: number;
}

export interface AgentFeedStatus {
  deliveryMode: AgentDeliveryMode;
  lastPolledAt: number | null;
  latestCursor: number | null;
  retained: number;
  retentionDays: number;
  maxEvents: number;
}
