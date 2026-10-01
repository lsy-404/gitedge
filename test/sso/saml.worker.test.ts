import { Buffer } from "node:buffer";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import { describe, expect, it } from "vitest";
import { completeSaml, samlMetadata, startSaml } from "../../workers/auth/src/sso/saml";
import type { SamlProvider, SsoProviderSecrets } from "../../workers/auth/src/sso/types";

const callbackUrl = "https://gitedge.example.test/api/auth/sso/callback";
const idpIssuer = "https://idp.example.test/entity";
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

function provider(signatureValidation: SamlProvider["signatureValidation"]): SamlProvider {
  return {
    id: "acme-saml",
    label: "Acme SAML",
    allowSignup: true,
    protocol: "saml",
    issuer: idpIssuer,
    entryPoint: "https://idp.example.test/sso",
    certificates: [certificate],
    entityId: "https://gitedge.example.test/saml/sp",
    signingCertificate: certificate,
    signatureValidation,
  };
}

const secrets: SsoProviderSecrets = { privateKey };

function sign(xml: string, xpath: string, algorithm: "sha1" | "sha256" = "sha256"): string {
  const signatureAlgorithm =
    algorithm === "sha1"
      ? "http://www.w3.org/2000/09/xmldsig#rsa-sha1"
      : "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  const digestAlgorithm =
    algorithm === "sha1"
      ? "http://www.w3.org/2000/09/xmldsig#sha1"
      : "http://www.w3.org/2001/04/xmlenc#sha256";
  const signature = new SignedXml({
    privateKey,
    signatureAlgorithm,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signature.addReference({
    xpath,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm,
  });
  signature.computeSignature(xml, {
    prefix: "ds",
    location: { reference: "//*[local-name()='Issuer']", action: "after" },
  });
  return signature.getSignedXml();
}

function xmlResponse(
  requestId: string,
  options: {
    destination?: string;
    recipient?: string;
    issuer?: string;
    audience?: string;
    expired?: boolean;
  } = {}
): string {
  const now = Date.now();
  const instant = new Date(now).toISOString();
  const notBefore = new Date(now - 60_000).toISOString();
  const expiry = new Date(now + (options.expired ? -60_000 : 300_000)).toISOString();
  const issuer = options.issuer ?? idpIssuer;
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assertion1" Version="2.0" IssueInstant="${instant}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">person@example.test</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${options.recipient ?? callbackUrl}" NotOnOrAfter="${expiry}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${expiry}"><saml:AudienceRestriction><saml:Audience>${options.audience ?? "https://gitedge.example.test/saml/sp"}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${instant}" SessionIndex="session-123"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>person@example.test</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Example Person</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response1" Version="2.0" IssueInstant="${instant}" Destination="${options.destination ?? callbackUrl}" InResponseTo="${requestId}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
}

async function loginRequest(
  signatureValidation: SamlProvider["signatureValidation"]
): Promise<{ provider: SamlProvider; requestId: string; payload: string }> {
  const selectedProvider = provider(signatureValidation);
  const authorization = await startSaml(selectedProvider, secrets, callbackUrl, "opaque-state");
  const requestUrl = new URL(authorization.url);
  expect(requestUrl.searchParams.get("RelayState")).toBe("opaque-state");
  const requestXml = inflateRawSync(
    Buffer.from(requestUrl.searchParams.get("SAMLRequest") ?? "", "base64")
  ).toString("utf8");
  expect(requestXml).toContain("AuthnRequest");
  expect(requestXml).toContain(callbackUrl);
  const decodedState: unknown = JSON.parse(authorization.payload);
  if (
    typeof decodedState !== "object" ||
    decodedState === null ||
    !("requestId" in decodedState) ||
    typeof decodedState.requestId !== "string"
  ) {
    throw new Error("SAML state does not include a request ID.");
  }
  const payload = decodedState;
  expect(requestXml).toContain(payload.requestId);
  return {
    provider: selectedProvider,
    requestId: payload.requestId,
    payload: authorization.payload,
  };
}

async function completeSignedLogin(
  signatureValidation: SamlProvider["signatureValidation"]
): Promise<void> {
  const {
    provider: selectedProvider,
    requestId,
    payload,
  } = await loginRequest(signatureValidation);
  let response = xmlResponse(requestId);
  if (signatureValidation !== "response")
    response = response.replace(/<saml:Assertion[\s\S]*<\/saml:Assertion>/, (assertion) =>
      sign(assertion, "/*[local-name()='Assertion']")
    );
  if (signatureValidation !== "assertion") response = sign(response, "/*[local-name()='Response']");
  const claims = await completeSaml(
    selectedProvider,
    secrets,
    callbackUrl,
    Buffer.from(response).toString("base64"),
    payload
  );
  expect(claims).toMatchObject({
    subject: "person@example.test",
    displayName: "Example Person",
    email: "person@example.test",
    emailVerified: false,
    sessionIndex: "session-123",
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  });
}

describe("SAML worker protocol", () => {
  it("builds a Redirect-bound AuthnRequest with request correlation and metadata", async () => {
    const { provider: selectedProvider } = await loginRequest("both");
    const metadata = samlMetadata(selectedProvider, secrets, callbackUrl);
    expect(metadata).toContain(`entityID="${selectedProvider.entityId}"`);
    expect(metadata).toContain(callbackUrl);
    expect(metadata).toContain("X509Certificate");
  });

  const signatureModes: SamlProvider["signatureValidation"][] = ["both", "assertion", "response"];
  it.each(signatureModes)("accepts a real signed response in %s mode", async (mode) => {
    await completeSignedLogin(mode);
  });

  it("rejects an unsolicited IdP-initiated assertion", async () => {
    const { provider: selectedProvider, payload } = await loginRequest("assertion");
    const response = xmlResponse("").replace(
      /<saml:Assertion[\s\S]*<\/saml:Assertion>/,
      (assertion) => sign(assertion, "/*[local-name()='Assertion']")
    );
    await expect(
      completeSaml(
        selectedProvider,
        secrets,
        callbackUrl,
        Buffer.from(response).toString("base64"),
        payload
      )
    ).rejects.toThrow();
  });

  it.each([
    ["Destination", { destination: "https://attacker.example.test/acs" }],
    ["Recipient", { recipient: "https://attacker.example.test/acs" }],
    ["issuer", { issuer: "https://attacker.example.test/idp" }],
    ["audience", { audience: "https://attacker.example.test/sp" }],
    ["expiry", { expired: true }],
  ])("rejects a signed assertion with invalid %s", async (_label, options) => {
    const { provider: selectedProvider, requestId, payload } = await loginRequest("assertion");
    const response = xmlResponse(requestId, options);
    const signed = response.replace(/<saml:Assertion[\s\S]*<\/saml:Assertion>/, (assertion) =>
      sign(assertion, "/*[local-name()='Assertion']")
    );
    await expect(
      completeSaml(
        selectedProvider,
        secrets,
        callbackUrl,
        Buffer.from(signed).toString("base64"),
        payload
      )
    ).rejects.toThrow();
  });

  it("rejects a response whose signature was changed after signing", async () => {
    const { provider: selectedProvider, requestId, payload } = await loginRequest("response");
    const signed = sign(xmlResponse(requestId), "/*[local-name()='Response']").replace(
      "person@example.test",
      "attacker@example.test"
    );
    await expect(
      completeSaml(
        selectedProvider,
        secrets,
        callbackUrl,
        Buffer.from(signed).toString("base64"),
        payload
      )
    ).rejects.toThrow();
  });

  it("rejects SHA-1 signature and digest algorithms before library verification", async () => {
    const { provider: selectedProvider, requestId, payload } = await loginRequest("response");
    const signed = sign(xmlResponse(requestId), "/*[local-name()='Response']", "sha1");
    await expect(
      completeSaml(
        selectedProvider,
        secrets,
        callbackUrl,
        Buffer.from(signed).toString("base64"),
        payload
      )
    ).rejects.toThrow("SHA-256 or SHA-512");
  });
});
