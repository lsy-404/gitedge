import { z } from "zod";

export const AI_SUMMARY_DEFAULT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const AI_SUMMARY_DEFAULT_HOURLY_LIMIT = 20;
export const AI_SUMMARY_PROMPT_CHARS = 48_000;
export const AI_SUMMARY_TIMEOUT_MS = 45_000;
export const AI_SUMMARY_LABEL = "AI summary";

const line = z.string().trim().min(1).max(400);

/** Structured model output; every field is plain text. */
export const AiSummaryContentSchema = z.object({
  overview: z.string().trim().min(1).max(1500),
  notableChanges: z.array(line).max(8),
  riskAreas: z.array(line).max(6),
  reviewerFocus: z.array(line).max(6),
});
export type AiSummaryContent = z.infer<typeof AiSummaryContentSchema>;

/** Why a summary is not offered for a repository. */
export const AiSummaryUnavailableReasonSchema = z.enum([
  "site_disabled",
  "repository_disabled",
  "private_consent_required",
]);
export type AiSummaryUnavailableReason = z.infer<typeof AiSummaryUnavailableReasonSchema>;

export const AiSummaryErrorCodeSchema = z.enum([
  "disabled",
  "diff_unavailable",
  "rate_limited",
  "model_error",
  "invalid_output",
  "timeout",
]);
export type AiSummaryErrorCode = z.infer<typeof AiSummaryErrorCodeSchema>;

export const AiSummaryAuthorSchema = z
  .object({ kind: z.literal("system"), name: z.literal(AI_SUMMARY_LABEL) })
  .describe(
    "The identity that authors a summary; it is not a user, agent or CI actor and can never review."
  );
export type AiSummaryAuthor = z.infer<typeof AiSummaryAuthorSchema>;

export const AiSummarySchema = z.object({
  id: z.string(),
  author: AiSummaryAuthorSchema,
  headOid: z.string(),
  model: z.string(),
  content: AiSummaryContentSchema,
  truncated: z
    .boolean()
    .describe(
      "True when the diff did not fit the prompt budget and the model saw only part of it."
    ),
  generatedAt: z.number(),
});
export type AiSummary = z.infer<typeof AiSummarySchema>;

export const AiSummaryJobSchema = z.object({
  status: z.enum(["queued", "running", "failed"]),
  errorCode: AiSummaryErrorCodeSchema.nullable(),
  updatedAt: z.number(),
});
export type AiSummaryJob = z.infer<typeof AiSummaryJobSchema>;

export const AiSummaryStateSchema = z.object({
  unavailable: AiSummaryUnavailableReasonSchema.nullable().describe(
    "Null when the feature is on; otherwise the reason it is off."
  ),
  summary: AiSummarySchema.nullable(),
  job: AiSummaryJobSchema.nullable(),
});
export type AiSummaryState = z.infer<typeof AiSummaryStateSchema>;
