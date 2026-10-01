import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import App from "../../apps/web/src/App.vue";
import { router } from "../../apps/web/src/router";
import { i18n } from "../../apps/web/src/i18n";
import { ssoAuthorizationUrl } from "../../apps/web/src/lib/api";
import { clearSession, sessionState, setSession } from "../../apps/web/src/lib/session";

const providers = [
  { id: "acme-oidc", label: "Acme", protocol: "oidc" },
  {
    id: "corp-saml",
    label: "Corporate Login",
    protocol: "saml",
    metadataUrl: "https://idp.example.test/metadata.xml",
  },
];

const identity = {
  id: "identity-1",
  providerId: "acme-oidc",
  providerLabel: "Acme",
  protocol: "oidc",
  displayName: "Example User",
  email: "user@example.test",
  emailVerified: true,
  createdAt: 1,
  lastLoginAt: 2,
};

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountRoute(path: string) {
  await router.push(path);
  await router.isReady();
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(App);
  app.use(router);
  app.use(i18n);
  app.mount(root);
  return {
    root,
    async navigate(to: string) {
      await router.push(to);
      await settle();
    },
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearSession();
  i18n.global.locale.value = "en";
  document.body.innerHTML = "";
});

describe("OIDC and SAML account flows", () => {
  it("allows configured HTTPS authorization URLs and rejects unsafe schemes and userinfo", () => {
    expect(ssoAuthorizationUrl("https://identity.example.test/authorize")?.href).toBe(
      "https://identity.example.test/authorize"
    );
    expect(ssoAuthorizationUrl("javascript:alert(1)")).toBeNull();
    expect(ssoAuthorizationUrl("data:text/html,login")).toBeNull();
    expect(ssoAuthorizationUrl("https://user:password@identity.example.test/authorize")).toBeNull();
  });

  it("lists provider protocols and metadata and uses only a safe in-site login return path", async () => {
    i18n.global.locale.value = "en";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://gitedge.test");
        if (url.pathname === "/api/auth/sso/providers")
          return new Response(JSON.stringify({ data: providers }), { status: 200 });
        return new Response("Not signed in", { status: 401 });
      })
    );
    const mounted = await mountRoute("/login?redirect=https%3A%2F%2Fevil.example%2Fsteal");
    await settle();

    const acmeLink = mounted.root.querySelector<HTMLAnchorElement>(
      '.federation-provider[href*="acme-oidc"]'
    );
    const samlLink = mounted.root.querySelector<HTMLAnchorElement>(
      '.federation-provider[href*="corp-saml"]'
    );
    expect(acmeLink?.textContent).toContain("OIDC");
    expect(samlLink?.textContent).toContain("SAML");
    expect(
      new URL(acmeLink?.href || "https://gitedge.test/", "https://gitedge.test").searchParams.get(
        "returnTo"
      )
    ).toBe("/dashboard");
    expect(
      mounted.root.querySelector('a[href="https://idp.example.test/metadata.xml"]')?.textContent
    ).toContain("SAML metadata");

    await mounted.navigate("/login?error=sso_invalid_response");
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "Single sign-on could not be completed"
    );
    expect(mounted.root.textContent).not.toContain("sso_invalid_response");
    mounted.unmount();
  });

  it("shows all providers and existing GitHub identity, then preserves backend unlink errors", async () => {
    setSession({
      id: "user-1",
      identifier: "person@example.test",
      externalIdentity: {
        provider: "github",
        login: "person",
        accessLevel: "identity",
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://gitedge.test");
      if (url.pathname === "/api/auth/session")
        return new Response(
          JSON.stringify({
            data: {
              id: "user-1",
              identifier: "person@example.test",
              externalIdentity: { provider: "github", login: "person", accessLevel: "identity" },
            },
          }),
          { status: 200 }
        );
      if (url.pathname === "/api/auth/sso/providers")
        return new Response(JSON.stringify({ data: providers }), { status: 200 });
      if (url.pathname === "/api/auth/sso/identities")
        return new Response(JSON.stringify({ data: [identity] }), { status: 200 });
      if (init?.method === "DELETE")
        return new Response(
          JSON.stringify({ error: { message: "Keep another sign-in method before unlinking." } }),
          { status: 409 }
        );
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountRoute("/settings/account?sso=linked");
    await settle();

    expect(mounted.root.textContent).toContain("The single sign-on identity is linked.");
    expect(mounted.root.textContent).toContain("Linked sign-in identities");
    expect(mounted.root.textContent).toContain("OIDC");
    expect(mounted.root.textContent).toContain("SAML");
    expect(mounted.root.textContent).toContain("GitHub");
    expect(mounted.root.querySelectorAll(".sso-provider")).toHaveLength(1);

    mounted.root.querySelector<HTMLButtonElement>(".sso-identity .btn")?.click();
    await settle();
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "Keep another sign-in method before unlinking."
    );
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes("/api/auth/sso/identities/identity-1") && init?.method === "DELETE"
      )
    ).toBe(true);
    await mounted.navigate("/settings/account?error=sso_identity_in_use");
    expect(
      Array.from(mounted.root.querySelectorAll('[role="alert"]'))
        .map((alert) => alert.textContent)
        .join(" ")
    ).toContain("already linked to another GitEdge account");
    mounted.unmount();
  });

  it("creates an explicit identity-link request and rejects an authorization URL with userinfo", async () => {
    setSession({ id: "user-1", identifier: "person@example.test" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://gitedge.test");
      if (url.pathname === "/api/auth/session")
        return new Response(
          JSON.stringify({ data: { id: "user-1", identifier: "person@example.test" } }),
          { status: 200 }
        );
      if (url.pathname === "/api/auth/sso/providers")
        return new Response(JSON.stringify({ data: [providers[0]] }), { status: 200 });
      if (url.pathname === "/api/auth/sso/identities")
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (init?.method === "POST")
        return new Response(
          JSON.stringify({
            data: { url: "https://user@identity.example.test/authorize" },
          }),
          { status: 200 }
        );
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountRoute("/settings/account");
    await settle();

    mounted.root.querySelector<HTMLButtonElement>(".sso-provider .btn")?.click();
    await settle();

    const linkCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(linkCall?.[0]).toContain("/api/auth/sso/acme-oidc/link");
    expect(JSON.parse(String(linkCall?.[1]?.body))).toEqual({ returnTo: "/settings/account" });
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "Unable to start identity linking"
    );
    mounted.unmount();
  });

  it("ends the GitEdge session and reports when provider logout is unavailable", async () => {
    setSession({ id: "user-1", identifier: "user@example.test" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://gitedge.test");
      if (url.pathname === "/api/auth/session")
        return new Response(
          JSON.stringify({ data: { id: "user-1", identifier: "user@example.test" } }),
          { status: 200 }
        );
      if (url.pathname === "/api/auth/sso/providers")
        return new Response(JSON.stringify({ data: [providers[0]] }), { status: 200 });
      if (url.pathname === "/api/auth/sso/identities")
        return new Response(JSON.stringify({ data: [identity] }), { status: 200 });
      if (url.pathname === "/api/auth/sso/acme-oidc/logout" && init?.method === "POST")
        return new Response(
          JSON.stringify({ data: { url: null, providerLogoutUnavailable: true } }),
          { status: 200 }
        );
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountRoute("/settings/account");
    await settle();

    mounted.root.querySelectorAll<HTMLButtonElement>(".sso-identity .btn")[1]?.click();
    await settle();

    expect(sessionState.user).toBeNull();
    expect(router.currentRoute.value.fullPath).toBe("/login?error=sso_logout_unavailable");
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "GitEdge session has ended, but the identity provider did not confirm sign-out"
    );
    const logoutCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(logoutCall?.[0]).toContain("/api/auth/sso/acme-oidc/logout");
    expect(JSON.parse(String(logoutCall?.[1]?.body))).toEqual({ identityId: identity.id });
    mounted.unmount();
  });
});
