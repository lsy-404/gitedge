import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NotificationPreferences from "../../apps/web/src/components/NotificationPreferences.vue";
import NotificationsView from "../../apps/web/src/pages/NotificationsView.vue";
import { i18n } from "../../apps/web/src/i18n";
import { api } from "../../apps/web/src/lib/api";
import { renderMarkdown } from "../../apps/web/src/lib/markdown";
import {
  notificationState,
  refreshUnreadCount,
  startNotificationPolling,
  stopNotificationPolling,
} from "../../apps/web/src/lib/notifications";
import type { Notification } from "../../packages/contracts/src/notifications";
import { control, findButton, h, mountAt, settle, unmountAll } from "./task-support";

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n1",
    reason: "mentioned",
    subjectKind: "issue",
    subjectNumber: 4,
    title: "Flaky build",
    repository: { id: "r1", owner: "acme", name: "project" },
    actor: "octocat",
    createdAt: 1_790_000_000_000,
    readAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  i18n.global.locale.value = "en";
});

afterEach(async () => {
  stopNotificationPolling();
  await unmountAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("notifications page", () => {
  it("groups by repository, links to the subject and marks items read", async () => {
    const list = vi.spyOn(api, "notifications").mockResolvedValue({
      items: [
        notification(),
        notification({
          id: "n2",
          reason: "merged",
          subjectKind: "pull_request",
          subjectNumber: 9,
          title: "Ship it",
          readAt: 5,
        }),
        notification({
          id: "n3",
          reason: "invited",
          subjectKind: "repository",
          subjectNumber: null,
          title: null,
          repository: { id: "r2", owner: "acme", name: "other" },
        }),
      ],
      nextCursor: null,
    });
    const mark = vi.spyOn(api, "markNotificationsRead").mockResolvedValue({ updated: 1 });
    vi.spyOn(api, "notificationUnreadCount").mockResolvedValue({ unread: 1, capped: false });
    const mounted = await mountAt("/_verify/notifications", "/_verify/notifications", () =>
      h(NotificationsView)
    );
    const groups = Array.from(mounted.root.querySelectorAll(".box h2")).map(
      (node) => node.textContent
    );
    expect(groups).toEqual(["acme/project", "acme/other"]);
    const links = Array.from(
      mounted.root.querySelectorAll<HTMLAnchorElement>("a.notification-title")
    );
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/acme/project/issues/4",
      "/acme/project/pulls/9",
      "/dashboard",
    ]);
    expect(mounted.root.textContent).toContain(
      "You were invited to collaborate on this repository"
    );
    expect(mounted.root.querySelectorAll(".notification-unread")).toHaveLength(2);

    findButton(mounted.root, "Mark as read").click();
    await settle();
    expect(mark).toHaveBeenCalledWith({ ids: ["n1"] });
    expect(mounted.root.querySelectorAll(".notification-unread")).toHaveLength(1);

    findButton(mounted.root, "Mark all as read").click();
    await settle();
    expect(mark).toHaveBeenLastCalledWith({ all: true });
    expect(mounted.root.querySelectorAll(".notification-unread")).toHaveLength(0);

    findButton(mounted.root, "Unread").click();
    await settle();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ unread: true }));
    mounted.unmount();
  });

  it("filters by reason, pages with the cursor and reports failures", async () => {
    const list = vi
      .spyOn(api, "notifications")
      .mockResolvedValueOnce({ items: [notification()], nextCursor: "1:n1" })
      .mockResolvedValueOnce({
        items: [notification({ id: "n9", subjectNumber: 5 })],
        nextCursor: null,
      })
      .mockRejectedValueOnce(new Error("offline"));
    const mounted = await mountAt(
      "/_verify/notifications-page",
      "/_verify/notifications-page",
      () => h(NotificationsView)
    );
    findButton(mounted.root, "Load more").click();
    await settle();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ before: "1:n1" }));
    expect(mounted.root.querySelectorAll("a.notification-title")).toHaveLength(2);
    expect(mounted.root.textContent).not.toContain("Load more");

    const select = control(mounted.root, "select");
    Reflect.set(select, "value", "merged");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(mounted.root.textContent).toContain("Notifications could not be loaded.");
    mounted.unmount();
  });

  it("shows an empty state", async () => {
    vi.spyOn(api, "notifications").mockResolvedValue({ items: [], nextCursor: null });
    const mounted = await mountAt(
      "/_verify/notifications-empty",
      "/_verify/notifications-empty",
      () => h(NotificationsView)
    );
    expect(mounted.root.textContent).toContain("No notifications yet.");
    mounted.unmount();
  });
});

describe("unread count polling", () => {
  it("polls on an interval and refreshes when the window regains focus", async () => {
    vi.useFakeTimers();
    const count = vi
      .spyOn(api, "notificationUnreadCount")
      .mockResolvedValue({ unread: 3, capped: false });
    startNotificationPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(notificationState.unread).toBe(3);
    expect(count).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count).toHaveBeenCalledTimes(2);
    count.mockResolvedValue({ unread: 100, capped: true });
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(notificationState).toMatchObject({ unread: 100, capped: true });
    stopNotificationPolling();
    expect(notificationState.unread).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(count).toHaveBeenCalledTimes(3);
  });

  it("keeps the last count when a refresh fails", async () => {
    notificationState.unread = 2;
    vi.spyOn(api, "notificationUnreadCount").mockRejectedValue(new Error("offline"));
    await refreshUnreadCount();
    expect(notificationState.unread).toBe(2);
    notificationState.unread = 0;
  });
});

describe("notification preferences", () => {
  it("saves the muted reasons", async () => {
    vi.spyOn(api, "notificationPreferences").mockResolvedValue({ mutedReasons: ["comment"] });
    const save = vi
      .spyOn(api, "saveNotificationPreferences")
      .mockImplementation(async (payload) => payload);
    const mounted = await mountAt(
      "/_verify/notification-prefs",
      "/_verify/notification-prefs",
      () => h(NotificationPreferences)
    );
    const switches = mounted.root.querySelectorAll("fluent-switch, .fluent-switch");
    expect(switches.length).toBeGreaterThan(0);
    findButton(mounted.root, "Save preferences").click();
    await settle();
    expect(save).toHaveBeenCalledWith({ mutedReasons: ["comment"] });
    expect(mounted.root.textContent).toContain("Notification preferences saved.");
    mounted.unmount();
  });
});

describe("mentions in Markdown", () => {
  it("links users and agents outside code when enabled", () => {
    const html = renderMarkdown(
      "Thanks @octocat and acme/@helper, not `@code` or me@example.com.\n\n```\n@fenced\n```",
      undefined,
      false,
      { mentions: true }
    );
    const root = document.createElement("div");
    root.innerHTML = html;
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a.mention"));
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["@octocat", "/octocat"],
      ["acme/@helper", "/acme/@helper"],
    ]);
    expect(root.querySelector("code")?.textContent).toBe("@code");
  });

  it("leaves mentions as text by default", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("Hello @octocat");
    expect(root.querySelector("a")).toBeNull();
  });
});
