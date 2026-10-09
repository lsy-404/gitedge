import { z } from "zod";

export const AiSummaryStateSchema = z.object({
  data: z.object({
    unavailable: z.string().nullable(),
    summary: z
      .object({
        id: z.string(),
        author: z.object({ kind: z.literal("system"), name: z.string() }),
        headOid: z.string(),
        model: z.string(),
        truncated: z.boolean(),
        generatedAt: z.number(),
        content: z.object({
          overview: z.string(),
          notableChanges: z.array(z.string()),
          riskAreas: z.array(z.string()),
          reviewerFocus: z.array(z.string()),
        }),
      })
      .nullable(),
    job: z
      .object({ status: z.string(), errorCode: z.string().nullable(), updatedAt: z.number() })
      .nullable(),
  }),
});
