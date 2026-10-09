import type {
  AccountProfile,
  AccountPreferences,
} from "../../../../packages/contracts/src/account";
import type {
  AccessToken,
  CreateAccessTokenInput,
  CreatedAccessToken,
} from "../../../../packages/contracts/src/access-tokens";
import type { GitCredential, BrowserSession } from "../../../../packages/contracts/src/credentials";
import type {
  SigningKey,
  SigningKeyChallenge,
  CommitSignature,
} from "../../../../packages/contracts/src/signatures";
import type {
  Organization,
  OrganizationMember,
  User,
} from "../../../../packages/contracts/src/account";
import type { QuotaDetail, Usage } from "../../../../packages/contracts/src/ops";
import type { AuditPage } from "../../../../packages/contracts/src/audit";
import type {
  CreatedInvitation,
  Invitation,
  OrganizationRole,
} from "../../../../packages/contracts/src/invitations";
import type {
  AdminGroup,
  AdminPage,
  AdminRepository,
  AdminStats,
  AdminUser,
  UpdateAdminUserInput,
} from "../../../../packages/contracts/src/admin";
import type { DeletedRepository } from "../../../../packages/contracts/src/lifecycle";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import type {
  LoginResponse,
  PasskeyAuthenticationOptions,
  PasskeyRegistrationOptions,
  PasskeySummary,
  ReauthInput,
  RecoveryCodes,
  RecoveryOptions,
  SecondFactorInput,
  SecondFactorOptions,
  SecuritySummary,
  TotpEnrollment,
} from "../../../../packages/contracts/src/security";
import type { DeployPlan } from "../../../../packages/contracts/src/deploy";
import type {
  AgentProfile,
  AgentWebhookDelivery,
  AgentWebhookSettings,
} from "../../../../packages/contracts/src/agents";
import type {
  Actor,
  Agent,
  AgentSession,
  Assignee,
  CheckRun,
  Comment,
  Discussion,
  GitCommit,
  GitComparison,
  GitFile,
  GitGraph,
  GitRef,
  GitTree,
  GitTreeEntry,
  Issue,
  ListPage,
  PullRequest,
  Repository,
  Review,
  WikiPage,
  WikiPageSummary,
  CreatedAgentSession,
} from "../../../../packages/contracts/src/forge";
import type {
  CreateRepositoryImportInput,
  RepositoryImport,
} from "../../../../packages/contracts/src/imports";
import type {
  EditRepositoryFileInput,
  RepositoryBranch,
} from "../../../../packages/contracts/src/repository-controls";
import type { SsoIdentity, SsoProviderSummary } from "../../../../packages/contracts/src/sso";
import type {
  BrowserAccounts,
  BrowserIdentity,
  BrowserView,
} from "../../../../packages/contracts/src/browser-accounts";
import type {
  ActionRun,
  ActionRunSummary,
  ActionWorkflowFile,
  CreateActionRunInput,
} from "../../../../packages/contracts/src/actions";
import type {
  AgentAssignmentPolicy,
  AssigneeCandidate,
  AssigneeRef,
  AssignmentRole,
  DocumentRevisionSummary,
  MemoryIndex,
  MemoryVisibility,
  RepositorySettings,
  RepositorySettingsUpdate,
  RevisionActor,
  CollaboratorRemoval,
  RevocationOutcome,
  Task,
  TaskCommit,
  TaskDetail,
  TaskDocument,
  TaskDocumentKind,
  TaskLink,
  TaskLinkKind,
  TaskReference,
  TaskStatus,
  TaskTable,
} from "../../../../packages/contracts/src/tasks";
import type {
  BranchProtectionInput,
  BranchProtectionRule,
  RepositoryCollaborator,
  RepositoryCommunity,
  RepositoryRole,
} from "../../../../packages/contracts/src/repository-controls";

export type {
  Organization,
  OrganizationMember,
  User,
} from "../../../../packages/contracts/src/account";
export type { DeletedRepository } from "../../../../packages/contracts/src/lifecycle";
export type {
  AdminGroup,
  AdminPage,
  AdminRepository,
  AdminStats,
  AdminUser,
  AuditPage,
  CreatedInvitation,
  Invitation,
  OrganizationRole,
};
export type { AuditEvent } from "../../../../packages/contracts/src/audit";
export type {
  EditRepositoryFileInput,
  RepositoryBranch,
} from "../../../../packages/contracts/src/repository-controls";
export type {
  Actor,
  Agent,
  AgentSession,
  Assignee,
  CheckRun,
  Comment,
  Discussion,
  GitCommit,
  GitComparison,
  GitFile,
  GitGraph,
  GitRef,
  GitTree,
  GitTreeEntry,
  Issue,
  ListPage,
  PullRequest,
  Repository,
  Review,
  WikiPage,
  WikiPageSummary,
  CreatedAgentSession,
};
export type {
  BranchProtectionInput,
  BranchProtectionRule,
  RepositoryCollaborator,
  RepositoryCommunity,
  RepositoryCommunityFile,
  RepositoryRole,
} from "../../../../packages/contracts/src/repository-controls";
export type { ActionRun, ActionRunSummary, ActionWorkflowFile, CreateActionRunInput };
export type { SsoIdentity, SsoProviderSummary };
export type {
  AgentAssignmentPolicy,
  AssigneeCandidate,
  AssigneeRef,
  AssignmentRole,
  DocumentRevisionSummary,
  MemoryIndex,
  MemoryVisibility,
  RepositorySettings,
  RepositorySettingsUpdate,
  RevisionActor,
  Task,
  TaskCommit,
  TaskDetail,
  TaskDocument,
  TaskDocumentKind,
  TaskLink,
  TaskLinkKind,
  TaskReference,
  TaskStatus,
  TaskTable,
};

export interface ApiErrorDetail {
  /** Seconds to wait before retrying, from Retry-After or the rate-limit body. */
  retryAfter?: number | null;
  quota?: QuotaDetail | null;
  /** Organizations that block an account deletion. */
  organizations?: string[];
}

