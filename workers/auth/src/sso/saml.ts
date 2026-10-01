import { DOMParser } from "@xmldom/xmldom";
import { Buffer } from "node:buffer";
import { inflateRawSync } from "node:zlib";
import {
  SAML,
  ValidateInResponseTo,
  generateServiceProviderMetadata,
  type CacheItem,
  type CacheProvider,
  type Profile,
  type SamlConfig,
} from "@node-saml/node-saml";
import { getVerifiedXml } from "@node-saml/node-saml/lib/xml";
import { z } from "zod";
import type {
  SamlProvider,
  SsoAuthorization,
  SsoIdentityClaims,
  SsoProviderSecrets,
} from "./types";

const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const SAML_PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const XML_ENCRYPTION_NS = "http://www.w3.org/2001/04/xmlenc#";
const XML_ENCRYPTION_11_NS = "http://www.w3.org/2009/xmlenc11#";
const REQUEST_ID_TTL_MS = 10 * 60 * 1000;
const ACCEPTED_CLOCK_SKEW_MS = 30 * 1000;
const MAX_RESPONSE_BASE64_LENGTH = 1_000_000;
const ALLOWED_SIGNATURE_ALGORITHMS = new Set([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
]);
const ALLOWED_DIGEST_ALGORITHMS = new Set([
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmlenc#sha512",
]);
const SAML_STATE_SCHEMA = z
  .object({
    providerId: z.string().min(1).max(128),
    callbackUrl: z.string().url(),
    requestId: z.string().regex(/^_[0-9a-f]{40}$/),
    issuedAt: z.string().datetime(),
  })
  .strict();
const SAML_LOGOUT_STATE_SCHEMA = z
  .object({
    providerId: z.string().min(1).max(128),
    callbackUrl: z.string().url(),
    loginCallbackUrl: z.string().url(),
    requestId: z.string().regex(/^_[0-9a-f]{40}$/),
    issuedAt: z.string().datetime(),
    relayState: z.string().min(1).max(1024),
  })
  .strict();

interface SamlRequestState {
  providerId: string;
  callbackUrl: string;
  requestId: string;
  issuedAt: string;
}

interface SamlLogoutRequestState extends SamlRequestState {
  loginCallbackUrl: string;
  relayState: string;
}

class SingleRequestCache implements CacheProvider {
  private requestId: string | null;
  private issuedAt: string | null;
  private readCount = 0;
  private consumed = false;

  constructor(state?: Pick<SamlRequestState, "requestId" | "issuedAt">) {
    this.requestId = state?.requestId ?? null;
    this.issuedAt = state?.issuedAt ?? null;
  }

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    if (
      this.requestId !== null ||
      !/^_[0-9a-f]{40}$/.test(key) ||
      !Number.isFinite(Date.parse(value))
    ) {
      return null;
    }
    this.requestId = key;
    this.issuedAt = value;
    return { value, createdAt: Date.now() };
  }

  async getAsync(key: string): Promise<string | null> {
    if (
      this.consumed ||
      key !== this.requestId ||
      this.issuedAt === null ||
      this.readCount >= 2 ||
      Date.now() - Date.parse(this.issuedAt) > REQUEST_ID_TTL_MS
    ) {
      return null;
    }
    this.readCount += 1;
    return this.issuedAt;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (key === null || key !== this.requestId || this.consumed) return null;
    this.consumed = true;
    return this.issuedAt;
  }

  requestState(providerId: string, callbackUrl: string): SamlRequestState {
    if (this.requestId === null || this.issuedAt === null) {
      throw new Error("SAML AuthnRequest did not produce a request ID.");
    }
    return { providerId, callbackUrl, requestId: this.requestId, issuedAt: this.issuedAt };
  }

  wasConsumed(): boolean {
    return this.consumed;
  }
}

class VerifiableSaml extends SAML {
  trustedSigningCertificates(): Promise<string[]> {
    return this.getKeyInfosAsPem();
  }
}

function serviceProviderEntityId(provider: SamlProvider, callbackUrl: string): string {
  return provider.entityId?.trim() || callbackUrl;
}

