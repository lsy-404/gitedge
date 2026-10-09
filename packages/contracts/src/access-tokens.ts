import { z } from "zod";

export const ACCESS_TOKEN_PREFIX = "gep_";
export const ACCESS_TOKEN_MAX_DAYS = 365;
export const ACCESS_TOKEN_EXPIRY_PRESET_DAYS = [7, 30, 90, 365] as const;
export const ACCESS_TOKEN_MAX_REPOSITORIES = 50;

export const AccessTokenScopes = [
  "repo:read",
  "repo:write",
  "issues:write",
  "pulls:write",
  "org:read",
  "admin",
] as const;
export const AccessTokenScopeSchema = z.enum(AccessTokenScopes);
export type AccessTokenScope = z.infer<typeof AccessTokenScopeSchema>;

export const AccessTokenIdentitySchema = z.object({
  id: z.string().min(1),
  scopes: z.array(AccessTokenScopeSchema).min(1),
  repositoryIds: z.array(z.string().min(1)).max(ACCESS_TOKEN_MAX_REPOSITORIES).optional(),
});
export type AccessTokenIdentity = z.infer<typeof AccessTokenIdentitySchema>;

export const CreateAccessTokenInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z
      .array(AccessTokenScopeSchema)
      .min(1)
      .max(AccessTokenScopes.length)
      .refine((scopes) => new Set(scopes).size === scopes.length),
    repositoryIds: z
      .array(z.string().min(1))
      .min(1)
      .max(ACCESS_TOKEN_MAX_REPOSITORIES)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    expiresInDays: z.number().int().min(1).max(ACCESS_TOKEN_MAX_DAYS),
  })
  .strict();
export type CreateAccessTokenInput = z.infer<typeof CreateAccessTokenInputSchema>;

export interface AccessTokenRepository {
  id: string;
  owner: string;
  slug: string;
}
export interface AccessToken {
  id: string;
  name: string;
  prefix: string;
  scopes: AccessTokenScope[];
  repositories: AccessTokenRepository[] | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
export interface CreatedAccessToken extends AccessToken {
  token: string;
}

const IMPLIED_SCOPES: Readonly<Record<AccessTokenScope, readonly AccessTokenScope[]>> = {
  admin: AccessTokenScopes,
  "repo:write": ["repo:read"],
  "issues:write": ["repo:read"],
  "pulls:write": ["repo:read"],
  "repo:read": [],
  "org:read": [],
};

export function accessTokenAllows(
  token: Pick<AccessTokenIdentity, "scopes">,
  required: AccessTokenScope
): boolean {
  return token.scopes.some(
    (scope) => scope === required || IMPLIED_SCOPES[scope].includes(required)
  );
}

export function accessTokenAllowsRepository(
  token: Pick<AccessTokenIdentity, "repositoryIds">,
  repositoryId: string
): boolean {
  return !token.repositoryIds || token.repositoryIds.includes(repositoryId);
}

export type AccessTokenService = "forge" | "git" | "actions";

const ISSUE_RESOURCES = new Set(["issues", "discussions", "tasks", "memory", "wiki", "comments"]);

/** Scope a request needs, derived from the service, HTTP method and path segments. */
export function requiredAccessTokenScope(
  service: AccessTokenService,
  method: string,
  parts: readonly string[]
): AccessTokenScope {
  const reading = method === "GET" || method === "HEAD";
  if (service === "forge" && parts[0] === "organizations") return reading ? "org:read" : "admin";
  if (reading) return "repo:read";
  if (service === "git") return parts[2] === "merge" ? "pulls:write" : "repo:write";
  if (service === "actions") return "repo:write";
  if (parts[0] !== "repositories") return "admin";
  if (parts.length === 1) return "repo:write";
  if (parts.length === 2) return "admin";
  const resource = parts[2] ?? "";
  if (ISSUE_RESOURCES.has(resource)) return "issues:write";
  if (resource === "pull-requests") return "pulls:write";
  return "admin";
}

export function accessTokenPermits(
  token: AccessTokenIdentity,
  service: AccessTokenService,
  method: string,
  parts: readonly string[]
): boolean {
  return accessTokenAllows(token, requiredAccessTokenScope(service, method, parts));
}
