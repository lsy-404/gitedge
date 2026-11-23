import { z } from "zod";
import { base64UrlToBytes, bytesToBase64Url } from "../../../../src/worker/common/encoding";
import { readJsonLimited } from "../../../../src/worker/common/readText";

// The public installed-app client that google-colab-cli ships; its secret is published with the client.
const CLIENT_ID = "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com";
const CLIENT_SECRET = "d-FL95Q19q7MQmFpd7hHD0Ty";
// The only redirect registered for that client; Google shows the code there for the user to paste.
const REDIRECT_URI = "https://sdk.cloud.google.com/applicationdefaultauthcode.html";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/colaboratory",
];
const REQUEST_TIMEOUT_MS = 20_000;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
});
const tokenErrorSchema = z.object({ error: z.string() });
const idTokenSchema = z.object({ email: z.string().email() });

export interface GoogleTokens {
  accessToken: string;
  expiresAt: number;
  refreshToken: string | null;
  email: string | null;
}

export class GoogleGrantError extends Error {
  constructor(readonly code: string) {
    super(`Google rejected the grant: ${code}`);
  }
}

export function createCodeVerifier(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function authorizationUrl(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    prompt: "consent",
    access_type: "offline",
    token_usage: "remote",
    code_challenge: bytesToBase64Url(new Uint8Array(digest)),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = idTokenSchema.safeParse(
      JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)))
    );
    return claims.success ? claims.data.email : null;
  } catch {
    return null;
  }
}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await readJsonLimited(response, 65_536).catch(() => null);
  if (!response.ok) {
    const error = tokenErrorSchema.safeParse(payload);
    if (response.status === 400 && error.success) throw new GoogleGrantError(error.data.error);
    throw new Error(`Google token endpoint returned HTTP ${response.status}.`);
  }
  const tokens = tokenSchema.parse(payload);
  return {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    refreshToken: tokens.refresh_token ?? null,
    email: emailFromIdToken(tokens.id_token),
  };
}

export function exchangeAuthorizationCode(code: string, verifier: string): Promise<GoogleTokens> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
}

export function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}
