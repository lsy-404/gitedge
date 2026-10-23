import { z } from "zod";

export const QuotaLimitSchema = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);

export const UserGroupLimitsSchema = z
  .object({
    rpm: QuotaLimitSchema,
    maxRepositories: QuotaLimitSchema,
    maxPublicRepositories: QuotaLimitSchema,
    maxPrivateRepositories: QuotaLimitSchema,
    maxPushBytes: QuotaLimitSchema,
    maxRepositoryBytes: QuotaLimitSchema,
    maxStorageBytes: QuotaLimitSchema,
    maxPublicStorageBytes: QuotaLimitSchema,
    maxPrivateStorageBytes: QuotaLimitSchema,
    builtinRunnerEnabled: z.boolean(),
    maxBuiltinRunnerRunsPerHour: QuotaLimitSchema,
  })
  .strict();
export type UserGroupLimits = z.infer<typeof UserGroupLimitsSchema>;

export const DEFAULT_USER_GROUP_LIMITS: Readonly<Record<string, UserGroupLimits>> = {
  free: {
    rpm: 120,
    maxRepositories: 1_000,
    maxPublicRepositories: 1_000,
    maxPrivateRepositories: 1_000,
    maxPushBytes: 268_435_456,
    maxRepositoryBytes: 1_073_741_824,
    maxStorageBytes: 1_099_511_627_776,
    maxPublicStorageBytes: 1_099_511_627_776,
    maxPrivateStorageBytes: 1_099_511_627_776,
    builtinRunnerEnabled: true,
    maxBuiltinRunnerRunsPerHour: 60,
  },
  team: {
    rpm: 600,
    maxRepositories: 10_000,
    maxPublicRepositories: 10_000,
    maxPrivateRepositories: 10_000,
    maxPushBytes: 268_435_456,
    maxRepositoryBytes: 1_073_741_824,
    maxStorageBytes: 1_099_511_627_776,
    maxPublicStorageBytes: 1_099_511_627_776,
    maxPrivateStorageBytes: 1_099_511_627_776,
    builtinRunnerEnabled: true,
    maxBuiltinRunnerRunsPerHour: 120,
  },
  admin: {
    rpm: 1200,
    maxRepositories: -1,
    maxPublicRepositories: -1,
    maxPrivateRepositories: -1,
    maxPushBytes: -1,
    maxRepositoryBytes: -1,
    maxStorageBytes: -1,
    maxPublicStorageBytes: -1,
    maxPrivateStorageBytes: -1,
    builtinRunnerEnabled: true,
    maxBuiltinRunnerRunsPerHour: -1,
  },
};

const groupKey = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const UserGroupOverridesSchema = z.record(groupKey, UserGroupLimitsSchema.partial());

export function resolveUserGroupLimits(
  overrides: z.infer<typeof UserGroupOverridesSchema>
): Record<string, UserGroupLimits> {
  const result = { ...DEFAULT_USER_GROUP_LIMITS };
  for (const [key, limits] of Object.entries(overrides))
    result[key] = {
      ...(Object.hasOwn(DEFAULT_USER_GROUP_LIMITS, key)
        ? DEFAULT_USER_GROUP_LIMITS[key]
        : { ...DEFAULT_USER_GROUP_LIMITS.free, ...overrides.free }),
      ...limits,
    };
  return result;
}

export function parseUserGroupLimits(value: string | undefined): Record<string, UserGroupLimits> {
  if (!value) return resolveUserGroupLimits({});
  return resolveUserGroupLimits(UserGroupOverridesSchema.parse(JSON.parse(value)));
}

export const DeploymentSettingsSchema = z
  .object({
    allowPublicSignup: z.boolean().default(true),
    defaultUserGroup: groupKey.default("free"),
    siteAdmins: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/i)).default([]),
    ipRpmLimit: z.number().int().min(1).max(100_000).default(300),
    privateRepositoryResponse: z.enum(["not_found", "forbidden"]).default("not_found"),
    userGroups: UserGroupOverridesSchema.default({}),
  })
  .strict()
  .refine(
    (settings) =>
      Object.hasOwn(resolveUserGroupLimits(settings.userGroups), settings.defaultUserGroup),
    { path: ["defaultUserGroup"], message: "must name a configured user group" }
  );
