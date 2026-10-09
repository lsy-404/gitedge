import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type Component } from "vue";
import RepositoryBlame from "../../apps/web/src/components/RepositoryBlame.vue";
import RepositoryCode from "../../apps/web/src/components/RepositoryCode.vue";
import RepositoryCommit from "../../apps/web/src/components/RepositoryCommit.vue";
import RepositoryHistory from "../../apps/web/src/components/RepositoryHistory.vue";
import { i18n } from "../../apps/web/src/i18n";
import { router } from "../../apps/web/src/router";
import { clearSession, setSession } from "../../apps/web/src/lib/session";
import { fluentUi } from "../../apps/web/src/ui/fluent";
import type {
  GitBlame,
  GitCommit,
  GitCommitDetail,
  GitFileList,
  GitPathHistory,
  Repository,
} from "../../packages/contracts/src/forge";

const repository: Repository = {
  id: "repo-1",
  namespaceId: "namespace-1",
  owner: "example",
  name: "sample",
  slug: "sample",
  description: "",
  visibility: "public",
  defaultBranch: "main",
  createdAt: 1,
  updatedAt: 1,
  canWrite: false,
  viewerRole: null,
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
  actionsEnabled: true,
  actionsNetworkEnabled: false,
  onlineEditingEnabled: false,
  allowMergeCommit: true,
  allowSquashMerge: true,
  allowRebaseMerge: true,
  deleteBranchOnMerge: false,
};
const headOid = "a".repeat(40);
const olderOid = "b".repeat(40);
const oldestOid = "c".repeat(40);

function commit(oid: string, message: string, parents: string[] = []): GitCommit {
  return {
    oid,
    tree: "d".repeat(40),
    parents,
    message,
    author: { name: "Ada", email: "ada@example.test", timestamp: 1_790_000_000 },
  };
}