function serviceProviderLogoutCallbackUrl(callbackUrl: string): string {
  const url = new URL(callbackUrl);
  if (!url.pathname.endsWith("/callback")) {
    throw new Error("SAML callback URL must end with /callback to derive the logout callback.");
  }
  url.pathname = `${url.pathname.slice(0, -"callback".length)}logout-callback`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function assertSigningKeyPair(provider: SamlProvider, secrets: SsoProviderSecrets): void {
  if (Boolean(secrets.privateKey) !== Boolean(provider.signingCertificate)) {
    throw new Error("SAML signing requires both a private key and its signing certificate.");
  }
  if (
    provider.certificates.length === 0 ||
    provider.certificates.some((certificate) => !certificate.trim())
  ) {
    throw new Error("SAML requires at least one IdP signing certificate.");
  }
  if (Boolean(secrets.decryptionKey) !== Boolean(provider.decryptionCertificate)) {
    throw new Error("SAML decryption requires both a private key and its decryption certificate.");
  }
}

function createSaml(
  provider: SamlProvider,
  secrets: SsoProviderSecrets,
  callbackUrl: string,
  cacheProvider: CacheProvider,
  logoutCallbackUrl?: string
): VerifiableSaml {
  assertSigningKeyPair(provider, secrets);
  const serviceProviderEntity = serviceProviderEntityId(provider, callbackUrl);
  const options: SamlConfig = {
    entryPoint: provider.entryPoint,
    issuer: serviceProviderEntity,
    audience: serviceProviderEntity,
    idpIssuer: provider.issuer,
    idpCert: provider.certificates,
    callbackUrl,
    logoutUrl: provider.logoutUrl,
    logoutCallbackUrl,
    privateKey: secrets.privateKey,
    publicCert: provider.signingCertificate,
    decryptionPvk: secrets.decryptionKey,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    identifierFormat: null,
    allowCreate: false,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: ACCEPTED_CLOCK_SKEW_MS,
    maxAssertionAgeMs: REQUEST_ID_TTL_MS,
    wantAuthnResponseSigned: provider.signatureValidation !== "assertion",
    wantAssertionsSigned: provider.signatureValidation !== "response",
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: REQUEST_ID_TTL_MS,
    authnRequestBinding: "HTTP-Redirect",
    cacheProvider,
  };
  return new VerifiableSaml(options);
}

export async function startSaml(
  provider: SamlProvider,
  secrets: SsoProviderSecrets,
  callbackUrl: string,
  state: string
): Promise<SsoAuthorization> {
  if (!state.trim() || state.length > 1024) throw new Error("Invalid SAML RelayState.");
  const cache = new SingleRequestCache();
  const saml = createSaml(provider, secrets, callbackUrl, cache);
  const url = await saml.getAuthorizeUrlAsync(state, undefined, {});
  const payload = JSON.stringify(cache.requestState(provider.id, callbackUrl));
  return { url, payload };
}

export async function startSamlLogout(
  provider: SamlProvider,
  secrets: SsoProviderSecrets,
  loginCallbackUrl: string,
  logoutCallbackUrl: string,
  claims: SsoIdentityClaims,
  state: string
): Promise<SsoAuthorization> {
  if (!provider.logoutUrl) throw new Error("SAML single logout is not configured.");
  if (!state.trim() || state.length > 1024) throw new Error("Invalid SAML RelayState.");
  assertSigningKeyPair(provider, secrets);
  if (
    !claims.subject.trim() ||
    !claims.nameIdFormat ||
    claims.nameIdFormat === "urn:oasis:names:tc:SAML:2.0:nameid-format:transient"
  ) {
    throw new Error("SAML single logout requires a stable NameID and format.");
  }

  const cache = new SingleRequestCache();
  const saml = createSaml(provider, secrets, loginCallbackUrl, cache, logoutCallbackUrl);
  const profile: Profile = {
    issuer: provider.issuer,
    nameID: claims.subject,
    nameIDFormat: claims.nameIdFormat,
    sessionIndex: claims.sessionIndex,
  };
  const url = await saml.getLogoutUrlAsync(profile, state, {});
  const requestState = cache.requestState(provider.id, logoutCallbackUrl);
  return {
    url,
    payload: JSON.stringify({
      ...requestState,
      loginCallbackUrl,
      relayState: state,
    }),
  };
}

export async function completeSaml(
  provider: SamlProvider,
  secrets: SsoProviderSecrets,
  callbackUrl: string,
  samlResponse: string,
  payload: string
): Promise<SsoIdentityClaims> {
  const state = parseRequestState(provider, callbackUrl, payload);
  if (
    samlResponse.length === 0 ||
    samlResponse.length > MAX_RESPONSE_BASE64_LENGTH ||
    samlResponse.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(samlResponse)
  ) {
    throw new Error("Invalid SAML response encoding.");
  }

  const cache = new SingleRequestCache(state);
  const responseXml = Buffer.from(samlResponse, "base64").toString("utf8");
  assertModernSignatureAlgorithms(responseXml);
  assertSecureEncryptionAlgorithms(responseXml);
  const saml = createSaml(provider, secrets, callbackUrl, cache);
  const result = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
  if (!result.profile || result.loggedOut || !cache.wasConsumed()) {
    throw new Error("SAML response did not complete an SP-initiated login.");
  }
  const assertionXml = result.profile.getAssertionXml?.();
  if (assertionXml) assertModernSignatureAlgorithms(assertionXml, false);
  validateSamlResponse(provider, callbackUrl, state, result.profile);
  return claimsFromProfile(result.profile);
}

export async function completeSamlLogout(
  provider: SamlProvider,
  secrets: SsoProviderSecrets,
  loginCallbackUrl: string,
  logoutCallbackUrl: string,
  callbackRequest: Request,
  payload: string
): Promise<void> {
  if (!provider.logoutUrl) throw new Error("SAML single logout is not configured.");
  assertSigningKeyPair(provider, secrets);
  const state = parseLogoutRequestState(provider, loginCallbackUrl, logoutCallbackUrl, payload);
  const requestUrl = new URL(callbackRequest.url);
  const expectedCallback = new URL(logoutCallbackUrl);
  if (
    requestUrl.origin !== expectedCallback.origin ||
    requestUrl.pathname !== expectedCallback.pathname
  ) {
    throw new Error("SAML logout response callback does not match this request.");
  }

  const cache = new SingleRequestCache(state);
  const saml = createSaml(provider, secrets, loginCallbackUrl, cache, logoutCallbackUrl);
  let responseXml: string;
  let loggedOut = false;
  if (callbackRequest.method === "GET") {
    if (!requestUrl.search) throw new Error("SAML Redirect logout response is missing.");
    const parameters = requestUrl.searchParams;
    assertUniqueQueryParameters(parameters);
    const samlResponse = requiredQueryValue(parameters, "SAMLResponse");
    const relayState = requiredQueryValue(parameters, "RelayState");
    requiredQueryValue(parameters, "Signature");
    const signatureAlgorithm = requiredQueryValue(parameters, "SigAlg");
    if (relayState !== state.relayState || !ALLOWED_SIGNATURE_ALGORITHMS.has(signatureAlgorithm)) {
      throw new Error("SAML Redirect signature or state is invalid.");
    }
    assertResponseBase64(samlResponse);
    responseXml = new TextDecoder().decode(
      inflateRawSync(Buffer.from(samlResponse, "base64"), { maxOutputLength: 2_000_000 })
    );
    assertModernSignatureAlgorithms(responseXml, false);
    validateSamlLogoutResponse(provider, logoutCallbackUrl, state, responseXml);
    const values = Object.fromEntries(parameters.entries());
    const result = await saml.validateRedirectAsync(values, requestUrl.search.slice(1));
    loggedOut = result.loggedOut && result.profile === null;
  } else if (callbackRequest.method === "POST") {
    if (requestUrl.search)
      throw new Error("SAML POST logout response must not include query parameters.");
    const contentType = callbackRequest.headers
      .get("Content-Type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") {
      throw new Error("SAML POST logout response must use form-url-encoded binding.");
    }
    const form = await callbackRequest.formData();
    const samlResponse = requiredFormValue(form, "SAMLResponse");
    const relayState = requiredFormValue(form, "RelayState");
    if (relayState !== state.relayState) throw new Error("SAML POST state is invalid.");
    assertResponseBase64(samlResponse);
    responseXml = Buffer.from(samlResponse, "base64").toString("utf8");
    assertModernSignatureAlgorithms(responseXml);
    validateSamlLogoutResponse(provider, logoutCallbackUrl, state, responseXml);
    const document = parseXml(responseXml);
    const verifiedXml = getVerifiedXml(
      responseXml,
      document.documentElement,
      await saml.trustedSigningCertificates()
    );
    if (!verifiedXml) throw new Error("SAML POST logout response signature is invalid.");
    validateSamlLogoutResponse(provider, logoutCallbackUrl, state, verifiedXml);
    loggedOut = true;
  } else {
    throw new Error("Unsupported SAML logout response binding.");
  }

  if (!loggedOut) {
    throw new Error("SAML response did not complete an SP-initiated logout.");
  }
  await cache.removeAsync(state.requestId);
  if (!cache.wasConsumed()) throw new Error("SAML logout request correlation was not consumed.");
}

function parseLogoutRequestState(
  provider: SamlProvider,
  loginCallbackUrl: string,
  logoutCallbackUrl: string,
  payload: string
): SamlLogoutRequestState {
  if (payload.length > 4096) throw new Error("Invalid SAML logout request state.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid SAML logout request state.");
  }
  const state = SAML_LOGOUT_STATE_SCHEMA.parse(parsed);
  const issuedAt = Date.parse(state.issuedAt);
  if (
    state.providerId !== provider.id ||
    state.callbackUrl !== logoutCallbackUrl ||
    state.loginCallbackUrl !== loginCallbackUrl ||
    !Number.isFinite(issuedAt) ||
    issuedAt > Date.now() + ACCEPTED_CLOCK_SKEW_MS ||
    Date.now() - issuedAt > REQUEST_ID_TTL_MS
  ) {
    throw new Error("SAML logout request state is expired or does not match this provider.");
  }
  return state;
}

