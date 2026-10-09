import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h } from "vue";
import RepositoryTags from "../../apps/web/src/components/RepositoryTags.vue";
import { i18n } from "../../apps/web/src/i18n";
import { router } from "../../apps/web/src/router";
import { clearSession, setSession } from "../../apps/web/src/lib/session";
import { fluentUi } from "../../apps/web/src/ui/fluent";
import type { Repository } from "../../packages/contracts/src/forge";
import type { RepositoryTag } from "../../packages/contracts/src/releases";
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

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function mockApi(initial: RepositoryTag[]) {
  let tags = initial;
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://gitedge.test");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method, path: url.pathname, body });
      if (!url.pathname.endsWith("/tags")) throw new Error(`Unexpected request: ${url.pathname}`);
      if (method === "GET") return Response.json({ data: tags, truncated: false });
      if (method === "POST") {
        const created: RepositoryTag = {
          name: body.name,
          oid: "c".repeat(40),
          commitOid: "c".repeat(40),
          annotated: Boolean(body.message),
          subject: "s",
          timestamp: 1,
        };
        tags = [created, ...tags];
        return Response.json({ data: created }, { status: 201 });
      }
      tags = tags.filter((tag) => tag.name !== body.name);
      return Response.json({ data: { deleted: true } });
    })
  );
  return calls;
}

async function mountTags() {
  setSession({ id: "user-1", identifier: "owner@example.test" });
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(RepositoryTags, { repository, branches: ["main", "dev"], selectedBranch: "main" }),
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

function openPanel(root: HTMLElement) {
  root.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
  i18n.global.locale.value = "zh-CN";
  document.body.innerHTML = "";
});

describe("repository tags", () => {
  it("lists tags only after the panel is opened", async () => {
    i18n.global.locale.value = "en";
    const calls = mockApi([
      {
        name: "v1.0.0",
        oid: "a".repeat(40),
        commitOid: "b".repeat(40),
        annotated: true,
        subject: "s",
        timestamp: 1,
      },
    ]);
    const mounted = await mountTags();
    expect(calls).toEqual([]);
    openPanel(mounted.root);
    await settle();
    expect(calls).toHaveLength(1);
    expect(mounted.root.textContent).toContain("v1.0.0");
    expect(mounted.root.textContent).toContain("bbbbbbbb");
    mounted.unmount();
  });

  it("creates an annotated tag from the chosen branch and deletes with the expected id", async () => {
    i18n.global.locale.value = "en";
    const calls = mockApi([
      {
        name: "v0.1.0",
        oid: "a".repeat(40),
        commitOid: "a".repeat(40),
        annotated: false,
        subject: "s",
        timestamp: 1,
      },
    ]);
    const mounted = await mountTags();
    openPanel(mounted.root);
    await settle();
    const form = mounted.root.querySelector<HTMLFormElement>("form.tag-create");
    const inputs = form?.querySelectorAll<HTMLInputElement>("input");
    if (!form || !inputs) throw new Error("Tag form did not render.");
    inputs[0].value = "v2.0.0";
    inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
    inputs[1].value = "Release two";
    inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    const select = form.querySelector<HTMLSelectElement>("select");
    if (!select) throw new Error("Branch selector did not render.");
    select.value = "dev";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      name: "v2.0.0",
      target: "dev",
      message: "Release two",
    });
    expect(mounted.root.textContent).toContain("v2.0.0");
    await confirmClick(
      mounted.root.querySelector<HTMLButtonElement>('button[aria-label*="v0.1.0"]')
    );
    expect(calls.find((call) => call.method === "DELETE")?.body).toEqual({
      name: "v0.1.0",
      expectedOid: "a".repeat(40),
    });
    expect(mounted.root.textContent).not.toContain("v0.1.0");
    mounted.unmount();
  });
});
