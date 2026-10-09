import { shallowRef } from "vue";
import { ApiError } from "./api";

/** Holds an action refused with `reauth_required` and replays it once the user confirms. */
export function useReauthRetry() {
  const pending = shallowRef<(() => Promise<void>) | null>(null);

  function intercept(cause: unknown, retry: () => Promise<void>): boolean {
    if (!(cause instanceof ApiError && cause.code === "reauth_required")) return false;
    pending.value = retry;
    return true;
  }

  function confirmed(): void {
    const retry = pending.value;
    pending.value = null;
    if (retry) void retry();
  }

  return { pending, intercept, confirmed };
}
