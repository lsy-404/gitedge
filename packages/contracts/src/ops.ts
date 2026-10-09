import { z } from "zod";

export const ServiceHealthSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
});

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  services: z.record(z.string(), ServiceHealthSchema),
});

export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const QuotaResourceSchema = z.enum(["repositories", "storage"]);

/** Carried in `error.quota` of a 403 `quota_exceeded` response. */
export const QuotaDetailSchema = z.object({
  resource: QuotaResourceSchema,
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

export type QuotaDetail = z.infer<typeof QuotaDetailSchema>;

export const UsageSchema = z.object({
  groupKey: z.string(),
  repositories: z.object({
    used: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  }),
  // Artifacts does not report repository size, so usage is null until it does.
  storage: z.object({
    usedBytes: z.number().int().nonnegative().nullable(),
    limitBytes: z.number().int().positive(),
  }),
  maxPushBytes: z.number().int().positive(),
  maxRepositoryBytes: z.number().int().positive(),
  rpm: z.number().int().positive(),
});

export type Usage = z.infer<typeof UsageSchema>;
