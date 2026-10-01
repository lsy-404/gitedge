import { afterEach, describe, expect, it, vi } from "vitest";
import { startOidc, startOidcLogout } from "../../workers/auth/src/sso/oidc";
import type { OidcProvider } from "../../workers/auth/src/sso/types";

const issuer = "https://identity.example.test";
const clientId = "test-oidc-client";
const provider: OidcProvider = {
  id: "oidc-test",
  label: "Test identity provider",
  allowSignup: true,
  protocol: "oidc",
  issuer,
  clientId,
  scopes: ["profile"],
  tokenAuthMethod: "none",
};

function installDiscovery(endSessionEndpoint?: string): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== `${issuer}/.well-known/openid-configuration`)
      return new Response("Not found", { status: 404 });
    return Response.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      ...(endSessionEndpoint === undefined ? {} : { end_session_endpoint: endSessionEndpoint }),
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("OIDC RP logout and local callback URLs", () => {
  it("builds a provider logout URL without requiring an ID token", async () => {
    installDiscovery(`${issuer}/logout`);
    const url = await startOidcLogout(
      provider,
      {},
      "https://app.example.test/logout/callback",
      "logout-state-value-123"
    );
    expect(url).not.toBeNull();
    const logoutUrl = new URL(url ?? "");
    expect(logoutUrl.origin).toBe(issuer);
    expect(logoutUrl.pathname).toBe("/logout");
    expect(logoutUrl.searchParams.get("client_id")).toBe(clientId);
    expect(logoutUrl.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://app.example.test/logout/callback"
    );
    expect(logoutUrl.searchParams.get("state")).toBe("logout-state-value-123");
    expect(logoutUrl.searchParams.has("id_token_hint")).toBe(false);
  });

  it("returns null when the provider does not advertise an end-session endpoint", async () => {
    installDiscovery();
    await expect(
      startOidcLogout(
        provider,
        {},
        "https://app.example.test/logout/callback",
        "logout-state-value-123"
      )
    ).resolves.toBeNull();
  });

  it("accepts HTTP only for loopback OIDC callbacks", async () => {
    installDiscovery(`${issuer}/logout`);
    const authorization = await startOidc(
      provider,
      {},
      "http://127.0.0.1:8788/api/auth/sso/callback",
      "local-state-value-123"
    );
    expect(new URL(authorization.url).searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8788/api/auth/sso/callback"
    );
    await expect(
      startOidcLogout(provider, {}, "http://app.example.test/logout", "logout-state-value-123")
    ).rejects.toThrow("Invalid OIDC callback URL.");
  });
});
