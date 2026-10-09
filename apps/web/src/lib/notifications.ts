import { reactive } from "vue";
import { api } from "./api";

const POLL_INTERVAL_MS = 60_000;

export const notificationState = reactive({ unread: 0, capped: false });

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight: Promise<void> | null = null;

export function refreshUnreadCount(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = api
    .notificationUnreadCount()
    .then((count) => {
      notificationState.unread = count.unread;
      notificationState.capped = count.capped;
    })
    .catch(() => undefined)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function refreshWhenVisible(): void {
  if (document.visibilityState === "visible") void refreshUnreadCount();
}

/** Polls on an interval while the tab is visible and again whenever it regains focus. */
export function startNotificationPolling(): void {
  if (timer !== undefined) return;
  void refreshUnreadCount();
  timer = setInterval(refreshWhenVisible, POLL_INTERVAL_MS);
  window.addEventListener("focus", refreshWhenVisible);
  document.addEventListener("visibilitychange", refreshWhenVisible);
}

export function stopNotificationPolling(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  window.removeEventListener("focus", refreshWhenVisible);
  document.removeEventListener("visibilitychange", refreshWhenVisible);
  notificationState.unread = 0;
  notificationState.capped = false;
}
