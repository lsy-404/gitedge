export interface SsoProviderSummary {
  id: string;
  label: string;
  protocol: "oidc" | "saml";
  metadataUrl?: string;
}
export interface SsoIdentity {
  id: string;
  providerId: string;
  providerLabel: string;
  protocol: "oidc" | "saml";
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  createdAt: number;
  lastLoginAt: number;
}
