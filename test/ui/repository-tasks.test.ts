import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import RepositoryTasks from "../../apps/web/src/components/RepositoryTasks.vue";
import { i18n } from "../../apps/web/src/i18n";
import { ApiError, api } from "../../apps/web/src/lib/api";
import { clearSession } from "../../apps/web/src/lib/session";
import type { MemoryIndex, Task } from "../../packages/contracts/src/tasks";
import {
  control,
  detail,
  fieldValue,
  fill,
  findButton,
  findByLabel,
  human,
  mountAt,
  repository,
  settle,
  submit,
  task,
  taskDocument,
  unmountAll,
} from "./task-support";

const memory: MemoryIndex = {
  content: "## Conventions\n\nUse **D1** as the source of truth.",
  guidelineVersion: "v0.2.2",
  revision: 3,
  actor: human,
  updatedAt: 40,
};

function mountTasks(path: string) {
  return mountAt("/_verify/tasks/:number?", path, () => h(RepositoryTasks, { repository }));
}

beforeEach(() => {
  i18n.global.locale.value = "en";
});

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  clearSession();
  i18n.global.locale.value = "en";
  document.body.innerHTML = "";
});

describe("repository task list", () => {
  it("renders milestone-style rows, the memory index, and filters by status", async () => {
    const rows: Task[] = [
      task({
        number: 2,
        type: "BugFix",
        title: "Fix merge",
        status: "done",
        progress: { total: 1, done: 1, percent: 100 },
      }),
      task({ number: 1, assignee: { kind: "agent", id: "agent-1", name: "builder" } }),
    ];
    vi.spyOn(api, "memory").mockResolvedValue(memory);
    const tasksSpy = vi
      .spyOn(api, "tasks")
      .mockImplementation(async (_id, status) =>
        status ? rows.filter((row) => row.status === status) : rows
      );
    const mounted = await mountTasks("/_verify/tasks");

    const rendered = Array.from(mounted.root.querySelectorAll(".task-row"));
    expect(rendered).toHaveLength(2);
    expect(rendered[1].textContent).toContain("#1");
    expect(rendered[1].textContent).toContain("[Feature] Agent memory");
    expect(rendered[1].textContent).toContain("In progress");
    expect(rendered[1].textContent).toContain("2 of 5 done");
    expect(rendered[1].textContent).toContain("builder · Agent");
    expect(rendered[1].querySelector("progress")?.getAttribute("value")).toBe("40");
    expect(rendered[0].textContent).toContain("Unassigned");
    expect(rendered[1].getAttribute("href")).toBe("/acme/project/tasks/1");

    const memoryBox = control(mounted.root, ".memory-box");
    expect(memoryBox.querySelector("h2")?.textContent).toBe("Conventions");
    expect(memoryBox.querySelector("strong")?.textContent).toBe("D1");
    expect(memoryBox.textContent).toContain("Guideline v0.2.2");
    expect(memoryBox.textContent).toContain("r3");

    fill(control(mounted.root, ".status-filter select"), "done");
    await settle();
    expect(tasksSpy).toHaveBeenLastCalledWith("repo-1", "done");
    const filtered = mounted.root.querySelectorAll(".task-row");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].textContent).toContain("Fix merge");

    fill(control(mounted.root, ".status-filter select"), "pending");
    await settle();
    expect(mounted.root.querySelectorAll(".task-row")).toHaveLength(0);
    expect(mounted.root.textContent).toContain("No tasks have this status");
    mounted.unmount();
  });

  it("shows the generated task table as rendered Markdown", async () => {
    vi.spyOn(api, "memory").mockResolvedValue(memory);
    vi.spyOn(api, "tasks").mockResolvedValue([task()]);
    const tableSpy = vi.spyOn(api, "taskTable").mockResolvedValue({
      markdown: "| No. | Task |\n| --- | --- |\n| 001 | [Feature] Agent memory |",
      guidelineVersion: "v0.2.2",
    });
    const mounted = await mountTasks("/_verify/tasks");

    findButton(mounted.root, "Task table").click();
    await settle();

    expect(tableSpy).toHaveBeenCalledWith("repo-1");
    const rendered = control(mounted.root, ".table-view table");
    expect(rendered.querySelectorAll("th")).toHaveLength(2);
    expect(rendered.textContent).toContain("[Feature] Agent memory");
    expect(mounted.root.querySelector(".task-row")).toBeNull();
    mounted.unmount();
  });

  it("switches task documents through accessible native tabs", async () => {
    vi.spyOn(api, "memory").mockResolvedValue(memory);
    vi.spyOn(api, "tasks").mockResolvedValue([task()]);
    vi.spyOn(api, "task").mockResolvedValue(detail());
    vi.spyOn(api, "assigneeCandidates").mockResolvedValue([]);
    const mounted = await mountTasks("/_verify/tasks/1");

    const tabs = mounted.root.querySelectorAll<HTMLButtonElement>('.doc-tabs [role="tab"]');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    tabs[1]?.click();
    await settle();
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("false");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(mounted.root.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(
      tabs[1]?.id
    );

    mounted.unmount();
  });

  it("creates a task after validating its type", async () => {
    vi.spyOn(api, "memory").mockResolvedValue(memory);
    vi.spyOn(api, "tasks").mockResolvedValue([]);
    const createSpy = vi
      .spyOn(api, "createTask")
      .mockResolvedValue(detail({ number: 4, title: "New work" }));
    vi.spyOn(api, "task").mockResolvedValue(detail({ number: 4, title: "New work" }));
    vi.spyOn(api, "assigneeCandidates").mockResolvedValue([]);
    const mounted = await mountTasks("/_verify/tasks");

    findButton(mounted.root, "New task").click();
    await settle();
    const form = control(mounted.root, ".task-form");
    const inputs = form.querySelectorAll<HTMLElement>("input");
    fill(inputs[0], "Bad type!");
    fill(inputs[1], "New work");
    submit(form);
    await settle();
    expect(createSpy).not.toHaveBeenCalled();
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "Type must be 2–24 letters"
    );

    fill(inputs[0], "Docs");
    submit(form);
    await settle();
    expect(createSpy).toHaveBeenCalledWith("repo-1", {
      type: "Docs",
      title: "New work",
      motivation: "",
      description: "",
    });
    await vi.waitFor(() =>
      expect(mounted.root.querySelector(".task-heading h2")?.textContent).toContain("New work")
    );
    mounted.unmount();
  });

  it("explains that tasks are hidden when the server returns 403", async () => {
    vi.spyOn(api, "memory").mockRejectedValue(new ApiError(403, "forbidden"));
    vi.spyOn(api, "tasks").mockRejectedValue(new ApiError(403, "forbidden"));
    const mounted = await mountTasks("/_verify/tasks");

    expect(mounted.root.textContent).toContain("visible to repository members only");
    expect(mounted.root.querySelector(".task-row")).toBeNull();
    expect(mounted.root.querySelector('[role="alert"]')).toBeNull();
    mounted.unmount();
  });
});

