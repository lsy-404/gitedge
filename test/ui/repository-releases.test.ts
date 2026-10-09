import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h } from "vue";
import RepositoryReleases from "../../apps/web/src/components/RepositoryReleases.vue";
import { i18n } from "../../apps/web/src/i18n";
import { router } from "../../apps/web/src/router";
import { clearSession, setSession } from "../../apps/web/src/lib/session";
import { fluentUi } from "../../apps/web/src/ui/fluent";
import type { Repository } from "../../packages/contracts/src/forge";
import type { Release } from "../../packages/contracts/src/releases";
import { confirmClick, settle } from "./task-support";

const repository: Repository = {
  topics: [],
  starCount: 0,
  forkCount: 0,
  forkOf: null,
  id: "repo-1",
  namespaceId: "ns",
  owner: "example",
  name: "sample",
  slug: "sample",
  description: "",
  visibility: "public",
  defaultBranch: "main",
  createdAt: 1,
  updatedAt: 1,
  canWrite: true,
  viewerRole: "admin",
  archived: false,
  issuesEnabled: true,
  pullsEnabled: true,
  discussionsEnabled: true,
  wikiEnabled: true,
  requiredApprovals: 0,
  requirePassingChecks: false,
  tasksEnabled: true,
  agentsEnabled: true,
  deploymentsEnabled: true,
  graphEnabled: true,
  actionsEnabled: false,
  actionsNetworkEnabled: false,
  onlineEditingEnabled: true,
  allowMergeCommit: true,
  allowSquashMerge: true,
  allowRebaseMerge: true,
  deleteBranchOnMerge: false,
};

function release(overrides: Partial<Release> = {}): Release {
  return {
    id: "release-1",
    tagName: "v1.0.0",
    title: "First release",
    body: "Notes with **bold**",
    draft: false,
    prerelease: false,
    target: null,
    author: "owner",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    publishedAt: 1_700_000_000_000,
    assets: [
      {
        id: "asset-1",
        name: "app.zip",
        size: 2048,
        contentType: "application/zip",
        uploader: "owner",
        createdAt: 1,
      },
    ],
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function mockApi(
  initial: Release[],
  options: { failCreate?: { status: number; code: string } } = {}
) {
  let releases = initial;
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://gitedge.test");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? null);
      calls.push({ method, path: url.pathname + url.search, body });
      if (url.pathname.endsWith("/releases") && method === "GET")
        return Response.json({ data: releases, truncated: false });
      if (url.pathname.endsWith("/releases") && method === "POST") {
        if (options.failCreate)
          return Response.json(
            { error: { code: options.failCreate.code, message: "x" } },
            { status: options.failCreate.status }
          );
        releases = [
          release({
            id: "release-2",
            tagName: body.tagName,
            title: body.title || body.tagName,
            assets: [],
          }),
          ...releases,
        ];
        return Response.json({ data: releases[0] }, { status: 201 });
      }
      if (url.pathname.endsWith("/tags"))
        return Response.json({
          data: [
            {
              name: "v0.9.0",
              oid: "a".repeat(40),
              commitOid: "a".repeat(40),
              annotated: false,
              subject: "s",
              timestamp: 1,
            },
          ],
          truncated: false,
        });
      if (url.pathname.endsWith("/refs"))
        return Response.json({
          data: [
            { name: "refs/heads/main", oid: "a".repeat(40) },
            { name: "refs/heads/dev", oid: "b".repeat(40) },
          ],
        });
      if (method === "PUT" && url.pathname.includes("/assets")) {
        releases = releases.map((item) => ({
          ...item,
          assets: [
            ...item.assets,
            {
              id: "asset-2",
              name: url.searchParams.get("name") ?? "",
              size: 3,
              contentType: "text/plain",
              uploader: "owner",
              createdAt: 2,
            },
          ],
        }));
        return Response.json({ data: releases[0].assets.at(-1) }, { status: 201 });
      }
      if (method === "DELETE" && url.pathname.includes("/assets/")) {
        releases = releases.map((item) => ({
          ...item,
          assets: item.assets.filter((asset) => !url.pathname.endsWith(asset.id)),
        }));
        return Response.json({ data: { deleted: true } });
      }
      if (method === "DELETE") {
        releases = releases.filter((item) => !url.pathname.endsWith(item.id));
        return Response.json({ data: { deleted: true } });
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    })
  );
  return calls;
}

async function mountReleases(overrides: Partial<Repository> = {}) {
  setSession({ id: "user-1", identifier: "owner@example.test" });
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(
    defineComponent({
      setup: () => () => h(RepositoryReleases, { repository: { ...repository, ...overrides } }),
    })
  );
  app.use(router);
  app.use(i18n);
  app.use(fluentUi);
  app.mount(root);
  await settle();
  return {
    root,
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}

function fill(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
  i18n.global.locale.value = "zh-CN";
  document.body.innerHTML = "";
});

