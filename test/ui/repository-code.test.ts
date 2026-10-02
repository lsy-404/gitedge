import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import RepositoryCode from "../../apps/web/src/components/RepositoryCode.vue";
import { i18n } from "../../apps/web/src/i18n";
import { router } from "../../apps/web/src/router";
import { clearSession, setSession } from "../../apps/web/src/lib/session";

const repository = {
  id: "repo-1",
  namespaceId: "namespace-1",
  owner: "example",
  name: "sample",
  slug: "sample",
  artifactName: "example/sample",
  remote: "https://git.example/example/sample.git",
  description: "",
  visibility: "public" as const,
  defaultBranch: "main",
  createdAt: 1,
  updatedAt: 1,
  canWrite: false,
};

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountCode(path: string, section: string) {
  setSession({ id: "user-1", identifier: "user@example.test" });
  await router.push(path);
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(RepositoryCode, { repository, section });
  app.use(router);
  app.use(i18n);
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

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
  i18n.global.locale.value = "zh-CN";
  document.body.innerHTML = "";
});

describe("repository Code view", () => {
  it.each(["code", "commits"])(
    "shows setup instructions for a repository with no refs on %s",
    async (section) => {
      const requests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input), "https://gitedge.test");
          requests.push(url.pathname);
          return jsonResponse([]);
        })
      );
      const mounted = await mountCode("/example/sample", section);

      expect(mounted.root.querySelector(".empty-repository")?.textContent).toContain(
        "git push -u origin main"
      );
      expect(requests).toEqual(["/api/git/repositories/repo-1/refs"]);

      mounted.unmount();
    }
  );

  it("keeps invalid ref failures visible when refs exist", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://gitedge.test");
        requests.push(url.pathname + url.search);
        if (url.pathname.endsWith("/refs"))
          return jsonResponse([{ name: "refs/heads/main", oid: "commit-1" }]);
        if (url.pathname.endsWith("/commits")) return jsonResponse({ error: {} }, 404);
        if (url.pathname.endsWith("/graph"))
          return jsonResponse({ commits: [], refs: [], sessions: [], truncated: false });
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    i18n.global.locale.value = "en";
    const mounted = await mountCode("/example/sample/commits?ref=missing", "commits");

    expect(requests.some((request) => request.includes("ref=missing"))).toBe(true);
    expect(mounted.root.textContent).toContain("The requested item was not found");

    mounted.unmount();
  });

  it("keeps empty text files readable and enables Raw and Download", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://gitedge.test");
        if (url.pathname.endsWith("/refs"))
          return jsonResponse([{ name: "refs/heads/main", oid: "commit-1" }]);
        if (url.pathname.endsWith("/file"))
          return jsonResponse({
            path: "empty.txt",
            oid: "blob-1",
            size: 0,
            binary: false,
            content: "",
          });
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const mounted = await mountCode("/example/sample/blob/empty.txt?ref=main", "code");
    const buttons = Array.from(mounted.root.querySelectorAll(".file-actions fluent-button"));

    buttons[0]?.click();
    buttons[1]?.click();

    expect(mounted.root.querySelector(".code-source .highlighted-file")?.textContent).toBe("");
    expect(open).toHaveBeenCalledWith("blob:test", "_blank", "noopener");
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledTimes(2);

    mounted.unmount();
  });
});
