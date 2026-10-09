import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import RepositoryCode from "../../apps/web/src/components/RepositoryCode.vue";
import { i18n } from "../../apps/web/src/i18n";
import { api } from "../../apps/web/src/lib/api";
import { router } from "../../apps/web/src/router";
import { clearSession, setSession } from "../../apps/web/src/lib/session";
import { fluentUi } from "../../apps/web/src/ui/fluent";
import { confirmClick } from "./task-support";
import type { Repository } from "../../packages/contracts/src/forge";
import type {
  RepositoryBranch,
  RepositoryRole,
} from "../../packages/contracts/src/repository-controls";

const repository: Repository = {
  id: "repo-1",
  namespaceId: "namespace-1",
  owner: "example",
  name: "sample",
  slug: "sample",
  description: "",
  visibility: "public" as const,
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
const commitOid = "a".repeat(40);
const createdCommitOid = "b".repeat(40);
const nativeShowModal = HTMLDialogElement.prototype.showModal;
const nativeDialogClose = HTMLDialogElement.prototype.close;

function editorRoot(root: HTMLElement) {
  const editor = root.querySelector<HTMLElement>(".file-editor");
  if (!editor) throw new Error("File editor was not rendered.");
  return editor;
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountCode(
  path: string,
  section: string,
  overrides: Partial<typeof repository> = {},
  onChanged?: () => void
) {
  setSession({ id: "user-1", identifier: "user@example.test" });
  await router.push(path);
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(RepositoryCode, {
            repository: { ...repository, ...overrides },
            section,
            onChanged,
          });
      },
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

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status });
}

function branch(
  name: string,
  oid: string,
  overrides: Partial<RepositoryBranch> = {}
): RepositoryBranch {
  return {
    name,
    oid,
    protected: false,
    rules: [],
    isDefault: name === "main",
    ...overrides,
  };
}

