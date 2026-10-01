import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { createSign, createVerify } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import auth from "../../workers/auth/src/index";
import { completeSamlLogoutNotification } from "../../workers/auth/src/sso/saml";
import type { SamlProvider, SsoProviderSecrets } from "../../workers/auth/src/sso/types";
import { issueSession, hashToken } from "../../workers/auth/src/session";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";
import { certificate, privateKey } from "../support/saml-keys";

const origin = "https://gitedge.example.test";
const callback = `${origin}/api/auth/sso/enterprise/callback`;
const logout = `${origin}/api/auth/sso/enterprise/logout-callback`;
const nameIdFormat = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const algorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const provider: SamlProvider = {
  id: "enterprise",
  label: "Enterprise",
  protocol: "saml",
  allowSignup: false,
  issuer: "https://identity.example.test/realm",
  entryPoint: "https://identity.example.test/login",
  logoutUrl: "https://identity.example.test/logout",
  certificates: [certificate],
  signingCertificate: certificate,
  signatureValidation: "both",
};
const secrets: SsoProviderSecrets = { privateKey };
const environment: Parameters<typeof auth.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: new FixtureArtifacts(),
  ALLOW_PUBLIC_SIGNUP: "true",
  DEFAULT_USER_GROUP: "free",
  SSO_PROVIDERS_JSON: JSON.stringify([provider]),
  SSO_SECRETS_JSON: JSON.stringify({ enterprise: secrets }),
};
const migrations = import.meta.glob<string>("../../migrations/000*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

interface LogoutOptions {
  id?: string;
  subject?: string;
  indexes?: string[];
  issuer?: string;
  destination?: string;
  issuedAt?: string;
  signature?: "sha1" | "sha256" | "none";
}
function message(options: LogoutOptions = {}): string {
  const xml = `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${options.id ?? `_request-${crypto.randomUUID()}`}" Version="2.0" IssueInstant="${options.issuedAt ?? new Date().toISOString()}" Destination="${options.destination ?? logout}"><saml:Issuer>${options.issuer ?? provider.issuer}</saml:Issuer><saml:NameID Format="${nameIdFormat}">${options.subject ?? "subject-1"}</saml:NameID>${(options.indexes ?? ["session-1"]).map((index) => `<samlp:SessionIndex>${index}</samlp:SessionIndex>`).join("")}</samlp:LogoutRequest>`;
  if (options.signature === "none") return xml;
  const signer = new SignedXml({
    privateKey,
    signatureAlgorithm:
      options.signature === "sha1" ? "http://www.w3.org/2000/09/xmldsig#rsa-sha1" : algorithm,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signer.addReference({
    xpath: "/*[local-name()='LogoutRequest']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(xml);
  return signer.getSignedXml();
}
function post(xml: string, cookie = ""): Request {
  return new Request(logout, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams({
      SAMLRequest: Buffer.from(xml).toString("base64"),
      RelayState: "provider-return-state",
    }),
  });
}
function redirect(xml: string): Request {
  const params = new URLSearchParams({
    SAMLRequest: deflateRawSync(xml).toString("base64"),
    RelayState: "provider-return-state",
    SigAlg: algorithm,
  });
  const signer = createSign("RSA-SHA256");
  signer.update(params.toString());
  params.set("Signature", signer.sign(privateKey, "base64"));
  return new Request(`${logout}?${params}`);
}
function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace("/api/auth", "");
  return auth.fetch(new Request(url, request), environment);
}
async function session(userId: string, identityId?: string, index = "session-1"): Promise<string> {
  const token = await issueSession(environment, userId);
  if (identityId)
    await env.DB.prepare(
      "INSERT INTO auth_sso_sessions (token_hash, identity_id, session_index) VALUES (?, ?, ?)"
    )
      .bind(await hashToken(token), identityId, index)
      .run();
  return token;
}
async function exists(token: string): Promise<boolean> {
  return Boolean(
    await env.DB.prepare("SELECT token_hash FROM auth_sessions WHERE token_hash = ?")
      .bind(await hashToken(token))
      .first()
  );
}
beforeAll(async () => {
  for (const [name, sql] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b)))
    await runSqlScript(env.DB, sql);
  for (const id of ["u1", "u2"]) {
    await env.DB.prepare(
      "INSERT INTO users (id, identifier, password_salt, password_hash, created_at, group_key) VALUES (?, ?, 'fixture', 'fixture', ?, 'free')"
    )
      .bind(id, `person-${id}`, Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO auth_sso_identities (id, provider_id, protocol, issuer, subject, user_id, display_name, email_verified, name_id_format, created_at, last_login_at) VALUES (?, ?, 'saml', ?, ?, ?, 'Fixture', 0, ?, ?, ?)"
    )
      .bind(
        `identity-${id}`,
        provider.id,
        provider.issuer,
        id === "u1" ? "subject-1" : "subject-2",
        id,
        nameIdFormat,
        Date.now(),
        Date.now()
      )
      .run();
  }
});

describe("IdP SAML logout notifications", () => {
  it("validates POST and Redirect requests and returns a signed provider-bound response", async () => {
    for (const request of [post(message()), redirect(message({ signature: "none" }))]) {
      const result = await completeSamlLogoutNotification(
        provider,
        secrets,
        callback,
        logout,
        request
      );
      expect(result.subject).toBe("subject-1");
      expect(result.sessionIndexes).toEqual(["session-1"]);
      const target = new URL(result.responseUrl);
      expect(`${target.origin}${target.pathname}`).toBe(provider.logoutUrl);
      expect(target.searchParams.get("RelayState")).toBe("provider-return-state");
      const encoded = target.searchParams.get("SAMLResponse") ?? "";
      expect(inflateRawSync(Buffer.from(encoded, "base64")).toString()).toContain(
        `InResponseTo="${result.requestId}"`
      );
      const params = new URLSearchParams({
        SAMLResponse: encoded,
        RelayState: "provider-return-state",
        SigAlg: algorithm,
      });
      const verify = createVerify("RSA-SHA256");
      verify.update(params.toString());
      expect(verify.verify(certificate, target.searchParams.get("Signature") ?? "", "base64")).toBe(
        true
      );
    }
  });
  it("rejects unsigned, weak, modified, misdirected and expired requests", async () => {
    for (const xml of [
      message({ signature: "none" }),
      message({ signature: "sha1" }),
      message().replace("subject-1", "subject-2"),
      message({ issuer: "https://another.example.test" }),
      message({ destination: "https://another.example.test/logout" }),
      message({ issuedAt: new Date(Date.now() - 700_000).toISOString() }),
    ]) {
      await expect(
        completeSamlLogoutNotification(provider, secrets, callback, logout, post(xml))
      ).rejects.toThrow();
    }
    const unsignedRedirect = new URL(redirect(message({ signature: "none" })).url);
    unsignedRedirect.searchParams.delete("Signature");
    await expect(
      completeSamlLogoutNotification(
        provider,
        secrets,
        callback,
        logout,
        new Request(unsignedRedirect)
      )
    ).rejects.toThrow();
  });
  it("invalidates only matching SAML sessions and preserves an unrelated pending browser flow", async () => {
    const target = await session("u1", "identity-u1");
    const otherIndex = await session("u1", "identity-u1", "another-session");
    const passwordSession = await session("u1");
    const otherUser = await session("u2", "identity-u2");
    const response = await route(
      post(message(), `gitedge_session=${target}; gitedge_sso=unrelated-oidc-proof`)
    );
    expect(response.status).toBe(302);
    expect(await exists(target)).toBe(false);
    expect(await exists(otherIndex)).toBe(true);
    expect(await exists(passwordSession)).toBe(true);
    expect(await exists(otherUser)).toBe(true);
    expect(response.headers.get("Set-Cookie")).toContain("gitedge_session=");
    expect(response.headers.get("Set-Cookie")).not.toContain("gitedge_sso=");
  });
  it("consumes a notification once under concurrency and cannot revoke later sessions by replay", async () => {
    const first = await session("u1", "identity-u1");
    const xml = message();
    const responses = await Promise.all([route(post(xml)), route(post(xml))]);
    expect(responses.map((response) => response.status).sort()).toEqual([302, 400]);
    expect(await exists(first)).toBe(false);
    const later = await session("u1", "identity-u1");
    expect((await route(post(xml))).status).toBe(400);
    expect(await exists(later)).toBe(true);
  });
  it("rejects an invalid notification before mutating authenticated sessions", async () => {
    const token = await session("u1", "identity-u1");
    const response = await route(
      post(message().replace("subject-1", "subject-2"), `gitedge_session=${token}`)
    );
    expect(response.status).toBe(400);
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(await exists(token)).toBe(true);
  });
  it("supports subject-wide logout without touching another subject", async () => {
    const first = await session("u1", "identity-u1");
    const second = await session("u1", "identity-u1", "other-index");
    const other = await session("u2", "identity-u2");
    expect((await route(redirect(message({ indexes: [], signature: "none" })))).status).toBe(302);
    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(false);
    expect(await exists(other)).toBe(true);
  });
});
