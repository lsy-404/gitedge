import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, ref } from "vue";
import AssignmentPanel from "../../apps/web/src/components/AssignmentPanel.vue";
import { i18n } from "../../apps/web/src/i18n";
import { ApiError, api } from "../../apps/web/src/lib/api";
import { clearSession } from "../../apps/web/src/lib/session";
import type { Issue, PullRequest } from "../../packages/contracts/src/forge";
import {
  control,
  detail,
  fill,
  findByLabel,
  human,
  mountAt,
  repository,
  settle,
  task,
  unmountAll,
} from "./task-support";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    number: 7,
    title: "Initial issue",
    body: "",
    state: "open",
    author: "example-user",
    actor: human,
    labels: [],
    assignees: [{ kind: "user", id: "user-1", name: "example-user" }],
    reviewers: [],
    createdAt: 10,
    updatedAt: 11,
    ...overrides,
  };
}

const candidates = [
  { kind: "user" as const, id: "user-1", name: "example-user" },
  { kind: "user" as const, id: "user-2", name: "second-user" },
  { kind: "agent" as const, id: "agent-1", name: "builder", ownerName: "second-user" },
];

function mountPanel(item: Issue | PullRequest, kind: "issue" | "pull_request" = "issue") {
  const current = ref(item);
  return mountAt("/_verify/panel", "/_verify/panel", () =>
    h(AssignmentPanel, {
      repository,
      kind,
      item: current.value,
      onUpdated: (updated: Issue | PullRequest) => {
        current.value = updated;
      },
    })
  );
}

beforeEach(() => {
  i18n.global.locale.value = "en";
  vi.spyOn(api, "assigneeCandidates").mockResolvedValue(candidates);
  vi.spyOn(api, "tasks").mockResolvedValue([]);
});

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  clearSession();
  document.body.innerHTML = "";
});

function group(root: ParentNode, label: string): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>('[role="group"]')).find((entry) =>
    entry.querySelector(".eyebrow")?.textContent?.includes(label)
  );
  if (!found) throw new Error(`Missing group: ${label}`);
  return found;
}