function fill(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function mockCodeApi(
  options: {
    branches?: RepositoryBranch[];
    file?: { binary: boolean; content: string | null; size: number; oid?: string };
    onEdit?: (body: Record<string, unknown>) => Response;
    onPullCreate?: (body: Record<string, unknown>) => Response | void;
    onBranchCreate?: (body: Record<string, unknown>) => void;
    onBranchDelete?: (body: Record<string, unknown>) => void;
    onTag?: (method: string, body: Record<string, unknown>) => void;
    latestRelease?: { title: string; tagName: string } | null;
  } = {}
) {
  let branches = options.branches ?? [branch("main", commitOid)];
  let tags: Array<{ name: string; oid: string; commitOid: string; annotated: boolean }> = [];
  const requests: Array<{ path: string; method: string; body: string; ref: string | null }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://gitedge.test");
    const method = init?.method ?? "GET";
    const form = init?.body instanceof FormData ? init.body : null;
    const body = typeof init?.body === "string" ? init.body : String(form?.get("manifest") ?? "");
    requests.push({ path: url.pathname, method, body, ref: url.searchParams.get("ref") });
    if (url.pathname.endsWith("/community"))
      return jsonResponse({
        files: [],
        issueTemplates: [],
        pullRequestTemplate: null,
        truncated: false,
      });
    if (url.pathname.endsWith("/refs"))
      return jsonResponse(
        branches.map((item) => ({ name: "refs/heads/" + item.name, oid: item.oid }))
      );
    if (url.pathname.endsWith("/branches") && method === "GET") return jsonResponse(branches);
    if (url.pathname.endsWith("/branches") && method === "POST") {
      const parsed = JSON.parse(body) as { name: string };
      options.onBranchCreate?.(JSON.parse(body) as Record<string, unknown>);
      branches = [...branches, branch(parsed.name, createdCommitOid)];
      return jsonResponse({ name: parsed.name, oid: createdCommitOid }, 201);
    }
    if (url.pathname.endsWith("/branches") && method === "DELETE") {
      const parsed = JSON.parse(body) as { name: string };
      options.onBranchDelete?.(JSON.parse(body) as Record<string, unknown>);
      branches = branches.filter((item) => item.name !== parsed.name);
      return jsonResponse({ deleted: true });
    }
    if (url.pathname.endsWith("/tags")) {
      if (method === "GET")
        return new Response(
          JSON.stringify({
            data: tags.map((tag) => ({ ...tag, subject: "s", timestamp: 1 })),
            truncated: false,
          })
        );
      const parsed = JSON.parse(body) as { name: string; target?: string };
      options.onTag?.(method, parsed);
      if (method === "POST") {
        tags = [
          ...tags,
          { name: parsed.name, oid: createdCommitOid, commitOid: commitOid, annotated: false },
        ];
        return jsonResponse({ name: parsed.name }, 201);
      }
      tags = tags.filter((tag) => tag.name !== parsed.name);
      return jsonResponse({ deleted: true });
    }
    if (url.pathname.endsWith("/releases/latest")) {
      return options.latestRelease
        ? jsonResponse({ ...options.latestRelease, id: "release-1" })
        : new Response(JSON.stringify({ error: { code: "not_found", message: "none" } }), {
            status: 404,
          });
    }
    if (url.pathname.endsWith("/commits")) return jsonResponse([]);
    if (url.pathname.endsWith("/tree"))
      return jsonResponse({
        ref: url.searchParams.get("ref"),
        oid: "tree-1",
        path: "",
        entries: [
          {
            name: "readme.md",
            path: "readme.md",
            oid: "blob-v1",
            mode: "100644",
            type: "blob",
          },
        ],
      });
    if (url.pathname.endsWith("/file"))
      return jsonResponse({
        path: "readme.md",
        oid: options.file?.oid ?? "blob-v1",
        size: options.file?.size ?? 7,
        binary: options.file?.binary ?? false,
        content: options.file?.content ?? "initial",
      });
    if (url.pathname.endsWith("/commit")) {
      const manifest = JSON.parse(body) as {
        branch: string;
        newBranch?: string;
        changes: Array<{ op: string; path?: string; to?: string; part?: string }>;
      };
      const first = manifest.changes.at(-1);
      const part = first?.part ? form?.get(first.part) : null;
      const input = {
        ...manifest,
        path: first?.path ?? first?.to ?? "",
        content: part instanceof File ? await part.text() : null,
        files: Object.fromEntries(
          [...(form?.entries() ?? [])].filter(([key]) => key !== "manifest")
        ),
      };
      const response =
        options.onEdit?.(input) ??
        jsonResponse({ oid: "commit-v2", branch: input.newBranch ?? input.branch }, 201);
      if (response.ok) {
        const target = input.newBranch ?? input.branch;
        branches = branches.some((item) => item.name === target)
          ? branches.map((item) =>
              item.name === target ? { ...item, oid: createdCommitOid } : item
            )
          : [...branches, branch(target, createdCommitOid)];
      }
      return response;
    }
    if (url.pathname.endsWith("/pull-requests") && method === "POST") {
      return (
        options.onPullCreate?.(JSON.parse(body) as Record<string, unknown>) ??
        jsonResponse({ id: "pull-1", number: 12 }, 201)
      );
    }
    throw new Error("Unexpected mocked API request: " + method + " " + url.pathname);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
  i18n.global.locale.value = "zh-CN";
  document.body.innerHTML = "";
  if (nativeShowModal) HTMLDialogElement.prototype.showModal = nativeShowModal;
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (nativeDialogClose) HTMLDialogElement.prototype.close = nativeDialogClose;
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
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

  it("offers a write-scoped quickstart token on an empty repository", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([]))
    );
    i18n.global.locale.value = "en";
    const create = vi.spyOn(api, "createAccessToken").mockResolvedValue({
      id: "pat-2",
      name: "example/sample",
      prefix: "gep_12345678",
      scopes: ["repo:write"],
      repositories: null,
      createdAt: 1,
      expiresAt: Date.now() + 30 * 86_400_000,
      lastUsedAt: null,
      revokedAt: null,
      token: `gep_${"d".repeat(64)}`,
    });
    const mounted = await mountCode("/example/sample", "code", {
      viewerRole: "write",
      canWrite: true,
    });
    const empty = mounted.root.querySelector(".empty-repository");
    expect(empty?.textContent).toContain(
      "git remote add origin http://localhost:3000/example/sample.git"
    );
    expect(empty?.textContent).toContain(
      "git remote add gitedge http://localhost:3000/example/sample.git"
    );
    Array.from(empty?.querySelectorAll<HTMLElement>("button, fluent-button") ?? [])
      .find((item) => item.textContent?.includes("Generate token"))
      ?.click();
    await settle();

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["repo:write"], expiresInDays: 30 })
    );
    expect(mounted.root.querySelector(".token-once code")?.textContent).toBe(
      `gep_${"d".repeat(64)}`
    );
    mounted.unmount();
  });

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

  it("keeps empty text files readable and links to the raw and download URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://gitedge.test");
        if (url.pathname.endsWith("/refs"))
          return jsonResponse([{ name: "refs/heads/main", oid: "commit-1" }]);
        if (url.pathname.endsWith("/tree"))
          return jsonResponse({
            ref: "main",
            oid: "tree-1",
            path: "",
            entries: [
              { name: "empty.txt", path: "empty.txt", oid: "blob-1", mode: "100644", type: "blob" },
            ],
          });
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
    const mounted = await mountCode("/example/sample/blob/empty.txt?ref=main", "code");
    const rawLinks = Array.from(
      mounted.root.querySelectorAll<HTMLAnchorElement>(".file-actions a.btn")
    ).filter((link) => link.getAttribute("href")?.includes("/raw/"));

    expect(mounted.root.querySelector(".code-lines")).not.toBeNull();
    expect(mounted.root.querySelectorAll(".code-line")).toHaveLength(0);
    expect(rawLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/example/sample/raw/main/empty.txt",
      "/example/sample/raw/main/empty.txt?download=1",
    ]);
    expect(rawLinks[0]?.target).toBe("_blank");
    expect(rawLinks[1]?.hasAttribute("download")).toBe(true);

    mounted.unmount();
  });

  it("creates and deletes tags against the branch tip and the loaded tag id", async () => {
    i18n.global.locale.value = "en";
    const calls: Array<[string, Record<string, unknown>]> = [];
    mockCodeApi({ onTag: (method, body) => calls.push([method, body]) });
    const mounted = await mountCode("/example/sample", "code", { canWrite: true });
    const manager = Array.from(mounted.root.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Manage tags")
    );
    manager?.click();
    await settle();
    const form = mounted.root.querySelector<HTMLFormElement>(".tag-create");
    const inputs = form?.querySelectorAll<HTMLInputElement>("input");
    if (!form || !inputs?.length) throw new Error("Tag manager did not load.");
    fill(inputs[0], "v1.0.0");
    fill(inputs[1], "Release one");
    await settle();
    submit(form);
    await settle();

    expect(calls[0]).toEqual(["POST", { name: "v1.0.0", target: "main", message: "Release one" }]);
    expect(mounted.root.querySelector(".tag-row")?.textContent).toContain("v1.0.0");
    await confirmClick(
      mounted.root.querySelector<HTMLButtonElement>('button[aria-label="Delete tag v1.0.0"]')
    );

    expect(calls[1]).toEqual(["DELETE", { name: "v1.0.0", expectedOid: createdCommitOid }]);
    expect(mounted.root.querySelector(".tag-row")).toBeNull();
    mounted.unmount();
  });

  it("hides tag management from viewers without write access", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi();
    const mounted = await mountCode("/example/sample", "code");
    expect(mounted.root.textContent).not.toContain("Manage tags");
    mounted.unmount();
  });

  it("shows the latest release in the sidebar", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi({ latestRelease: { title: "Version one", tagName: "v1.0.0" } });
    const mounted = await mountCode("/example/sample", "code");
    const sidebar = mounted.root.querySelector(".about-release");
    expect(sidebar?.textContent).toContain("Version one");
    expect(sidebar?.textContent).toContain("v1.0.0");
    expect(sidebar?.querySelector("a")?.getAttribute("href")).toBe("/example/sample/releases");
    mounted.unmount();
  });

  it("offers source archives for the selected ref in the clone menu", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi();
    const mounted = await mountCode("/example/sample?ref=release%2Fone", "code");
    const links = Array.from(
      mounted.root.querySelectorAll<HTMLAnchorElement>(".clone-downloads a")
    ).map((link) => link.getAttribute("href"));
    mounted.root.querySelector<HTMLButtonElement>(".clone-menu-wrap > button")?.click();
    await settle();
    const opened = Array.from(
      mounted.root.querySelectorAll<HTMLAnchorElement>(".clone-downloads a")
    ).map((link) => link.getAttribute("href"));
    expect(links).toEqual([]);
    expect(opened).toEqual([
      "/example/sample/archive/release/one.zip",
      "/example/sample/archive/release/one.tar.gz",
    ]);
    mounted.unmount();
  });

  it("previews images through the raw URL and sends binaries to download", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi({ file: { binary: true, content: null, size: 4 } });
    const image = await mountCode("/example/sample/blob/docs/logo.png?ref=main", "code");
    expect(image.root.querySelector(".file-image img")?.getAttribute("src")).toBe(
      "/example/sample/raw/main/docs/logo.png"
    );
    expect(image.root.querySelector(".file-image img")?.getAttribute("alt")).toContain("logo.png");
    image.unmount();
    const binary = await mountCode("/example/sample/blob/tool.bin?ref=main", "code");
    expect(binary.root.querySelector(".file-image")).toBeNull();
    expect(binary.root.textContent).toContain("Download it to open it");
    expect(
      binary.root
        .querySelector<HTMLAnchorElement>(".file-actions a[download]")
        ?.getAttribute("href")
    ).toBe("/example/sample/raw/main/tool.bin?download=1");
    binary.unmount();
  });

  it("saves a file against the commit SHA loaded with its contents", async () => {
    i18n.global.locale.value = "en";
    const mock = mockCodeApi();
    const mounted = await mountCode("/example/sample/blob/readme.md?ref=main", "code", {
      canWrite: true,
      onlineEditingEnabled: true,
    });
    const editButton = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".file-actions button")
    ).find((button) => button.textContent?.includes("Edit"));
    expect(editButton?.disabled).toBe(false);
    editButton?.click();
    await settle();
    const editor = mounted.root.querySelector<HTMLFormElement>(".file-editor form");
    const textarea = editor?.querySelector<HTMLTextAreaElement>("textarea");
    const message = editor?.querySelector<HTMLInputElement>('input[maxlength="500"]');
    if (!editor || !textarea || !message) throw new Error("File editor fields were not rendered.");
    fill(textarea, "draft kept");
    fill(message, "Update readme");
    await settle();
    const saveButton = editor.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(saveButton?.disabled).toBe(false);
    submit(editor);
    await settle();

    expect(mock.requests.some((request) => request.path.endsWith("/commit"))).toBe(true);
    const editRequest = mock.requests.find((request) => request.path.endsWith("/commit"));
    expect(editRequest?.method).toBe("POST");
    expect(JSON.parse(editRequest?.body ?? "{}")).toMatchObject({
      branch: "main",
      expectedOid: commitOid,
      changes: [{ op: "put", path: "readme.md" }],
      message: "Update readme",
    });
    expect(mock.requests.find((request) => request.path.endsWith("/file"))?.ref).toBe(commitOid);
    expect(
      mock.requests.some((request) => request.path.endsWith("/file") && request.body === "")
    ).toBe(true);
    mounted.unmount();
  });

  it("initializes an empty repository with a null expected OID", async () => {
    i18n.global.locale.value = "en";
    let editBody: Record<string, unknown> | null = null;
    const mock = mockCodeApi({
      branches: [],
      onEdit: (body) => {
        editBody = body;
        return jsonResponse({ oid: createdCommitOid, branch: "main", path: "README.md" }, 201);
      },
    });
    const mounted = await mountCode("/example/sample", "code", {
      canWrite: true,
      onlineEditingEnabled: true,
    });
    const newFileButton = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent?.includes("New file"));
    newFileButton?.click();
    await settle();
    const form = mounted.root.querySelector<HTMLFormElement>(".file-editor form");
    const inputs = form?.querySelectorAll<HTMLInputElement>("input");
    const textarea = form?.querySelector<HTMLTextAreaElement>("textarea");
    if (!form || !inputs || !textarea) throw new Error("Empty repository editor did not open.");
    fill(inputs[0], "README.md");
    fill(textarea, "# First commit");
    fill(inputs[1], "Initialize repository");
    await settle();
    submit(form);
    await settle();

    expect(editBody).toMatchObject({
      branch: "main",
      expectedOid: null,
      path: "README.md",
      content: "# First commit",
    });
    expect(mock.requests.filter((request) => request.path.endsWith("/commit"))).toHaveLength(1);
    mounted.unmount();
  });

  it("keeps the draft after a stale edit conflict", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi({
      onEdit: () =>
        new Response(JSON.stringify({ error: { code: "refs_changed", message: "stale" } }), {
          status: 409,
        }),
    });
    const mounted = await mountCode("/example/sample/blob/readme.md?ref=main", "code", {
      canWrite: true,
      onlineEditingEnabled: true,
    });
    const editButton = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".file-actions button")
    ).find((button) => button.textContent?.includes("Edit"));
    editButton?.click();
    await settle();
    const editor = mounted.root.querySelector<HTMLFormElement>(".file-editor form");
    const textarea = editor?.querySelector<HTMLTextAreaElement>("textarea");
    const message = editor?.querySelector<HTMLInputElement>('input[maxlength="500"]');
    if (!editor || !textarea || !message) throw new Error("File editor fields were not rendered.");
    fill(textarea, "preserve this draft");
    fill(message, "Resolve later");
    await settle();
    const saveButton = editor.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(saveButton?.disabled).toBe(false);
    submit(editor);
    await settle();

    expect(mounted.root.querySelector(".file-editor")?.textContent).toContain(
      "Your draft is preserved"
    );
    expect(textarea.value).toBe("preserve this draft");
    expect(mounted.root.querySelector(".file-editor a")?.getAttribute("href")).toContain(
      "base=" + commitOid
    );
    mounted.unmount();
  });

  it("confirms file deletion and commits it against the loaded branch SHA", async () => {
    i18n.global.locale.value = "en";
    let editBody: Record<string, unknown> | null = null;
    mockCodeApi({
      onEdit: (body) => {
        editBody = body;
        return jsonResponse({ oid: createdCommitOid, branch: "main", path: "readme.md" }, 201);
      },
    });
    const mounted = await mountCode("/example/sample/blob/readme.md?ref=main", "code", {
      canWrite: true,
      onlineEditingEnabled: true,
    });
    const editButton = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".file-actions button")
    ).find((button) => button.textContent?.includes("Edit"));
    editButton?.click();
    await settle();
    const editor = mounted.root.querySelector<HTMLFormElement>(".file-editor form");
    const message = editor?.querySelector<HTMLInputElement>('input[maxlength="500"]');
    const deleteTrigger = Array.from(
      editor?.querySelectorAll<HTMLButtonElement>("button") ?? []
    ).find((button) => button.textContent?.includes("Delete file"));
    if (!editor || !message || !deleteTrigger)
      throw new Error("File delete action was not rendered.");
    fill(message, "Remove obsolete file");
    await settle();
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    });
    deleteTrigger.click();
    await settle();
    const confirmDelete = Array.from(mounted.root.querySelectorAll<HTMLButtonElement>("button"))
      .filter((button) => button.textContent?.trim() === "Delete file")
      .at(-1);
    confirmDelete?.click();
    await settle();

    expect(editBody).toMatchObject({
      branch: "main",
      expectedOid: commitOid,
      path: "readme.md",
      content: null,
      message: "Remove obsolete file",
    });
    mounted.unmount();
  });

  it("edits a protected branch through a new branch and creates the PR separately", async () => {
    i18n.global.locale.value = "en";
    let editBody: Record<string, unknown> | null = null;
    let pullBody: Record<string, unknown> | null = null;
    let pullAttempts = 0;
    const changed = vi.fn();
    const mock = mockCodeApi({
      branches: [branch("main", commitOid, { protected: true, rules: ["required-review"] })],
      onEdit: (body) => {
        editBody = body;
        return jsonResponse(
          { oid: createdCommitOid, branch: "feature/editor", path: "readme.md" },
          201
        );
      },
      onPullCreate: (body) => {
        pullBody = body;
        pullAttempts += 1;
        return pullAttempts === 1
          ? new Response(JSON.stringify({ error: { code: "failed", message: "failed" } }), {
              status: 500,
            })
          : jsonResponse({ id: "pull-1", number: 12 }, 201);
      },
    });
    const mounted = await mountCode(
      "/example/sample/blob/readme.md?ref=main",
      "code",
      {
        canWrite: true,
        onlineEditingEnabled: true,
        pullsEnabled: true,
      },
      changed
    );
    const editButton = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".file-actions button")
    ).find((button) => button.textContent?.includes("Edit"));
    editButton?.click();
    await settle();
    const editor = mounted.root.querySelector<HTMLFormElement>(".file-editor form");
    const textarea = editor?.querySelector<HTMLTextAreaElement>("textarea");
    const fields = editor?.querySelectorAll<HTMLInputElement>("input");
    const message = fields?.[1];
    const newBranch = fields?.[2];
    if (!editor || !textarea || !message || !newBranch)
      throw new Error("Protected branch editor controls were not rendered.");
    fill(textarea, "protected draft");
    fill(message, "Fix protected branch file");
    fill(newBranch, "feature/editor");
    await settle();
    const pullCheckbox = editor.querySelector<HTMLInputElement>(".fluent-checkbox__input");
    if (!pullCheckbox) throw new Error("PR option was not rendered for the new branch.");
    pullCheckbox.click();
    await settle();
    submit(editor);
    await settle();

    expect(editBody).toMatchObject({
      branch: "main",
      newBranch: "feature/editor",
      expectedOid: commitOid,
      content: "protected draft",
    });
    expect(pullBody).toMatchObject({
      baseRef: "main",
      headRef: "feature/editor",
      title: "Fix protected branch file",
    });
    expect(mounted.root.querySelector(".save-result")?.textContent).toContain(
      "pull request creation failed"
    );
    expect(mounted.root.querySelector(".save-result a")?.textContent).toBe("View committed file");
    expect(mounted.root.querySelector(".save-result a")?.getAttribute("href")).toContain(
      "/example/sample/blob/readme.md?ref=" + "b".repeat(40)
    );
    expect(
      mounted.root.querySelector('.save-result a[href="/example/sample/pulls/12"]')
    ).toBeNull();
    mounted.root.querySelector<HTMLButtonElement>(".save-result button")?.click();
    await settle();
    const pullLink = mounted.root.querySelector<HTMLAnchorElement>(
      '.save-result a[href="/example/sample/pulls/12"]'
    );
    expect(pullLink?.textContent).toBe("View pull request");
    expect(mounted.root.querySelector(".editor-fields")?.hasAttribute("disabled")).toBe(true);
    expect(mounted.root.textContent).not.toContain("branch name is invalid or already exists");
    expect(changed).toHaveBeenCalledTimes(2);
    expect(
      mock.requests.filter((request) => request.path.endsWith("/refs")).length
    ).toBeGreaterThan(1);
    mounted.unmount();
  });

  it("keeps the draft and asks for a new branch when the edit API returns 403", async () => {
    i18n.global.locale.value = "en";
    const editBodies: Array<Record<string, unknown>> = [];
    let attempt = 0;
    mockCodeApi({
      onEdit: (body) => {
        editBodies.push(body);
        attempt += 1;
        return attempt === 1
          ? new Response(
              JSON.stringify({ error: { code: "protected_branch", message: "protected" } }),
              {
                status: 403,
              }
            )
          : jsonResponse(
              { oid: createdCommitOid, branch: "feature/editor", path: "readme.md" },
              201
            );
      },
    });
    const mounted = await mountCode("/example/sample/blob/readme.md?ref=main", "code", {
      canWrite: true,
      onlineEditingEnabled: true,
    });
    const editButton = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".file-actions button")
    ).find((button) => button.textContent?.includes("Edit"));
    editButton?.click();
    await settle();
    const editor = mounted.root.querySelector<HTMLFormElement>(".file-editor form");
    const textarea = editor?.querySelector<HTMLTextAreaElement>("textarea");
    const fields = editor?.querySelectorAll<HTMLInputElement>("input");
    const message = fields?.[1];
    if (!editor || !textarea || !message) throw new Error("File editor fields were not rendered.");
    fill(textarea, "keep this protected draft");
    fill(message, "Move file from protected branch");
    await settle();
    submit(editor);
    await settle();

    expect(mounted.root.querySelector(".branch-guidance")?.textContent).toContain(
      "Create a branch"
    );
    expect(textarea.value).toBe("keep this protected draft");
    const newBranch = editor.querySelectorAll<HTMLInputElement>("input")[2];
    if (!newBranch) throw new Error("New branch input was not shown after 403.");
    fill(newBranch, "feature/editor");
    await settle();
    submit(editor);
    await settle();

    expect(editBodies[0]?.newBranch).toBeUndefined();
    expect(editBodies[1]).toMatchObject({ expectedOid: commitOid, newBranch: "feature/editor" });
    expect(mounted.root.querySelector(".save-result")?.textContent).toContain(
      "Changes were committed"
    );
    mounted.unmount();
  });

  it("creates, switches, and deletes branches with their loaded expected OIDs", async () => {
    i18n.global.locale.value = "en";
    const creates: Array<Record<string, unknown>> = [];
    const deletes: Array<Record<string, unknown>> = [];
    const mock = mockCodeApi({
      onBranchCreate: (body) => creates.push(body),
      onBranchDelete: (body) => deletes.push(body),
    });
    const mounted = await mountCode("/example/sample", "code", {
      canWrite: true,
      onlineEditingEnabled: true,
    });
    const managerButton = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent?.includes("Manage branches"));
    managerButton?.click();
    await settle();
    const branchForm = mounted.root.querySelector<HTMLFormElement>(".branch-create");
    const branchInput = branchForm?.querySelector<HTMLInputElement>("input");
    if (!branchForm || !branchInput) throw new Error("Branch manager did not load.");
    fill(branchInput, "feature/editor");
    await settle();
    submit(branchForm);
    await settle();

    expect(creates[0]).toMatchObject({
      name: "feature/editor",
      source: "main",
      expectedOid: commitOid,
    });
    expect(router.currentRoute.value.query.ref).toBe("feature/editor");
    expect(mounted.root.textContent).toContain("feature/editor");
    expect(mounted.root.querySelector(".repo-count")?.textContent).toContain("2 Branches");
    const deleteButton = mounted.root.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete branch feature/editor"]'
    );
    expect(deleteButton?.disabled).toBe(false);
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    });
    deleteButton?.click();
    await settle();
    const confirmDelete = Array.from(mounted.root.querySelectorAll<HTMLButtonElement>("button"))
      .filter((button) => button.textContent?.trim() === "Delete")
      .at(-1);
    confirmDelete?.click();
    await settle();

    expect(deletes[0]).toMatchObject({ name: "feature/editor", expectedOid: createdCommitOid });
    expect(router.currentRoute.value.query.ref).toBe("main");
    expect(mounted.root.querySelector(".repo-count")?.textContent).toContain("1 Branches");
    expect(
      mock.requests.filter((request) => request.path.endsWith("/refs")).length
    ).toBeGreaterThan(1);
    const defaultDelete = mounted.root.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete branch main"]'
    );
    expect(defaultDelete?.disabled).toBe(true);
    mounted.unmount();
  });

  it("disables binary-file editing and omits branch/edit calls when online editing is disabled", async () => {
    i18n.global.locale.value = "en";
    const binaryMock = mockCodeApi({ file: { binary: true, content: null, size: 1024 } });
    const binaryMounted = await mountCode("/example/sample/blob/readme.md?ref=main", "code", {
      canWrite: true,
      onlineEditingEnabled: true,
    });
    const editButton = Array.from(
      binaryMounted.root.querySelectorAll<HTMLButtonElement>(".file-actions button")
    ).find((button) => button.textContent?.includes("Edit"));
    expect(editButton?.disabled).toBe(true);
    editButton?.click();
    expect(binaryMounted.root.querySelector(".file-editor")).toBeNull();
    expect(binaryMock.requests.some((request) => request.path.endsWith("/commit"))).toBe(false);
    binaryMounted.unmount();

    const disabledMock = mockCodeApi();
    const disabledMounted = await mountCode("/example/sample", "code", {
      canWrite: true,
      onlineEditingEnabled: false,
    });
    expect(disabledMounted.root.querySelector(".file-editor")).toBeNull();
    expect(
      Array.from(disabledMounted.root.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Manage branches")
      )
    ).toBe(false);
    expect(
      disabledMock.requests.some(
        (request) => request.path.endsWith("/branches") || request.path.endsWith("/commit")
      )
    ).toBe(false);
    disabledMounted.unmount();

    for (const overrides of [
      { canWrite: false, onlineEditingEnabled: true },
      { canWrite: true, archived: true, onlineEditingEnabled: true },
    ]) {
      const gatedMock = mockCodeApi();
      const gatedMounted = await mountCode("/example/sample", "code", overrides);
      expect(gatedMounted.root.querySelector(".file-editor")).toBeNull();
      expect(
        Array.from(gatedMounted.root.querySelectorAll("button")).some((button) =>
          button.textContent?.includes("Manage branches")
        )
      ).toBe(false);
      expect(
        gatedMock.requests.some(
          (request) => request.path.endsWith("/branches") || request.path.endsWith("/commit")
        )
      ).toBe(false);
      gatedMounted.unmount();
    }
  });
});