type Handler = (url: URL) => unknown;
function mockApi(handlers: Record<string, Handler>) {
  const requests: URL[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://gitedge.test");
    requests.push(url);
    const resource = url.pathname.split("/").at(-1) ?? "";
    if (resource === "refs")
      return Response.json({ data: [{ name: "refs/heads/main", oid: headOid }] });
    if (resource === "community")
      return Response.json({
        data: { files: [], issueTemplates: [], pullRequestTemplate: null, truncated: false },
      });
    if (resource === "commits") return Response.json({ data: [] });
    const handler = handlers[resource];
    if (!handler) throw new Error("Unexpected mocked API request: " + url.pathname);
    return Response.json({ data: handler(url) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountAt(component: Component, path: string, props: Record<string, unknown> = {}) {
  setSession({ id: "user-1", identifier: "user@example.test" });
  await router.push(path);
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(
    defineComponent({ setup: () => () => h(component, { repository, ...props }) })
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

function press(target: Element | Document, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
  i18n.global.locale.value = "zh-CN";
  document.body.innerHTML = "";
});

const treeResponse = () => ({
  ref: "x",
  oid: "tree-1",
  path: "",
  entries: [{ name: "notes.txt", path: "notes.txt", oid: "blob-1", mode: "100644", type: "blob" }],
});
const fileResponse = (content: string) => ({
  path: "notes.txt",
  oid: "blob-1",
  size: content.length,
  binary: false,
  content,
});

describe("file finder", () => {
  const files: GitFileList = {
    oid: headOid,
    paths: ["README.md", "src/lib/api.ts", "src/main.ts", "docs/guide.md"],
    truncated: false,
  };
  const handlers = { tree: treeResponse, files: () => files };

  it("opens on the t shortcut, requests the list by commit id and opens the chosen blob", async () => {
    i18n.global.locale.value = "en";
    const { requests } = mockApi(handlers);
    const mounted = await mountAt(RepositoryCode, "/example/sample", { section: "code" });

    press(document.body, "t");
    await settle();
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    expect(dialog).not.toBeNull();
    const list = requests.filter((url) => url.pathname.endsWith("/files"));
    expect(list).toHaveLength(1);
    expect(list[0]?.searchParams.get("ref")).toBe(headOid);
    expect(document.activeElement?.getAttribute("role")).toBe("combobox");

    const input = document.activeElement as HTMLInputElement;
    input.value = "api";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options[0]?.textContent).toContain("src/lib/api.ts");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe("file-finder-option-0");

    press(input, "Enter");
    await settle();
    expect(router.currentRoute.value.path).toBe("/example/sample/blob/src/lib/api.ts");
    expect(router.currentRoute.value.query.ref).toBe("main");
    expect(document.querySelector("dialog[open]")).toBeNull();
    mounted.unmount();
  });

  it("moves the active result with the arrow keys and wraps around", async () => {
    i18n.global.locale.value = "en";
    mockApi(handlers);
    const mounted = await mountAt(RepositoryCode, "/example/sample", { section: "code" });
    press(document.body, "t");
    await settle();
    const input = document.activeElement as HTMLInputElement;
    press(input, "ArrowUp");
    await settle();
    expect(input.getAttribute("aria-activedescendant")).toBe("file-finder-option-3");
    press(input, "ArrowDown");
    await settle();
    expect(input.getAttribute("aria-activedescendant")).toBe("file-finder-option-0");
    mounted.unmount();
  });

  it("ignores the shortcut while typing and reports a truncated list", async () => {
    i18n.global.locale.value = "en";
    mockApi({ ...handlers, files: () => ({ ...files, truncated: true }) });
    const mounted = await mountAt(RepositoryCode, "/example/sample", { section: "code" });
    const field = document.createElement("input");
    document.body.append(field);
    press(field, "t");
    await settle();
    expect(document.querySelector("dialog[open]")).toBeNull();

    mounted.root.querySelector<HTMLButtonElement>(".search-trigger")?.click();
    await settle();
    expect(document.querySelector("dialog[open]")?.textContent).toContain(
      "Only the first 4 files are searchable"
    );
    mounted.unmount();
  });
});

describe("line anchors and permalinks", () => {
  const content = "one\ntwo\nthree\nfour\n";
  const handlers = { tree: treeResponse, file: () => fileResponse(content) };
  const path = "/example/sample/blob/notes.txt?ref=main";
  const selected = (root: HTMLElement) =>
    [...root.querySelectorAll(".code-line")].flatMap((row, index) =>
      row.classList.contains("selected") ? [index + 1] : []
    );

  it("renders one numbered row per line and highlights the anchored range", async () => {
    mockApi(handlers);
    const mounted = await mountAt(RepositoryCode, path + "#L2-L3", { section: "code" });
    expect(mounted.root.querySelectorAll(".code-line")).toHaveLength(4);
    expect(selected(mounted.root)).toEqual([2, 3]);
    mounted.unmount();
  });

  it("scrolls to the anchored line on load", async () => {
    mockApi(handlers);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const mounted = await mountAt(RepositoryCode, path + "#L3", { section: "code" });
    await settle();
    expect(scroll).toHaveBeenCalled();
    mounted.unmount();
  });

  it("sets the anchor on click and extends it on shift click", async () => {
    const { requests } = mockApi(handlers);
    const mounted = await mountAt(RepositoryCode, path, { section: "code" });
    const numbers = mounted.root.querySelectorAll<HTMLAnchorElement>("a.line-number");
    numbers[3]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
    expect(router.currentRoute.value.hash).toBe("#L4");
    expect(selected(mounted.root)).toEqual([4]);
    numbers[1]?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true })
    );
    await settle();
    expect(router.currentRoute.value.hash).toBe("#L2-L4");
    expect(selected(mounted.root)).toEqual([2, 3, 4]);
    expect(router.currentRoute.value.query.ref).toBe("main");
    expect(requests.filter((url) => url.pathname.endsWith("/file"))).toHaveLength(1);
    mounted.unmount();
  });

  it("copies a permalink with the full commit id and the selected range", async () => {
    i18n.global.locale.value = "en";
    mockApi(handlers);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const mounted = await mountAt(RepositoryCode, path + "#L2-L3", { section: "code" });
    const copy = [...mounted.root.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Copy permalink")
    );
    copy?.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/example/sample/blob/notes.txt?ref=${headOid}#L2-L3`
    );
    mounted.unmount();
  });

  it("rewrites the address to the permalink with the y shortcut", async () => {
    mockApi(handlers);
    const mounted = await mountAt(RepositoryCode, path + "#L1", { section: "code" });
    press(document.body, "y");
    await settle();
    expect(router.currentRoute.value.query.ref).toBe(headOid);
    expect(router.currentRoute.value.hash).toBe("#L1");
    mounted.unmount();
  });

  it("shows markdown source when a line anchor is present", async () => {
    mockApi({ tree: treeResponse, file: () => fileResponse("# Title\n\ntext\n") });
    const mounted = await mountAt(RepositoryCode, "/example/sample/blob/notes.md?ref=main#L3", {
      section: "code",
    });
    expect(mounted.root.querySelectorAll(".code-line")).toHaveLength(3);
    mounted.unmount();
  });
});

