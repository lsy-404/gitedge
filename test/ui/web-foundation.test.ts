import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import App from "../../apps/web/src/App.vue";
import SigningKeySettings from "../../apps/web/src/components/SigningKeySettings.vue";
import { ApiError, api, errorMessage } from "../../apps/web/src/lib/api";
import {
  clearSession,
  refreshSession,
  sessionState,
  setSession,
} from "../../apps/web/src/lib/session";
import { i18n } from "../../apps/web/src/i18n";
import { router } from "../../apps/web/src/router";
import { fluentUi } from "../../apps/web/src/ui/fluent";
import { h as testH, mountAt, settle, unmountAll } from "./task-support";

const t = (key: string, values?: Record<string, string | number>) =>
  i18n.global.t(key, values ?? {}, { locale: "en" });

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearSession();
  i18n.global.locale.value = "zh-CN";
});

describe("errorMessage", () => {
  it("maps status codes to localized defaults and honors overrides", () => {
    expect(errorMessage(new ApiError(403, "x"), t)).toBe(t("permissionDenied"));
    expect(errorMessage(new ApiError(404, "x"), t)).toBe(t("resourceNotFound"));
    expect(errorMessage(new ApiError(409, "x"), t)).toBe(t("conflictError"));
    expect(errorMessage(new ApiError(429, "x"), t)).toBe(t("rateLimited"));
    expect(errorMessage(new ApiError(401, "x"), t)).toBe(t("apiError"));
    expect(errorMessage(new ApiError(401, "x"), t, { 401: "invalidCredentials" })).toBe(
      t("invalidCredentials")
    );
    expect(errorMessage(new ApiError(409, "x"), t, { 409: "nameTaken" })).toBe(t("nameTaken"));
    expect(errorMessage(new Error("raw"), t)).toBe(t("apiError"));
    expect(errorMessage(new Error("raw"), t, {}, "deployWizard.error")).toBe(
      t("deployWizard.error")
    );
  });

  it("never exposes the server message and keeps the machine-readable code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "conflict", message: "Server text" } }), {
        status: 409,
      })
    );
    const failure = await api.session().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure instanceof ApiError && failure.code).toBe("conflict");
    expect(errorMessage(failure, t)).not.toContain("Server text");
  });
});

describe("session refresh failures", () => {
  it("keeps the signed-in identity when a later check fails transiently", async () => {
    const user = { id: "user-1", identifier: "example-user" };
    setSession(user);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(api, "browserSession").mockRejectedValue(new ApiError(503, "Unavailable"));
    await refreshSession();
    expect(sessionState.user).toEqual(user);
    expect(sessionState.view).toBe("account");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [], truncated: false }), { status: 200 })
      );
    await api.issues("repo-1");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("X-GitEdge-Expected-User")).toBe(
      "user-1"
    );
  });
});

describe("application shell", () => {
  it("keeps guest previews on public routes", async () => {
    const mounted = await mountAt(
      "/_verify/guest-shell",
      "/_verify/guest-shell",
      () => testH(App),
      () => testH("div")
    );
    sessionState.user = null;
    sessionState.view = "guest";
    await settle();

    expect(mounted.root.querySelector('a[href="/dashboard"]')).toBeNull();
    expect(mounted.root.querySelector('a[href="/organizations"]')).toBeNull();
    expect(mounted.root.querySelector(".brand")?.getAttribute("href")).toBe("/_verify/guest-shell");
    await router.push("/dashboard");
    expect(router.currentRoute.value.path).toBe("/_verify/guest-shell");
    mounted.unmount();
  });

  it("reports a failed sign-out without leaving the page", async () => {
    vi.spyOn(api, "logout").mockRejectedValue(new ApiError(503, "Unavailable"));
    vi.spyOn(api, "accountProfile").mockRejectedValue(new Error("unused profile"));
    const mounted = await mountAt(
      "/_verify/sign-out",
      "/_verify/sign-out",
      () => testH(App),
      () => testH("div")
    );
    const button = Array.from(mounted.root.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes(i18n.global.t("signOut"))
    );
    button?.click();
    await settle();

    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      i18n.global.t("signOutError")
    );
    expect(router.currentRoute.value.path).toBe("/_verify/sign-out");
    expect(sessionState.user).not.toBeNull();
    mounted.unmount();
  });

  it("names the document after the route and moves focus to the main region", async () => {
    const mounted = await mountAt(
      "/title-test/:owner/:repo",
      "/title-test/acme/project",
      () => testH(App),
      () => testH("div")
    );
    expect(document.title).toBe("acme/project · GitEdge");

    await router.push("/title-test/acme/other");
    await settle();

    expect(document.title).toBe("acme/other · GitEdge");
    expect(document.activeElement?.id).toBe("main");
    mounted.unmount();
  });
});

describe("date formatting", () => {
  it("follows the application locale instead of the browser locale", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-CN");
    i18n.global.locale.value = "en";
    vi.spyOn(api, "signingKeys").mockResolvedValue([
      {
        id: "key-1",
        title: "Laptop",
        fingerprint: "SHA256:abc",
        keyIds: [],
        publicKey: "key",
        createdAt: Date.UTC(2026, 0, 15, 12),
        revokedAt: null,
      },
    ]);
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(SigningKeySettings);
    app.use(i18n);
    app.use(fluentUi);
    app.mount(root);
    await nextTick();
    await settle();

    expect(root.textContent).toContain("Jan 15, 2026");
    app.unmount();
    root.remove();
  });
});
