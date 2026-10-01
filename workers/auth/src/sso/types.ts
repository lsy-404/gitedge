export interface SsoProviderBase {
  id: string;
  label: string;
  allowSignup: boolean;
}
export interface OidcProvider extends SsoProviderBase {
  protocol: "oidc";
  issuer: string;
  clientId: string;
  scopes: string[];
  tokenAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
}
export interface SamlProvider extends SsoProviderBase {
  protocol: "saml";
  issuer: string;
  entryPoint: string;
  certificates: string[];
  entityId?: string;
  signingCertificate?: string;
  decryptionCertificate?: string;
  signatureValidation: "both" | "assertion" | "response";
  logoutUrl?: string;
}
export type SsoProvider = OidcProvider | SamlProvider;
export interface SsoProviderSecrets {
  clientSecret?: string;
  privateKey?: string;
  decryptionKey?: string;
}
export interface SsoIdentityClaims {
  subject: string;
  displayName: string;
  email?: string;
  emailVerified: boolean;
  sessionIndex?: string;
  nameIdFormat?: string;
}
export interface SsoAuthorization {
  url: string;
  payload: string;
}
export interface SsoEnvironment {
  DB: D1Database;
  SSO_PROVIDERS_JSON?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SSO_SECRETS_JSON?: string;
  DEFAULT_USER_GROUP: string;
  LOG_LEVEL?: string;
}