function assertUniqueQueryParameters(parameters: URLSearchParams): void {
  const allowed = new Set(["SAMLResponse", "RelayState", "Signature", "SigAlg"]);
  const seen = new Set<string>();
  for (const [name] of parameters) {
    if (!allowed.has(name) || seen.has(name)) {
      throw new Error("SAML Redirect logout response contains invalid query parameters.");
    }
    seen.add(name);
  }
}

function assertResponseBase64(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_RESPONSE_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error("Invalid SAML response encoding.");
  }
}

function requiredQueryValue(parameters: URLSearchParams, name: string): string {
  const value = parameters.get(name);
  if (!value) throw new Error(`SAML Redirect logout response is missing ${name}.`);
  return value;
}

function requiredFormValue(form: FormData, name: string): string {
  const values = form.getAll(name);
  const value = values[0];
  if (values.length !== 1 || typeof value !== "string" || !value) {
    throw new Error(`SAML POST logout response is missing or duplicates ${name}.`);
  }
  return value;
}

function validateSamlLogoutResponse(
  provider: SamlProvider,
  logoutCallbackUrl: string,
  state: SamlLogoutRequestState,
  xml: string
): void {
  const response = parseXml(xml).documentElement;
  if (response.localName !== "LogoutResponse" || response.namespaceURI !== SAML_PROTOCOL_NS) {
    throw new Error("SAML logout response root is invalid.");
  }
  if (
    response.getAttribute("Destination") !== logoutCallbackUrl ||
    response.getAttribute("InResponseTo") !== state.requestId
  ) {
    throw new Error("SAML logout response destination or request correlation is invalid.");
  }
  const issueInstant = Date.parse(response.getAttribute("IssueInstant") ?? "");
  const now = Date.now();
  if (
    !Number.isFinite(issueInstant) ||
    issueInstant > now + ACCEPTED_CLOCK_SKEW_MS ||
    now - issueInstant > REQUEST_ID_TTL_MS
  ) {
    throw new Error("SAML logout response IssueInstant is invalid or expired.");
  }
  if (requiredText(response, SAML_ASSERTION_NS, "Issuer") !== provider.issuer) {
    throw new Error("SAML logout response issuer does not match the configured IdP.");
  }
  const status = elementChildren(response, SAML_PROTOCOL_NS, "Status");
  const statusCode = status[0] ? elementChildren(status[0], SAML_PROTOCOL_NS, "StatusCode") : [];
  if (
    status.length !== 1 ||
    statusCode.length !== 1 ||
    statusCode[0].getAttribute("Value") !== "urn:oasis:names:tc:SAML:2.0:status:Success"
  ) {
    throw new Error("SAML logout response status is not successful.");
  }
}

