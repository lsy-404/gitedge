import { z } from "zod";
import { AccessTokenIdentitySchema } from "./access-tokens";
import { ActionJobIdentitySchema } from "./runners";
import { NamespaceSlugSchema } from "./account";
import { AgentSessionIdentitySchema, GitBranchSchema } from "./forge";
import { RepositorySlugSchema } from "./repository-controls";
import { ConfirmationInputSchema } from "./lifecycle";
export * from "./repository-controls";
export * from "./forge";
export * from "./account-runner";
export * from "./review-comments";
export * from "./references";
export * from "./agents";
export * from "./agent-events";
export * from "./access-tokens";
export * from "./tasks";
export * from "./trust";
export * from "./account";
export * from "./actions";
export * from "./runners";
export * from "./browser-accounts";
export * from "./ops";
export * from "./lifecycle";
export * from "./imports";
export * from "./import-url";
export * from "./security";
export * from "./audit";
export * from "./invitations";
export * from "./admin";
export * from "./mentions";
export * from "./notifications";
export * from "./webhooks";
export * from "./text-lines";
export * from "./releases";
export * from "./social";
export * from "./auto-merge";
export * from "./merge-requirements";
export * from "./ai-summary";
export * from "./pages";
export * from "./dashboard";
export * from "./github-sync";
export * from "./ip-access";

export const ErrorCodeSchema = z.enum([
  "bad_request",
  "unauthorized",
  "forbidden",
  "account_disabled",
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

/** Identity Auth resolves for a browser session, personal access token or agent session. */
export const TrustedUserSchema = z
  .object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    groupKey: z.string().min(1),
    agentSession: AgentSessionIdentitySchema.optional(),
    token: AccessTokenIdentitySchema.optional(),
    job: ActionJobIdentitySchema.optional(),
    recentAuthAt: z
      .number()
      .optional()
      .describe(
        "Epoch milliseconds of the session's latest password or second-factor confirmation."
      ),
  })
  .readonly();
export type TrustedUser = z.infer<typeof TrustedUserSchema>;

export {
  DEFAULT_USER_GROUP_LIMITS,
  parseUserGroupLimits,
  type UserGroupLimits,
} from "./deployment-settings";

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
  if (limit === -1) return { allowed: true, retryAfter: 0 };
  if (limit === 0) return { allowed: false, retryAfter: 60 };
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
  identifier: NamespaceSlugSchema.refine((value) => value.length >= 3),
  password: z.string().min(12).max(256),
});
export const LoginInputSchema = z.object({
  identifier: z.string().trim().min(3).max(64),
  password: z.string().min(12).max(256),
});

export const CreateOrganizationInputSchema = z.object({
  slug: NamespaceSlugSchema,
  displayName: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
});

export const CreateRepositoryInputSchema = z.object({
  initializeReadme: z.boolean().default(false),
  owner: NamespaceSlugSchema,
  slug: RepositorySlugSchema,
  visibility: z.enum(["public", "private"]),
  description: z.string().trim().max(500).default(""),
});

export const TransferRepositoryInputSchema = ConfirmationInputSchema.extend({
  owner: NamespaceSlugSchema,
});
export type TransferRepositoryInput = z.infer<typeof TransferRepositoryInputSchema>;

export const CreateIssueInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(50_000).default(""),
  labels: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
});

export const UpdateIssueInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(50_000).optional(),
    state: z.enum(["open", "closed"]).optional(),
    labels: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

export const CreatePullRequestInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(50_000).default(""),
    baseRef: GitBranchSchema,
    headRef: GitBranchSchema,
    headSessionId: z.string().nullable().default(null),
    headRepositoryId: z.string().min(1).nullable().default(null),
    draft: z.boolean().default(false),
  })
  .refine((value) => !(value.headSessionId && value.headRepositoryId), {
    message: "A pull request head is a session or a fork, not both.",
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

export * from "./sso";
export * from "./signing";
export * from "./profiles";
