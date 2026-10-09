import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import AccountProfilePanel from "../../apps/web/src/components/AccountProfilePanel.vue";
import AccessTokenSettings from "../../apps/web/src/components/AccessTokenSettings.vue";
import CredentialSettings from "../../apps/web/src/components/CredentialSettings.vue";
import BrowserSessions from "../../apps/web/src/components/BrowserSessions.vue";
import { api } from "../../apps/web/src/lib/api";
import { i18n } from "../../apps/web/src/i18n";
import { preferencesState } from "../../apps/web/src/lib/preferences";
import { sessionState, clearSession } from "../../apps/web/src/lib/session";
import { router } from "../../apps/web/src/router";
import type { AccountProfile } from "../../packages/contracts/src/account";
import {
  control,
  fill,
  findButton,
  mountAt,
  repository,
  settle,
  confirmClick,
  submit,
  unmountAll,
} from "./task-support";

const profile: AccountProfile = {
  identifier: "workspace",
  displayName: "Maintainer",
  bio: "",
  location: "",
  website: "",
  preferences: {
    theme: "light",
    locale: "en",
    density: "comfortable",
    tabSize: 2,
    lineWrap: false,
  },
};
function field(root: ParentNode, label: string): HTMLInputElement {
  const matching = Array.from(root.querySelectorAll("label")).find((item) =>
    item.textContent?.includes(label)
  );
  const input = matching?.querySelector("input");
  if (!input) throw new Error(`Missing input ${label}`);
  return input;
}
beforeEach(() => {
  i18n.global.locale.value = "en";
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  clearSession();
});
describe("Account settings using Platform Kit", () => {
  it("saves a profile rename and refreshes the active account", async () => {
    vi.spyOn(api, "accountProfile").mockResolvedValue(structuredClone(profile));
    const save = vi
      .spyOn(api, "updateAccountProfile")
      .mockResolvedValue({ ...profile, identifier: "maintainer", displayName: "New display" });
    vi.spyOn(api, "browserSession").mockResolvedValue({
      user: { id: "user-1", identifier: "maintainer" },
      view: { kind: "account" },
    });
    const mounted = await mountAt("/_verify/account/profile", "/_verify/account/profile", () =>
      h(AccountProfilePanel, { section: "profile" })
    );
    fill(field(mounted.root, "Username"), "maintainer");
    fill(field(mounted.root, "Display name"), "New display");
    await settle();
    submit(control(mounted.root, "form"));
    await settle();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: "maintainer", displayName: "New display" })
    );
    expect(sessionState.user?.identifier).toBe("maintainer");
    expect(mounted.root.textContent).toContain("Settings saved.");
  });
  it("persists the code wrapping preference through the actual switch", async () => {
    vi.spyOn(api, "accountProfile").mockResolvedValue(structuredClone(profile));
    vi.spyOn(api, "browserSession").mockResolvedValue({
      user: { id: "user-1", identifier: profile.identifier },
      view: { kind: "account" },
    });
    const save = vi
      .spyOn(api, "updateAccountProfile")
      .mockResolvedValue({ ...profile, preferences: { ...profile.preferences, lineWrap: true } });
    const mounted = await mountAt(
      "/_verify/account/preferences",
      "/_verify/account/preferences",
      () => h(AccountProfilePanel, { section: "preferences" })
    );
    control(mounted.root, '[role="switch"]').click();
    await settle();
    submit(control(mounted.root, "form"));
    await settle();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ preferences: expect.objectContaining({ lineWrap: true }) })
    );
    expect(preferencesState.lineWrap).toBe(true);
  });
  it("shows a thirty-day credential once and removes its secret when dismissed", async () => {
    vi.spyOn(api, "repositories").mockResolvedValue([repository]);
    vi.spyOn(api, "gitCredentials").mockResolvedValue([]);
    vi.spyOn(api, "createCloneToken").mockResolvedValue({
      id: "token-1",
      token: "one-time-secret",
      expiresAt: Date.now() + 30 * 86400000,
    });
    const mounted = await mountAt(
      "/_verify/account/credentials",
      "/_verify/account/credentials",
      () => h(CredentialSettings)
    );
    fill(control(mounted.root, "input"), "Development");
    await settle();
    submit(control(mounted.root, "form"));
    await settle();
    expect(
      mounted.root.querySelector("input[readonly]")?.getAttribute("value") ??
        mounted.root.querySelector<HTMLInputElement>("input[readonly]")?.value
    ).toBe("one-time-secret");
    findButton(mounted.root, "Saved, hide token").click();
    await settle();
    expect(mounted.root.querySelector("input[readonly]")).toBeNull();
  });
  it("creates a personal access token, shows it once and lists revocable tokens", async () => {
    const existing = {
      id: "pat-old",
      name: "Laptop",
      prefix: "gep_deadbeef",
      scopes: ["repo:write" as const],
      repositories: [{ id: "repo-1", owner: "workspace", slug: "app" }],
      createdAt: 1,
      expiresAt: Date.now() + 86_400_000,
      lastUsedAt: null,
      revokedAt: null,
    };
    vi.spyOn(api, "repositories").mockResolvedValue([repository]);
    const list = vi.spyOn(api, "accessTokens").mockResolvedValue([existing]);
    const create = vi.spyOn(api, "createAccessToken").mockResolvedValue({
      ...existing,
      id: "pat-new",
      name: "CI",
      scopes: ["repo:read"],
      repositories: null,
      token: `gep_${"e".repeat(64)}`,
    });
    const revoke = vi.spyOn(api, "revokeAccessToken").mockResolvedValue({ revoked: true });
    const mounted = await mountAt("/_verify/account/tokens", "/_verify/account/tokens", () =>
      h(AccessTokenSettings)
    );
    expect(mounted.root.textContent).toContain("Laptop");
    expect(mounted.root.textContent).toContain("gep_deadbeef");
    expect(mounted.root.textContent).toContain("workspace/app");
    expect(mounted.root.textContent).toContain("Never used");

    fill(control(mounted.root, "input"), "CI");
    await settle();
    submit(control(mounted.root, "form"));
    await settle();
    expect(create).toHaveBeenCalledWith({
      name: "CI",
      scopes: ["repo:read"],
      expiresInDays: 30,
    });
    expect(mounted.root.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe(
      `gep_${"e".repeat(64)}`
    );
    findButton(mounted.root, "Saved, hide token").click();
    await settle();
    expect(mounted.root.querySelector("input[readonly]")).toBeNull();

    await confirmClick(findButton(mounted.root, "Revoke"));
    expect(revoke).toHaveBeenCalledWith("pat-old");
    expect(list.mock.calls.length).toBeGreaterThan(1);
  });
  it("still lists access tokens when the repository picker cannot load", async () => {
    vi.spyOn(api, "repositories").mockRejectedValue(new Error("Repository listing failed"));
    vi.spyOn(api, "accessTokens").mockResolvedValue([
      {
        id: "pat-kept",
        name: "Deploy key",
        prefix: "gep_cafebabe",
        scopes: ["repo:read"],
        repositories: null,
        createdAt: 1,
        expiresAt: Date.now() + 86_400_000,
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    const mounted = await mountAt("/_verify/account/tokens", "/_verify/account/tokens", () =>
      h(AccessTokenSettings)
    );
    expect(mounted.root.textContent).toContain("Request failed");
    expect(mounted.root.textContent).toContain("Deploy key");
  });
  it("revokes the current browser session and clears local identity", async () => {
    vi.spyOn(api, "browserSessions").mockResolvedValue([
      { id: "current", createdAt: 1, expiresAt: Date.now() + 100000, isCurrent: true },
    ]);
    const revoke = vi
      .spyOn(api, "revokeBrowserSession")
      .mockResolvedValue({ revoked: true, isCurrent: true });
    const mounted = await mountAt("/_verify/account/sessions", "/_verify/account/sessions", () =>
      h(BrowserSessions)
    );
    await confirmClick(findButton(mounted.root, "Sign out session"));
    expect(revoke).toHaveBeenCalledWith("current");
    expect(sessionState.user).toBeNull();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/login"));
  });
});
