import type { BrowserView } from "../../../../packages/contracts/src/browser-accounts";
import { reactive } from "vue";
import { api, setExpectedIdentity, type User } from "./api";

export const sessionState = reactive<{
  user: User | null;
  view: BrowserView["kind"];
  checked: boolean;
  loading: boolean;
}>({ user: null, view: "account", checked: false, loading: false });

let refreshInFlight: Promise<User | null> | null = null;
let refreshVersion = 0;

export function refreshSession(): Promise<User | null> {
  if (refreshInFlight) return refreshInFlight;
  sessionState.loading = true;
  const version = refreshVersion;
  let request: Promise<User | null>;
  request = (async () => {
    try {
      const { user, view } = await api.browserSession();
      if (version === refreshVersion) {
        sessionState.user = user;
        sessionState.view = view.kind;
        setExpectedIdentity(user?.id ?? null, view.kind);
      }
    } catch (cause) {
      console.warn("session-refresh-failed", cause);
    } finally {
      if (version === refreshVersion) {
        sessionState.checked = true;
        sessionState.loading = false;
      }
      if (version === refreshVersion) refreshInFlight = null;
    }
    return sessionState.user;
  })();
  refreshInFlight = request;
  return request;
}

export function setSession(user: User): void {
  refreshVersion += 1;
  refreshInFlight = null;
  sessionState.user = user;
  sessionState.view = "account";
  setExpectedIdentity(user.id);
  sessionState.checked = true;
  sessionState.loading = false;
}

export function clearSession(): void {
  refreshVersion += 1;
  refreshInFlight = null;
  sessionState.user = null;
  sessionState.view = "account";
  setExpectedIdentity(null);
  sessionState.checked = true;
  sessionState.loading = false;
}
