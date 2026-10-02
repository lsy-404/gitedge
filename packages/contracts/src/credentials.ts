export interface GitCredential {
  id: string;
  repositoryId: string;
  name: string;
  permission: "read" | "write";
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
}
export interface BrowserSession {
  id: string;
  createdAt: number;
  expiresAt: number;
  isCurrent: boolean;
}