describe("repository Code view interactions", () => {
  function button(root: HTMLElement, text: string) {
    return Array.from(root.querySelectorAll<HTMLElement>("button")).find((item) =>
      item.textContent?.includes(text)
    );
  }
  function press(target: Element, key: string) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  it("generates a thirty-day repository-scoped token and shows it once", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi();
    const create = vi.spyOn(api, "createAccessToken").mockResolvedValue({
      id: "pat-1",
      name: "example/sample",
      prefix: "gep_12345678",
      scopes: ["repo:read"],
      repositories: null,
      createdAt: 1,
      expiresAt: Date.now() + 30 * 86_400_000,
      lastUsedAt: null,
      revokedAt: null,
      token: `gep_${"c".repeat(64)}`,
    });
    const mounted = await mountCode("/example/sample", "code", {
      visibility: "private",
      viewerRole: "read",
      canWrite: false,
    });
    button(mounted.root, "Code")?.click();
    await settle();

    expect(mounted.root.querySelector("#clone-menu")).not.toBeNull();
    expect(mounted.root.textContent).toContain(
      "git clone http://localhost:3000/example/sample.git"
    );
    expect(mounted.root.textContent).not.toContain("http.extraHeader");
    expect(mounted.root.textContent).toContain("credential.helper osxkeychain");
    expect(mounted.root.textContent).toContain("credential.helper manager");
    expect(mounted.root.textContent).toContain("credential.helper libsecret");
    button(mounted.root, "Generate token")?.click();
    await settle();

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["repo:read"],
        expiresInDays: 30,
        repositoryIds: [expect.any(String)],
      })
    );
    expect(mounted.root.querySelector(".token-once code")?.textContent).toBe(
      `gep_${"c".repeat(64)}`
    );
    button(mounted.root, "Close")?.click();
    await settle();
    expect(mounted.root.querySelector(".token-once")).toBeNull();
    mounted.unmount();
  });

  it("hides token generation from viewers without a role", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi();
    const mounted = await mountCode("/example/sample", "code");
    button(mounted.root, "Code")?.click();
    await settle();

    expect(mounted.root.querySelector("#clone-menu")).not.toBeNull();
    expect(button(mounted.root, "Generate token")).toBeUndefined();
    mounted.unmount();
  });

  it("returns focus to the clone toggle on Escape", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi();
    const mounted = await mountCode("/example/sample", "code");
    const toggle = button(mounted.root, "Code");
    toggle?.click();
    await settle();
    expect(toggle?.getAttribute("aria-controls")).toBe("clone-menu");
    press(document.body, "Escape");
    await settle();
    expect(mounted.root.querySelector("#clone-menu")).toBeNull();
    expect(document.activeElement).toBe(toggle);
    mounted.unmount();
  });

  it("announces the copied clone URL", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const mounted = await mountCode("/example/sample", "code");
    button(mounted.root, "Code")?.click();
    await settle();
    mounted.root.querySelector<HTMLElement>(".clone-url fluent-button, .clone-url button")?.click();
    await settle();

    expect(writeText).toHaveBeenCalledOnce();
    expect(mounted.root.querySelector("[role=status]")?.textContent).toBe("Copied");
    mounted.unmount();
  });

  it("keeps listed commits mounted while loading more and disables the button", async () => {
    i18n.global.locale.value = "en";
    const pending: Array<(response: Response) => void> = [];
    const graphLimits: string[] = [];
    const commit = (index: number) => ({
      oid: index.toString(16).padStart(40, "0"),
      message: `commit ${index}`,
      parents: [],
      author: { name: "A", email: "a@example.test", timestamp: 1 },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://gitedge.test");
        if (url.pathname.endsWith("/refs"))
          return jsonResponse([{ name: "refs/heads/main", oid: commitOid }]);
        if (url.pathname.endsWith("/commits")) return jsonResponse([commit(1)]);
        if (url.pathname.endsWith("/graph")) {
          graphLimits.push(url.searchParams.get("limit") ?? "");
          const count = Number(url.searchParams.get("limit"));
          const body = {
            commits: Array.from({ length: count === 100 ? 2 : 3 }, (_, i) => commit(i + 1)),
            refs: [],
            sessions: [],
            truncated: true,
          };
          if (count === 100) return jsonResponse(body);
          return new Promise<Response>((resolve) =>
            pending.push(() => resolve(jsonResponse(body)))
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const mounted = await mountCode("/example/sample/commits?ref=main", "commits");
    expect(mounted.root.querySelectorAll(".commit-row")).toHaveLength(2);
    const more = button(mounted.root, "Load more");
    if (!more) throw new Error("Load more button was not rendered.");
    more.click();
    more.click();
    await settle();

    expect(mounted.root.querySelectorAll(".commit-row")).toHaveLength(2);
    expect(mounted.root.querySelector(".state-loading, [aria-busy=true]")).toBeNull();
    expect(button(mounted.root, "Load more")?.hasAttribute("disabled")).toBe(true);
    expect(graphLimits).toEqual(["100", "150"]);
    pending[0]?.(jsonResponse({}));
    await settle();
    expect(mounted.root.querySelectorAll(".commit-row")).toHaveLength(3);
    mounted.unmount();
  });

  it("reports truncated comparisons and omitted diffs", async () => {
    i18n.global.locale.value = "en";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://gitedge.test");
        if (url.pathname.endsWith("/refs"))
          return jsonResponse([{ name: "refs/heads/main", oid: commitOid }]);
        if (url.pathname.endsWith("/compare"))
          return jsonResponse({
            base: commitOid,
            head: createdCommitOid,
            commits: [],
            truncated: true,
            files: [
              { path: "big.txt", type: "modified", binary: false, patch: null },
              { path: "logo.png", type: "added", binary: true, patch: null },
            ],
          });
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const mounted = await mountCode("/example/sample/compare?base=main&head=main", "compare");
    const text = mounted.root.textContent ?? "";

    expect(text).toContain("This comparison is too large");
    expect(text).toContain("Diff omitted because the comparison exceeded its size budget.");
    expect(text).toContain("Binary files do not have a text preview");
    mounted.unmount();
  });

  it("asks before discarding an edited file", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const mounted = await mountCode("/example/sample/blob/readme.md?ref=main", "code", {
      canWrite: true,
      onlineEditingEnabled: true,
    });
    button(mounted.root, "Edit")?.click();
    await settle();
    const textarea = mounted.root.querySelector<HTMLTextAreaElement>(".file-editor textarea");
    if (!textarea) throw new Error("File editor did not open.");
    fill(textarea, "changed");
    await settle();
    button(editorRoot(mounted.root), "Cancel")?.click();
    await settle();

    expect(confirm).toHaveBeenCalledOnce();
    expect(mounted.root.querySelector(".file-editor")).not.toBeNull();
    confirm.mockReturnValue(true);
    button(editorRoot(mounted.root), "Cancel")?.click();
    await settle();
    expect(mounted.root.querySelector(".file-editor")).toBeNull();
    mounted.unmount();
  });

  it("keeps the page mounted when copying fails", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi();
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const mounted = await mountCode("/example/sample", "code");
    button(mounted.root, "Code")?.click();
    await settle();
    mounted.root.querySelector<HTMLElement>(".clone-url fluent-button, .clone-url button")?.click();
    await settle();

    expect(mounted.root.querySelector("[role=alert]")?.textContent).toContain("Could not copy");
    expect(mounted.root.querySelector(".clone-url")).not.toBeNull();
    expect(mounted.root.querySelector(".state-error")).toBeNull();
    mounted.unmount();
  });

  it("re-enables Load more after changing ref mid-request", async () => {
    i18n.global.locale.value = "en";
    const pending: Array<() => void> = [];
    const commit = (index: number) => ({
      oid: index.toString(16).padStart(40, "0"),
      message: `commit ${index}`,
      parents: [],
      author: { name: "A", email: "a@example.test", timestamp: 1 },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://gitedge.test");
        if (url.pathname.endsWith("/refs"))
          return jsonResponse([
            { name: "refs/heads/main", oid: commitOid },
            { name: "refs/heads/dev", oid: commitOid },
          ]);
        if (url.pathname.endsWith("/commits")) return jsonResponse([commit(1)]);
        if (url.pathname.endsWith("/graph")) {
          const body = {
            commits: [commit(1), commit(2)],
            refs: [],
            sessions: [],
            truncated: true,
          };
          if (url.searchParams.get("limit") === "100") return jsonResponse(body);
          return new Promise<Response>((resolve) =>
            pending.push(() => resolve(jsonResponse(body)))
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const mounted = await mountCode("/example/sample/commits?ref=main", "commits");
    button(mounted.root, "Load more")?.click();
    await settle();
    expect(pending).toHaveLength(1);
    await router.push("/example/sample/commits?ref=dev");
    await settle();
    pending[0]?.();
    await settle();
    expect(button(mounted.root, "Load more")?.hasAttribute("disabled")).toBe(false);
    mounted.unmount();
  });
});

function dropFiles(target: Element, files: File[]) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { items: [], files } });
  target.dispatchEvent(event);
}

function pickFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function fileWithPath(name: string, relativePath: string, content = "data"): File {
  const file = new File([content], name);
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

function changeForm(root: HTMLElement) {
  const form = root.querySelector<HTMLFormElement>(".change-form form");
  if (!form) throw new Error("Change form was not rendered.");
  return form;
}

function buttonWithText(root: ParentNode, text: string) {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!button) throw new Error(`Button ${text} was not rendered.`);
  return button;
}

function enableDialogs() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
}

