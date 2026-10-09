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
export type AiSummaryUnavailableReason =
  "site_disabled" | "repository_disabled" | "private_consent_required";

export type AiSummaryErrorCode =
  "disabled" | "diff_unavailable" | "rate_limited" | "model_error" | "invalid_output" | "timeout";

/** The identity that authors a summary; it is not a user, agent or CI actor and can never review. */
export interface AiSummaryAuthor {
  kind: "system";
  name: typeof AI_SUMMARY_LABEL;
}

export interface AiSummary {
  id: string;
  author: AiSummaryAuthor;
  headOid: string;
  model: string;
  content: AiSummaryContent;
  /** True when the diff did not fit the prompt budget and the model saw only part of it. */
  truncated: boolean;
  generatedAt: number;
}

export interface AiSummaryJob {
  status: "queued" | "running" | "failed";
  errorCode: AiSummaryErrorCode | null;
  updatedAt: number;
}

export interface AiSummaryState {
  /** Null when the feature is on; otherwise the reason it is off. */
  unavailable: AiSummaryUnavailableReason | null;
  summary: AiSummary | null;
  job: AiSummaryJob | null;
}