describe("AssignmentPanel", () => {
  it("adds a human assignee and an agent reviewer with separate roles", async () => {
    let latest = issue();
    const setSpy = vi
      .spyOn(api, "setIssueAssignees")
      .mockImplementation(async (_id, _n, payload) => {
        const named = payload.assignees.map((ref) => ({
          ...ref,
          name: candidates.find((candidate) => candidate.id === ref.id)?.name ?? ref.id,
        }));
        latest = issue(
          payload.role === "assignee"
            ? { assignees: named, reviewers: latest.reviewers }
            : { assignees: latest.assignees, reviewers: named }
        );
        return latest;
      });
    const mounted = await mountPanel(issue());

    const assignees = group(mounted.root, "Assignees");
    const reviewers = group(mounted.root, "Reviewers");
    expect(assignees.textContent).toContain("example-user");
    expect(reviewers.textContent).toContain("No reviewers");
    // The assignee already in the set is not offered again.
    const assigneeOptions = Array.from(assignees.querySelectorAll("fluent-option")).map((option) =>
      option.getAttribute("value")
    );
    expect(assigneeOptions).toEqual(["", "user:user-2", "agent:agent-1"]);
    expect(assignees.querySelector("fluent-option[value='agent:agent-1']")?.textContent).toContain(
      "builder · Agent (owner second-user)"
    );

    fill(control(assignees, "fluent-dropdown"), "user:user-2");
    await settle();
    expect(setSpy).toHaveBeenLastCalledWith("repo-1", 7, {
      role: "assignee",
      assignees: [
        { kind: "user", id: "user-1" },
        { kind: "user", id: "user-2" },
      ],
    });
    expect(group(mounted.root, "Assignees").textContent).toContain("second-user");

    fill(control(group(mounted.root, "Reviewers"), "fluent-dropdown"), "agent:agent-1");
    await settle();
    expect(setSpy).toHaveBeenLastCalledWith("repo-1", 7, {
      role: "reviewer",
      assignees: [{ kind: "agent", id: "agent-1" }],
    });
    const updatedReviewers = group(mounted.root, "Reviewers");
    expect(updatedReviewers.textContent).toContain("builder");
    expect(updatedReviewers.textContent).toContain("Agent");
    expect(mounted.root.textContent).toContain("Agent reviews do not count toward merge approval");

    findByLabel(mounted.root, "Remove example-user").click();
    await settle();
    expect(setSpy).toHaveBeenLastCalledWith("repo-1", 7, {
      role: "assignee",
      assignees: [{ kind: "user", id: "user-2" }],
    });
    mounted.unmount();
  });

  it("uses the pull request endpoint for pull requests", async () => {
    const pull: PullRequest = {
      id: "pull-1",
      number: 12,
      title: "Update parser",
      body: "",
      state: "open",
      author: "example-user",
      actor: human,
      baseRef: "main",
      headRef: "feature",
      headSessionId: null,
      draft: false,
      mergedOid: null,
      assignees: [],
      reviewers: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const setSpy = vi.spyOn(api, "setPullAssignees").mockResolvedValue({
      ...pull,
      reviewers: [{ kind: "user", id: "user-2", name: "second-user" }],
    });
    const mounted = await mountPanel(pull, "pull_request");

    fill(control(group(mounted.root, "Reviewers"), "fluent-dropdown"), "user:user-2");
    await settle();
    expect(setSpy).toHaveBeenCalledWith("repo-1", 12, {
      role: "reviewer",
      assignees: [{ kind: "user", id: "user-2" }],
    });
    expect(group(mounted.root, "Reviewers").textContent).toContain("second-user");
    mounted.unmount();
  });

  it("explains a policy rejection and keeps the previous set", async () => {
    vi.spyOn(api, "setIssueAssignees").mockRejectedValue(new ApiError(403, "forbidden"));
    const mounted = await mountPanel(issue());

    fill(control(group(mounted.root, "Reviewers"), "fluent-dropdown"), "agent:agent-1");
    await settle();
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "only an agent's owner can assign that agent"
    );
    expect(group(mounted.root, "Reviewers").textContent).toContain("No reviewers");
    mounted.unmount();
  });

  it("moves an item between tasks by unlinking before linking", async () => {
    const first = task({ number: 1, title: "First", progress: { total: 1, done: 0, percent: 0 } });
    const second = task({
      number: 2,
      title: "Second",
      progress: { total: 0, done: 0, percent: null },
    });
    vi.spyOn(api, "tasks").mockResolvedValue([first, second]);
    vi.spyOn(api, "task").mockResolvedValue(
      detail({
        ...first,
        links: [{ kind: "issue", number: 7, title: "Initial issue", state: "open", createdAt: 1 }],
      })
    );
    const order: string[] = [];
    vi.spyOn(api, "detachTaskLink").mockImplementation(async (_id, number) => {
      order.push(`detach:${number}`);
    });
    vi.spyOn(api, "attachTaskLink").mockImplementation(async (_id, number, payload) => {
      order.push(`attach:${number}:${payload.kind}:${payload.number}`);
      return {
        kind: payload.kind,
        number: payload.number,
        title: "Initial issue",
        state: "open",
        createdAt: 2,
      };
    });
    const mounted = await mountPanel(issue());

    const select = control(mounted.root, ".task-select fluent-dropdown");
    expect(mounted.root.querySelector(".task-select fluent-option[selected]")).toBeNull();
    fill(select, "2");
    await settle();
    expect(order).toEqual(["detach:1", "attach:2:issue:7"]);
    mounted.unmount();
  });

  it("is read only without write access", async () => {
    const mounted = await mountAt("/_verify/panel", "/_verify/panel", () =>
      h(AssignmentPanel, {
        repository: { ...repository, canWrite: false },
        kind: "issue",
        item: issue(),
      })
    );

    expect(mounted.root.textContent).toContain("example-user");
    expect(mounted.root.querySelector("fluent-dropdown")).toBeNull();
    expect(mounted.root.querySelector("[aria-label^='Remove']")).toBeNull();
    expect(api.assigneeCandidates).not.toHaveBeenCalled();
    mounted.unmount();
  });
});
