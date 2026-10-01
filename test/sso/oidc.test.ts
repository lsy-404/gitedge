import { FixtureOidc } from "../support/oidc";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as oidc from "openid-client";
import { completeOidc, startOidc } from "../../workers/auth/src/sso/oidc";
import type { OidcProvider } from "../../workers/auth/src/sso/types";

const issuer = "https://identity.example.test";
const callbackUrl = "https://app.example.test/api/auth/sso/callback";
const clientId = "gitedge-oidc-client";
const clientSecret = "test-client-secret";
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

let fixture: FixtureOidc;
function installDiscoveryFetch(): void {
  vi.stubGlobal("fetch", fixture.fetch);
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
  fixture = await FixtureOidc.create();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fixture.tokenRequests.length = 0;
});

describe("OIDC authorization code flow", () => {
  it("uses configured client authentication, S256 PKCE, state and nonce", async () => {
    installDiscoveryFetch();
    for (const { method, callbackMethod } of tokenAuthCases) {
      fixture.tokenRequests.length = 0;
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

      fixture.idToken = await fixture.sign({
        iss: issuer,
        sub: `subject-${method}`,
        aud: clientId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: flow.nonce,
        name: "Fixture User",
        email: "fixture@example.test",
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
        displayName: "Fixture User",
        email: "fixture@example.test",
        emailVerified: true,
      });
      expect(fixture.tokenRequests).toHaveLength(1);
      const request = fixture.tokenRequests[0];
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
    fixture.idToken = await fixture.sign({
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
    const validToken = await fixture.sign({
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
    fixture.idToken = `${header}.${claims}.${firstSignatureCharacter === "A" ? "B" : "A"}${signature.slice(1)}`;

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
