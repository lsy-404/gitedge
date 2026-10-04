import { z } from "zod";
import type { User } from "./account";

export const BROWSER_ACCOUNT_LIMIT = 5;

export interface BrowserAccount {
  id: string;
  identifier: string;
  displayName: string;
}

export const SwitchBrowserViewSchema = z.object({ kind: z.enum(["account", "guest"]) });
export type BrowserView = z.infer<typeof SwitchBrowserViewSchema>;

export interface BrowserIdentity {
  user: User | null;
  view: BrowserView;
}

export interface BrowserAccounts {
  accounts: BrowserAccount[];
  activeAccountId: string | null;
  view: BrowserView;
  accountLimit: number;
}

export const SwitchBrowserAccountSchema = z.object({ userId: z.string().uuid() });