const writer = { canWrite: true, onlineEditingEnabled: true, pullsEnabled: true };

describe("repository web file operations", () => {
  it("uploads dropped files and a picked folder into the current directory in one commit", async () => {
    i18n.global.locale.value = "en";
    let sent: Record<string, unknown> | null = null;
    mockCodeApi({
      onEdit: (body) => {
        sent = body;
        return jsonResponse({ oid: createdCommitOid, branch: "main" }, 201);
      },
    });
    const mounted = await mountCode("/example/sample/tree/docs?ref=main", "code", writer);
    buttonWithText(mounted.root, "Upload files").click();
    await settle();
    expect(mounted.root.querySelector(".change-form")?.textContent).toContain("5.0 MiB");
    expect(mounted.root.querySelector(".change-form")?.textContent).toContain("10 MiB");

    const zone = mounted.root.querySelector(".drop-zone");
    if (!zone) throw new Error("Drop zone was not rendered.");
    dropFiles(zone, [new File(["one"], "a.txt"), new File(["two"], "b.bin")]);
    await settle();
    const folderInput = mounted.root.querySelector<HTMLInputElement>(
      'input[type="file"][webkitdirectory]'
    );
    if (!folderInput) throw new Error("Folder picker was not rendered.");
    pickFiles(folderInput, [fileWithPath("c.txt", "assets/img/c.txt", "three")]);
    await settle();

    const staged = Array.from(mounted.root.querySelectorAll(".staged-list code")).map(
      (item) => item.textContent
    );
    expect(staged).toEqual(["docs/a.txt", "docs/b.bin", "docs/assets/img/c.txt"]);

    const form = changeForm(mounted.root);
    fill(form.querySelector<HTMLInputElement>('input[maxlength="500"]')!, "Add assets");
    await settle();
    submit(form);
    await settle();

    expect(sent).toMatchObject({
      branch: "main",
      expectedOid: commitOid,
      message: "Add assets",
      changes: [
        { op: "put", path: "docs/a.txt" },
        { op: "put", path: "docs/b.bin" },
        { op: "put", path: "docs/assets/img/c.txt" },
      ],
    });
    expect(Object.keys((sent as unknown as { files: object }).files)).toEqual(["f0", "f1", "f2"]);
    expect(router.currentRoute.value.path).toBe("/example/sample/tree/docs");
    expect(router.currentRoute.value.query.ref).toBe("main");
    mounted.unmount();
  });

  it("rejects oversized files and invalid paths before staging them", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi();
    const mounted = await mountCode("/example/sample?ref=main", "code", writer);
    buttonWithText(mounted.root, "Upload files").click();
    await settle();
    const zone = mounted.root.querySelector(".drop-zone");
    if (!zone) throw new Error("Drop zone was not rendered.");
    dropFiles(zone, [
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "huge.bin"),
      new File(["x"], ".git"),
      new File(["ok"], "ok.txt"),
    ]);
    await settle();

    const text = mounted.root.querySelector(".change-form")?.textContent ?? "";
    expect(text).toContain("huge.bin");
    expect(text).toContain("per-file size limit");
    expect(text).toContain("invalid path");
    expect(
      Array.from(mounted.root.querySelectorAll(".staged-list code")).map((i) => i.textContent)
    ).toEqual(["ok.txt"]);
    mounted.unmount();
  });

  it("opens the pull request form prefilled after committing to a new branch", async () => {
    i18n.global.locale.value = "en";
    let sent: Record<string, unknown> | null = null;
    mockCodeApi({
      onEdit: (body) => {
        sent = body;
        return jsonResponse({ oid: createdCommitOid, branch: "feature/upload" }, 201);
      },
    });
    const mounted = await mountCode("/example/sample?ref=main", "code", writer);
    buttonWithText(mounted.root, "Upload files").click();
    await settle();
    const zone = mounted.root.querySelector(".drop-zone");
    if (!zone) throw new Error("Drop zone was not rendered.");
    dropFiles(zone, [new File(["x"], "new.txt")]);
    await settle();
    const form = changeForm(mounted.root);
    const fields = form.querySelectorAll<HTMLInputElement>('input:not([type="file"])');
    fill(fields[0], "Upload new file");
    fill(fields[1], "feature/upload");
    await settle();
    const checkbox = form.querySelector<HTMLInputElement>(".fluent-checkbox__input");
    if (!checkbox) throw new Error("Pull request option was not rendered.");
    expect(checkbox.checked).toBe(true);
    submit(form);
    await settle();

    expect(sent).toMatchObject({ branch: "main", newBranch: "feature/upload" });
    expect(router.currentRoute.value.path).toBe("/example/sample/pulls");
    expect(router.currentRoute.value.query).toMatchObject({
      new: "1",
      base: "main",
      head: "feature/upload",
      title: "Upload new file",
    });
    mounted.unmount();
  });

  it("opens the new branch instead of a pull request form when pull requests are disabled", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi({
      onEdit: () => jsonResponse({ oid: createdCommitOid, branch: "feature/upload" }, 201),
    });
    const mounted = await mountCode("/example/sample?ref=main", "code", {
      ...writer,
      pullsEnabled: false,
    });
    buttonWithText(mounted.root, "Upload files").click();
    await settle();
    const zone = mounted.root.querySelector(".drop-zone");
    if (!zone) throw new Error("Drop zone was not rendered.");
    dropFiles(zone, [new File(["x"], "new.txt")]);
    await settle();
    const form = changeForm(mounted.root);
    const fields = form.querySelectorAll<HTMLInputElement>('input:not([type="file"])');
    fill(fields[0], "Upload new file");
    fill(fields[1], "feature/upload");
    await settle();
    expect(form.querySelector(".fluent-checkbox__input")).toBeNull();
    submit(form);
    await settle();

    expect(router.currentRoute.value.path).toBe("/example/sample");
    expect(router.currentRoute.value.query.ref).toBe("feature/upload");
    mounted.unmount();
  });

  it("keeps staged files and links the latest branch when the parent is stale", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi({
      onEdit: () =>
        new Response(JSON.stringify({ error: { code: "refs_changed", message: "changed" } }), {
          status: 409,
        }),
    });
    const mounted = await mountCode("/example/sample?ref=main", "code", writer);
    buttonWithText(mounted.root, "Upload files").click();
    await settle();
    const zone = mounted.root.querySelector(".drop-zone");
    if (!zone) throw new Error("Drop zone was not rendered.");
    dropFiles(zone, [new File(["x"], "new.txt")]);
    await settle();
    const form = changeForm(mounted.root);
    fill(form.querySelector<HTMLInputElement>('input[maxlength="500"]')!, "Upload");
    await settle();
    submit(form);
    await settle();

    expect(form.textContent).toContain("The branch changed");
    expect(form.querySelector("a")?.getAttribute("href")).toContain("base=" + commitOid);
    expect(mounted.root.querySelectorAll(".staged-list li")).toHaveLength(1);
    mounted.unmount();
  });

  it("asks for a new branch when a protected branch rejects the upload", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi({
      branches: [branch("main", commitOid, { protected: true, rules: ["main"] })],
    });
    const mounted = await mountCode("/example/sample?ref=main", "code", writer);
    buttonWithText(mounted.root, "Upload files").click();
    await settle();
    expect(mounted.root.querySelector(".change-form .branch-guidance")).not.toBeNull();
    const zone = mounted.root.querySelector(".drop-zone");
    if (!zone) throw new Error("Drop zone was not rendered.");
    dropFiles(zone, [new File(["x"], "new.txt")]);
    await settle();
    const form = changeForm(mounted.root);
    fill(form.querySelector<HTMLInputElement>('input[maxlength="500"]')!, "Upload");
    await settle();
    expect(buttonWithText(form, "Commit upload").disabled).toBe(true);
    mounted.unmount();
  });

  it("deletes a folder after confirmation and returns to the parent directory", async () => {
    i18n.global.locale.value = "en";
    enableDialogs();
    let sent: Record<string, unknown> | null = null;
    mockCodeApi({
      onEdit: (body) => {
        sent = body;
        return jsonResponse({ oid: createdCommitOid, branch: "main" }, 201);
      },
    });
    const mounted = await mountCode("/example/sample/tree/docs/guide?ref=main", "code", writer);
    buttonWithText(
      mounted.root.querySelector(".code-toolbar") as HTMLElement,
      "Delete folder"
    ).click();
    await settle();
    const form = changeForm(mounted.root);
    fill(form.querySelector<HTMLInputElement>('input[maxlength="500"]')!, "Remove guide");
    await settle();
    submit(form);
    await settle();
    expect(sent).toBeNull();
    const confirm = Array.from(mounted.root.querySelectorAll<HTMLButtonElement>("dialog button"))
      .filter((button) => button.textContent?.trim() === "Delete folder")
      .at(-1);
    confirm?.click();
    await settle();

    expect(sent).toMatchObject({
      expectedOid: commitOid,
      changes: [{ op: "delete", path: "docs/guide" }],
    });
    expect(router.currentRoute.value.path).toBe("/example/sample/tree/docs");
    mounted.unmount();
  });

  it("renames a folder to a new path with a single move", async () => {
    i18n.global.locale.value = "en";
    let sent: Record<string, unknown> | null = null;
    mockCodeApi({
      onEdit: (body) => {
        sent = body;
        return jsonResponse({ oid: createdCommitOid, branch: "main" }, 201);
      },
    });
    const mounted = await mountCode("/example/sample/tree/docs?ref=main", "code", writer);
    buttonWithText(
      mounted.root.querySelector(".code-toolbar") as HTMLElement,
      "Rename folder"
    ).click();
    await settle();
    const form = changeForm(mounted.root);
    const fields = form.querySelectorAll<HTMLInputElement>("input");
    fill(fields[0], "docs/../escape");
    await settle();
    expect(buttonWithText(form, "Commit move").disabled).toBe(true);
    fill(fields[0], "guides/handbook");
    fill(form.querySelector<HTMLInputElement>('input[maxlength="500"]')!, "Move docs");
    await settle();
    submit(form);
    await settle();

    expect(sent).toMatchObject({ changes: [{ op: "move", from: "docs", to: "guides/handbook" }] });
    expect(router.currentRoute.value.path).toBe("/example/sample/tree/guides/handbook");
    mounted.unmount();
  });

  it("renames a file from the editor path, moving it when the content is unchanged", async () => {
    i18n.global.locale.value = "en";
    const sent: Array<Record<string, unknown>> = [];
    mockCodeApi({
      onEdit: (body) => {
        sent.push(body);
        return jsonResponse({ oid: createdCommitOid, branch: "main" }, 201);
      },
    });
    const mounted = await mountCode("/example/sample/blob/readme.md?ref=main", "code", writer);
    const edit = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".file-actions button")
    ).find((button) => button.textContent?.includes("Edit"));
    edit?.click();
    await settle();
    const editor = mounted.root.querySelector<HTMLFormElement>(".file-editor form");
    if (!editor) throw new Error("File editor was not rendered.");
    const pathField = editor.querySelector<HTMLInputElement>('input[maxlength="1000"]');
    if (!pathField) throw new Error("Path field was not rendered.");
    fill(pathField, "docs/README.md");
    fill(editor.querySelector<HTMLInputElement>('input[maxlength="500"]')!, "Move readme");
    await settle();
    submit(editor);
    await settle();

    expect(sent[0]).toMatchObject({
      expectedOid: commitOid,
      changes: [{ op: "move", from: "readme.md", to: "docs/README.md" }],
    });
    mounted.unmount();
  });

  it("shows the server reason when a rename targets an existing path", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi({
      onEdit: () =>
        new Response(
          JSON.stringify({
            error: { code: "bad_request", message: "The destination already exists." },
          }),
          { status: 400 }
        ),
    });
    const mounted = await mountCode("/example/sample/blob/readme.md?ref=main", "code", writer);
    Array.from(mounted.root.querySelectorAll<HTMLButtonElement>(".file-actions button"))
      .find((button) => button.textContent?.includes("Edit"))
      ?.click();
    await settle();
    const editor = mounted.root.querySelector<HTMLFormElement>(".file-editor form");
    if (!editor) throw new Error("File editor was not rendered.");
    fill(editor.querySelector<HTMLInputElement>('input[maxlength="1000"]')!, "docs/taken.md");
    fill(editor.querySelector<HTMLInputElement>('input[maxlength="500"]')!, "Move readme");
    await settle();
    submit(editor);
    await settle();

    expect(mounted.root.querySelector(".file-editor")?.textContent).toContain(
      "The server rejected this change: The destination already exists."
    );
    mounted.unmount();
  });

  it("moves the file with its new content when a rename also edits content", async () => {
    i18n.global.locale.value = "en";
    const sent: Array<Record<string, unknown>> = [];
    mockCodeApi({
      onEdit: (body) => {
        sent.push(body);
        return jsonResponse({ oid: createdCommitOid, branch: "main" }, 201);
      },
    });
    const mounted = await mountCode("/example/sample/blob/readme.md?ref=main", "code", writer);
    Array.from(mounted.root.querySelectorAll<HTMLButtonElement>(".file-actions button"))
      .find((button) => button.textContent?.includes("Edit"))
      ?.click();
    await settle();
    const editor = mounted.root.querySelector<HTMLFormElement>(".file-editor form");
    if (!editor) throw new Error("File editor was not rendered.");
    fill(editor.querySelector<HTMLInputElement>('input[maxlength="1000"]')!, "docs/readme.md");
    fill(editor.querySelector<HTMLTextAreaElement>("textarea")!, "changed");
    fill(editor.querySelector<HTMLInputElement>('input[maxlength="500"]')!, "Move and edit");
    await settle();
    submit(editor);
    await settle();

    expect(sent[0]).toMatchObject({
      changes: [{ op: "move", from: "readme.md", to: "docs/readme.md", part: "f0" }],
      content: "changed",
    });
    mounted.unmount();
  });

  it("does not offer web file operations when online editing is disabled", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi();
    const mounted = await mountCode("/example/sample/tree/docs?ref=main", "code", {
      canWrite: true,
      onlineEditingEnabled: false,
    });
    expect(mounted.root.textContent).not.toContain("Upload files");
    expect(mounted.root.textContent).not.toContain("Delete folder");
    mounted.unmount();
  });
});
