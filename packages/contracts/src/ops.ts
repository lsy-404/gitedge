import { z } from "zod";
import { QuotaLimitSchema } from "./deployment-settings";

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

export const QuotaResourceSchema = z.enum([
  "repositories",
  "public_repositories",
  "private_repositories",
  "storage",
]);

/** Carried in `error.quota` of a 403 `quota_exceeded` response. */
export const QuotaDetailSchema = z.object({
  resource: QuotaResourceSchema,
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
});

export type QuotaDetail = z.infer<typeof QuotaDetailSchema>;

const RepositoryUsageSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: QuotaLimitSchema,
});
const StorageUsageSchema = z.object({
  usedBytes: z.number().int().nonnegative().nullable(),
  limitBytes: QuotaLimitSchema,
});

export const UsageSchema = z.object({
  groupKey: z.string(),
  repositories: RepositoryUsageSchema,
  publicRepositories: RepositoryUsageSchema,
  privateRepositories: RepositoryUsageSchema,
  // Artifacts does not report repository size, so usage is null until it does.
  storage: StorageUsageSchema,
  publicStorage: StorageUsageSchema,
  privateStorage: StorageUsageSchema,
  builtinRunner: z.object({
    enabled: z.boolean(),
    runsPerRepositoryPerHour: QuotaLimitSchema,
  }),
  maxPushBytes: QuotaLimitSchema,
  maxRepositoryBytes: QuotaLimitSchema,
  rpm: QuotaLimitSchema,
});

export type Usage = z.infer<typeof UsageSchema>;
