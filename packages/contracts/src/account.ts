import { z } from "zod";
import type { AgentSessionIdentity } from "./forge";

export const ReservedAccountIdentifiers: ReadonlySet<string> = new Set([
  "account",
  "assets",
  "agents",
  "api",
  "app",
  "auth",
  "browse",
  "dashboard",
  "explore",
  "git",
  "github",
  "issues",
  "login",
  "logout",
  "new",
  "organizations",
  "profile",
  "pulls",
  "register",
  "repositories",
  "search",
  "sessions",
  "settings",
  "sso",
  "tokens",
  "web-sessions",
  "wiki",
]);

export interface User {
  id: string;
  identifier: string;
  externalIdentity?: ExternalIdentity;
  agentSession?: AgentSessionIdentity;
}

export interface ExternalIdentity {
  provider: "github" | "oidc";
  login: string;
  avatarUrl?: string;
  profileUrl?: string;
}

export interface Organization {
  slug: string;
  displayName: string;
  description?: string;
  avatarUrl?: string;
  role?: "owner" | "member";
}

export interface OrganizationMember {
  identifier: string;
  role: "owner" | "member";
}

export const AccountPreferencesSchema = z.object({
  theme: z.enum(["system", "light", "dark"]),
  locale: z.enum(["zh-CN", "en"]),
  density: z.enum(["comfortable", "compact"]),
  tabSize: z.union([z.literal(2), z.literal(4), z.literal(8)]),
  lineWrap: z.boolean(),
});

export const DefaultAccountPreferences = {
  theme: "system",
  locale: "zh-CN",
  density: "comfortable",
  tabSize: 2,
  lineWrap: false,
} as const satisfies z.infer<typeof AccountPreferencesSchema>;

export const AccountProfileSchema = z.object({
  identifier: z.string().trim().min(3).max(63),
  displayName: z.string().trim().min(1).max(100),
  bio: z.string().max(500),
  location: z.string().trim().max(100),
  website: z.string().trim().max(255),
  preferences: AccountPreferencesSchema,
});

export const UpdateAccountProfileSchema = z.object({
  identifier: z.string().trim().min(3).max(63).optional(),
  displayName: z.string().trim().min(1).max(100).optional(),
  bio: z.string().max(500).optional(),
  location: z.string().trim().max(100).optional(),
  website: z.string().trim().max(255).optional(),
  preferences: AccountPreferencesSchema.partial().optional(),
});

export type AccountPreferences = z.infer<typeof AccountPreferencesSchema>;
export type AccountProfile = z.infer<typeof AccountProfileSchema>;
