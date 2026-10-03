import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import RepositoryCode from "../../apps/web/src/components/RepositoryCode.vue";
import { i18n } from "../../apps/web/src/i18n";
import { router } from "../../apps/web/src/router";
import { clearSession, setSession } from "../../apps/web/src/lib/session";
import { fluentUi } from "../../apps/web/src/ui/fluent";
import type { RepositoryBranch } from "../../packages/contracts/src/repository-controls";

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
  overrides: Partial<typeof repository> = {}
) {
  setSession({ id: "user-1", identifier: "user@example.test" });
  await router.push(path);
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(RepositoryCode, { repository: { ...repository, ...overrides }, section });
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
    onPullCreate?: (body: Record<string, unknown>) => void;
    onBranchCreate?: (body: Record<string, unknown>) => void;
    onBranchDelete?: (body: Record<string, unknown>) => void;
  } = {}
) {
  let branches = options.branches ?? [branch("main", commitOid)];
  const requests: Array<{ path: string; method: string; body: string; ref: string | null }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://gitedge.test");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
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
    if (url.pathname.endsWith("/edit"))
      return (
        options.onEdit?.(JSON.parse(body) as Record<string, unknown>) ??
        jsonResponse({ oid: "commit-v2", branch: "main", path: "readme.md" }, 201)
      );
    if (url.pathname.endsWith("/pull-requests") && method === "POST") {
      options.onPullCreate?.(JSON.parse(body) as Record<string, unknown>);
      return jsonResponse({ id: "pull-1" }, 201);
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
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const mounted = await mountCode("/example/sample/blob/empty.txt?ref=main", "code");
    const buttons = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".file-actions .fluent-button")
    );

    buttons[0]?.click();
    buttons[1]?.click();

    expect(mounted.root.querySelector(".code-source .highlighted-file")?.textContent).toBe("");
    expect(open).toHaveBeenCalledWith("blob:test", "_blank", "noopener");
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledTimes(2);

    mounted.unmount();
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
    const message = editor?.querySelector<HTMLInputElement>("input");
    if (!editor || !textarea || !message) throw new Error("File editor fields were not rendered.");
    fill(textarea, "draft kept");
    fill(message, "Update readme");
    await settle();
    const saveButton = editor.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(saveButton?.disabled).toBe(false);
    submit(editor);
    await settle();

    expect(mock.requests.some((request) => request.path.endsWith("/edit"))).toBe(true);
    const editRequest = mock.requests.find((request) => request.path.endsWith("/edit"));
    expect(editRequest?.method).toBe("POST");
    expect(JSON.parse(editRequest?.body ?? "{}")).toMatchObject({
      branch: "main",
      expectedOid: commitOid,
      path: "readme.md",
      content: "draft kept",
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
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests.at(1)?.path).toBe("/api/git/repositories/repo-1/edit");
    mounted.unmount();
  });

  it("keeps the draft after a stale edit conflict", async () => {
    i18n.global.locale.value = "en";
    mockCodeApi({
      onEdit: () =>
        new Response(JSON.stringify({ error: { code: "conflict", message: "stale" } }), {
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
    const message = editor?.querySelector<HTMLInputElement>("input");
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
    const message = editor?.querySelector<HTMLInputElement>("input");
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
    mockCodeApi({
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
      },
    });
    const mounted = await mountCode("/example/sample/blob/readme.md?ref=main", "code", {
      canWrite: true,
      onlineEditingEnabled: true,
      pullsEnabled: true,
    });
    const editButton = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".file-actions button")
    ).find((button) => button.textContent?.includes("Edit"));
    editButton?.click();
    await settle();
    const editor = mounted.root.querySelector<HTMLFormElement>(".file-editor form");
    const textarea = editor?.querySelector<HTMLTextAreaElement>("textarea");
    const fields = editor?.querySelectorAll<HTMLInputElement>("input");
    const message = fields?.[0];
    const newBranch = fields?.[1];
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
    expect(mounted.root.querySelector(".save-result")?.textContent).toContain("Created");
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
          ? new Response(JSON.stringify({ error: { code: "forbidden", message: "protected" } }), {
              status: 403,
            })
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
    const message = fields?.[0];
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
    const newBranch = editor.querySelectorAll<HTMLInputElement>("input")[1];
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
    mockCodeApi({
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
    expect(binaryMock.requests.some((request) => request.path.endsWith("/edit"))).toBe(false);
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
        (request) => request.path.endsWith("/branches") || request.path.endsWith("/edit")
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
          (request) => request.path.endsWith("/branches") || request.path.endsWith("/edit")
        )
      ).toBe(false);
      gatedMounted.unmount();
    }
  });
});
