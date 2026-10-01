import { Buffer } from "node:buffer";
import { createSign } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import * as xmlEncryption from "xml-encryption";
import { SignedXml } from "xml-crypto";
import { describe, expect, it } from "vitest";
import {
  completeSaml,
  completeSamlLogout,
  samlMetadata,
  startSaml,
  startSamlLogout,
} from "../../workers/auth/src/sso/saml";
import type {
  SamlProvider,
  SsoIdentityClaims,
  SsoProviderSecrets,
} from "../../workers/auth/src/sso/types";

const loginCallbackUrl = "https://gitedge.example.test/api/auth/sso/acme-saml/callback";
const logoutCallbackUrl = "https://gitedge.example.test/api/auth/sso/acme-saml/logout-callback";
const idpIssuer = "https://idp.example.test/entity";
const idpLogoutUrl = "https://idp.example.test/slo";
const privateKey = `-----BEGIN PRIVATE KEY-----
MIIEwAIBADANBgkqhkiG9w0BAQEFAASCBKowggSmAgEAAoIBAQDLqWYsH3/Z0jKr
/FYnIsokbmQ5mbZpsXX/EJN5b/beNZDtOHNd+pywRl3HKVuVF+tjojpU1DkKdcol
56RKczzkep9dK9vRIi12/xeFWyVqCacZ80FAmVFPvSVK41XZTbYGcgDV0qp34xLM
vemkeF2nfLi45wkZuHwhgaWooy3d3Kc08vio+rLYKmp03loJiSaSjAHgV3cyG7WT
eZDQ22STIDRpqqm52qq2OAMEMi9C1sh/6Yt90AIZZRJnf7y1jUUJj+Dh2d1lWS+0
mVvrCsDm0NBYjpdLbfNKbPqnnVhuflNsO0hbKSOgIJoDg6WI38dCs4SgPeYqu6Hs
JJuCh14/AgMBAAECggEBALVohuH2jONxIEGh2vuxOW2KByxnhtxOflRcZ4BcAwGb
pSQojFrByKAbjZzBchoz3DA7aMn233g5w35P/z9xtmOt9hX/4yU91FGSl1jp/0Gc
p4Ot8gmgh5UHXhh+txGA7wp+sc/EfqObWDuXTm556LIvnjrVUH3gnnEaEn1MHKbp
Nf3uw0gtfIQiwfWYAdRbwJIAqSdhkKR2VB2LftTiWVej9R/8XPqOt2axhUJHuQp/
bUktnJjys5a7msXifgqREAgd4WwysRj6iQqy/PHZeVWOCH9ChHXEZcSMDmxsTRCB
zhJ9BZ2HdK5cTD7QjGznuPE2Awcr4lSg1QieN/t9Y0ECgYEA6jfPFgeSlrt/TbUC
0J5VFGiOtU/jatxZByHgBKZgmXFI7bRPGUD+G/her5r/tV/8B5uw1wRzwdh9H55v
05l7KTcS2lflhrfiHbxnb0h+XIcBS1q5+zhILWH0kgNenkueGufmr17JMAgW4RFU
HJNi3gfkx+BR4Oaq1Ir/iy/WqWMCgYEA3podh6pHf0jFU9z3vviiGrvt0EzoIy7A
tti+yVBUNcaILa1RMW/vLZLDWLoTlq3yimezFXwQl6OHE+6l33CN56YVI2crU0sl
mUvimnwRw2sKOMSqz0JvgHmQtUuvDllmUFq+X0NlPUcP9K23yGZm0Xl4YTIWJgf0
abPbJDUgfHUCgYEA2v1rZpGWAdE1ahaAl0YzDm3kYKpdXCDCLOUDa9WUJGPDaF1a
R6Z48PX8sfwechtYrlRnt+K1yNz9wH6G2DV87kBMJFJijN+JT3xEycviOekQ0L/3
fGhXM/eOkKcN5LuXDFkfW4EoYvxtR+rH1iAIJMkEo82dQMbrmuaLoDwOXTkCgYEA
l5mMDO3Z3YTY5sFxdHzuIZjlYFxQKE3Z72zzmjT79NetvLXxuuKJmJcANTgcyRzU
NpBjNXmV7z/uaZO5IdAMxLumX8MOjZ57D8jPnfhrPJR0lK7TyW1sdKnV9LKDmRkn
hggW6NgEZdQ0uKVqqa+bzIOWiVNMJEB8o1RbJXCNHFUCgYEAoyX73i5vqqW8Ezht
DkXVorDxilucalk1Jqa689VhQi8eRyiq1ntV7qpf/eM1bepTTgz7xvcH7UyzQdJa
khub4A9xbvF9NugcBeZdR+4oSFO4z7bepiSk1tjhmtJDUgtF4dKnyDRxqvFVWKo/
HwzwtUEPV/GBcQHvJIHh4DlbiHs=
-----END PRIVATE KEY-----`;
const certificate = `-----BEGIN CERTIFICATE-----
MIICvDCCAaQCCQCa9ddWjjtknDANBgkqhkiG9w0BAQsFADAgMR4wHAYDVQQDDBVH
aXRFZGdlIFNBTUwgVGVzdCBJZFAwHhcNMjYxMDAxMTgzMzU3WhcNMzYwOTI4MTgz
MzU3WjAgMR4wHAYDVQQDDBVHaXRFZGdlIFNBTUwgVGVzdCBJZFAwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDLqWYsH3/Z0jKr/FYnIsokbmQ5mbZpsXX/
EJN5b/beNZDtOHNd+pywRl3HKVuVF+tjojpU1DkKdcol56RKczzkep9dK9vRIi12
/xeFWyVqCacZ80FAmVFPvSVK41XZTbYGcgDV0qp34xLMvemkeF2nfLi45wkZuHwh
gaWooy3d3Kc08vio+rLYKmp03loJiSaSjAHgV3cyG7WTeZDQ22STIDRpqqm52qq2
OAMEMi9C1sh/6Yt90AIZZRJnf7y1jUUJj+Dh2d1lWS+0mVvrCsDm0NBYjpdLbfNK
bPqnnVhuflNsO0hbKSOgIJoDg6WI38dCs4SgPeYqu6HsJJuCh14/AgMBAAEwDQYJ
KoZIhvcNAQELBQADggEBAJ8c6ySf3SsPNeYfn3b10VQtOK6yJRNktIcOPeltN77r
XQwlSbNJfn4lW2DO8JBj0wCJMdgRnpl5LA/ysz3DG1jcW+rDHf5c66B1KAyP5gh8
w/DKh1Q1MRWITYLXBKds3NG1HPYTqf73+wpPoXDxXLe8jD52Dk2w3iK2NTR242O2
IYX1c0ezz2z9LsRtpJpwUu/2QvRQv5w4uUhmpCMRngk8DPtHRA3cAbYG5aSItGQr
YUEi6VtdGzom6Wtrv6rfXuRQ+nt/rSpWHKYPRRPlabBufvwykDP6cI/C/Zv79cVM
OhuOnB4ndxMILo15vnWyH9JxQp1+jQw6dG/89iuWnSA=
-----END CERTIFICATE-----`;

