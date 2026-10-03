import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../apps/web/src/App.vue";
import BrowserAccountMenu from "../../apps/web/src/components/BrowserAccountMenu.vue";
import AuthView from "../../apps/web/src/pages/AuthView.vue";
import { api, expectedIdentityHeaders, setExpectedIdentity } from "../../apps/web/src/lib/api";
import { clearSession, setSession, sessionState } from "../../apps/web/src/lib/session";
import {
  loadAccountPreferences,
  updatePreference,
  preferencesState,
} from "../../apps/web/src/lib/preferences";
import { i18n } from "../../apps/web/src/i18n";
import { router } from "../../apps/web/src/router";
import type { BrowserAccounts } from "../../packages/contracts/src/browser-accounts";
import type { User } from "../../packages/contracts/src/account";
import { control, h as testH, mountAt, settle, unmountAll } from "./task-support";

const user: User = { id: "user-1", identifier: "one@example.test" };
const agentUser: User = {
  ...user,
  agentSession: {
    id: "session-1",
    agentId: "agent-1",
    agentName: "Builder",
    repositoryId: "repo-1",
    workspaceName: "project",
    permission: "write",
  },
};
const browserAccounts: BrowserAccounts = {
  accounts: [
    { id: "user-1", identifier: "one@example.test", displayName: "One" },
    { id: "user-2", identifier: "two@example.test", displayName: "Two" },
  ],
  activeAccountId: "user-1",
  view: { kind: "account" },
  agentViews: [
    {
      sessionId: "session-1",
      agentId: "agent-1",
      agentName: "Builder",
      agentHandle: "builder",
      repositoryId: "repo-1",
      owner: "one",
      repository: "project",
      permission: "write",
      expiresAt: Date.now() + 60_000,
    },
  ],
  accountLimit: 5,
  agentViewsTruncated: false,
};

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearSession();
  setExpectedIdentity(null);
  preferencesState.locale = "zh-CN";
  i18n.global.locale.value = "zh-CN";
  localStorage.removeItem("gitedge.preferences");
});

function accountMenu(targets: string[]) {
  return testH(BrowserAccountMenu, {
    onIdentitySwitch: (target: string) => targets.push(target),
  });
}

describe("browser account and agent view menu", () => {
  it("loads the browser account list only after the avatar menu opens", async () => {
    vi.spyOn(api, "accountProfile").mockRejectedValue(new Error("unused profile"));
    const load = vi.spyOn(api, "browserAccounts").mockResolvedValue(browserAccounts);
    const mounted = await mountAt("/_verify/browser-accounts", "/_verify/browser-accounts", () =>
      testH(App)
    );

    expect(load).not.toHaveBeenCalled();
    control(mounted.root, ".user-menu summary").click();
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
    expect(mounted.root.querySelectorAll(".browser-account-option")).toHaveLength(3);
    expect(mounted.root.textContent).toContain("浏览器账户");
    mounted.unmount();
  });

  it("switches a listed account and emits a hard-navigation target", async () => {
    setSession(user);
    vi.spyOn(api, "browserAccounts").mockResolvedValue(browserAccounts);
    const switchAccount = vi
      .spyOn(api, "switchBrowserAccount")
      .mockResolvedValue({ switched: true });
    const targets: string[] = [];
    const mounted = await mountAt("/_verify/account-select", "/_verify/account-select", () =>
      accountMenu(targets)
    );
    await settle();

    const account = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".browser-account-option")
    ).find((button) => button.textContent?.includes("two@example.test"));
    account?.click();
    await settle();

    expect(switchAccount).toHaveBeenCalledWith("user-2");
    expect(targets).toEqual(["/dashboard"]);
    mounted.unmount();
  });

  it("switches to an agent session and returns to the repository", async () => {
    setSession(user);
    vi.spyOn(api, "browserAccounts").mockResolvedValue(browserAccounts);
    const switchView = vi.spyOn(api, "switchBrowserView").mockResolvedValue({ switched: true });
    const targets: string[] = [];
    const mounted = await mountAt("/_verify/agent-view", "/_verify/agent-view", () =>
      accountMenu(targets)
    );
    await settle();

    const agent = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".browser-agent-option")
    ).find((button) => button.textContent?.includes("Builder"));
    agent?.click();
    await settle();

    expect(switchView).toHaveBeenCalledWith({ kind: "agent", sessionId: "session-1" });
    expect(targets).toEqual(["/one/project"]);
    mounted.unmount();
  });

  it("lets a signed-out browser reactivate its selected human account", async () => {
    vi.spyOn(api, "browserAccounts").mockResolvedValue(browserAccounts);
    const switchView = vi.spyOn(api, "switchBrowserView").mockResolvedValue({ switched: true });
    const targets: string[] = [];
    const mounted = await mountAt("/_verify/reactivate-view", "/_verify/reactivate-view", () =>
      accountMenu(targets)
    );
    clearSession();
    await settle();

    const active = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".browser-account-option")
    ).find((button) => button.textContent?.includes("one@example.test"));
    expect(active?.textContent).toContain("恢复本人视角");
    active?.click();
    await settle();

    expect(switchView).toHaveBeenCalledWith({ kind: "account" });
    expect(targets).toEqual(["/dashboard"]);
    mounted.unmount();
  });

  it("keeps retry and add-account actions available after an account-list failure", async () => {
    const load = vi
      .spyOn(api, "browserAccounts")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(browserAccounts);
    const add = vi.fn();
    const mounted = await mountAt("/_verify/account-retry", "/_verify/account-retry", () =>
      testH(BrowserAccountMenu, { onAddAccount: add })
    );
    await settle();

    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "无法加载浏览器账户"
    );
    Array.from(mounted.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("重试"))
      ?.click();
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(mounted.root.textContent).toContain("One");

    load.mockRejectedValueOnce(new Error("offline again"));
    const failedAgain = await mountAt(
      "/_verify/account-retry-again",
      "/_verify/account-retry-again",
      () => testH(BrowserAccountMenu, { onAddAccount: add })
    );
    await settle();
    Array.from(failedAgain.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("添加账户"))
      ?.click();
    expect(add).toHaveBeenCalledTimes(1);
    mounted.unmount();
    failedAgain.unmount();
  });
});