describe("path history view", () => {
  const first: GitPathHistory = {
    commits: [commit(headOid, "Change api\n\nbody", [olderOid]), commit(olderOid, "Add api")],
    inspected: 200,
    truncated: true,
    nextCursor: oldestOid,
  };
  const second: GitPathHistory = {
    commits: [commit(oldestOid, "Initial api")],
    inspected: 40,
    truncated: false,
    nextCursor: null,
  };

  it("pins the first page to the branch head and loads older commits with the cursor", async () => {
    i18n.global.locale.value = "en";
    const { requests } = mockApi({
      history: (url) => (url.searchParams.get("cursor") ? second : first),
      tree: () => ({ ...treeResponse(), entries: [] }),
    });
    const mounted = await mountAt(RepositoryHistory, "/example/sample/history/src/api.ts?ref=main");
    const history = () => requests.filter((url) => url.pathname.endsWith("/history"));
    expect(history()[0]?.searchParams.get("ref")).toBe(headOid);
    expect(history()[0]?.searchParams.get("path")).toBe("src/api.ts");
    const rows = mounted.root.querySelectorAll(".history-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector("a")?.getAttribute("href")).toBe(
      `/example/sample/commit/${headOid}`
    );
    expect(mounted.root.textContent).toContain("Inspected 200 commits");

    const more = [...mounted.root.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Check older commits")
    );
    more?.click();
    await settle();
    expect(history()[1]?.searchParams.get("cursor")).toBe(oldestOid);
    expect(history()[1]?.searchParams.get("ref")).toBe(headOid);
    expect(mounted.root.querySelectorAll(".history-row")).toHaveLength(3);
    expect(mounted.root.textContent).toContain("Inspected 240 commits");
    expect(mounted.root.textContent).not.toContain("Check older commits");
    mounted.unmount();
  });

  it("explains an empty history", async () => {
    i18n.global.locale.value = "en";
    mockApi({
      history: () => ({ commits: [], inspected: 3, truncated: false, nextCursor: null }),
      tree: () => ({ ...treeResponse(), entries: [] }),
    });
    const mounted = await mountAt(RepositoryHistory, "/example/sample/history/gone.txt?ref=main");
    expect(mounted.root.textContent).toContain("No commit in the inspected range");
    mounted.unmount();
  });
});