export class ApiError extends Error {
  public readonly retryAfter: number | null;
  public readonly quota: QuotaDetail | null;
  public readonly organizations: string[];
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string | null = null,
    detail: ApiErrorDetail = {}
  ) {
    super(message);
    this.retryAfter = detail.retryAfter ?? null;
    this.quota = detail.quota ?? null;
    this.organizations = detail.organizations ?? [];
  }
}

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Maps a failed request to localized text. `overrides` replaces the generic message for a status
 * with a message key that explains the failure in the context of the action; `fallbackKey` is used
 * when the failure carries no status-specific meaning.
 */
export function errorMessage(
  cause: unknown,
  t: Translate,
  overrides: Partial<Record<number, string>> = {},
  fallbackKey = "apiError"
): string {
  if (cause instanceof ApiError) {
    if (cause.quota)
      return t("quotaReached", {
        resource: t(`quotaResource_${cause.quota.resource}`),
        used: formatQuotaValue(cause.quota.resource, cause.quota.used),
        limit: formatQuotaValue(cause.quota.resource, cause.quota.limit),
      });
    if (cause.status === 429 && cause.retryAfter !== null)
      return t("rateLimitedRetry", { seconds: cause.retryAfter });
    const override = overrides[cause.status];
    if (override) return t(override);
    if (cause.status === 403) return t("permissionDenied");
    if (cause.status === 404) return t("resourceNotFound");
    if (cause.status === 409) return t("conflictError");
    if (cause.status === 429) return t("rateLimited");
  }
  return t(fallbackKey);
}

/** Invite an existing user by username, or anyone through a one-time link bound to an email. */
export type InviteePayload = { identifier: string } | { email: string };

function organizationPath(slug: string): string {
  return `/api/forge/organizations/${encodeURIComponent(slug)}`;
}

export interface PublicProfile {
  owner: string;
  displayName: string;
  bio: string;
  location: string;
  website: string;
  readme: { content: string; repositoryId: string; path: string } | null;
  repositories: Repository[];
  truncated: boolean;
}

export function ssoAuthorizationUrl(value: string): URL | null {
  try {
    const target = new URL(value);
    if (target.protocol !== "https:" || target.username || target.password) return null;
    return target;
  } catch {
    return null;
  }
}

export interface SsoLogoutResponse {
  url: string | null;
  providerLogoutUnavailable: boolean;
}

interface ApiEnvelope<T> {
  data: T;
  truncated?: boolean;
}

let expectedUserId: string | null = null;
let expectedViewId = "account";

export function setExpectedIdentity(userId: string | null, agentSessionId?: string): void {
  expectedUserId = userId;
  expectedViewId = agentSessionId ?? "account";
}

export function expectedIdentityHeaders(path: string, method = "GET"): Record<string, string> {
  if (
    path === "/api/auth/session" ||
    path === "/api/auth/browser-session" ||
    (path === "/api/auth/accounts" && method === "GET")
  )
    return {};
  return {
    ...(expectedUserId ? { "X-GitEdge-Expected-User": expectedUserId } : {}),
    "X-GitEdge-Expected-View": expectedViewId,
  };
}

function request<T>(path: string, init?: RequestInit): Promise<T>;
function request(path: string, init: RequestInit | undefined, allowNoContent: true): Promise<void>;
async function request<T>(
  path: string,
  init?: RequestInit,
  allowNoContent = false
): Promise<T | void> {
  const envelope = await requestEnvelope<T>(path, init, allowNoContent);
  return envelope ? envelope.data : undefined;
}

async function requestPage<T>(path: string): Promise<ListPage<T>> {
  const envelope = await requestEnvelope<T[]>(path);
  if (!envelope || typeof envelope.truncated !== "boolean")
    throw new ApiError(200, "Invalid list response");
  return { items: envelope.data, truncated: envelope.truncated };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRetryAfter(value: unknown): number | null {
  const seconds = typeof value === "string" ? Number(value.trim()) : value;
  return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0
    ? seconds
    : null;
}

function parseQuota(value: unknown): QuotaDetail | null {
  if (!isRecord(value)) return null;
  const { resource, used, limit } = value;
  if (
    (resource === "repositories" || resource === "storage") &&
    typeof used === "number" &&
    Number.isSafeInteger(used) &&
    used >= 0 &&
    typeof limit === "number" &&
    Number.isSafeInteger(limit) &&
    limit > 0
  )
    return { resource, used, limit };
  return null;
}

interface ParsedErrorBody {
  message: string;
  code: string | null;
  retryAfter: number | null;
  quota: QuotaDetail | null;
  organizations: string[];
}

/** Reads both the `{ error: { code, message } }` envelope and the Gateway's flat rate-limit body. */
function parseErrorBody(body: string, statusText: string): ParsedErrorBody {
  const failure: ParsedErrorBody = {
    message: body || statusText,
    code: null,
    retryAfter: null,
    quota: null,
    organizations: [],
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return failure;
  }
  if (!isRecord(parsed)) return failure;
  failure.retryAfter = parseRetryAfter(parsed.retryAfter);
  const error = parsed.error;
  if (typeof error === "string") failure.message = error;
  else if (isRecord(error)) {
    if (typeof error.message === "string") failure.message = error.message;
    if (typeof error.code === "string") failure.code = error.code;
    failure.quota = parseQuota(error.quota);
    if (Array.isArray(error.organizations))
      failure.organizations = error.organizations.filter(
        (item): item is string => typeof item === "string"
      );
  }
  return failure;
}

/** Storage quotas are bytes; repository counts are shown as plain numbers. */
export function formatQuotaValue(resource: QuotaDetail["resource"], value: number): string {
  return resource === "storage" ? formatBytes(value) : String(value);
}

export function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

async function requestEnvelope<T>(
  path: string,
  init?: RequestInit,
  allowNoContent = false
): Promise<ApiEnvelope<T> | void> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...expectedIdentityHeaders(path, (init?.method ?? "GET").toUpperCase()),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    const failure = parseErrorBody(body, response.statusText);
    throw new ApiError(response.status, failure.message, failure.code, {
      retryAfter: parseRetryAfter(response.headers.get("Retry-After")) ?? failure.retryAfter,
      quota: failure.quota,
      organizations: failure.organizations,
    });
  }
  if (response.status === 204) {
    if (allowNoContent) return;
    throw new ApiError(response.status, "Expected a response body");
  }
  const envelope: ApiEnvelope<T> = await response.json();
  if (!envelope || typeof envelope !== "object" || !("data" in envelope)) {
    throw new ApiError(response.status, "Invalid response envelope");
  }
  return envelope;
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const value = params.toString();
  return value ? `?${value}` : "";
}