const secrets: SsoProviderSecrets = { privateKey, decryptionKey: privateKey };
const claims: SsoIdentityClaims = {
  subject: "persistent-user-81",
  displayName: "Example Person",
  emailVerified: false,
  sessionIndex: "session-123",
  nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
};

function provider(signatureValidation: SamlProvider["signatureValidation"] = "both"): SamlProvider {
  return {
    id: "acme-saml",
    label: "Acme SAML",
    allowSignup: true,
    protocol: "saml",
    issuer: idpIssuer,
    entryPoint: "https://idp.example.test/sso",
    logoutUrl: idpLogoutUrl,
    certificates: [certificate],
    entityId: "https://gitedge.example.test/saml/sp",
    signingCertificate: certificate,
    decryptionCertificate: certificate,
    signatureValidation,
  };
}

function sign(xml: string): string {
  const signature = new SignedXml({
    privateKey,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signature.addReference({
    xpath: "/*[local-name()='LogoutResponse']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signature.computeSignature(xml, {
    prefix: "ds",
    location: { reference: "//*[local-name()='Issuer']", action: "after" },
  });
  return signature.getSignedXml();
}

function responseXml(
  requestId: string,
  options: {
    destination?: string;
    issuer?: string;
    status?: string;
    inResponseTo?: string;
    issueInstant?: string;
  } = {}
): string {
  return `<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_logout_response1" Version="2.0" IssueInstant="${options.issueInstant ?? new Date().toISOString()}" Destination="${options.destination ?? logoutCallbackUrl}" InResponseTo="${options.inResponseTo ?? requestId}"><saml:Issuer>${options.issuer ?? idpIssuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${options.status ?? "urn:oasis:names:tc:SAML:2.0:status:Success"}"/></samlp:Status></samlp:LogoutResponse>`;
}

function stateField(payload: string, name: string): string {
  const value: unknown = JSON.parse(payload);
  if (
    typeof value !== "object" ||
    value === null ||
    !(name in value) ||
    typeof value[name] !== "string"
  ) {
    throw new Error(`SAML logout state is missing ${name}.`);
  }
  return value[name];
}

async function beginLogout(): Promise<{
  provider: SamlProvider;
  payload: string;
  requestId: string;
  relayState: string;
}> {
  const selectedProvider = provider();
  const authorization = await startSamlLogout(
    selectedProvider,
    secrets,
    loginCallbackUrl,
    logoutCallbackUrl,
    claims,
    "opaque-logout-state"
  );
  return {
    provider: selectedProvider,
    payload: authorization.payload,
    requestId: stateField(authorization.payload, "requestId"),
    relayState: stateField(authorization.payload, "relayState"),
  };
}

function signedRedirectRequest(responseXml: string, relayState: string): Request {
  const compressed = deflateRawSync(Buffer.from(responseXml, "utf8")).toString("base64");
  const signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  const params = new URLSearchParams();
  params.set("SAMLResponse", compressed);
  params.set("RelayState", relayState);
  params.set("SigAlg", signatureAlgorithm);
  const signedData = params.toString();
  const signer = createSign("RSA-SHA256");
  signer.update(signedData);
  signer.end();
  const signature = signer.sign(privateKey, "base64");
  return new Request(
    `${logoutCallbackUrl}?${signedData}&Signature=${encodeURIComponent(signature)}`
  );
}

function encryptedAssertion(xml: string, keyDigest: "sha1" | "sha256" = "sha256"): Promise<string> {
  const options = Object.assign(
    {
      rsa_pub: certificate,
      pem: certificate,
      encryptionAlgorithm: "http://www.w3.org/2001/04/xmlenc#aes256-cbc",
      keyEncryptionAlgorithm: "http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p",
      disallowEncryptionWithInsecureAlgorithm: true,
    },
    { keyEncryptionDigest: keyDigest }
  );
  return new Promise((resolve, reject) => {
    xmlEncryption.encrypt(xml, options, (error, encrypted) => {
      if (error) reject(error);
      else resolve(encrypted);
    });
  });
}

function assertionXml(requestId: string): string {
  const now = Date.now();
  const instant = new Date(now).toISOString();
  const expiry = new Date(now + 300_000).toISOString();
  const start = new Date(now - 60_000).toISOString();
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_encrypted_assertion1" Version="2.0" IssueInstant="${instant}"><saml:Issuer>${idpIssuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">person@example.test</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${loginCallbackUrl}" NotOnOrAfter="${expiry}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${start}" NotOnOrAfter="${expiry}"><saml:AudienceRestriction><saml:Audience>https://gitedge.example.test/saml/sp</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${instant}" SessionIndex="session-encrypted"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>person@example.test</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
}

function signedEncryptedResponse(
  requestId: string,
  encrypted: string,
  signResponse = true
): string {
  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_encrypted_response1" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${loginCallbackUrl}" InResponseTo="${requestId}"><saml:Issuer>${idpIssuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:EncryptedAssertion>${encrypted}</saml:EncryptedAssertion></samlp:Response>`;
  if (!signResponse) return response;
  const signature = new SignedXml({
    privateKey,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signature.addReference({
    xpath: "/*[local-name()='Response']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signature.computeSignature(response, {
    prefix: "ds",
    location: { reference: "//*[local-name()='Issuer']", action: "after" },
  });
  return signature.getSignedXml();
}

describe("SAML federated logout and encrypted assertions", () => {
  it("creates a signed SP-initiated Redirect LogoutRequest with stable NameID and session index", async () => {
    const { provider: selectedProvider } = await beginLogout();
    const authorization = await startSamlLogout(
      selectedProvider,
      secrets,
      loginCallbackUrl,
      logoutCallbackUrl,
      claims,
      "logout-check"
    );
    const url = new URL(authorization.url);
    expect(url.origin + url.pathname).toBe(idpLogoutUrl);
    expect(url.searchParams.get("SigAlg")).toBe(
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
    );
    expect(url.searchParams.get("Signature")).toBeTruthy();
    const request = inflateRawSync(
      Buffer.from(url.searchParams.get("SAMLRequest") ?? "", "base64")
    ).toString("utf8");
    expect(request).toContain("LogoutRequest");
    expect(request).toContain(claims.subject);
    expect(request).toContain(claims.sessionIndex);
  });

  it("validates signed POST LogoutResponse issuer, destination, success status, correlation and expiry", async () => {
    const { provider: selectedProvider, requestId, relayState, payload } = await beginLogout();
    const signed = sign(responseXml(requestId));
    const body = new URLSearchParams({
      SAMLResponse: Buffer.from(signed).toString("base64"),
      RelayState: relayState,
    });
    await expect(
      completeSamlLogout(
        selectedProvider,
        secrets,
        loginCallbackUrl,
        logoutCallbackUrl,
        new Request(logoutCallbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        }),
        payload
      )
    ).resolves.toBeUndefined();
  });

  it("validates signed Redirect LogoutResponse using the original raw query signature", async () => {
    const { provider: selectedProvider, requestId, relayState, payload } = await beginLogout();
    const request = signedRedirectRequest(responseXml(requestId), relayState);
    await expect(
      completeSamlLogout(
        selectedProvider,
        secrets,
        loginCallbackUrl,
        logoutCallbackUrl,
        request,
        payload
      )
    ).resolves.toBeUndefined();
  });

  it("rejects a POST LogoutResponse with a damaged XML signature", async () => {
    const { provider: selectedProvider, requestId, relayState, payload } = await beginLogout();
    const signed = sign(responseXml(requestId)).replace(
      "<ds:SignatureValue>",
      "<ds:SignatureValue>A"
    );
    const body = new URLSearchParams({
      SAMLResponse: Buffer.from(signed).toString("base64"),
      RelayState: relayState,
    });
    await expect(
      completeSamlLogout(
        selectedProvider,
        secrets,
        loginCallbackUrl,
        logoutCallbackUrl,
        new Request(logoutCallbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        }),
        payload
      )
    ).rejects.toThrow();
  });

  it.each([
    ["issuer", { issuer: "https://attacker.example.test/idp" }],
    ["destination", { destination: "https://attacker.example.test/logout" }],
    ["status", { status: "urn:oasis:names:tc:SAML:2.0:status:Requester" }],
    ["request correlation", { inResponseTo: "_mismatched-request" }],
    ["expiry", { issueInstant: new Date(Date.now() - 11 * 60_000).toISOString() }],
  ])("rejects a signed POST LogoutResponse with invalid %s", async (_name, options) => {
    const { provider: selectedProvider, requestId, relayState, payload } = await beginLogout();
    const signed = sign(responseXml(requestId, options));
    const body = new URLSearchParams({
      SAMLResponse: Buffer.from(signed).toString("base64"),
      RelayState: relayState,
    });
    await expect(
      completeSamlLogout(
        selectedProvider,
        secrets,
        loginCallbackUrl,
        logoutCallbackUrl,
        new Request(logoutCallbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        }),
        payload
      )
    ).rejects.toThrow();
  });

  it("rejects a Redirect LogoutResponse with a forged query signature", async () => {
    const { provider: selectedProvider, requestId, relayState, payload } = await beginLogout();
    const request = signedRedirectRequest(responseXml(requestId), relayState);
    const url = new URL(request.url);
    url.searchParams.set("Signature", "invalid");
    await expect(
      completeSamlLogout(
        selectedProvider,
        secrets,
        loginCallbackUrl,
        logoutCallbackUrl,
        new Request(url),
        payload
      )
    ).rejects.toThrow();
  });

  it("publishes logout and assertion decryption endpoints in metadata", () => {
    const metadata = samlMetadata(provider(), secrets, loginCallbackUrl);
    expect(metadata).toContain(logoutCallbackUrl);
    expect(metadata).toContain("AssertionConsumerService");
    expect(metadata).toContain('KeyDescriptor use="encryption"');
    expect(metadata).toContain("X509Certificate");
  });

  it("decrypts a real AES-encrypted assertion using the configured Workers-compatible key", async () => {
    const selectedProvider = provider("response");
    const authorization = await startSaml(
      selectedProvider,
      secrets,
      loginCallbackUrl,
      "encrypted-state"
    );
    const state: unknown = JSON.parse(authorization.payload);
    if (
      typeof state !== "object" ||
      state === null ||
      !("requestId" in state) ||
      typeof state.requestId !== "string"
    ) {
      throw new Error("SAML state is missing the AuthnRequest ID.");
    }
    const encrypted = await encryptedAssertion(assertionXml(state.requestId));
    const response = signedEncryptedResponse(state.requestId, encrypted);
    const decoded = await completeSaml(
      selectedProvider,
      secrets,
      loginCallbackUrl,
      Buffer.from(response).toString("base64"),
      authorization.payload
    );
    expect(decoded).toMatchObject({
      subject: "person@example.test",
      emailVerified: false,
      sessionIndex: "session-encrypted",
    });
  });

  it("accepts the standard RSA-OAEP SHA-1 encryption digest without allowing SHA-1 signatures", async () => {
    const selectedProvider = provider("response");
    const authorization = await startSaml(
      selectedProvider,
      secrets,
      loginCallbackUrl,
      "sha1-state"
    );
    const state: unknown = JSON.parse(authorization.payload);
    if (
      typeof state !== "object" ||
      state === null ||
      !("requestId" in state) ||
      typeof state.requestId !== "string"
    ) {
      throw new Error("SAML state is missing the AuthnRequest ID.");
    }
    const encrypted = await encryptedAssertion(assertionXml(state.requestId), "sha1");
    const response = signedEncryptedResponse(state.requestId, encrypted);
    await expect(
      completeSaml(
        selectedProvider,
        secrets,
        loginCallbackUrl,
        Buffer.from(response).toString("base64"),
        authorization.payload
      )
    ).resolves.toMatchObject({ subject: "person@example.test" });
  });
});

it("validates a signed encrypted assertion without requiring an unsigned outer response signature", async () => {
  const selected = provider("assertion");
  const authorization = await startSaml(
    selected,
    secrets,
    loginCallbackUrl,
    "encrypted-assertion-state"
  );
  const requestId = stateField(authorization.payload, "requestId");
  const signature = new SignedXml({
    privateKey,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signature.addReference({
    xpath: "/*[local-name()='Assertion']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signature.computeSignature(assertionXml(requestId));
  const encrypted = await encryptedAssertion(signature.getSignedXml());
  const response = signedEncryptedResponse(requestId, encrypted, false);
  expect(
    await completeSaml(
      selected,
      secrets,
      loginCallbackUrl,
      Buffer.from(response).toString("base64"),
      authorization.payload
    )
  ).toMatchObject({ subject: "person@example.test" });
  signature.signatureAlgorithm = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
  signature.computeSignature(assertionXml(requestId));
  const weakSignature = await encryptedAssertion(signature.getSignedXml());
  await expect(
    completeSaml(
      selected,
      secrets,
      loginCallbackUrl,
      Buffer.from(signedEncryptedResponse(requestId, weakSignature, false)).toString("base64"),
      authorization.payload
    )
  ).rejects.toThrow("SHA-256 or SHA-512");
  const unsignedEncrypted = await encryptedAssertion(assertionXml(requestId));
  await expect(
    completeSaml(
      selected,
      secrets,
      loginCallbackUrl,
      Buffer.from(signedEncryptedResponse(requestId, unsignedEncrypted, false)).toString("base64"),
      authorization.payload
    )
  ).rejects.toThrow();
});

it("rejects insecure RSA v1.5 key transport before decryption", async () => {
  const selected = provider("response");
  const authorization = await startSaml(
    selected,
    secrets,
    loginCallbackUrl,
    "insecure-encryption-state"
  );
  const requestId = stateField(authorization.payload, "requestId");
  const encrypted = (await encryptedAssertion(assertionXml(requestId))).replaceAll(
    "rsa-oaep-mgf1p",
    "rsa-1_5"
  );
  await expect(
    completeSaml(
      selected,
      secrets,
      loginCallbackUrl,
      Buffer.from(signedEncryptedResponse(requestId, encrypted)).toString("base64"),
      authorization.payload
    )
  ).rejects.toThrow("AES and RSA-OAEP");
});
