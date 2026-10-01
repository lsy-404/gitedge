import { z } from "zod";
import type { AgentSessionIdentity } from "./forge";
export * from "./forge";

export const ErrorCodeSchema = z.enum([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "method_not_allowed",
  "internal_error",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export type ServiceError = {
  readonly error: { readonly code: ErrorCode; readonly message: string };
};

export type ServiceResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly error: ServiceError["error"] };

export type TrustedUser = {
  readonly id: string;
  readonly identifier: string;
  readonly groupKey: string;
  readonly agentSession?: AgentSessionIdentity;
};

export type UserGroupLimits = {
  readonly rpm: number;
  readonly maxRepositories: number;
  readonly maxPushBytes: number;
  readonly maxRepositoryBytes: number;
  readonly maxStorageBytes: number;
};

export const DEFAULT_USER_GROUP_LIMITS: Readonly<Record<string, UserGroupLimits>> = {
  free: {
    rpm: 120,
    maxRepositories: 10,
    maxPushBytes: 268_435_456,
    maxRepositoryBytes: 1_073_741_824,
    maxStorageBytes: 5_368_709_120,
  },
  team: {
    rpm: 600,
    maxRepositories: 100,
    maxPushBytes: 1_073_741_824,
    maxRepositoryBytes: 10_737_418_240,
    maxStorageBytes: 107_374_182_400,
  },
  admin: {
    rpm: 1200,
    maxRepositories: 1_000,
    maxPushBytes: 5_368_709_120,
    maxRepositoryBytes: 107_374_182_400,
    maxStorageBytes: 1_099_511_627_776,
  },
};

export function parseUserGroupLimits(value: string | undefined): Record<string, UserGroupLimits> {
  if (!value) return { ...DEFAULT_USER_GROUP_LIMITS };
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_USER_GROUP_LIMITS };
    }
    const result: Record<string, UserGroupLimits> = { ...DEFAULT_USER_GROUP_LIMITS };
    for (const [groupKey, raw] of Object.entries(parsed)) {
      if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
        result[groupKey] = { ...result.free, rpm: raw };
        continue;
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const base = result[groupKey] ?? result.free;
      const candidate = { ...base };
      for (const field of [
        "rpm",
        "maxRepositories",
        "maxPushBytes",
        "maxRepositoryBytes",
        "maxStorageBytes",
      ] as const) {
        const next = raw[field];
        if (typeof next === "number" && Number.isSafeInteger(next) && next > 0)
          candidate[field] = next;
      }
      result[groupKey] = candidate;
    }
    return result;
  } catch {
    return { ...DEFAULT_USER_GROUP_LIMITS };
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfter: number;
}

export interface RateLimitStub {
  consume(key: string, limit: number, now?: number): Promise<RateLimitDecision>;
}

export interface RateLimitNamespace {
  getByName(name: string): RateLimitStub;
}

const RATE_LIMIT_SHARD_COUNT = 32;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function consumeRateLimit(
  namespace: RateLimitNamespace,
  key: string,
  limit: number
): Promise<RateLimitDecision> {
  const digest = await sha256Hex(key);
  const shard = Number.parseInt(digest.slice(0, 2), 16) % RATE_LIMIT_SHARD_COUNT;
  return namespace.getByName(`rate-limit-${shard}`).consume(digest, limit);
}

export const RepositoryRouteCacheRecordSchema = z.object({
  repositoryId: z.string(),
  namespaceId: z.string(),
  doName: z.string(),
  updatedAt: z.number(),
});

export type RepositoryRouteCacheRecord = z.infer<typeof RepositoryRouteCacheRecordSchema>;

export function repositoryRouteCacheKey(namespaceSlug: string, repositorySlug: string): string {
  return `repo-route:v1:${namespaceSlug}/${repositorySlug}`;
}

export const RegisterInputSchema = z.object({
  identifier: z.string().trim().min(3).max(64),
  password: z.string().min(12).max(256),
});

export const LoginInputSchema = RegisterInputSchema;

export const NamespaceSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const CreateOrganizationInputSchema = z.object({
  slug: NamespaceSlugSchema,
  displayName: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
});

export const AddOrganizationMemberInputSchema = z.object({
  identifier: z.string().trim().min(3).max(64),
  role: z.enum(["owner", "member"]).default("member"),
});

export const CreateRepositoryInputSchema = z.object({
  owner: NamespaceSlugSchema,
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  visibility: z.enum(["public", "private"]),
  description: z.string().trim().max(500).default(""),
});

export const CreateIssueInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(50_000).default(""),
  labels: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  assignees: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
});

export const UpdateIssueInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(50_000).optional(),
    state: z.enum(["open", "closed"]).optional(),
    labels: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    assignees: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

export const CreatePullRequestInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(50_000).default(""),
  baseRef: z.string().trim().min(1).max(255),
  headRef: z.string().trim().min(1).max(255),
  headSessionId: z.string().nullable().default(null),
  draft: z.boolean().default(false),
});

export const UpdatePullRequestInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(50_000).optional(),
    state: z.enum(["open", "closed"]).optional(),
    draft: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

export const PutWikiPageInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().max(100_000),
  expectedRevision: z.number().int().nonnegative().optional(),
});
