import * as oidc from "openid-client";
import { z } from "zod";
import type {
  OidcProvider,
  SsoAuthorization,
  SsoIdentityClaims,
  SsoProviderSecrets,
} from "./types";

const HTTP_TIMEOUT_SECONDS = 10;
const OidcFlowPayloadSchema = z.object({
  version: z.literal(1),
  providerId: z.string().min(1),
  issuer: z.string().url(),
  clientId: z.string().min(1),
  callbackUrl: z.string().url(),
  codeVerifier: z.string().min(43).max(128),
  nonce: z.string().min(16).max(256),
});
type OidcFlowPayload = z.infer<typeof OidcFlowPayloadSchema>;

function secureUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid OIDC ${field}.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`Invalid OIDC ${field}.`);
  }
  return url;
}

function clientAuthentication(
  provider: OidcProvider,
  secrets: SsoProviderSecrets
): oidc.ClientAuth {
  switch (provider.tokenAuthMethod) {
    case "client_secret_basic":
      if (!secrets.clientSecret) throw new Error("OIDC client secret is required.");
      return oidc.ClientSecretBasic(secrets.clientSecret);
    case "client_secret_post":
      if (!secrets.clientSecret) throw new Error("OIDC client secret is required.");
      return oidc.ClientSecretPost(secrets.clientSecret);
    case "none":
      return oidc.None();
  }
}

async function discover(
  provider: OidcProvider,
  secrets: SsoProviderSecrets
): Promise<oidc.Configuration> {
  const issuer = secureUrl(provider.issuer, "issuer");
  return oidc.discovery(
    issuer,
    provider.clientId,
    { token_endpoint_auth_method: provider.tokenAuthMethod },
    clientAuthentication(provider, secrets),
    {
      execute: [oidc.enableNonRepudiationChecks],
      timeout: HTTP_TIMEOUT_SECONDS,
    }
  );
}

function assertCallbackRequest(callbackRequest: Request, callbackUrl: string): void {
  if (callbackRequest.method !== "GET" && callbackRequest.method !== "POST")
    throw new Error("Unsupported OIDC callback method.");
  const expected = secureUrl(callbackUrl, "callback URL");
  const actual = new URL(callbackRequest.url);
  actual.search = "";
  actual.hash = "";
  if (actual.href !== expected.href) throw new Error("OIDC callback URL mismatch.");
}

function parsePayload(payload: string): OidcFlowPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw new Error("Invalid OIDC flow payload.");
  }
  const parsed = OidcFlowPayloadSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("Invalid OIDC flow payload.");
  return parsed.data;
}

export async function startOidc(
  provider: OidcProvider,
  secrets: SsoProviderSecrets,
  callbackUrl: string,
  state: string
): Promise<SsoAuthorization> {
  if (state.length < 16 || state.length > 512) throw new Error("Invalid OIDC state.");
  const callback = secureUrl(callbackUrl, "callback URL");
  const configuration = await discover(provider, secrets);
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const nonce = oidc.randomNonce();
  const scopes = [...new Set(["openid", ...provider.scopes])];
  const authorizationUrl = oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: callback.href,
    response_type: "code",
    scope: scopes.join(" "),
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const flow: OidcFlowPayload = {
    version: 1,
    providerId: provider.id,
    issuer: provider.issuer,
    clientId: provider.clientId,
    callbackUrl: callback.href,
    codeVerifier,
    nonce,
  };
  return { url: authorizationUrl.href, payload: JSON.stringify(flow) };
}

export async function completeOidc(
  provider: OidcProvider,
  secrets: SsoProviderSecrets,
  callbackRequest: Request,
  callbackUrl: string,
  expectedState: string,
  payload: string
): Promise<SsoIdentityClaims> {
  const flow = parsePayload(payload);
  const callback = secureUrl(callbackUrl, "callback URL");
  if (
    flow.providerId !== provider.id ||
    flow.issuer !== provider.issuer ||
    flow.clientId !== provider.clientId ||
    flow.callbackUrl !== callback.href
  ) {
    throw new Error("OIDC flow does not match the configured provider.");
  }
  if (expectedState.length < 16 || expectedState.length > 512)
    throw new Error("Invalid OIDC state.");
  assertCallbackRequest(callbackRequest, callback.href);
  const configuration = await discover(provider, secrets);
  const tokens = await oidc.authorizationCodeGrant(configuration, callbackRequest, {
    expectedState,
    expectedNonce: flow.nonce,
    pkceCodeVerifier: flow.codeVerifier,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error("OIDC provider did not return an ID token.");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== configuration.serverMetadata().issuer ||
    !audiences.includes(provider.clientId) ||
    (audiences.length > 1 && claims.azp !== provider.clientId) ||
    claims.exp <= now ||
    claims.iat > now + 60 ||
    !claims.sub
  ) {
    throw new Error("OIDC ID token claims are invalid.");
  }
  const email =
    typeof claims.email === "string" && claims.email.length > 0 ? claims.email : undefined;
  const displayName =
    (typeof claims.name === "string" && claims.name.trim()) ||
    (typeof claims.preferred_username === "string" && claims.preferred_username.trim()) ||
    email ||
    claims.sub;
  return {
    subject: claims.sub,
    displayName,
    ...(email === undefined ? {} : { email }),
    emailVerified: claims.email_verified === true,
  };
}