export interface DeployAccount {
  id: string;
  name: string;
}

export interface DeploySession {
  accounts: DeployAccount[];
  nonce: string;
}

export interface DeployResourceAvailability {
  id: string;
  exists: boolean;
}

function deployPath(name: string, repositoryId: string, ref: string): string {
  return `/api/deploy/${name}${query({ repositoryId, ref })}`;
}

function repositoryPath(repositoryId: string, resource: string): string {
  return `/api/forge/repositories/${encodeURIComponent(repositoryId)}/${resource}`;
}

function gitPath(repositoryId: string, resource: string): string {
  return `/api/git/repositories/${encodeURIComponent(repositoryId)}/${resource}`;
}

function actionsRepositoryPath(repositoryId: string, resource: string): string {
  return `/api/actions/repositories/${encodeURIComponent(repositoryId)}/${resource}`;
}

export const api = {
  browserAccounts: () => request<BrowserAccounts>("/api/auth/accounts"),
  switchBrowserAccount: (userId: string) =>
    request<{ switched: boolean }>("/api/auth/accounts/switch", {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  switchBrowserView: (payload: BrowserView) =>
    request<{ switched: boolean }>("/api/auth/accounts/view", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  removeBrowserAccount: (userId: string) =>
    request<{ removed: boolean; isCurrent: boolean }>(
      `/api/auth/accounts/${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    ),
  logoutAllBrowserAccounts: () =>
    request<{ loggedOut: boolean }>("/api/auth/accounts/logout-all", { method: "POST" }),
  usage: () => request<Usage>("/api/forge/usage"),
  accountProfile: () => request<AccountProfile>("/api/auth/profile"),
  updateAccountProfile: (
    payload: Partial<Omit<AccountProfile, "preferences">> & {
      preferences?: Partial<AccountPreferences>;
    }
  ) =>
    request<AccountProfile>("/api/auth/profile", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  accessTokens: () => request<AccessToken[]>("/api/auth/access-tokens"),
  createAccessToken: (payload: CreateAccessTokenInput) =>
    request<CreatedAccessToken>("/api/auth/access-tokens", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  revokeAccessToken: (id: string) =>
    request<{ revoked: boolean }>(`/api/auth/access-tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  gitCredentials: () => request<GitCredential[]>("/api/auth/tokens"),
  revokeGitCredential: (id: string) =>
    request<{ revoked: boolean }>(`/api/auth/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  browserSessions: () => request<BrowserSession[]>("/api/auth/web-sessions"),
  revokeBrowserSession: (id: string) =>
    request<{ revoked: boolean; isCurrent: boolean }>(
      `/api/auth/web-sessions/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    ),
  signingKeys: () => request<SigningKey[]>("/api/auth/signing-keys"),
  createSigningChallenge: (payload: { title: string; publicKey: string }) =>
    request<SigningKeyChallenge>("/api/auth/signing-keys/challenges", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  addSigningKey: (payload: { challengeId: string; signature: string }) =>
    request<SigningKey>("/api/auth/signing-keys", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  revokeSigningKey: (id: string) =>
    request<{ revoked: boolean }>(`/api/auth/signing-keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  commitSignature: (repositoryId: string, ref: string, oid: string) =>
    request<CommitSignature>(gitPath(repositoryId, `signature${query({ ref, oid })}`)),
  login: (payload: { identifier: string; password: string }) =>
    request<LoginResponse>("/api/auth/login", { method: "POST", body: JSON.stringify(payload) }),
  completeLogin: (mfaToken: string, factor: SecondFactorInput) =>
    request<User>("/api/auth/login/second-factor", {
      method: "POST",
      body: JSON.stringify({ mfaToken, factor }),
    }),
  secondFactorOptions: (mfaToken: string) =>
    request<SecondFactorOptions>("/api/auth/login/second-factor/options", {
      method: "POST",
      body: JSON.stringify({ mfaToken }),
    }),
  passkeyLoginOptions: () =>
    request<PasskeyAuthenticationOptions>("/api/auth/login/passkey/options", { method: "POST" }),
  passkeyLogin: (challengeId: string, response: AuthenticationResponseJSON) =>
    request<User>("/api/auth/login/passkey", {
      method: "POST",
      body: JSON.stringify({ challengeId, response }),
    }),
  recoveryOptions: () => request<RecoveryOptions>("/api/auth/recovery/options"),
  resetPasswordWithRecoveryCode: (payload: {
    identifier: string;
    recoveryCode: string;
    newPassword: string;
  }) =>
    request<{ reset: boolean }>("/api/auth/recovery/password", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  requestPasswordResetEmail: (email: string) =>
    request<{ sent: boolean }>("/api/auth/recovery/email", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  confirmPasswordResetEmail: (payload: {
    token: string;
    newPassword: string;
    factor?: { method: "totp" | "recovery"; code: string };
  }) =>
    request<{ reset: boolean }>("/api/auth/recovery/email/confirm", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  verifyEmail: (token: string) =>
    request<{ verified: boolean }>("/api/auth/email/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  security: () => request<SecuritySummary>("/api/auth/security"),
  reauthenticate: (input: ReauthInput) =>
    request<{ recentAuthAt: number; expiresAt: number }>("/api/auth/reauth", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  reauthPasskeyOptions: () =>
    request<SecondFactorOptions>("/api/auth/reauth/passkey/options", { method: "POST" }),
  changePassword: (newPassword: string) =>
    request<{ changed: boolean }>("/api/auth/security/password", {
      method: "POST",
      body: JSON.stringify({ newPassword }),
    }),
  setEmail: (email: string) =>
    request<{ sent: boolean }>("/api/auth/security/email", {
      method: "PUT",
      body: JSON.stringify({ email }),
    }),
  removeEmail: () =>
    request<{ removed: boolean }>("/api/auth/security/email", { method: "DELETE" }),
  enrollTotp: () => request<TotpEnrollment>("/api/auth/security/totp", { method: "POST" }),
  confirmTotp: (code: string) =>
    request<{ enabled: boolean; recoveryCodes?: string[] }>("/api/auth/security/totp/confirm", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  disableTotp: (payload: { password?: string; code: string }) =>
    request<{ enabled: boolean }>("/api/auth/security/totp/disable", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  regenerateRecoveryCodes: () =>
    request<RecoveryCodes>("/api/auth/security/recovery-codes", { method: "POST" }),
  passkeyRegistrationOptions: () =>
    request<PasskeyRegistrationOptions>("/api/auth/security/passkeys/options", {
      method: "POST",
    }),
  addPasskey: (name: string, response: RegistrationResponseJSON) =>
    request<{ passkey: PasskeySummary; recoveryCodes?: string[] }>("/api/auth/security/passkeys", {
      method: "POST",
      body: JSON.stringify({ name, response }),
    }),
  renamePasskey: (id: string, name: string) =>
    request<{ renamed: boolean }>(`/api/auth/security/passkeys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  removePasskey: (id: string) =>
    request<{ removed: boolean }>(`/api/auth/security/passkeys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  register: (payload: { identifier: string; password: string }) =>
    request<User>("/api/auth/register", { method: "POST", body: JSON.stringify(payload) }),
  logout: () => request("/api/auth/logout", { method: "POST" }, true),
  session: () => request<User>("/api/auth/session"),
  browserSession: () => request<BrowserIdentity>("/api/auth/browser-session"),
  ssoProviders: () => request<SsoProviderSummary[]>("/api/auth/sso/providers"),
  ssoIdentities: () => request<SsoIdentity[]>("/api/auth/sso/identities"),
  linkSsoIdentity: (providerId: string, returnTo: string) =>
    request<{ url: string }>(`/api/auth/sso/${encodeURIComponent(providerId)}/link`, {
      method: "POST",
      body: JSON.stringify({ returnTo }),
    }),
  logoutSsoIdentity: (providerId: string, identityId: string) =>
    request<SsoLogoutResponse>(`/api/auth/sso/${encodeURIComponent(providerId)}/logout`, {
      method: "POST",
      body: JSON.stringify({ identityId }),
    }),
  unlinkSsoIdentity: (identityId: string) =>
    request<{ unlinked: boolean }>(`/api/auth/sso/identities/${encodeURIComponent(identityId)}`, {
      method: "DELETE",
    }),
  repositories: () => request<Repository[]>("/api/forge/repositories"),
  publicProfile: (owner: string) =>
    request<PublicProfile>(`/api/forge/profiles/${encodeURIComponent(owner)}`),
  repository: (owner: string, repo: string) =>
    request<Repository>(
      `/api/forge/repositories/by-name/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    ),
  createRepository: (payload: {
    name: string;
    owner: string;
    description: string;
    visibility: "public" | "private";
    initializeReadme: boolean;
  }) =>
    request<Repository>("/api/forge/repositories", {
      method: "POST",
      body: JSON.stringify({
        slug: payload.name,
        owner: payload.owner,
        description: payload.description,
        visibility: payload.visibility,
        initializeReadme: payload.initializeReadme,
      }),
    }),
  importRepository: (payload: CreateRepositoryImportInput) =>
    request<RepositoryImport>("/api/forge/repository-imports", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  repositoryImports: () => request<RepositoryImport[]>("/api/forge/repository-imports"),
  repositoryImport: (id: string) =>
    request<RepositoryImport>(`/api/forge/repository-imports/${encodeURIComponent(id)}`),
  retryRepositoryImport: (id: string) =>
    request<RepositoryImport>(`/api/forge/repository-imports/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    }),
  organizations: () => request<Organization[]>("/api/forge/organizations"),
  createOrganization: (payload: { slug: string; displayName: string; description: string }) =>
    request<Organization>("/api/forge/organizations", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  organization: (slug: string) =>
    request<Organization>(`/api/forge/organizations/${encodeURIComponent(slug)}`),
  organizationMembers: (slug: string) =>
    request<OrganizationMember[]>(`/api/forge/organizations/${encodeURIComponent(slug)}/members`),
  inviteOrganizationMember: (slug: string, payload: InviteePayload & { role: OrganizationRole }) =>
    request<CreatedInvitation>(`${organizationPath(slug)}/invitations`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  organizationInvitations: (slug: string) =>
    request<Invitation[]>(`${organizationPath(slug)}/invitations`),
  cancelOrganizationInvitation: (slug: string, id: string) =>
    request(`${organizationPath(slug)}/invitations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  updateOrganizationMember: (slug: string, identifier: string, role: OrganizationRole) =>
    request<OrganizationMember>(
      `${organizationPath(slug)}/members/${encodeURIComponent(identifier)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }
    ),
  organizationAuditLog: (slug: string, cursor?: string) =>
    request<AuditPage>(`${organizationPath(slug)}/audit-log${query({ cursor })}`),
  myInvitations: () => request<Invitation[]>("/api/forge/invitations"),
  resolveInvitation: (id: string, action: "accept" | "decline") =>
    request<Invitation>(`/api/forge/invitations/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
    }),
  invitationByToken: (token: string, action: "lookup" | "accept" | "decline") =>
    request<Invitation>(`/api/forge/invitations/${action}`, {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  accountAuditLog: (cursor?: string) =>
    request<AuditPage>(`/api/auth/audit-log${query({ cursor })}`),
  deleteAccount: (confirm: string) =>
    request(
      "/api/auth/account/delete",
      { method: "POST", body: JSON.stringify({ confirm }) },
      true
    ),
  exportAccount: async (): Promise<Blob> => {
    const response = await fetch("/api/auth/account/export", {
      credentials: "include",
      headers: expectedIdentityHeaders("/api/auth/account/export"),
    });
    if (!response.ok) {
      const failure = parseErrorBody(await response.text(), response.statusText);
      throw new ApiError(response.status, failure.message, failure.code);
    }
    return response.blob();
  },
  adminUsers: (params: { q?: string; cursor?: string }) =>
    request<AdminPage<AdminUser>>(`/api/auth/admin/users${query(params)}`),
  adminRepositories: (params: { q?: string; cursor?: string }) =>
    request<AdminPage<AdminRepository>>(`/api/auth/admin/repositories${query(params)}`),
  adminGroups: () => request<AdminGroup[]>("/api/auth/admin/groups"),
  adminStats: () => request<AdminStats>("/api/auth/admin/stats"),
  setAdminUserDisabled: (id: string, disabled: boolean) =>
    request<{ id: string; disabled: boolean; revocationIncomplete: boolean }>(
      `/api/auth/admin/users/${encodeURIComponent(id)}/${disabled ? "disable" : "enable"}`,
      { method: "POST" }
    ),
  updateAdminUser: (id: string, payload: UpdateAdminUserInput) =>
    request<{ id: string; groupKey: string; siteAdmin: boolean }>(
      `/api/auth/admin/users/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(payload) }
    ),
  removeOrganizationMember: async (slug: string, identifier: string): Promise<boolean> => {
    const envelope = await requestEnvelope<RevocationOutcome>(
      `/api/forge/organizations/${encodeURIComponent(slug)}/members/${encodeURIComponent(identifier)}`,
      { method: "DELETE" },
      true
    );
    return envelope?.data.revocationIncomplete === true;
  },
  deleteOrganization: (slug: string, confirm: string) =>
    request(
      `/api/forge/organizations/${encodeURIComponent(slug)}`,
      { method: "DELETE", body: JSON.stringify({ confirm }) },
      true
    ),
  deleteRepository: (repositoryId: string, confirm: string) =>
    request<{ deletedAt: number; purgeAfter: number } & RevocationOutcome>(
      `/api/forge/repositories/${encodeURIComponent(repositoryId)}`,
      { method: "DELETE", body: JSON.stringify({ confirm }) }
    ),
  transferRepository: (repositoryId: string, payload: { owner: string; confirm: string }) =>
    request<Repository & RevocationOutcome>(repositoryPath(repositoryId, "transfer"), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deletedRepositories: () => requestPage<DeletedRepository>("/api/forge/deleted-repositories"),
  restoreRepository: (repositoryId: string) =>
    request<Repository>(
      `/api/forge/deleted-repositories/${encodeURIComponent(repositoryId)}/restore`,
      { method: "POST" }
    ),
  purgeRepository: (repositoryId: string, confirm: string) =>
    request<{ purged: boolean }>(
      `/api/forge/deleted-repositories/${encodeURIComponent(repositoryId)}`,
      { method: "DELETE", body: JSON.stringify({ confirm }) }
    ),
  refs: (repositoryId: string) => request<GitRef[]>(gitPath(repositoryId, "refs")),
  tree: (repositoryId: string, ref: string, path: string) =>
    request<GitTree>(gitPath(repositoryId, `tree${query({ ref, path })}`)),
  file: (repositoryId: string, ref: string, path: string) =>
    request<GitFile>(gitPath(repositoryId, `file${query({ ref, path })}`)),
  repositoryBranches: (repositoryId: string) =>
    request<RepositoryBranch[]>(gitPath(repositoryId, "branches")),
  createRepositoryBranch: (
    repositoryId: string,
    payload: { name: string; source: string; expectedOid: string }
  ) =>
    request<{ name: string; oid: string }>(gitPath(repositoryId, "branches"), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteRepositoryBranch: (repositoryId: string, payload: { name: string; expectedOid: string }) =>
    request<{ deleted: boolean }>(gitPath(repositoryId, "branches"), {
      method: "DELETE",
      body: JSON.stringify(payload),
    }),
  editRepositoryFile: (repositoryId: string, payload: EditRepositoryFileInput) =>
    request<{ oid: string; branch: string; path: string }>(gitPath(repositoryId, "edit"), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  commits: (repositoryId: string, ref: string, offset: number, limit: number) =>
    request<GitCommit[]>(gitPath(repositoryId, `commits${query({ ref, offset, limit })}`)),
  graph: (repositoryId: string, ref: string, limit: number) =>
    request<GitGraph>(gitPath(repositoryId, `graph${query({ ref, limit })}`)),
  compare: (repositoryId: string, base: string, head: string, headSessionId?: string | null) =>
    request<GitComparison>(
      gitPath(
        repositoryId,
        `compare${query({ base, head, headSessionId: headSessionId ?? undefined })}`
      )
    ),
  createCloneToken: (payload: {
    repositoryId: string;
    name: string;
    permission: "read" | "write";
    ttlSeconds: number;
  }) =>
    request<{ id: string; token: string; expiresAt: number }>("/api/auth/tokens", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  issues: (repositoryId: string) => requestPage<Issue>(repositoryPath(repositoryId, "issues")),
  issue: (repositoryId: string, number: number) =>
    request<Issue>(repositoryPath(repositoryId, `issues/${number}`)),
  createIssue: (
    repositoryId: string,
    payload: { title: string; body: string; labels?: string[] }
  ) =>
    request<Issue>(repositoryPath(repositoryId, "issues"), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateIssue: (
    repositoryId: string,
    number: number,
    payload: Partial<Pick<Issue, "title" | "body" | "state" | "labels">>
  ) =>
    request<Issue>(repositoryPath(repositoryId, `issues/${number}`), {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  pulls: (repositoryId: string) =>
    requestPage<PullRequest>(repositoryPath(repositoryId, "pull-requests")),
  pull: (repositoryId: string, number: number) =>
    request<PullRequest>(repositoryPath(repositoryId, `pull-requests/${number}`)),
  createPullRequest: (
    repositoryId: string,
    payload: {
      title: string;
      body: string;
      headRef: string;
      baseRef: string;
      headSessionId?: string | null;
      draft?: boolean;
    }
  ) =>
    request<PullRequest>(repositoryPath(repositoryId, "pull-requests"), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updatePullRequest: (
    repositoryId: string,
    number: number,
    payload: Partial<Pick<PullRequest, "title" | "body" | "state" | "draft">>
  ) =>
    request<PullRequest>(repositoryPath(repositoryId, `pull-requests/${number}`), {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  pullDiff: (repositoryId: string, number: number) =>
    request<GitComparison>(repositoryPath(repositoryId, `pull-requests/${number}/diff`)),
  mergePull: (
    repositoryId: string,
    number: number,
    payload: {
      expectedBaseOid: string;
      expectedHeadOid: string;
      method: "merge" | "squash" | "rebase";
    }
  ) =>
    request<PullRequest>(repositoryPath(repositoryId, `pull-requests/${number}/merge`), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  discussions: (repositoryId: string) =>
    requestPage<Discussion>(repositoryPath(repositoryId, "discussions")),
  discussion: (repositoryId: string, number: number) =>
    request<Discussion>(repositoryPath(repositoryId, `discussions/${number}`)),
  createDiscussion: (
    repositoryId: string,
    payload: { title: string; body: string; category: Discussion["category"] }
  ) =>
    request<Discussion>(repositoryPath(repositoryId, "discussions"), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateDiscussion: (
    repositoryId: string,
    number: number,
    payload: Partial<Pick<Discussion, "title" | "body" | "state" | "answerCommentId">>
  ) =>
    request<Discussion>(repositoryPath(repositoryId, `discussions/${number}`), {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  wiki: (repositoryId: string) =>
    requestPage<WikiPageSummary>(repositoryPath(repositoryId, "wiki")),
  wikiPage: (repositoryId: string, slug: string) =>
    request<WikiPage>(repositoryPath(repositoryId, `wiki/${encodeURIComponent(slug)}`)),
  wikiHistory: (repositoryId: string, slug: string) =>
    requestPage<WikiPageSummary>(
      repositoryPath(repositoryId, `wiki/${encodeURIComponent(slug)}/history`)
    ),
  wikiRevision: (repositoryId: string, slug: string, revision: number) =>
    request<WikiPage>(
      repositoryPath(repositoryId, `wiki/${encodeURIComponent(slug)}/revisions/${revision}`)
    ),
  restoreWikiRevision: (
    repositoryId: string,
    slug: string,
    revision: number,
    expectedRevision: number
  ) =>
    request<WikiPage>(
      repositoryPath(repositoryId, `wiki/${encodeURIComponent(slug)}/restore/${revision}`),
      { method: "POST", body: JSON.stringify({ expectedRevision }) }
    ),
  updateWikiPage: (
    repositoryId: string,
    slug: string,
    payload: { title: string; content: string; expectedRevision?: number }
  ) =>
    request<WikiPage>(repositoryPath(repositoryId, `wiki/${encodeURIComponent(slug)}`), {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  comments: (
    repositoryId: string,
    resource: "issues" | "pull-requests" | "discussions",
    number: number
  ) => requestPage<Comment>(repositoryPath(repositoryId, `${resource}/${number}/comments`)),
  createComment: (
    repositoryId: string,
    resource: "issues" | "pull-requests" | "discussions",
    number: number,
    body: string
  ) =>
    request<Comment>(repositoryPath(repositoryId, `${resource}/${number}/comments`), {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  updateComment: (
    repositoryId: string,
    resource: "issues" | "pull-requests" | "discussions",
    number: number,
    commentId: string,
    body: string
  ) =>
    request<Comment>(
      repositoryPath(
        repositoryId,
        `${resource}/${number}/comments/${encodeURIComponent(commentId)}`
      ),
      {
        method: "PATCH",
        body: JSON.stringify({ body }),
      }
    ),
  deleteComment: (
    repositoryId: string,
    resource: "issues" | "pull-requests" | "discussions",
    number: number,
    commentId: string
  ) =>
    request(
      repositoryPath(
        repositoryId,
        `${resource}/${number}/comments/${encodeURIComponent(commentId)}`
      ),
      { method: "DELETE" },
      true
    ),
  reviews: (repositoryId: string, number: number) =>
    request<Review[]>(repositoryPath(repositoryId, `pull-requests/${number}/reviews`)),
  createReview: (
    repositoryId: string,
    number: number,
    payload: { commitOid: string; state: Review["state"]; body: string }
  ) =>
    request<Review>(repositoryPath(repositoryId, `pull-requests/${number}/reviews`), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  checks: (repositoryId: string, number: number) =>
    request<CheckRun[]>(repositoryPath(repositoryId, `pull-requests/${number}/checks`)),
  createCheck: (
    repositoryId: string,
    number: number,
    payload: {
      name: string;
      commitOid: string;
      status: CheckRun["status"];
      conclusion: CheckRun["conclusion"];
      summary: string;
      detailsUrl?: string | null;
    }
  ) =>
    request<CheckRun>(repositoryPath(repositoryId, `pull-requests/${number}/checks`), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  memory: (repositoryId: string) => request<MemoryIndex>(repositoryPath(repositoryId, "memory")),
  memoryHistory: (repositoryId: string) =>
    request<DocumentRevisionSummary[]>(repositoryPath(repositoryId, "memory/history")),
  memoryRevision: (repositoryId: string, revision: number) =>
    request<MemoryIndex>(repositoryPath(repositoryId, `memory/revisions/${revision}`)),
  putMemory: (repositoryId: string, payload: { content: string; expectedRevision: number }) =>
    request<MemoryIndex>(repositoryPath(repositoryId, "memory"), {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  tasks: (repositoryId: string, status?: TaskStatus) =>
    request<Task[]>(repositoryPath(repositoryId, `tasks${query({ status })}`)),
  taskTable: (repositoryId: string) =>
    request<TaskTable>(repositoryPath(repositoryId, "tasks/table")),
  task: (repositoryId: string, number: number) =>
    request<TaskDetail>(repositoryPath(repositoryId, `tasks/${number}`)),
  createTask: (
    repositoryId: string,
    payload: { type: string; title: string; motivation: string; description: string }
  ) =>
    request<TaskDetail>(repositoryPath(repositoryId, "tasks"), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateTask: (
    repositoryId: string,
    number: number,
    payload: Partial<Pick<Task, "type" | "title" | "motivation" | "description" | "status">>
  ) =>
    request<TaskDetail>(repositoryPath(repositoryId, `tasks/${number}`), {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  assignTask: (repositoryId: string, number: number, assignee: AssigneeRef | null) =>
    request<TaskDetail>(repositoryPath(repositoryId, `tasks/${number}/assignee`), {
      method: "PUT",
      body: JSON.stringify({ assignee }),
    }),
  taskDocument: (repositoryId: string, number: number, kind: TaskDocumentKind) =>
    request<TaskDocument>(repositoryPath(repositoryId, `tasks/${number}/documents/${kind}`)),
  taskDocumentHistory: (repositoryId: string, number: number, kind: TaskDocumentKind) =>
    request<DocumentRevisionSummary[]>(
      repositoryPath(repositoryId, `tasks/${number}/documents/${kind}/history`)
    ),
  taskDocumentRevision: (
    repositoryId: string,
    number: number,
    kind: TaskDocumentKind,
    revision: number
  ) =>
    request<TaskDocument>(
      repositoryPath(repositoryId, `tasks/${number}/documents/${kind}/revisions/${revision}`)
    ),
  putTaskDocument: (
    repositoryId: string,
    number: number,
    kind: TaskDocumentKind,
    payload: { content: string; expectedRevision: number }
  ) =>
    request<TaskDocument>(repositoryPath(repositoryId, `tasks/${number}/documents/${kind}`), {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  attachTaskLink: (
    repositoryId: string,
    number: number,
    payload: { kind: TaskLinkKind; number: number }
  ) =>
    request<TaskLink>(repositoryPath(repositoryId, `tasks/${number}/links`), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  detachTaskLink: (
    repositoryId: string,
    number: number,
    kind: TaskLinkKind,
    targetNumber: number
  ) =>
    request(
      repositoryPath(repositoryId, `tasks/${number}/links/${kind}/${targetNumber}`),
      { method: "DELETE" },
      true
    ),
  itemTask: (repositoryId: string, kind: TaskLinkKind, number: number) =>
    request<TaskReference | null>(repositoryPath(repositoryId, `tasks/link/${kind}/${number}`)),
  moveItemTask: (repositoryId: string, kind: TaskLinkKind, number: number, task: number | null) =>
    request<TaskReference | null>(repositoryPath(repositoryId, `tasks/link/${kind}/${number}`), {
      method: "PUT",
      body: JSON.stringify({ task }),
    }),
  bindTaskCommit: (repositoryId: string, number: number, payload: { oid: string; ref: string }) =>
    request<TaskCommit>(repositoryPath(repositoryId, `tasks/${number}/commits`), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  unbindTaskCommit: (repositoryId: string, number: number, oid: string) =>
    request(
      repositoryPath(repositoryId, `tasks/${number}/commits/${encodeURIComponent(oid)}`),
      { method: "DELETE" },
      true
    ),
  assigneeCandidates: (repositoryId: string) =>
    request<AssigneeCandidate[]>(repositoryPath(repositoryId, "assignee-candidates")),
  setIssueAssignees: (
    repositoryId: string,
    number: number,
    payload: { role: AssignmentRole; assignees: AssigneeRef[] }
  ) =>
    request<Issue>(repositoryPath(repositoryId, `issues/${number}/assignees`), {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  setPullAssignees: (
    repositoryId: string,
    number: number,
    payload: { role: AssignmentRole; assignees: AssigneeRef[] }
  ) =>
    request<PullRequest>(repositoryPath(repositoryId, `pull-requests/${number}/assignees`), {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  repositorySettings: (repositoryId: string) =>
    request<RepositorySettings>(repositoryPath(repositoryId, "settings")),
  updateRepositorySettings: (
    repositoryId: string,
    payload: Partial<Omit<RepositorySettings, "canManage">>
  ) =>
    request<RepositorySettingsUpdate>(repositoryPath(repositoryId, "settings"), {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  repositoryCommunity: (repositoryId: string, refName: string) =>
    request<RepositoryCommunity>(`${gitPath(repositoryId, "community")}${query({ ref: refName })}`),
  branchRules: (repositoryId: string) =>
    request<BranchProtectionRule[]>(repositoryPath(repositoryId, "branch-rules")),
  createBranchRule: (repositoryId: string, payload: BranchProtectionInput) =>
    request<BranchProtectionRule>(repositoryPath(repositoryId, "branch-rules"), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateBranchRule: (repositoryId: string, ruleId: string, payload: BranchProtectionInput) =>
    request<BranchProtectionRule>(
      repositoryPath(repositoryId, `branch-rules/${encodeURIComponent(ruleId)}`),
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      }
    ),
  deleteBranchRule: (repositoryId: string, ruleId: string) =>
    request(
      repositoryPath(repositoryId, `branch-rules/${encodeURIComponent(ruleId)}`),
      { method: "DELETE" },
      true
    ),
  repositoryCollaborators: (repositoryId: string) =>
    request<RepositoryCollaborator[]>(repositoryPath(repositoryId, "collaborators")),
  inviteRepositoryCollaborator: (
    repositoryId: string,
    payload: InviteePayload & { role: RepositoryRole }
  ) =>
    request<CreatedInvitation>(repositoryPath(repositoryId, "invitations"), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  repositoryInvitations: (repositoryId: string) =>
    request<Invitation[]>(repositoryPath(repositoryId, "invitations")),
  cancelRepositoryInvitation: (repositoryId: string, id: string) =>
    request(repositoryPath(repositoryId, `invitations/${encodeURIComponent(id)}`), {
      method: "DELETE",
    }),
  updateRepositoryCollaborator: (repositoryId: string, userId: string, role: RepositoryRole) =>
    request<RepositoryCollaborator>(
      repositoryPath(repositoryId, `collaborators/${encodeURIComponent(userId)}`),
      { method: "PATCH", body: JSON.stringify({ role }) }
    ),
  repositoryAuditLog: (repositoryId: string, cursor?: string) =>
    request<AuditPage>(`${repositoryPath(repositoryId, "audit-log")}${query({ cursor })}`),
  deleteRepositoryCollaborator: (repositoryId: string, userId: string) =>
    request<CollaboratorRemoval>(
      repositoryPath(repositoryId, `collaborators/${encodeURIComponent(userId)}`),
      { method: "DELETE" }
    ),
  actionWorkflows: (repositoryId: string, ref: string, oid?: string) =>
    request<{ oid: string; workflows: ActionWorkflowFile[] }>(
      `${actionsRepositoryPath(repositoryId, "workflows")}${query({ ref, oid })}`
    ),
  actionRuns: (repositoryId: string) =>
    request<ActionRunSummary[]>(actionsRepositoryPath(repositoryId, "runs")),
  actionRun: (runId: string) =>
    request<ActionRun>(`/api/actions/runs/${encodeURIComponent(runId)}`),
  startActionRun: (repositoryId: string, input: CreateActionRunInput) =>
    request<ActionRunSummary>(actionsRepositoryPath(repositoryId, "runs"), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancelActionRun: (runId: string) =>
    request<ActionRun>(`/api/actions/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    }),
  agents: () => request<Agent[]>("/api/auth/agents"),
  agent: (id: string) => request<Agent>(`/api/auth/agents/${encodeURIComponent(id)}`),
  updateAgent: (
    id: string,
    payload: Partial<Pick<Agent, "handle" | "name" | "description" | "profilePublic">>
  ) =>
    request<Agent>(`/api/auth/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  agentProfile: (owner: string, handle: string) =>
    request<AgentProfile>(
      `/api/auth/agent-profiles/${encodeURIComponent(owner)}/${encodeURIComponent(handle)}`
    ),
  agentWebhook: (id: string) =>
    request<(AgentWebhookSettings & { configured: true; updatedAt: number }) | null>(
      `/api/auth/agents/${encodeURIComponent(id)}/webhook`
    ),
  saveAgentWebhook: (id: string, payload: AgentWebhookSettings, rotateSecret = false) =>
    request<AgentWebhookSettings & { configured: true; secret: string | null }>(
      `/api/auth/agents/${encodeURIComponent(id)}/webhook`,
      { method: "PUT", body: JSON.stringify({ ...payload, rotateSecret }) }
    ),
  testAgentWebhook: (id: string) =>
    request<AgentWebhookDelivery>(`/api/auth/agents/${encodeURIComponent(id)}/webhook/test`, {
      method: "POST",
      body: "{}",
    }),
  agentWebhookDeliveries: (id: string) =>
    request<AgentWebhookDelivery[]>(
      `/api/auth/agents/${encodeURIComponent(id)}/webhook/deliveries`
    ),
  retryAgentWebhookDelivery: (id: string, deliveryId: string) =>
    request<AgentWebhookDelivery>(
      `/api/auth/agents/${encodeURIComponent(id)}/webhook/deliveries/${encodeURIComponent(deliveryId)}/retry`,
      { method: "POST", body: "{}" }
    ),
  createAgent: (payload: { handle?: string; name: string; description: string }) =>
    request<Agent>("/api/auth/agents", { method: "POST", body: JSON.stringify(payload) }),
  disableAgent: (id: string) =>
    request(`/api/auth/agents/${encodeURIComponent(id)}`, { method: "DELETE" }, true),
  agentSessions: (id: string) =>
    request<AgentSession[]>(`/api/auth/agents/${encodeURIComponent(id)}/sessions`),
  createAgentSession: (
    id: string,
    payload: {
      repositoryId: string;
      baseRef: string;
      permission: "read" | "write";
      ttlSeconds: number;
    }
  ) =>
    request<CreatedAgentSession>(`/api/auth/agents/${encodeURIComponent(id)}/sessions`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  revokeAgentSession: (id: string, sessionId: string) =>
    request(
      `/api/auth/agents/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
      true
    ),
  repositorySessions: (repositoryId: string) =>
    request<AgentSession[]>(`/api/auth/sessions${query({ repositoryId })}`),
  deployPlan: (repositoryId: string, ref: string) =>
    request<DeployPlan>(deployPath("plan", repositoryId, ref)),
  deploySession: (
    repositoryId: string,
    ref: string,
    payload: { token: string; manifestDigest: string }
  ) =>
    request<DeploySession>(deployPath("session", repositoryId, ref), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  endDeploySession: (repositoryId: string, ref: string) =>
    request<{ cleared: boolean }>(deployPath("session", repositoryId, ref), { method: "DELETE" }),
  deployAccount: (
    repositoryId: string,
    ref: string,
    payload: { accountId: string; nonce: string }
  ) =>
    request<unknown>(deployPath("account", repositoryId, ref), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deployResources: (
    repositoryId: string,
    ref: string,
    payload: { nonce: string; resourceNames: Record<string, string> }
  ) =>
    request<{ resources: DeployResourceAvailability[] }>(
      deployPath("resources", repositoryId, ref),
      { method: "POST", body: JSON.stringify(payload) }
    ),
  deployStep: <T>(
    step: "provision" | "migrate" | "deploy",
    repositoryId: string,
    ref: string,
    payload: {
      nonce: string;
      resourceNames?: Record<string, string>;
      workerName?: string;
      confirmDigest?: string;
    }
  ) =>
    request<T>(deployPath(step, repositoryId, ref), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