describe("blame view", () => {
  const blame: GitBlame = {
    oid: headOid,
    path: "notes.txt",
    blobOid: "blob-1",
    lineCount: 4,
    hunks: [
      { startLine: 1, lineCount: 2, commitOid: olderOid },
      { startLine: 3, lineCount: 1, commitOid: headOid },
      { startLine: 4, lineCount: 1, commitOid: null },
    ],
    commits: [
      { oid: olderOid, summary: "Add notes", author: { name: "Ada", timestamp: 1_790_000_000 } },
      { oid: headOid, summary: "Edit notes", author: { name: "Bo", timestamp: 1_790_000_100 } },
    ],
    inspected: 25,
    partial: true,
  };
  const handlers = {
    blame: () => blame,
    file: () => fileResponse("one\ntwo\nthree\nfour\n"),
  };

  it("shows one gutter entry per hunk with commit links and reports partial results", async () => {
    i18n.global.locale.value = "en";
    const { requests } = mockApi(handlers);
    const mounted = await mountAt(RepositoryBlame, "/example/sample/blame/notes.txt?ref=main#L3");
    expect(requests.find((url) => url.pathname.endsWith("/blame"))?.searchParams.get("ref")).toBe(
      headOid
    );
    expect(mounted.root.querySelectorAll(".blame-start")).toHaveLength(3);
    expect(mounted.root.querySelectorAll(".code-line")).toHaveLength(4);
    const links = [...mounted.root.querySelectorAll<HTMLAnchorElement>("a.blame-summary")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/example/sample/commit/${olderOid}`,
      `/example/sample/commit/${headOid}`,
    ]);
    expect(mounted.root.textContent).toContain("Older history");
    expect(mounted.root.textContent).toContain("after inspecting 25 commits, 1 lines");
    expect(mounted.root.querySelectorAll(".code-line.selected")).toHaveLength(1);

    links[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
    expect(router.currentRoute.value.path).toBe(`/example/sample/commit/${olderOid}`);
    mounted.unmount();
  });

  it("explains unsupported files instead of failing", async () => {
    i18n.global.locale.value = "en";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const resource = new URL(String(input), "https://gitedge.test").pathname.split("/").at(-1);
        if (resource === "refs")
          return Response.json({ data: [{ name: "refs/heads/main", oid: headOid }] });
        if (resource === "blame")
          return Response.json(
            { error: { code: "binary_file", message: "Blame is unavailable for binary files." } },
            { status: 422 }
          );
        return Response.json({ data: { ...fileResponse(""), binary: true, content: null } });
      })
    );
    const mounted = await mountAt(RepositoryBlame, "/example/sample/blame/logo.png?ref=main");
    expect(mounted.root.textContent).toContain("Blame is unavailable for binary files");
    expect(mounted.root.querySelector(".code-lines")).toBeNull();
    mounted.unmount();
  });
});

describe("commit page", () => {
  const detail: GitCommitDetail = {
    commit: commit(headOid, "Fix the parser\n\nLonger explanation", [olderOid]),
    files: [
      {
        path: "src/parser.ts",
        type: "modified",
        oldOid: "1".repeat(40),
        newOid: "2".repeat(40),
        patch: "--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -1 +1 @@\n-old\n+new\n",
        binary: false,
      },
      {
        path: "logo.png",
        type: "added",
        oldOid: null,
        newOid: "3".repeat(40),
        patch: null,
        binary: true,
      },
    ],
    truncated: true,
  };

  it("shows the message, parents and diff and warns when the diff is truncated", async () => {
    i18n.global.locale.value = "en";
    const { requests } = mockApi({ "commit-diff": () => detail });
    const mounted = await mountAt(RepositoryCommit, `/example/sample/commit/${headOid}`, {
      oid: headOid,
    });
    expect(
      requests.find((url) => url.pathname.endsWith("/commit-diff"))?.searchParams.get("oid")
    ).toBe(headOid);
    expect(mounted.root.querySelector("h2")?.textContent).toBe("Fix the parser");
    expect(mounted.root.textContent).toContain("Longer explanation");
    expect(
      mounted.root.querySelector(`a[href="/example/sample/commit/${olderOid}"]`)
    ).not.toBeNull();
    expect(mounted.root.querySelectorAll(".compare-file")).toHaveLength(2);
    expect(mounted.root.textContent).toContain("+new");
    expect(mounted.root.textContent).toContain("some files or patches are omitted");
    const browse = mounted.root.querySelector<HTMLAnchorElement>("a.btn");
    expect(browse?.getAttribute("href")).toBe(`/example/sample?ref=${headOid}`);
    mounted.unmount();
  });

  it("resolves the commit, history and blame routes", () => {
    expect(router.resolve(`/example/sample/commit/${headOid}`).params.oid).toBe(headOid);
    expect(router.resolve("/example/sample/commit/not-an-oid").params.oid).toBeUndefined();
    expect(router.resolve("/example/sample/blame/src/a.ts").params).toMatchObject({
      view: "blame",
      path: ["src", "a.ts"],
    });
    expect(router.resolve("/example/sample/history/src/a.ts").params.view).toBe("history");
  });
});
