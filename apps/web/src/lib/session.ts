import { reactive } from "vue";
import { api, type User } from "./api";

export const sessionState = reactive<{
  user: User | null;
  checked: boolean;
  loading: boolean;
}>({ user: null, checked: false, loading: false });

let refreshInFlight: Promise<User | null> | null = null;
let refreshVersion = 0;

export function refreshSession(): Promise<User | null> {
  if (refreshInFlight) return refreshInFlight;
  sessionState.loading = true;
  const version = refreshVersion;
  let request: Promise<User | null>;
  request = (async () => {
    try {
      const user = await api.session();
      if (version === refreshVersion) sessionState.user = user;
    } catch {
      if (version === refreshVersion) sessionState.user = null;
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
  sessionState.checked = true;
  sessionState.loading = false;
}

export function clearSession(): void {
  refreshVersion += 1;
  refreshInFlight = null;
  sessionState.user = null;
  sessionState.checked = true;
  sessionState.loading = false;
}
