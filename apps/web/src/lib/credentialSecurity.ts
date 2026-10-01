import type { CreatedAgentSession } from "../../../../packages/contracts/src/forge";

export function isCredentialExpired(expiresAt: number, now: number): boolean {
  return expiresAt <= now;
}

export function clearOneTimeToken<T extends { token: string }>(credential: T): T {
  return { ...credential, token: "" };
}

export function clearAgentSessionSecrets(session: CreatedAgentSession): CreatedAgentSession {
  return { ...session, token: "", gitToken: "" };
}
