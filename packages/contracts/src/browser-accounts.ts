import { z } from "zod";
import type { AgentSessionIdentity } from "./forge";

export const BROWSER_ACCOUNT_LIMIT = 5;

export interface BrowserAccount {
  id: string;
  identifier: string;
  displayName: string;
}

export interface BrowserAgentView {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentHandle: string;
  repositoryId: string;
  owner: string;
  repository: string;
  permission: "read" | "write";
  expiresAt: number;
}

export type BrowserView = { kind: "account" } | { kind: "agent"; session: AgentSessionIdentity };

export interface BrowserAccounts {
  accounts: BrowserAccount[];
  activeAccountId: string | null;
  view: BrowserView;
  agentViews: BrowserAgentView[];
  accountLimit: number;
  agentViewsTruncated: boolean;
}

export const SwitchBrowserAccountSchema = z.object({ userId: z.string().uuid() });
export const SwitchBrowserViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account") }),
  z.object({ kind: z.literal("agent"), sessionId: z.string().uuid() }),
]);