function parseRequestState(
  provider: SamlProvider,
  callbackUrl: string,
  payload: string
): SamlRequestState {
  if (payload.length > 2048) throw new Error("Invalid SAML request state.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid SAML request state.");
  }
  const state = SAML_STATE_SCHEMA.parse(parsed);
  const issuedAt = Date.parse(state.issuedAt);
  if (
    state.providerId !== provider.id ||
    state.callbackUrl !== callbackUrl ||
    !Number.isFinite(issuedAt) ||
    issuedAt > Date.now() + ACCEPTED_CLOCK_SKEW_MS ||
    Date.now() - issuedAt > REQUEST_ID_TTL_MS
  ) {
    throw new Error("SAML request state is expired or does not match this provider.");
  }
  return state;
}

function parseXml(xml: string): Document {
  if (/<!DOCTYPE/i.test(xml)) throw new Error("SAML XML document types are not allowed.");
  const errors: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => errors.push(message),
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(xml, "application/xml");
  if (errors.length > 0 || !document.documentElement) throw new Error("Invalid SAML XML.");
  return document;
}

function assertModernSignatureAlgorithms(xml: string, requireSignature = true): void {
  const document = parseXml(xml);
  const signatures = descendantElements(
    document.documentElement,
    "http://www.w3.org/2000/09/xmldsig#",
    "Signature"
  );
  if (requireSignature && signatures.length === 0) {
    throw new Error("SAML response must contain a signed assertion or response.");
  }
  for (const signature of signatures) {
    const signatureMethods = descendantElements(
      signature,
      "http://www.w3.org/2000/09/xmldsig#",
      "SignatureMethod"
    );
    const digestMethods = descendantElements(
      signature,
      "http://www.w3.org/2000/09/xmldsig#",
      "DigestMethod"
    );
    if (
      signatureMethods.length !== 1 ||
      !ALLOWED_SIGNATURE_ALGORITHMS.has(signatureMethods[0].getAttribute("Algorithm") ?? "") ||
      digestMethods.length === 0 ||
      digestMethods.some(
        (method) => !ALLOWED_DIGEST_ALGORITHMS.has(method.getAttribute("Algorithm") ?? "")
      )
    ) {
      throw new Error("SAML signatures must use RSA with SHA-256 or SHA-512.");
    }
  }
}

