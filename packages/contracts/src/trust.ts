import { AccessTokenIdentitySchema } from "./access-tokens";
import { AgentSessionIdentitySchema, type Actor } from "./forge";
import type { TrustedUser } from "./index";

export const REPOSITORY_ACCESS_DENIED_HEADER = "X-GitEdge-Repository-Access-Denied";

export const RECENT_AUTH_HEADER = "X-GitEdge-Recent-Auth";

export const TRUSTED_USER_HEADERS = [
  "x-gitedge-user-id",
  "x-gitedge-user-email",
  "x-gitedge-user-name",
  "x-gitedge-user-group",
  "x-gitedge-agent-session",
  "x-gitedge-access-token",
  "x-gitedge-git-grant",
  RECENT_AUTH_HEADER.toLowerCase(),
  REPOSITORY_ACCESS_DENIED_HEADER,
] as const;

export function readTrustedUser(request: Request): TrustedUser | null {
  const id = request.headers.get("X-GitEdge-User-Id");
  const identifier = request.headers.get("X-GitEdge-User-Name");
  const groupKey = request.headers.get("X-GitEdge-User-Group");
  if (!id || !identifier || !groupKey) return null;
  const rawSession = request.headers.get("X-GitEdge-Agent-Session");
  const rawToken = request.headers.get("X-GitEdge-Access-Token");
  const rawRecent = request.headers.get(RECENT_AUTH_HEADER);
  const recent = rawRecent && /^\d{1,16}$/.test(rawRecent) ? Number(rawRecent) : undefined;
  try {
    const agentSession = rawSession
      ? AgentSessionIdentitySchema.safeParse(JSON.parse(rawSession))
      : null;
    const token = rawToken ? AccessTokenIdentitySchema.safeParse(JSON.parse(rawToken)) : null;
    if ((agentSession && !agentSession.success) || (token && !token.success)) return null;
    // Only browser sessions carry a recent human confirmation.
    const human = !agentSession && !token;
    return {
      id,
      identifier,
      groupKey,
      ...(agentSession?.success ? { agentSession: agentSession.data } : {}),
      ...(token?.success ? { token: token.data } : {}),
      ...(human && recent !== undefined ? { recentAuthAt: recent } : {}),
    };
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
    if (user.recentAuthAt !== undefined && !user.agentSession && !user.token)
      headers.set(RECENT_AUTH_HEADER, String(user.recentAuthAt));
    if (user.agentSession)
      headers.set("X-GitEdge-Agent-Session", JSON.stringify(user.agentSession));
    if (user.token) headers.set("X-GitEdge-Access-Token", JSON.stringify(user.token));
  }
  return headers;
}