describe("add-account sign-in and request identity", () => {
  it("allows an existing login to enter add-account mode and returns to the requested page", async () => {
    setSession(user);
    vi.spyOn(api, "ssoProviders").mockResolvedValue([
      { id: "work", label: "Work", protocol: "oidc" },
    ]);
    const mounted = await mountAt("/_verify/add-account", "/_verify/add-account", () =>
      testH(AuthView)
    );
    await router.push({ path: "/login", query: { add: "1", redirect: "/one/project" } });
    await settle();

    expect(router.currentRoute.value.path).toBe("/login");
    expect(mounted.root.querySelector("h1")?.textContent).toContain("添加另一个账户");
    expect(mounted.root.querySelector<HTMLAnchorElement>(".federation-provider")?.href).toContain(
      "prompt=select_account"
    );
    const cancel = mounted.root.querySelector<HTMLButtonElement>(".auth-page-footer button");
    expect(cancel?.textContent).toContain("取消并返回");
    const replace = vi.spyOn(router, "replace");
    cancel?.click();
    await settle();
    expect(replace).toHaveBeenCalledWith("/one/project");
    await replace.mock.results[0]?.value;
    expect(router.currentRoute.value.fullPath).toBe("/one/project");
    mounted.unmount();
  });

  it("requests account selection from GitHub during add-account login", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { origin: "https://gitedge.test", assign });
    setSession(user);
    vi.spyOn(api, "ssoProviders").mockResolvedValue([]);
    const mounted = await mountAt("/_verify/github-add", "/_verify/github-add", () =>
      testH(AuthView)
    );
    await router.push({ path: "/login", query: { add: "1", redirect: "/one/project" } });
    await settle();

    control(mounted.root, ".github-auth-choice").click();
    const target = new URL(String(assign.mock.calls[0]?.[0]), "https://gitedge.test");
    expect(target.pathname).toBe("/api/auth/github/start");
    expect(target.searchParams.get("prompt")).toBe("select_account");
    mounted.unmount();
  });

  it("sends expected user and view on business requests, but not session/account-list reads", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: browserAccounts }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    setExpectedIdentity("user-1", "session-1");

    await api.session();
    await api.browserAccounts();
    await api.repositories();
    await api.switchBrowserView({ kind: "account" });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({});
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({});
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      "X-GitEdge-Expected-User": "user-1",
      "X-GitEdge-Expected-View": "session-1",
    });
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toMatchObject({
      "X-GitEdge-Expected-User": "user-1",
      "X-GitEdge-Expected-View": "session-1",
    });
    expect(expectedIdentityHeaders("/api/deploy/plan?repositoryId=repo-1", "GET")).toEqual({
      "X-GitEdge-Expected-User": "user-1",
      "X-GitEdge-Expected-View": "session-1",
    });
  });

  it("refreshes the session on tab focus and reloads when only the agent session changed", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { origin: "https://gitedge.test", reload, assign: vi.fn() });
    vi.spyOn(api, "accountProfile").mockRejectedValue(new Error("unused profile"));
    const nextViewUser: User = {
      ...agentUser,
      agentSession: { ...agentUser.agentSession!, id: "session-2" },
    };
    const refresh = vi.spyOn(api, "session").mockResolvedValue(nextViewUser);
    const mounted = await mountAt(
      "/_verify/identity-focus",
      "/_verify/identity-focus",
      () => testH(App),
      () => testH("div")
    );
    setSession(agentUser);
    await settle();
    refresh.mockClear();
    reload.mockClear();

    window.dispatchEvent(new Event("focus"));
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sessionState.user?.agentSession?.id).toBe("session-2");
    expect(reload).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it("keeps preference changes local in an agent view", async () => {
    setSession(agentUser);
    const readProfile = vi.spyOn(api, "accountProfile");
    const saveProfile = vi.spyOn(api, "updateAccountProfile");

    await loadAccountPreferences();
    await updatePreference("locale", "en");

    expect(readProfile).not.toHaveBeenCalled();
    expect(saveProfile).not.toHaveBeenCalled();
    expect(i18n.global.locale.value).toBe("en");
    expect(JSON.parse(localStorage.getItem("gitedge.preferences") ?? "{}")).toMatchObject({
      locale: "en",
    });
  });
});