function assertSecureEncryptionAlgorithms(xml: string): void {
  const document = parseXml(xml);
  const encryptedAssertions = descendantElements(
    document.documentElement,
    SAML_ASSERTION_NS,
    "EncryptedAssertion"
  );
  if (encryptedAssertions.length === 0) return;
  if (encryptedAssertions.length !== 1)
    throw new Error("SAML response contains multiple encrypted assertions.");
  const encryptedData = elementChildren(encryptedAssertions[0], XML_ENCRYPTION_NS, "EncryptedData");
  if (encryptedData.length !== 1)
    throw new Error("SAML encrypted assertion must contain one EncryptedData element.");
  const dataMethods =
    encryptedData.length === 1
      ? elementChildren(encryptedData[0], XML_ENCRYPTION_NS, "EncryptionMethod")
      : [];
  const allowedDataAlgorithms = new Set([
    `${XML_ENCRYPTION_NS}aes128-cbc`,
    `${XML_ENCRYPTION_NS}aes256-cbc`,
    `${XML_ENCRYPTION_11_NS}aes128-gcm`,
    `${XML_ENCRYPTION_11_NS}aes256-gcm`,
  ]);
  const encryptedKeys = descendantElements(encryptedData[0], XML_ENCRYPTION_NS, "EncryptedKey");
  const keyMethods =
    encryptedKeys.length === 1
      ? elementChildren(encryptedKeys[0], XML_ENCRYPTION_NS, "EncryptionMethod")
      : [];
  const keyDigests =
    keyMethods.length === 1
      ? elementChildren(keyMethods[0], "http://www.w3.org/2000/09/xmldsig#", "DigestMethod")
      : [];
  const allowedKeyDigests = new Set([
    "http://www.w3.org/2001/04/xmlenc#sha256",
    "http://www.w3.org/2001/04/xmlenc#sha512",
    "http://www.w3.org/2000/09/xmldsig#sha256",
    "http://www.w3.org/2000/09/xmldsig#sha512",
  ]);
  if (
    encryptedData.length !== 1 ||
    dataMethods.length !== 1 ||
    !allowedDataAlgorithms.has(dataMethods[0].getAttribute("Algorithm") ?? "") ||
    keyMethods.length !== 1 ||
    keyMethods[0].getAttribute("Algorithm") !== `${XML_ENCRYPTION_NS}rsa-oaep-mgf1p` ||
    keyDigests.length !== 1 ||
    !allowedKeyDigests.has(keyDigests[0].getAttribute("Algorithm") ?? "")
  ) {
    throw new Error("SAML assertion encryption must use AES, RSA-OAEP and SHA-256 or SHA-512.");
  }
}

