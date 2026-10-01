import type { SsoProviderSummary, TrustedUser } from "../../../../packages/contracts/src/index";
import { createLogger } from "../../../../src/worker/common/logger";
import { readTextLimited } from "../../../../src/worker/common/readText";
import {
  createToken,
  hashToken,
  issueSession,
  createSessionCookie,
  readCookie,
  SESSION_MAX_AGE_SECONDS,
} from "../session";
import { ssoProviders, ssoSecrets } from "./config";
import { listSsoIdentities, resolveSsoIdentity, unlinkSsoIdentity } from "./identities";
import { startOidc, completeOidc } from "./oidc";
import { startSaml, completeSaml, samlMetadata } from "./saml";
import type { SsoEnvironment, SsoIdentityClaims, SsoProvider, SsoProviderSecrets } from "./types";

const FLOW_COOKIE = "gitedge_sso";
const FLOW_SECONDS = 600;
interface SsoRequestRow {
  intent: "login" | "link" | "logout";
  user_id: string | null;
  session_hash: string | null;
  return_to: string;
  callback_url: string;
  payload: string;
}
function json(data: unknown, status = 200): Response {
  return Response.json({ data }, { status, headers: { "Cache-Control": "no-store" } });
}
function fail(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}
function flowCookie(value: string, age = FLOW_SECONDS): string {
  // SAML POST callbacks need the browser proof on cross-site navigations.
  return `${FLOW_COOKIE}=${value}; Path=/api/auth/sso; Secure; HttpOnly; SameSite=None; Max-Age=${age}`;
}
function browserProof(request: Request): string {
  const entry = request.headers
    .get("Cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${FLOW_COOKIE}=`));
  return entry?.slice(FLOW_COOKIE.length + 1) ?? "";
}
function safeReturnTo(value: string, origin: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f]/.test(value) &&
    new URL(value, origin).origin === origin
  );
}
function callbackUrl(request: Request, provider: SsoProvider): string {
  return new URL(`/api/auth/sso/${provider.id}/callback`, request.url).toString();
}
function redirect(returnTo: string, errorCode?: string): Response {
  const target = new URL(returnTo, "https://gitedge.invalid");
  if (errorCode) target.searchParams.set("error", `sso_${errorCode}`);
  const headers = new Headers({
    Location: `${target.pathname}${target.search}`,
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", flowCookie("", 0));
  return new Response(null, { status: 303, headers });
}
function validClaims(claims: SsoIdentityClaims): boolean {
  return Boolean(
    claims.subject &&
    claims.subject.length <= 1024 &&
    claims.displayName.length <= 512 &&
    (!claims.email || claims.email.length <= 320)
  );
}
async function finishLogin(
  env: SsoEnvironment,
  provider: SsoProvider,
  flow: SsoRequestRow,
  claims: SsoIdentityClaims,
  request: Request
): Promise<Response> {
  if (!validClaims(claims)) return redirect(flow.return_to, "invalid_response");
  let linkUser: TrustedUser | null = null;
  if (flow.intent === "link") {
    linkUser = await env.DB.prepare(
      "SELECT u.id, u.identifier, u.group_key AS groupKey FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ?"
    )
      .bind(flow.session_hash, flow.user_id, Date.now())
      .first<TrustedUser>();
    if (!linkUser) return redirect(flow.return_to, "expired");
  }
  const resolved = await resolveSsoIdentity(env, provider, claims, linkUser);
  if (!resolved.ok) return redirect(flow.return_to, resolved.reason);
  const response = redirect(flow.return_to);
  if (flow.intent === "link") {
    const target = new URL(flow.return_to, "https://gitedge.invalid");
    target.searchParams.set("sso", "linked");
    response.headers.set("Location", `${target.pathname}${target.search}`);
  } else {
    const token = await issueSession(env, resolved.identity.userId);
    await env.DB.prepare("INSERT INTO auth_sso_sessions (token_hash, identity_id) VALUES (?, ?)")
      .bind(await hashToken(token), resolved.identity.id)
      .run();
    const previous = readCookie(request);
    if (previous)
      await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
        .bind(await hashToken(previous))
        .run();
    response.headers.append("Set-Cookie", createSessionCookie(token, SESSION_MAX_AGE_SECONDS));
  }
  createLogger(env.LOG_LEVEL, { service: "sso" }).info("sso:authenticated", {
    providerId: provider.id,
    protocol: provider.protocol,
    userId: resolved.identity.userId,
    intent: flow.intent,
  });
  return response;
}

async function handleSsoRequest(
  request: Request,
  env: SsoEnvironment,
  user: TrustedUser | null
): Promise<Response> {
  const logger = createLogger(env.LOG_LEVEL, { service: "sso" });
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  let providers: SsoProvider[];
  try {
    providers = ssoProviders(env);
  } catch {
    logger.error("sso:configuration-invalid", {});
    return fail(503, "sso_configuration", "SSO provider configuration is unavailable.");
  }
  if (parts[1] === "providers" && parts.length === 2 && request.method === "GET") {
    const summaries: SsoProviderSummary[] = providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      protocol: provider.protocol,
      ...(provider.protocol === "saml"
        ? { metadataUrl: new URL(`/api/auth/sso/${provider.id}/metadata`, url).toString() }
        : {}),
    }));
    return json(summaries);
  }
  if (parts[1] === "identities") {
    if (!user || user.agentSession || request.headers.has("Authorization"))
      return fail(401, "unauthorized", "A human account session is required.");
    if (request.method === "GET" && parts.length === 2)
      return json(await listSsoIdentities(env, user, providers));
    if (request.method === "DELETE" && parts.length === 3) {
      if (request.headers.get("Origin") !== url.origin)
        return fail(403, "forbidden", "Same-origin account management is required.");
      if (!(await unlinkSsoIdentity(env, user, parts[2], providers)))
        return fail(
          409,
          "last_login_method",
          "Identity was not found or is the account's last login method."
        );
      logger.info("sso:identity-unlinked", { userId: user.id, identityId: parts[2] });
      return json({ unlinked: true });
    }
    return fail(405, "method_not_allowed", "Method is not allowed.");
  }
  const provider = providers.find((candidate) => candidate.id === parts[1]);
  if (!provider || parts.length !== 3) return fail(404, "not_found", "SSO provider was not found.");
  let secrets: SsoProviderSecrets;
  try {
    secrets = ssoSecrets(env, provider);
  } catch {
    return fail(503, "sso_configuration", "SSO provider credentials are unavailable.");
  }
  if (parts[2] === "metadata" && request.method === "GET" && provider.protocol === "saml") {
    return new Response(samlMetadata(provider, secrets, callbackUrl(request, provider)), {
      headers: { "Content-Type": "application/samlmetadata+xml", "Cache-Control": "no-store" },
    });
  }
  if (
    (parts[2] === "start" && request.method === "GET") ||
    (parts[2] === "link" && request.method === "POST")
  ) {
    const linking = parts[2] === "link";
    if (linking && (!user || user.agentSession || request.headers.has("Authorization")))
      return fail(401, "unauthorized", "A human account session is required.");
    if (linking && request.headers.get("Origin") !== url.origin)
      return fail(403, "forbidden", "Same-origin account management is required.");
    let returnTo =
      url.searchParams.get("returnTo") ?? (linking ? "/settings/account" : "/dashboard");
    if (linking) {
      const text = await readTextLimited(request.body, 4096);
      if (text === null)
        return fail(413, "bad_request", "Account-link request exceeded the size limit.");
      try {
        const input: unknown = JSON.parse(text ?? "null");
        if (
          input &&
          typeof input === "object" &&
          "returnTo" in input &&
          typeof input.returnTo === "string"
        )
          returnTo = input.returnTo;
      } catch {
        return fail(400, "bad_request", "Invalid account-link request.");
      }
    }
    if (!safeReturnTo(returnTo, url.origin))
      return fail(400, "bad_request", "The return path must stay on this site.");
    const state = createToken();
    const proof = createToken();
    const callback = callbackUrl(request, provider);
    try {
      const authorization =
        provider.protocol === "oidc"
          ? await startOidc(provider, secrets, callback, state)
          : await startSaml(provider, secrets, callback, state);
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM auth_sso_requests WHERE expires_at <= ?").bind(now),
        env.DB.prepare(
          "INSERT INTO auth_sso_requests (state_hash, provider_id, issuer, browser_hash, intent, user_id, session_hash, return_to, callback_url, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          await hashToken(state),
          provider.id,
          provider.issuer,
          await hashToken(proof),
          linking ? "link" : "login",
          linking ? (user?.id ?? null) : null,
          linking ? await hashToken(readCookie(request) ?? "") : null,
          returnTo,
          callback,
          authorization.payload,
          now,
          now + FLOW_SECONDS * 1000
        ),
      ]);
      logger.info("sso:started", { providerId: provider.id, protocol: provider.protocol, linking });
      const response = linking
        ? json({ url: authorization.url })
        : new Response(null, {
            status: 302,
            headers: { Location: authorization.url, "Cache-Control": "no-store" },
          });
      response.headers.append("Set-Cookie", flowCookie(proof));
      return response;
    } catch {
      logger.warn("sso:start-failed", { providerId: provider.id });
      return fail(
        502,
        "sso_configuration",
        "The identity provider could not start authentication."
      );
    }
  }
  if (parts[2] === "callback" && ["GET", "POST"].includes(request.method)) {
    const body = request.method === "POST" ? await readTextLimited(request.body, 1024 * 1024) : "";
    if (body === null) return fail(413, "bad_request", "SSO response exceeded the size limit.");
    const params = request.method === "POST" ? new URLSearchParams(body) : url.searchParams;
    const state = params.get(provider.protocol === "saml" ? "RelayState" : "state");
    const proof = browserProof(request);
    if (!state || state.length > 128 || !proof || proof.length > 128)
      return fail(400, "sso_expired", "Authentication state is missing or expired.");
    const flow = await env.DB.prepare(
      "DELETE FROM auth_sso_requests WHERE state_hash = ? AND provider_id = ? AND issuer = ? AND browser_hash = ? AND expires_at > ? RETURNING intent, user_id, session_hash, return_to, callback_url, payload"
    )
      .bind(
        await hashToken(state),
        provider.id,
        provider.issuer,
        await hashToken(proof),
        Date.now()
      )
      .first<SsoRequestRow>();
    if (!flow)
      return fail(400, "sso_expired", "Authentication state is invalid, expired, or already used.");
    if (new URL(flow.callback_url).origin !== url.origin)
      return redirect(flow.return_to, "invalid_response");
    try {
      let claims: SsoIdentityClaims;
      if (provider.protocol === "saml") {
        const assertion = params.get("SAMLResponse");
        if (request.method !== "POST" || !assertion)
          return redirect(flow.return_to, "invalid_response");
        claims = await completeSaml(provider, secrets, flow.callback_url, assertion, flow.payload);
      } else {
        const publicUrl = new URL(flow.callback_url);
        publicUrl.search = url.search;
        const callbackRequest = new Request(publicUrl, {
          method: request.method,
          headers: request.headers,
          ...(request.method === "POST" ? { body } : {}),
        });
        claims = await completeOidc(
          provider,
          secrets,
          callbackRequest,
          flow.callback_url,
          state,
          flow.payload
        );
      }
      return await finishLogin(env, provider, flow, claims, request);
    } catch {
      logger.warn("sso:callback-rejected", {
        providerId: provider.id,
        protocol: provider.protocol,
      });
      return redirect(flow.return_to, "invalid_response");
    }
  }
  return fail(405, "method_not_allowed", "Method is not allowed.");
}

export async function handleSso(
  request: Request,
  env: SsoEnvironment,
  user: TrustedUser | null
): Promise<Response> {
  try {
    return await handleSsoRequest(request, env, user);
  } catch {
    createLogger(env.LOG_LEVEL, { service: "sso" }).error("sso:request-failed", {});
    return fail(503, "sso_unavailable", "Single sign-on is temporarily unavailable.");
  }
}
