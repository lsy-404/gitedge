import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as oidc from "openid-client";
import { completeOidc, startOidc } from "../../workers/auth/src/sso/oidc";
import type { OidcProvider } from "../../workers/auth/src/sso/types";

const issuer = "https://identity.example.test";
const callbackUrl = "https://app.example.test/api/auth/sso/callback";
const clientId = "gitedge-oidc-client";
const clientSecret = "test-client-secret";
const textEncoder = new TextEncoder();
const FlowPayloadSchema = z.object({
  version: z.literal(1),
  providerId: z.string(),
  issuer: z.string(),
  clientId: z.string(),
  callbackUrl: z.string(),
  codeVerifier: z.string(),
  nonce: z.string(),
});

type TokenAuthTestCase = {
  method: OidcProvider["tokenAuthMethod"];
  callbackMethod: "GET" | "POST";
};
const tokenAuthCases: TokenAuthTestCase[] = [
  { method: "client_secret_basic", callbackMethod: "GET" },
  { method: "client_secret_post", callbackMethod: "POST" },
  { method: "none", callbackMethod: "GET" },
];

function parseFlowPayload(payload: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw new Error("Invalid test flow payload.");
  }
  return FlowPayloadSchema.parse(decoded);
}

let signingKey: CryptoKey | null = null;
let publicJwk: JsonWebKey | null = null;
let responseIdToken = "";
const tokenRequests: Array<{ authorization: string | null; body: URLSearchParams }> = [];

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signIdToken(claims: Record<string, string | number | boolean>): Promise<string> {
  if (!signingKey) throw new Error("OIDC signing key is not initialized.");
  const header = base64Url(
    textEncoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }))
  );
  const payload = base64Url(textEncoder.encode(JSON.stringify(claims)));
  const content = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    textEncoder.encode(content)
  );
  return `${content}.${base64Url(new Uint8Array(signature))}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestBody(body: BodyInit | null | undefined): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  return typeof body === "string" ? new URLSearchParams(body) : new URLSearchParams();
}

function installDiscoveryFetch(): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(requestUrl(input));
      if (url.href === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: [
            "client_secret_basic",
            "client_secret_post",
            "none",
          ],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.href === `${issuer}/jwks`) {
        if (!publicJwk) throw new Error("OIDC public key is not initialized.");
        return Response.json({
          keys: [{ ...publicJwk, kid: "test-key", use: "sig", alg: "RS256" }],
        });
      }
      if (url.href === `${issuer}/token`) {
        const body = requestBody(init?.body);
        const headers = new Headers(init?.headers);
        tokenRequests.push({ authorization: headers.get("Authorization"), body });
        return Response.json({
          access_token: "ephemeral-access-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: responseIdToken,
        });
      }
      return new Response("Not found", { status: 404 });
    }
  );
}

function provider(tokenAuthMethod: OidcProvider["tokenAuthMethod"]): OidcProvider {
  return {
    id: `oidc-${tokenAuthMethod}`,
    label: "Test identity provider",
    allowSignup: true,
    protocol: "oidc",
    issuer,
    clientId,
    scopes: ["profile", "email", "openid"],
    tokenAuthMethod,
  };
}

beforeAll(async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  signingKey = keys.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
});

afterEach(() => {
  vi.unstubAllGlobals();
  tokenRequests.length = 0;
});

describe("OIDC authorization code flow", () => {
  it("uses configured client authentication, S256 PKCE, state and nonce", async () => {
    installDiscoveryFetch();
    for (const { method, callbackMethod } of tokenAuthCases) {
      tokenRequests.length = 0;
      const currentProvider = provider(method);
      const secrets = method === "none" ? {} : { clientSecret };
      const state = `state-for-${method}-roundtrip`;
      const authorization = await startOidc(currentProvider, secrets, callbackUrl, state);
      const authorizationUrl = new URL(authorization.url);
      const flow = parseFlowPayload(authorization.payload);
      expect(authorizationUrl.origin).toBe(issuer);
      expect(authorizationUrl.pathname).toBe("/authorize");
      expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(callbackUrl);
      expect(authorizationUrl.searchParams.get("scope")).toBe("openid profile email");
      expect(authorizationUrl.searchParams.get("state")).toBe(state);
      expect(authorizationUrl.searchParams.get("nonce")).toBe(flow.nonce);
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("code_challenge")).toBe(
        await oidc.calculatePKCECodeChallenge(flow.codeVerifier)
      );
      expect(flow).toMatchObject({ providerId: currentProvider.id, issuer, clientId, callbackUrl });

      responseIdToken = await signIdToken({
        iss: issuer,
        sub: `subject-${method}`,
        aud: clientId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: flow.nonce,
        name: "Rosmontis",
        email: "rosmontis@example.test",
        email_verified: true,
      });
      const callback =
        callbackMethod === "POST"
          ? new Request(callbackUrl, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ code: "one-time-code", state }),
            })
          : new Request(`${callbackUrl}?code=one-time-code&state=${encodeURIComponent(state)}`);
      const identity = await completeOidc(
        currentProvider,
        secrets,
        callback,
        callbackUrl,
        state,
        authorization.payload
      );
      expect(identity).toEqual({
        subject: `subject-${method}`,
        displayName: "Rosmontis",
        email: "rosmontis@example.test",
        emailVerified: true,
      });
      expect(tokenRequests).toHaveLength(1);
      const request = tokenRequests[0];
      expect(request?.body.get("code_verifier")).toBe(flow.codeVerifier);
      if (method === "client_secret_basic") {
        const authorization = request?.authorization;
        expect(authorization?.startsWith("Basic ")).toBe(true);
        const encodedCredentials = authorization?.slice("Basic ".length) ?? "";
        const decodedCredentials = atob(encodedCredentials);
        const [encodedClientId, encodedSecret] = decodedCredentials.split(":");
        expect(decodeURIComponent(encodedClientId ?? "")).toBe(clientId);
        expect(decodeURIComponent(encodedSecret ?? "")).toBe(clientSecret);
        expect(request?.body.has("client_secret")).toBe(false);
      } else if (method === "client_secret_post") {
        expect(request?.authorization).toBeNull();
        expect(request?.body.get("client_secret")).toBe(clientSecret);
      } else {
        expect(request?.authorization).toBeNull();
        expect(request?.body.has("client_secret")).toBe(false);
      }
    }
  });

  it("returns unverified email as explicitly unverified", async () => {
    installDiscoveryFetch();
    const currentProvider = provider("none");
    const authorization = await startOidc(
      currentProvider,
      {},
      callbackUrl,
      "state-for-unverified-email"
    );
    const flow = parseFlowPayload(authorization.payload);
    responseIdToken = await signIdToken({
      iss: issuer,
      sub: "subject-unverified",
      aud: clientId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: flow.nonce,
      email: "unverified@example.test",
      email_verified: false,
    });
    const callback = new Request(
      `${callbackUrl}?code=one-time-code&state=state-for-unverified-email`
    );
    await expect(
      completeOidc(
        currentProvider,
        {},
        callback,
        callbackUrl,
        "state-for-unverified-email",
        authorization.payload
      )
    ).resolves.toEqual({
      subject: "subject-unverified",
      displayName: "unverified@example.test",
      email: "unverified@example.test",
      emailVerified: false,
    });
  });

  it("rejects an ID token with a tampered signature", async () => {
    installDiscoveryFetch();
    const currentProvider = provider("none");
    const state = "state-for-tampered-signature";
    const authorization = await startOidc(currentProvider, {}, callbackUrl, state);
    const flow = parseFlowPayload(authorization.payload);
    const validToken = await signIdToken({
      iss: issuer,
      sub: "subject-tampered-signature",
      aud: clientId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: flow.nonce,
    });
    const [header, claims, signature] = validToken.split(".");
    if (!header || !claims || !signature) throw new Error("Invalid signed test token.");
    const firstSignatureCharacter = signature[0];
    if (!firstSignatureCharacter) throw new Error("Invalid signed test token.");
    responseIdToken = `${header}.${claims}.${firstSignatureCharacter === "A" ? "B" : "A"}${signature.slice(1)}`;

    await expect(
      completeOidc(
        currentProvider,
        {},
        new Request(`${callbackUrl}?code=one-time-code&state=${state}`),
        callbackUrl,
        state,
        authorization.payload
      )
    ).rejects.toThrow();
  });
});
