import { AgentSessionIdentitySchema, type Actor } from "./forge";
import type { TrustedUser } from "./index";

export const REPOSITORY_ACCESS_DENIED_HEADER = "X-GitEdge-Repository-Access-Denied";

export const TRUSTED_USER_HEADERS = [
  "x-gitedge-user-id",
  "x-gitedge-user-email",
  "x-gitedge-user-name",
  "x-gitedge-user-group",
  "x-gitedge-agent-session",
  "x-gitedge-git-grant",
  REPOSITORY_ACCESS_DENIED_HEADER,
] as const;

export function readTrustedUser(request: Request): TrustedUser | null {
  const id = request.headers.get("X-GitEdge-User-Id");
  const identifier = request.headers.get("X-GitEdge-User-Name");
  const groupKey = request.headers.get("X-GitEdge-User-Group");
  if (!id || !identifier || !groupKey) return null;
  const rawSession = request.headers.get("X-GitEdge-Agent-Session");
  if (!rawSession) return { id, identifier, groupKey };
  try {
    const parsed = AgentSessionIdentitySchema.safeParse(JSON.parse(rawSession));
    return parsed.success ? { id, identifier, groupKey, agentSession: parsed.data } : null;
  } catch {
    return null;
  }
}

export function actorForUser(user: TrustedUser): Actor {
  const session = user.agentSession;
  return session
    ? { kind: "agent", id: session.agentId, name: session.agentName, sessionId: session.id }
    : { kind: "user", id: user.id, name: user.identifier };
}

export function trustedHeaders(user?: TrustedUser): Headers {
  const headers = new Headers();
  if (user) {
    headers.set("X-GitEdge-User-Id", user.id);
    headers.set("X-GitEdge-User-Name", user.identifier);
    headers.set("X-GitEdge-User-Group", user.groupKey);
    if (user.agentSession)
      headers.set("X-GitEdge-Agent-Session", JSON.stringify(user.agentSession));
  }
  return headers;
}
