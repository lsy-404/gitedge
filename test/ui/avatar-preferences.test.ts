import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../apps/web/src/App.vue";
import { i18n } from "../../apps/web/src/i18n";
import { api } from "../../apps/web/src/lib/api";
import { preferencesState } from "../../apps/web/src/lib/preferences";
import { clearSession } from "../../apps/web/src/lib/session";
import { router } from "../../apps/web/src/router";
import type { AccountProfile } from "../../packages/contracts/src/account";
import { control, h, mountAt, settle, unmountAll } from "./task-support";

const profile: AccountProfile = {
  identifier: "octocat",
  displayName: "Octocat",
  bio: "",
  location: "",
  website: "",
  preferences: {
    theme: "system",
    locale: "en",
    density: "comfortable",
    tabSize: 2,
    lineWrap: false,
  },
};

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  clearSession();
  localStorage.removeItem("gitedge.preferences");
  i18n.global.locale.value = "zh-CN";
});

describe("avatar appearance preferences", () => {
  it("expands keyboard accessible language and theme choices and saves account preferences", async () => {
    vi.spyOn(api, "accountProfile").mockResolvedValue(structuredClone(profile));
    const save = vi.spyOn(api, "updateAccountProfile").mockImplementation(async (payload) => ({
      ...profile,
      preferences: { ...profile.preferences, ...payload.preferences },
    }));
    const mounted = await mountAt("/_verify/avatar", "/_verify/avatar", () => h(App));
    control(mounted.root, ".user-menu summary").click();
    await settle();

    const languageToggle = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".user-menu button")
    ).find((button) => button.textContent?.includes("Language"));
    expect(languageToggle).toBeDefined();
    languageToggle?.click();
    await settle();
    const chinese = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".preference-options button")
    ).find((button) => button.textContent?.includes("简体中文"));
    expect(chinese).toBeDefined();
    chinese?.click();
    await settle();
    expect(i18n.global.locale.value).toBe("zh-CN");
    expect(save).toHaveBeenCalledWith({ preferences: { locale: "zh-CN" } });

    const themeToggle = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".user-menu button")
    ).find((button) => button.textContent?.includes("外观主题"));
    themeToggle?.click();
    await settle();
    const dark = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".preference-options button")
    ).find((button) => button.textContent?.includes("深色"));
    dark?.click();
    await settle();
    expect(preferencesState.theme).toBe("dark");
    expect(save).toHaveBeenLastCalledWith({ preferences: { theme: "dark" } });
    mounted.unmount();
  });

  it("stores anonymous preference changes locally", async () => {
    clearSession();
    const { updatePreference, loadAccountPreferences } =
      await import("../../apps/web/src/lib/preferences");
    await updatePreference("locale", "en");
    expect(JSON.parse(localStorage.getItem("gitedge.preferences") ?? "{}")).toMatchObject({
      locale: "en",
    });
    await loadAccountPreferences();
    expect(i18n.global.locale.value).toBe("en");
  });

  it("keeps the anonymous avatar preference menu available on the login page", async () => {
    vi.spyOn(api, "accountProfile").mockResolvedValue(structuredClone(profile));
    const mounted = await mountAt("/_verify/login-avatar", "/_verify/login-avatar", () => h(App));
    clearSession();
    await router.push("/login");
    await settle();

    control(mounted.root, ".user-menu summary").click();
    await settle();
    expect(
      Array.from(mounted.root.querySelectorAll(".user-menu button")).some((button) =>
        button.textContent?.includes("Language")
      )
    ).toBe(true);
    mounted.unmount();
  });

  it("shows a save error and restores the previous account preference", async () => {
    vi.spyOn(api, "accountProfile").mockResolvedValue(structuredClone(profile));
    vi.spyOn(api, "updateAccountProfile").mockRejectedValue(new Error("offline"));
    const mounted = await mountAt("/_verify/avatar-error", "/_verify/avatar-error", () => h(App));
    control(mounted.root, ".user-menu summary").click();
    await settle();
    Array.from(mounted.root.querySelectorAll<HTMLButtonElement>(".user-menu button"))
      .find((button) => button.textContent?.includes("Language"))
      ?.click();
    await settle();
    Array.from(mounted.root.querySelectorAll<HTMLButtonElement>(".preference-options button"))
      .find((button) => button.textContent?.includes("简体中文"))
      ?.click();
    await settle();

    expect(i18n.global.locale.value).toBe("en");
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
    mounted.unmount();
  });

  it("keeps an explicit selection when the initial account profile read completes late", async () => {
    let resolveProfile!: (value: AccountProfile) => void;
    vi.spyOn(api, "accountProfile").mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve;
      })
    );
    vi.spyOn(api, "updateAccountProfile").mockResolvedValue({
      ...profile,
      preferences: { ...profile.preferences, locale: "en" },
    });
    const mounted = await mountAt("/_verify/avatar-race", "/_verify/avatar-race", () => h(App));
    control(mounted.root, ".user-menu summary").click();
    await settle();
    Array.from(mounted.root.querySelectorAll<HTMLButtonElement>(".user-menu button"))
      .find((button) => button.textContent?.includes("Language"))
      ?.click();
    await settle();
    Array.from(mounted.root.querySelectorAll<HTMLButtonElement>(".preference-options button"))
      .find((button) => button.textContent?.includes("English"))
      ?.click();
    await settle();

    resolveProfile(structuredClone(profile));
    await settle();
    expect(i18n.global.locale.value).toBe("en");
    mounted.unmount();
  });
});
