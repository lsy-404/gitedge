export interface User {
  id: string;
  identifier: string;
  externalIdentity?: ExternalIdentity;
}

export interface ExternalIdentity {
  provider: "github" | "oidc";
  login: string;
  avatarUrl?: string;
  profileUrl?: string;
}

export interface Organization {
  slug: string;
  displayName: string;
  description?: string;
  avatarUrl?: string;
  role?: "owner" | "member";
}

export interface OrganizationMember {
  identifier: string;
  role: "owner" | "member";
}
