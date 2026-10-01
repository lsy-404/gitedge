export interface User {
  id: string;
  identifier: string;
  externalIdentity?: ExternalIdentity;
}

export interface ExternalIdentity {
  provider: "github";
  login: string;
  avatarUrl?: string;
  profileUrl?: string;
  accessLevel: "identity" | "read";
  emails?: string[];
  organizations?: { login: string; avatarUrl?: string }[];
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