function elementChildren(parent: Element, namespace: string, localName: string): Element[] {
  const found: Element[] = [];
  for (const child of Array.from(parent.childNodes)) {
    if (!isElement(child)) continue;
    if (child.namespaceURI === namespace && child.localName === localName) found.push(child);
  }
  return found;
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function descendantElements(parent: Element, namespace: string, localName: string): Element[] {
  const found: Element[] = [];
  for (const child of Array.from(parent.childNodes)) {
    if (!isElement(child)) continue;
    if (child.namespaceURI === namespace && child.localName === localName) found.push(child);
    found.push(...descendantElements(child, namespace, localName));
  }
  return found;
}

function requiredText(parent: Element, namespace: string, localName: string): string {
  const child = elementChildren(parent, namespace, localName)[0];
  const value = child?.textContent?.trim();
  if (!value) throw new Error(`SAML ${localName} is missing.`);
  return value;
}

function assertTimeWindow(element: Element, now: number, requireEnd: boolean): void {
  const notBefore = element.getAttribute("NotBefore") || null;
  const notOnOrAfter = element.getAttribute("NotOnOrAfter") || null;
  const start = notBefore === null ? null : Date.parse(notBefore);
  const end = notOnOrAfter === null ? null : Date.parse(notOnOrAfter);
  if (
    (notBefore !== null && !Number.isFinite(start)) ||
    (notOnOrAfter !== null && !Number.isFinite(end)) ||
    (start !== null && now + ACCEPTED_CLOCK_SKEW_MS < start) ||
    (end !== null && now - ACCEPTED_CLOCK_SKEW_MS >= end) ||
    (requireEnd && end === null)
  ) {
    throw new Error("SAML assertion validity window is invalid.");
  }
}

function validateSamlResponse(
  provider: SamlProvider,
  callbackUrl: string,
  state: SamlRequestState,
  profile: Profile
): void {
  const responseXml = profile.getSamlResponseXml?.();
  const assertionXml = profile.getAssertionXml?.();
  if (!responseXml || !assertionXml) throw new Error("SAML library did not return verified XML.");

  const response = parseXml(responseXml).documentElement;
  if (response.localName !== "Response" || response.namespaceURI !== SAML_PROTOCOL_NS) {
    throw new Error("SAML response root is invalid.");
  }
  if (response.getAttribute("Destination") !== callbackUrl) {
    throw new Error("SAML response destination does not match this callback.");
  }
  if (requiredText(response, SAML_ASSERTION_NS, "Issuer") !== provider.issuer) {
    throw new Error("SAML response issuer does not match the configured IdP.");
  }
  const status = elementChildren(response, SAML_PROTOCOL_NS, "Status");
  const statusCode = status[0] ? elementChildren(status[0], SAML_PROTOCOL_NS, "StatusCode") : [];
  if (
    status.length !== 1 ||
    statusCode.length !== 1 ||
    statusCode[0].getAttribute("Value") !== "urn:oasis:names:tc:SAML:2.0:status:Success"
  ) {
    throw new Error("SAML response status is not successful.");
  }
  if (profile.issuer !== provider.issuer) {
    throw new Error("SAML assertion issuer does not match the configured IdP.");
  }

  const assertion = parseXml(assertionXml).documentElement;
  if (assertion.localName !== "Assertion" || assertion.namespaceURI !== SAML_ASSERTION_NS) {
    throw new Error("Verified SAML assertion root is invalid.");
  }
  if (requiredText(assertion, SAML_ASSERTION_NS, "Issuer") !== provider.issuer) {
    throw new Error("SAML assertion issuer does not match the configured IdP.");
  }
  const issueInstant = Date.parse(assertion.getAttribute("IssueInstant") ?? "");
  const now = Date.now();
  if (
    !Number.isFinite(issueInstant) ||
    issueInstant > now + ACCEPTED_CLOCK_SKEW_MS ||
    now - issueInstant > REQUEST_ID_TTL_MS
  ) {
    throw new Error("SAML assertion IssueInstant is invalid or expired.");
  }

  const conditions = elementChildren(assertion, SAML_ASSERTION_NS, "Conditions");
  if (conditions.length !== 1)
    throw new Error("SAML assertion must contain one Conditions element.");
  assertTimeWindow(conditions[0], now, true);

  const subjects = elementChildren(assertion, SAML_ASSERTION_NS, "Subject");
  const confirmations =
    subjects.length === 1
      ? elementChildren(subjects[0], SAML_ASSERTION_NS, "SubjectConfirmation")
      : [];
  const matchingConfirmation = confirmations.some((confirmation) => {
    if (confirmation.getAttribute("Method") !== "urn:oasis:names:tc:SAML:2.0:cm:bearer")
      return false;
    return elementChildren(confirmation, SAML_ASSERTION_NS, "SubjectConfirmationData").some(
      (item) =>
        item.getAttribute("Recipient") === callbackUrl &&
        item.getAttribute("InResponseTo") === state.requestId &&
        hasValidTimeWindow(item, now)
    );
  });
  if (!matchingConfirmation) {
    throw new Error("SAML subject confirmation does not match this callback and request.");
  }
}

function hasValidTimeWindow(element: Element, now: number): boolean {
  try {
    assertTimeWindow(element, now, true);
    return true;
  } catch {
    return false;
  }
}

function profileValue(profile: Profile, names: string[]): string | undefined {
  for (const name of names) {
    const value = profile[name];
    const candidate =
      typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function claimsFromProfile(profile: Profile): SsoIdentityClaims {
  const subject = typeof profile.nameID === "string" ? profile.nameID : "";
  if (
    !subject.trim() ||
    profile.nameIDFormat === "urn:oasis:names:tc:SAML:2.0:nameid-format:transient"
  ) {
    throw new Error(
      "SAML response has no stable NameID; configure a persistent or equivalent identifier."
    );
  }
  const displayName = profileValue(profile, [
    "displayName",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "urn:oid:2.16.840.1.113730.3.1.241",
    "cn",
    "name",
  ]);
  const email = profileValue(profile, [
    "email",
    "mail",
    "EmailAddress",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "urn:oid:0.9.2342.19200300.100.1.3",
  ]);
  return {
    subject,
    displayName: displayName ?? subject,
    email,
    emailVerified: false,
    sessionIndex: profile.sessionIndex,
    nameIdFormat: profile.nameIDFormat,
  };
}

export function samlMetadata(
  provider: SamlProvider,
  secrets: SsoProviderSecrets,
  callbackUrl: string
): string {
  assertSigningKeyPair(provider, secrets);
  return generateServiceProviderMetadata({
    issuer: serviceProviderEntityId(provider, callbackUrl),
    callbackUrl,
    logoutCallbackUrl: provider.logoutUrl
      ? serviceProviderLogoutCallbackUrl(callbackUrl)
      : undefined,
    identifierFormat: null,
    wantAssertionsSigned: provider.signatureValidation !== "response",
    privateKey: secrets.privateKey,
    publicCerts: provider.signingCertificate ?? null,
    decryptionPvk: secrets.decryptionKey,
    decryptionCert: provider.decryptionCertificate ?? null,
  });
}
