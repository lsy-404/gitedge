import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import AccountDataSettings from "../../apps/web/src/components/AccountDataSettings.vue";
import AdminUsers from "../../apps/web/src/components/AdminUsers.vue";
import AuditLogList from "../../apps/web/src/components/AuditLogList.vue";
import PendingInvitations from "../../apps/web/src/components/PendingInvitations.vue";
import AuthView from "../../apps/web/src/pages/AuthView.vue";
import InviteAcceptView from "../../apps/web/src/pages/InviteAcceptView.vue";
import { i18n } from "../../apps/web/src/i18n";
import { ApiError, api } from "../../apps/web/src/lib/api";
import { router } from "../../apps/web/src/router";
import type { AdminUser, AuditEvent, Invitation } from "../../apps/web/src/lib/api";
import {
  confirmClick,
  control,
  fill,
  findButton,
  mountAt,
  settle,
  unmountAll,
} from "./task-support";

const invitation: Invitation = {
  id: "inv-1",
  kind: "repository",
  role: "write",
  organization: null,
  repository: { id: "repo-1", owner: "acme", name: "project" },
  inviter: "alice",
  invitee: "user@example.test",
  inviteeEmail: null,
  status: "pending",
  createdAt: 1,
  expiresAt: Date.now() + 86_400_000,
};

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "e1",
    createdAt: 1_700_000_000_000,
    action: "repository.visibility_changed",
    actor: { kind: "user", id: "u1", name: "alice", ref: null },
    target: { type: "repository", id: "repo-1", label: "acme/project" },
    repositoryId: "repo-1",
    metadata: { from: "private", to: "public" },
    ...overrides,
  };
}

beforeEach(() => {
  i18n.global.locale.value = "en";
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("pending invitations", () => {
  it("lists invitations on the dashboard and accepts or declines them", async () => {
    const list = vi
      .spyOn(api, "myInvitations")
      .mockResolvedValueOnce([invitation])
      .mockResolvedValue([]);
    const resolve = vi.spyOn(api, "resolveInvitation").mockResolvedValue(invitation);
    const accepted = vi.fn();
    const mounted = await mountAt("/_verify/pending", "/_verify/pending", () =>
      h(PendingInvitations, { onAccepted: accepted })
    );
    expect(mounted.root.textContent).toContain("alice invited you to collaborate on acme/project");
    findButton(mounted.root, "Accept").click();
    await settle();
    expect(resolve).toHaveBeenCalledWith("inv-1", "accept");
    expect(accepted).toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(2);
    expect(mounted.root.querySelector(".pending-invitations")).toBeNull();
    mounted.unmount();
  });

  it("renders nothing without invitations and reports a closed one", async () => {
    vi.spyOn(api, "myInvitations").mockResolvedValue([invitation]);
    vi.spyOn(api, "resolveInvitation").mockRejectedValue(new ApiError(409, "closed"));
    const mounted = await mountAt("/_verify/pending-closed", "/_verify/pending-closed", () =>
      h(PendingInvitations)
    );
    findButton(mounted.root, "Decline").click();
    await settle();
    expect(mounted.root.textContent).toContain("expired, was cancelled or was already handled");
    mounted.unmount();
  });
});

describe("invitation link page", () => {
  it("looks the invitation up with the fragment token and accepts it", async () => {
    const lookup = vi.spyOn(api, "invitationByToken").mockResolvedValue(invitation);
    const token = "gei_" + "a".repeat(64);
    const mounted = await mountAt("/_verify/invite", `/_verify/invite#${token}`, () =>
      h(InviteAcceptView)
    );
    expect(lookup).toHaveBeenCalledWith(token, "lookup");
    expect(mounted.root.textContent).toContain("alice invited you to collaborate on acme/project");
    const push = vi.spyOn(router, "replace").mockResolvedValue(undefined);
    findButton(mounted.root, "Accept").click();
    await settle();
    expect(lookup).toHaveBeenLastCalledWith(token, "accept");
    expect(push).toHaveBeenCalledWith("/acme/project");
    mounted.unmount();
  });

  it("explains an unknown invitation", async () => {
    vi.spyOn(api, "invitationByToken").mockRejectedValue(new ApiError(404, "missing"));
    const mounted = await mountAt(
      "/_verify/invite-missing",
      `/_verify/invite-missing#gei_${"b".repeat(64)}`,
      () => h(InviteAcceptView)
    );
    expect(mounted.root.textContent).toContain("was not found, or it was not sent to you");
    mounted.unmount();
  });

  it("keeps the invitation address when switching between sign in and registration", async () => {
    vi.spyOn(api, "ssoProviders").mockResolvedValue([]);
    const mounted = await mountAt(
      "/_verify/auth",
      `/_verify/auth?redirect=${encodeURIComponent("/invite#gei_x")}`,
      () => h(AuthView)
    );
    const link = mounted.root.querySelector<HTMLAnchorElement>('a[href*="/register"]');
    expect(link?.getAttribute("href")).toContain("redirect=/invite%23gei_x");
    mounted.unmount();
  });
});

describe("audit log list", () => {
  it("shows localized actions, marks non-user actors and pages with a cursor", async () => {
    const load = vi
      .fn<(cursor?: string) => Promise<{ events: AuditEvent[]; nextCursor: string | null }>>()
      .mockResolvedValueOnce({
        events: [
          event(),
          event({
            id: "e2",
            action: "access_token.created",
            actor: { kind: "token", id: "u1", name: "alice", ref: "t1" },
          }),
        ],
        nextCursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        events: [event({ id: "e3", action: "repository.deleted", metadata: {} })],
        nextCursor: null,
      });
    const mounted = await mountAt("/_verify/audit", "/_verify/audit", () =>
      h(AuditLogList, { load, reloadKey: "x" })
    );
    expect(mounted.root.textContent).toContain("Changed repository visibility");
    expect(mounted.root.textContent).toContain("from: private · to: public");
    expect(mounted.root.textContent).toContain("Access token");
    findButton(mounted.root, "Load more").click();
    await settle();
    expect(load).toHaveBeenLastCalledWith("cursor-1");
    expect(mounted.root.textContent).toContain("Deleted the repository");
    expect(mounted.root.textContent).not.toContain("Load more");
    mounted.unmount();
  });

  it("shows an empty state and retries a failed load", async () => {
    const load = vi
      .fn<(cursor?: string) => Promise<{ events: AuditEvent[]; nextCursor: string | null }>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ events: [], nextCursor: null });
    const mounted = await mountAt("/_verify/audit-empty", "/_verify/audit-empty", () =>
      h(AuditLogList, { load, reloadKey: "x" })
    );
    findButton(mounted.root, "Retry").click();
    await settle();
    expect(mounted.root.textContent).toContain("No audit entries yet");
    mounted.unmount();
  });
});

