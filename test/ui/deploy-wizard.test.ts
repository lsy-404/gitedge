import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { i18n } from "../../apps/web/src/i18n";
import { fluentUi } from "../../apps/web/src/ui/fluent";
import DeployWizard from "../../apps/web/src/components/DeployWizard.vue";

const repository = {
  id: "repo-1",
  namespaceId: "ns-1",
  owner: "example",
  name: "sample",
  slug: "sample",
  description: "",
  visibility: "private" as const,
  defaultBranch: "main",
  createdAt: 1,
  updatedAt: 1,
  canWrite: true,
  archived: false,
  issuesEnabled: true,
  pullsEnabled: true,
  discussionsEnabled: true,
  wikiEnabled: true,
  requiredApprovals: 0,
  requirePassingChecks: false,
};

const plan = {
  repositoryId: "repo-1",
  ref: "main",
  manifestDigest: "sha256:review-this-digest",
  permissions: ["workers:write", "d1:write"],
  manifest: {
    schema: 1,
    name: "Sample service",
    license: { id: "MIT", text: "MIT license terms" },
    terms: { required: true, text: "Service usage terms" },
    worker: {
      entrypoint: "worker.js",
      modules: ["worker.js", "shared.mjs"],
      compatibilityDate: "2026-10-01",
      compatibilityFlags: [],
      vars: { MODE: "production" },
    },
    resources: {
      d1: [
        { id: "database", binding: "DB", name: "sample-db", migrations: ["migrations/001.sql"] },
      ],
      r2: [],
      kv: [],
    },
  },
};

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function submitForm(root: HTMLElement, selector: string): void {
  const form = root.querySelector(selector);
  if (!(form instanceof HTMLFormElement)) throw new Error(`Expected form: ${selector}`);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function mountWizard() {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(DeployWizard, { repository });
  app.use(i18n);
  app.use(fluentUi);
  app.mount(root);
  return {
    root,
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  i18n.global.locale.value = "zh-CN";
  document.body.innerHTML = "";
});

describe("Cloudflare deployment wizard", () => {
  it("shows the complete plan and license disclosures before asking for a token", async () => {
    i18n.global.locale.value = "en";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: plan }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const mounted = mountWizard();

    submitForm(mounted.root, ".deploy-read-form");
    await settle();

    expect(mounted.root.textContent).toContain("sha256:review-this-digest");
    expect(mounted.root.textContent).toContain("workers:write");
    expect(mounted.root.textContent).toContain("worker.js");
    expect(mounted.root.textContent).toContain("D1 · DB · sample-db");
    expect(mounted.root.textContent).toContain("MIT license terms");
    expect(mounted.root.textContent).toContain("Service usage terms");
    expect(mounted.root.querySelector<HTMLElement>("#deploy-token")).not.toBeNull();
    expect(mounted.root.querySelector(".deploy-confirm-form")).toBeNull();

    mounted.unmount();
  });

  it("retries by stable step ID and continues through the remaining steps", async () => {
    i18n.global.locale.value = "en";
    const requests: string[] = [];
    let migrationAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://gitedge.test");
      const action = url.pathname.split("/").at(-1) ?? "";
      requests.push(action);
      if (action === "plan") return new Response(JSON.stringify({ data: plan }), { status: 200 });
      if (action === "session")
        return new Response(
          JSON.stringify({
            data: { accounts: [{ id: "account-1", name: "Account" }], nonce: "nonce" },
          }),
          { status: 200 }
        );
      if (action === "resources")
        return new Response(
          JSON.stringify({ data: { resources: [{ id: "database", exists: false }] } }),
          { status: 200 }
        );
      if (action === "migrate" && migrationAttempts++ === 0)
        return new Response(
          JSON.stringify({ error: { code: "unavailable", message: "Migration service busy" } }),
          {
            status: 503,
          }
        );
      if (action === "deploy")
        return new Response(
          JSON.stringify({
            data: { workerName: "sample-worker", url: "https://sample.workers.dev", resources: [] },
          }),
          { status: 200 }
        );
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = mountWizard();

    submitForm(mounted.root, ".deploy-read-form");
    await settle();
    const tokenInput = mounted.root.querySelector<HTMLElement>("#deploy-token");
    if (!tokenInput) throw new Error("Token field was not rendered");
    Reflect.set(tokenInput, "value", "temporary-test-token");
    tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
    submitForm(mounted.root, ".deploy-token-form");
    await settle();

    const confirm = mounted.root.querySelector<HTMLElement>("#deploy-confirm");
    if (!confirm) throw new Error("Deployment confirmation was not rendered");
    Reflect.set(confirm, "checked", true);
    confirm.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    submitForm(mounted.root, ".deploy-confirm-form");
    await settle();
    expect(mounted.root.textContent).toContain("Migration service busy");
    expect(requests.slice(-2)).toEqual(["provision", "migrate"]);

    mounted.root.querySelector<HTMLElement>("[role='alert'] .fluent-button")?.click();
    await settle();

    expect(requests.slice(-2)).toEqual(["migrate", "deploy"]);
    expect(mounted.root.textContent).toContain("Deployment complete");
    expect(
      mounted.root.querySelector(".deploy-progress li[data-state='done']")?.textContent
    ).toContain("Prepare resources");

    mounted.unmount();
  });

  it("reports a non-JSON gateway failure without leaking parser errors", async () => {
    i18n.global.locale.value = "en";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 }))
    );
    const mounted = mountWizard();

    submitForm(mounted.root, ".deploy-read-form");
    await settle();

    expect(mounted.root.querySelector("[role='alert']")).not.toBeNull();
    expect(mounted.root.textContent).not.toContain("Unexpected token");
    expect(mounted.root.textContent).not.toContain("Bad gateway");
    expect(mounted.root.querySelector("[role='alert']")?.textContent).toContain(
      i18n.global.t("deployWizard.error")
    );
    mounted.unmount();
  });

  it("does not claim resources will be created when availability could not be checked", async () => {
    i18n.global.locale.value = "en";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const action = new URL(String(input), "https://gitedge.test").pathname.split("/").at(-1);
      if (action === "plan") return new Response(JSON.stringify({ data: plan }), { status: 200 });
      if (action === "session")
        return new Response(
          JSON.stringify({
            data: { accounts: [{ id: "account-1", name: "Account" }], nonce: "nonce" },
          }),
          { status: 200 }
        );
      if (action === "resources") return new Response("unavailable", { status: 502 });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = mountWizard();

    submitForm(mounted.root, ".deploy-read-form");
    await settle();
    const tokenInput = mounted.root.querySelector<HTMLElement>("#deploy-token");
    if (!tokenInput) throw new Error("Token field was not rendered");
    Reflect.set(tokenInput, "value", "temporary-test-token");
    tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
    submitForm(mounted.root, ".deploy-token-form");
    await settle();

    expect(mounted.root.textContent).toContain("Could not verify");
    expect(mounted.root.textContent).not.toContain("Will create");
    mounted.unmount();
  });
});
