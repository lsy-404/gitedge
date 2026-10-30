import { z } from "zod";

export const GitOAuthRequestSchema = z
  .object({
    client_id: z.literal("gitedge-gcm"),
    redirect_uri: z.string().max(512),
    response_type: z.literal("code"),
    scope: z.string().max(128),
    state: z.string().min(1).max(512),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal("S256"),
  })
  .strict();
export const GitOAuthConsentSchema = GitOAuthRequestSchema.extend({ approve: z.boolean() });