describe("site administration users", () => {
  const user: AdminUser = {
    id: "u-2",
    identifier: "target",
    groupKey: "free",
    createdAt: 1,
    disabledAt: null,
    deletedAt: null,
    siteAdmin: false,
    configuredAdmin: false,
  };

  it("disables an account and asks for identity confirmation when it is stale", async () => {
    vi.spyOn(api, "adminGroups").mockResolvedValue([{ key: "free", rpm: 1, maxRepositories: 1 }]);
    const list = vi.spyOn(api, "adminUsers").mockResolvedValue({ items: [user], nextCursor: null });
    const disable = vi
      .spyOn(api, "setAdminUserDisabled")
      .mockRejectedValueOnce(new ApiError(403, "reauth", "reauth_required"))
      .mockResolvedValue({ id: user.id, disabled: true });
    vi.spyOn(api, "security").mockRejectedValue(new Error("not needed"));
    const mounted = await mountAt("/_verify/admin-users", "/_verify/admin-users", () =>
      h(AdminUsers)
    );
    expect(mounted.root.textContent).toContain("target");
    await confirmClick(
      Array.from(mounted.root.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Disable"
      )
    );
    expect(disable).toHaveBeenCalledWith("u-2", true);
    expect(list).toHaveBeenCalled();
    expect(mounted.root.querySelector(".state-error, [role='alert']")).not.toBeNull();
    mounted.unmount();
  });

  it("searches by username", async () => {
    vi.spyOn(api, "adminGroups").mockResolvedValue([]);
    const list = vi.spyOn(api, "adminUsers").mockResolvedValue({ items: [], nextCursor: null });
    const mounted = await mountAt("/_verify/admin-search", "/_verify/admin-search", () =>
      h(AdminUsers)
    );
    fill(control(mounted.root, ".admin-search input"), "ali");
    await settle();
    findButton(mounted.root, "Search").click();
    await settle();
    expect(list).toHaveBeenLastCalledWith({ q: "ali" });
    expect(mounted.root.textContent).toContain("No matching users");
    mounted.unmount();
  });
});

describe("account data", () => {
  it("lists the organizations that block deletion", async () => {
    vi.spyOn(api, "deleteAccount").mockRejectedValue(
      Object.assign(new ApiError(409, "blocked", "organization_ownership"), {
        organizations: ["team-a"],
      })
    );
    const mounted = await mountAt("/_verify/data", "/_verify/data", () => h(AccountDataSettings));
    const input = control(mounted.root, ".type-to-confirm input");
    fill(input, "user@example.test");
    await settle();
    findButton(mounted.root, "Delete my account permanently").click();
    await settle();
    expect(mounted.root.textContent).toContain("team-a");
    mounted.unmount();
  });
});
