import type {
  Organization,
  OrganizationMember,
  User,
} from "../../../../packages/contracts/src/account";
import type {
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
  Issue,
  PullRequest,
  Repository,
  Review,
  WikiPage,
  CreatedAgentSession,
} from "../../../../packages/contracts/src/forge";
import type { SsoIdentity, SsoProviderSummary } from "../../../../packages/contracts/src/sso";
import type {
  AgentAssignmentPolicy,
  AssigneeCandidate,
  AssigneeRef,
  AssignmentRole,
  DocumentRevisionSummary,
  MemoryIndex,
  MemoryVisibility,
  RepositorySettings,
  RevisionActor,
  Task,
  TaskCommit,
  TaskDetail,
  TaskDocument,
  TaskDocumentKind,
  TaskLink,
  TaskLinkKind,
  TaskStatus,
  TaskTable,
} from "../../../../packages/contracts/src/tasks";

export type {
  Organization,
  OrganizationMember,
  User,
} from "../../../../packages/contracts/src/account";
export type {
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
  Issue,
  PullRequest,
  Repository,
  Review,
  WikiPage,
  CreatedAgentSession,
};
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
  RevisionActor,
  Task,
  TaskCommit,
  TaskDetail,
  TaskDocument,
  TaskDocumentKind,
  TaskLink,
  TaskLinkKind,
  TaskStatus,
  TaskTable,
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
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
}

function request<T>(path: string, init?: RequestInit): Promise<T>;
function request(path: string, init: RequestInit | undefined, allowNoContent: true): Promise<void>;
async function request<T>(
  path: string,
  init?: RequestInit,
  allowNoContent = false
): Promise<T | void> {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!response.ok) {
    const body = await response.text();
    let message = body || response.statusText;
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
    } catch {
      message = body || response.statusText;
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) {
    if (allowNoContent) return;
    throw new ApiError(response.status, "Expected a response body");
  }
  const envelope: ApiEnvelope<T> = await response.json();
  if (!envelope || typeof envelope !== "object" || !("data" in envelope)) {
    throw new ApiError(response.status, "Invalid response envelope");
  }
  return envelope.data;
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const value = params.toString();
  return value ? `?${value}` : "";
}

function repositoryPath(repositoryId: string, resource: string): string {
  return `/api/forge/repositories/${encodeURIComponent(repositoryId)}/${resource}`;
}

function gitPath(repositoryId: string, resource: string): string {
  return `/api/git/repositories/${encodeURIComponent(repositoryId)}/${resource}`;
}

export const api = {
  login: (payload: { identifier: string; password: string }) =>
    request<User>("/api/auth/login", { method: "POST", body: JSON.stringify(payload) }),
  register: (payload: { identifier: string; password: string }) =>
    request<User>("/api/auth/register", { method: "POST", body: JSON.stringify(payload) }),
  logout: () => request("/api/auth/logout", { method: "POST" }, true),
  session: () => request<User>("/api/auth/session"),
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
  repository: (owner: string, repo: string) =>
    request<Repository>(
      `/api/forge/repositories/by-name/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    ),
  createRepository: (payload: {
    name: string;
    owner: string;
    description: string;
    visibility: "public" | "private";
  }) =>
    request<Repository>("/api/forge/repositories", {
      method: "POST",
      body: JSON.stringify({
        slug: payload.name,
        owner: payload.owner,
        description: payload.description,
        visibility: payload.visibility,
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
  refs: (repositoryId: string) => request<GitRef[]>(gitPath(repositoryId, "refs")),
  tree: (repositoryId: string, ref: string, path: string) =>
    request<GitTree>(gitPath(repositoryId, `tree${query({ ref, path })}`)),
  file: (repositoryId: string, ref: string, path: string) =>
    request<GitFile>(gitPath(repositoryId, `file${query({ ref, path })}`)),
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
  issues: (repositoryId: string) => request<Issue[]>(repositoryPath(repositoryId, "issues")),
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
    request<PullRequest[]>(repositoryPath(repositoryId, "pull-requests")),
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
    payload: { expectedBaseOid: string; expectedHeadOid: string }
  ) =>
    request<PullRequest>(repositoryPath(repositoryId, `pull-requests/${number}/merge`), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  discussions: (repositoryId: string) =>
    request<Discussion[]>(repositoryPath(repositoryId, "discussions")),
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
  wiki: (repositoryId: string) => request<WikiPage[]>(repositoryPath(repositoryId, "wiki")),
  wikiPage: (repositoryId: string, slug: string) =>
    request<WikiPage>(repositoryPath(repositoryId, `wiki/${encodeURIComponent(slug)}`)),
  wikiHistory: (repositoryId: string, slug: string) =>
    request<WikiPage[]>(repositoryPath(repositoryId, `wiki/${encodeURIComponent(slug)}/history`)),
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
  ) => request<Comment[]>(repositoryPath(repositoryId, `${resource}/${number}/comments`)),
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
    payload: { memoryVisibility?: MemoryVisibility; agentAssignmentPolicy?: AgentAssignmentPolicy }
  ) =>
    request<RepositorySettings>(repositoryPath(repositoryId, "settings"), {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  agents: () => request<Agent[]>("/api/auth/agents"),
  createAgent: (payload: { name: string; description: string }) =>
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
};