describe("task detail", () => {
  it("recovers from a document revision conflict without losing the draft", async () => {
    vi.spyOn(api, "task").mockResolvedValue(detail());
    vi.spyOn(api, "assigneeCandidates").mockResolvedValue([]);
    let calls = 0;
    const putSpy = vi
      .spyOn(api, "putTaskDocument")
      .mockImplementation(async (_id, _n, kind, body) => {
        calls += 1;
        if (calls === 1) throw new ApiError(409, "Task document revision has changed.");
        return taskDocument(kind, { content: body.content, revision: body.expectedRevision + 1 });
      });
    const reloadSpy = vi
      .spyOn(api, "taskDocument")
      .mockResolvedValue(taskDocument("plan", { content: "Remote plan", revision: 3 }));
    const mounted = await mountTasks("/_verify/tasks/1");

    const panel = control(mounted.root, ".doc-panel");
    expect(panel.querySelector("h2")?.textContent).toBe("Plan");
    findButton(panel, "Edit").click();
    await settle();
    const editor = control(panel, ".doc-editor");
    fill(control(editor, "textarea"), "My local plan");
    submit(editor);
    await settle();

    expect(putSpy).toHaveBeenNthCalledWith(1, "repo-1", 1, "plan", {
      content: "My local plan",
      expectedRevision: 2,
    });
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("changed by someone else");

    findButton(panel, "Load latest").click();
    await settle();
    expect(reloadSpy).toHaveBeenCalledWith("repo-1", 1, "plan");
    expect(panel.textContent).toContain("Updated to r3");
    expect(panel.querySelector(".doc-latest")?.textContent).toContain("Remote plan");
    expect(fieldValue(control(panel, "textarea"))).toBe("My local plan");

    submit(control(panel, ".doc-editor"));
    await settle();
    expect(putSpy).toHaveBeenNthCalledWith(2, "repo-1", 1, "plan", {
      content: "My local plan",
      expectedRevision: 3,
    });
    expect(panel.querySelector(".doc-editor")).toBeNull();
    expect(panel.textContent).toContain("My local plan");
    expect(panel.textContent).toContain("r4");
    mounted.unmount();
  });

  it("opens an earlier revision read only and offers it as a draft", async () => {
    vi.spyOn(api, "task").mockResolvedValue(detail());
    vi.spyOn(api, "assigneeCandidates").mockResolvedValue([]);
    vi.spyOn(api, "taskDocumentHistory").mockResolvedValue([
      { revision: 2, actor: human, size: 25, updatedAt: 30 },
      {
        revision: 1,
        actor: { kind: "system", id: "gitedge", name: "GitEdge" },
        size: 10,
        updatedAt: 20,
      },
    ]);
    const revisionSpy = vi
      .spyOn(api, "taskDocumentRevision")
      .mockResolvedValue(taskDocument("plan", { content: "Old plan", revision: 1 }));
    const mounted = await mountTasks("/_verify/tasks/1");

    const panel = control(mounted.root, ".doc-panel");
    findButton(panel, "History").click();
    await settle();
    const rows = panel.querySelectorAll(".doc-revisions li");
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain("System");

    findByLabel(panel, "View r1").click();
    await settle();
    expect(revisionSpy).toHaveBeenCalledWith("repo-1", 1, "plan", 1);
    expect(panel.textContent).toContain("Viewing r1");
    expect(panel.textContent).toContain("Old plan");
    expect(findButton(panel, "Edit from this revision")).toBeTruthy();

    findButton(panel, "Edit from this revision").click();
    await settle();
    expect(fieldValue(control(panel, "textarea"))).toBe("Old plan");
    mounted.unmount();
  });

  it("binds and unbinds commits and attaches and detaches linked items", async () => {
    const bound = {
      oid: "a".repeat(40),
      ref: "main",
      summary: "Add memory",
      author: "example-user",
      boundBy: human,
      source: "manual" as const,
      boundAt: 50,
    };
    const merged = {
      ...bound,
      oid: "b".repeat(40),
      summary: "Merge pull request",
      source: "pull_request_merge" as const,
    };
    let current = detail({
      commits: [merged],
      links: [
        { kind: "pull_request", number: 8, title: "Memory PR", state: "merged", createdAt: 5 },
      ],
    });
    vi.spyOn(api, "task").mockImplementation(async () => current);
    vi.spyOn(api, "assigneeCandidates").mockResolvedValue([]);
    vi.spyOn(api, "issues").mockResolvedValue({
      items: [
        {
          id: "i1",
          number: 3,
          title: "Track memory",
          body: "",
          state: "open",
          author: "example-user",
          actor: human,
          labels: [],
          assignees: [],
          reviewers: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      truncated: false,
    });
    vi.spyOn(api, "pulls").mockResolvedValue({ items: [], truncated: false });
    const bindSpy = vi.spyOn(api, "bindTaskCommit").mockImplementation(async () => {
      current = detail({ ...current, commits: [bound, merged] });
      return bound;
    });
    const unbindSpy = vi.spyOn(api, "unbindTaskCommit").mockImplementation(async () => {
      current = detail({ ...current, commits: [merged] });
    });
    const attachSpy = vi.spyOn(api, "attachTaskLink").mockImplementation(async () => {
      current = detail({
        ...current,
        links: [
          ...current.links,
          { kind: "issue", number: 3, title: "Track memory", state: "open", createdAt: 6 },
        ],
      });
      return current.links[current.links.length - 1];
    });
    const detachSpy = vi.spyOn(api, "detachTaskLink").mockImplementation(async () => {
      current = detail({
        ...current,
        links: current.links.filter((link) => link.kind !== "pull_request"),
      });
    });
    const mounted = await mountTasks("/_verify/tasks/1");

    const commitCard = control(mounted.root, ".commits-card");
    expect(commitCard.textContent).toContain("bbbbbbbb");
    expect(commitCard.textContent).toContain("PR merge");
    expect(commitCard.querySelector("a")?.getAttribute("href")).toContain(`oid=${"b".repeat(40)}`);

    findButton(commitCard, "Bind commit").click();
    await settle();
    const form = control(commitCard, ".commit-form");
    const inputs = form.querySelectorAll<HTMLElement>("input");
    fill(inputs[0], "not-an-oid");
    submit(form);
    await settle();
    expect(bindSpy).not.toHaveBeenCalled();
    expect(form.textContent).toContain("40-character");
    fill(inputs[0], "a".repeat(40));
    submit(form);
    await settle();
    expect(bindSpy).toHaveBeenCalledWith("repo-1", 1, { oid: "a".repeat(40), ref: "main" });
    expect(commitCard.textContent).toContain("aaaaaaaa");
    expect(commitCard.textContent).toContain("Manual");

    findByLabel(commitCard, "Unbind commit aaaaaaaa").click();
    await settle();
    expect(unbindSpy).toHaveBeenCalledWith("repo-1", 1, "a".repeat(40));
    expect(commitCard.textContent).not.toContain("aaaaaaaa");

    const linkCard = control(mounted.root, ".links-card");
    expect(linkCard.textContent).toContain("#8 Memory PR");
    findButton(linkCard, "Link item").click();
    await settle();
    fill(control(linkCard, "select"), "issue:3");
    submit(control(linkCard, "form"));
    await settle();
    expect(attachSpy).toHaveBeenCalledWith("repo-1", 1, { kind: "issue", number: 3 });
    expect(linkCard.textContent).toContain("#3 Track memory");

    findByLabel(linkCard, "Unlink #8").click();
    await settle();
    expect(detachSpy).toHaveBeenCalledWith("repo-1", 1, "pull_request", 8);
    expect(linkCard.textContent).not.toContain("Memory PR");
    mounted.unmount();
  });

  it("changes status and assigns an agent from the candidate list", async () => {
    let current = detail();
    vi.spyOn(api, "task").mockImplementation(async () => current);
    vi.spyOn(api, "assigneeCandidates").mockResolvedValue([
      { kind: "user", id: "user-1", name: "example-user" },
      { kind: "agent", id: "agent-1", name: "builder", ownerName: "example-user" },
    ]);
    const updateSpy = vi.spyOn(api, "updateTask").mockImplementation(async (_id, _n, patch) => {
      current = detail({ ...current, ...patch });
      return current;
    });
    const assignSpy = vi.spyOn(api, "assignTask").mockImplementation(async (_id, _n, assignee) => {
      current = detail({
        ...current,
        assignee: assignee ? { ...assignee, name: "builder" } : null,
      });
      return current;
    });
    const mounted = await mountTasks("/_verify/tasks/1");

    const dropdowns = mounted.root.querySelectorAll<HTMLElement>(".task-controls select");
    fill(dropdowns[0], "done");
    await settle();
    expect(updateSpy).toHaveBeenCalledWith("repo-1", 1, { status: "done" });

    fill(dropdowns[1], "agent:agent-1");
    await settle();
    expect(assignSpy).toHaveBeenCalledWith("repo-1", 1, { kind: "agent", id: "agent-1" });
    mounted.unmount();
  });

  it("hides editing controls from viewers who cannot write", async () => {
    vi.spyOn(api, "task").mockResolvedValue(detail());
    const mounted = await mountAt("/_verify/tasks/:number?", "/_verify/tasks/1", () =>
      h(RepositoryTasks, { repository: { ...repository, canWrite: false } })
    );

    expect(mounted.root.querySelector(".doc-panel")?.textContent).not.toContain("Edit");
    expect(mounted.root.querySelector(".task-controls select")).toBeNull();
    expect(mounted.root.querySelector(".commit-form")).toBeNull();
    mounted.unmount();
  });
});