describe("repository releases", () => {
  it("lists releases with notes, asset downloads and source archives", async () => {
    i18n.global.locale.value = "en";
    mockApi([
      release(),
      release({
        id: "release-0",
        tagName: "v0.9.0-rc",
        title: "Candidate",
        prerelease: true,
        assets: [],
      }),
    ]);
    const mounted = await mountReleases({ canWrite: false });
    const cards = mounted.root.querySelectorAll(".release-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("Latest");
    expect(cards[0].querySelector("strong")?.textContent).toBe("bold");
    expect(cards[1].textContent).toContain("Pre-release");
    expect(cards[0].querySelector<HTMLAnchorElement>("a[download]")?.getAttribute("href")).toBe(
      "/api/forge/repositories/repo-1/releases/release-1/assets/asset-1"
    );
    expect(
      Array.from(cards[0].querySelectorAll<HTMLAnchorElement>(".release-asset a"))
        .map((link) => link.getAttribute("href"))
        .slice(1)
    ).toEqual(["/example/sample/archive/v1.0.0.zip", "/example/sample/archive/v1.0.0.tar.gz"]);
    expect(mounted.root.querySelector(".release-upload")).toBeNull();
    expect(mounted.root.textContent).not.toContain("New release");
    mounted.unmount();
  });

  it("shows an empty state", async () => {
    i18n.global.locale.value = "en";
    mockApi([]);
    const mounted = await mountReleases();
    expect(mounted.root.textContent).toContain("No releases yet.");
    mounted.unmount();
  });

  it("creates a release from a branch when the tag is new", async () => {
    i18n.global.locale.value = "en";
    const calls = mockApi([]);
    const mounted = await mountReleases();
    Array.from(mounted.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("New release"))
      ?.click();
    await settle();
    const form = mounted.root.querySelector<HTMLFormElement>("form.release-editor");
    const inputs = form?.querySelectorAll<HTMLInputElement>(
      "input[type='text'], input:not([type])"
    );
    if (!form || !inputs) throw new Error("Release editor did not render.");
    fill(inputs[0], "v2.0.0");
    await settle();
    expect(form.querySelector("select")).not.toBeNull();
    fill(form.querySelector<HTMLTextAreaElement>("textarea")!, "Notes");
    await settle();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      tagName: "v2.0.0",
      target: "main",
      source: "main",
      body: "Notes",
      draft: false,
    });
    expect(mounted.root.querySelectorAll(".release-card")).toHaveLength(1);
    mounted.unmount();
  });

  it("does not ask for a branch when an existing tag is chosen", async () => {
    i18n.global.locale.value = "en";
    const calls = mockApi([]);
    const mounted = await mountReleases();
    Array.from(mounted.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("New release"))
      ?.click();
    await settle();
    const form = mounted.root.querySelector<HTMLFormElement>("form.release-editor");
    const inputs = form?.querySelectorAll<HTMLInputElement>("input:not([type])");
    if (!form || !inputs) throw new Error("Release editor did not render.");
    fill(inputs[0], "v0.9.0");
    await settle();
    expect(form.textContent).not.toContain("Create tag from branch");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(calls.find((call) => call.method === "POST")?.body).not.toHaveProperty("target");
    mounted.unmount();
  });

  it("explains a duplicate tag", async () => {
    i18n.global.locale.value = "en";
    mockApi([], { failCreate: { status: 409, code: "release_exists" } });
    const mounted = await mountReleases();
    Array.from(mounted.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("New release"))
      ?.click();
    await settle();
    const form = mounted.root.querySelector<HTMLFormElement>("form.release-editor");
    fill(form!.querySelector<HTMLInputElement>("input:not([type])")!, "v0.9.0");
    await settle();
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(mounted.root.textContent).toContain("This tag already has a release.");
    mounted.unmount();
  });

  it("uploads assets with their name and deletes releases after confirmation", async () => {
    i18n.global.locale.value = "en";
    const calls = mockApi([release()]);
    const mounted = await mountReleases();
    const input = mounted.root.querySelector<HTMLInputElement>(
      ".release-upload input[type='file']"
    )!;
    const file = new File(["abc"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.path).toBe(
      "/api/forge/repositories/repo-1/releases/release-1/assets?name=notes.txt"
    );
    expect(mounted.root.textContent).toContain("notes.txt");
    await confirmClick(
      mounted.root.querySelector<HTMLButtonElement>('button[aria-label^="Delete release"]')
    );
    expect(
      calls.some((call) => call.method === "DELETE" && call.path.endsWith("/releases/release-1"))
    ).toBe(true);
    expect(mounted.root.textContent).toContain("No releases yet.");
    mounted.unmount();
  });

  it("rejects oversized files before uploading", async () => {
    i18n.global.locale.value = "en";
    const calls = mockApi([release()]);
    const mounted = await mountReleases();
    const input = mounted.root.querySelector<HTMLInputElement>(
      ".release-upload input[type='file']"
    )!;
    const file = new File(["x"], "huge.bin");
    Object.defineProperty(file, "size", { value: 101 * 1024 * 1024 });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    expect(mounted.root.textContent).toContain("huge.bin is larger than the 100 MiB limit");
    mounted.unmount();
  });

  it("hides write controls in archived repositories", async () => {
    i18n.global.locale.value = "en";
    mockApi([release()]);
    const mounted = await mountReleases({ archived: true });
    expect(mounted.root.querySelector(".release-upload")).toBeNull();
    expect(mounted.root.textContent).not.toContain("New release");
    mounted.unmount();
  });
});
