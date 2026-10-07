import type {
  AccountProfile,
  AccountPreferences,
} from "../../../../packages/contracts/src/account";
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

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string | null = null
  ) {
    super(message);
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
    const override = overrides[cause.status];
    if (override) return t(override);
    if (cause.status === 403) return t("permissionDenied");
    if (cause.status === 404) return t("resourceNotFound");
    if (cause.status === 409) return t("conflictError");
    if (cause.status === 429) return t("rateLimited");
  }
  return t(fallbackKey);
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
    let message = body || response.statusText;
    let code: string | null = null;
    try {
      const parsed: unknown = JSON.parse(body);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof parsed.error === "object" &&
        parsed.error !== null &&
        "message" in parsed.error &&
        typeof parsed.error.message === "string"
      )
        message = parsed.error.message;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof parsed.error === "object" &&
        parsed.error !== null &&
        "code" in parsed.error &&
        typeof parsed.error.code === "string"
      )
        code = parsed.error.code;
    } catch {
      message = body || response.statusText;
    }
    throw new ApiError(response.status, message, code);
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
    request<User>("/api/auth/login", { method: "POST", body: JSON.stringify(payload) }),
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
  addOrganizationMember: (
    slug: string,
    payload: { identifier: string; role: "owner" | "member" }
  ) =>
    request<OrganizationMember>(`/api/forge/organizations/${encodeURIComponent(slug)}/members`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  removeOrganizationMember: async (slug: string, identifier: string): Promise<boolean> => {
    const envelope = await requestEnvelope<RevocationOutcome>(
      `/api/forge/organizations/${encodeURIComponent(slug)}/members/${encodeURIComponent(identifier)}`,
      { method: "DELETE" },
      true
    );
    return envelope?.data.revocationIncomplete === true;
  },
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
  putRepositoryCollaborator: (
    repositoryId: string,
    payload: { identifier: string; role: RepositoryRole }
  ) =>
    request<RepositoryCollaborator>(repositoryPath(repositoryId, "collaborators"), {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
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
