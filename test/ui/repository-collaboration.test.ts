import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { i18n } from "../../apps/web/src/i18n";
import collaborationMessages from "../../apps/web/src/i18n/collaboration";
import { ApiError, api, type ReviewComment } from "../../apps/web/src/lib/api";
import { clearSession, setSession } from "../../apps/web/src/lib/session";
import { fluentUi } from "../../apps/web/src/ui/fluent";
import { router } from "../../apps/web/src/router";
import RepositoryCollaboration from "../../apps/web/src/components/RepositoryCollaboration.vue";
import type {
  Actor,
  CheckRun,
  Comment,
  Discussion,
  GitComparison,
  Issue,
  PullRequest,
  Repository,
  Review,
  WikiPage,
} from "../../packages/contracts/src/forge";

const human: Actor = { kind: "user", id: "user-1", name: "Example User" };
const repository: Repository = {
  id: "repo-1",
  namespaceId: "namespace-1",
  owner: "acme",
  name: "project",
  slug: "project",
  description: "A test repository",
  visibility: "public",
  defaultBranch: "main",
  createdAt: 1,
  updatedAt: 2,
  canWrite: true,
  archived: false,
  issuesEnabled: true,
  pullsEnabled: true,
  discussionsEnabled: true,
  wikiEnabled: true,
  tasksEnabled: true,
  agentsEnabled: true,
  deploymentsEnabled: true,
  graphEnabled: true,
  actionsEnabled: true,
  actionsNetworkEnabled: false,
  onlineEditingEnabled: true,
  allowMergeCommit: true,
  allowSquashMerge: true,
  allowRebaseMerge: true,
  deleteBranchOnMerge: false,
  requiredApprovals: 0,
  requirePassingChecks: false,
};
const pendingUnmounts: Array<() => void> = [];
let sectionUnderTest = "issues";
let routeSequence = 0;

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    number: 7,
    title: "Initial issue",
    body: "Initial description",
    state: "open",
    author: "example-user",
    actor: human,
    labels: ["bug"],
    assignees: [{ kind: "user", id: "u-1", name: "example-user" }],
    reviewers: [],
    createdAt: 10,
    updatedAt: 11,
    ...overrides,
  };
}

function pull(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "pull-1",
    number: 12,
    title: "Update parser",
    body: "Parser changes",
    state: "open",
    author: "example-user",
    actor: human,
    baseRef: "main",
    headRef: "feature/parser",
    headSessionId: null,
    draft: false,
    mergedOid: null,
    assignees: [],
    reviewers: [],
    createdAt: 10,
    updatedAt: 11,
    ...overrides,
  };
}

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "comment-1",
    body: "A useful answer",
    actor: human,
    createdAt: 12,
    updatedAt: 12,
    ...overrides,
  };
}

function discussion(overrides: Partial<Discussion> = {}): Discussion {
  return {
    id: "discussion-1",
    number: 4,
    title: "How does this work?",
    body: "Question body",
    category: "q-and-a",
    state: "open",
    actor: human,
    answerCommentId: null,
    createdAt: 10,
    updatedAt: 11,
    ...overrides,
  };
}

function page(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    slug: "guide",
    title: "Guide",
    content: "Original docs",
    revision: 2,
    updatedBy: "example-user",
    updatedAt: 20,
    ...overrides,
  };
}

function settle(): Promise<void> {
  return (async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
      await nextTick();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  })();
}

function control(root: ParentNode, selector: string): HTMLElement {
  const field = root.querySelector<HTMLElement>(selector);
  if (!field) throw new Error(`Expected control: ${selector}`);
  return field;
}

function findButton(root: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>("button.fluent-button")).find(
    (button) => button.textContent?.replace(/\s+/g, " ").includes(text)
  );
  if (!found)
    throw new Error(
      `Could not find button containing: ${text}. Rendered text: ${root.textContent}`
    );
  return found;
}

/** Sets the control's value property and emits the event Fluent would: `change` for dropdowns. */
function fill(field: HTMLElement, value: string): void {
  Reflect.set(field, "value", value);
  field.dispatchEvent(
    new Event(field.localName === "select" ? "change" : "input", { bubbles: true })
  );
}

function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  vi.spyOn(api, "issueReferences").mockResolvedValue({
    pullRequests: [],
    events: [],
    truncated: false,
  });
  vi.spyOn(api, "reviewComments").mockResolvedValue({ items: [], truncated: false });
  vi.spyOn(api, "repositoryCommunity").mockResolvedValue({
    files: [],
    issueTemplates: [],
    pullRequestTemplate: null,
    truncated: false,
  });
  i18n.global.mergeLocaleMessage("zh-CN", collaborationMessages["zh-CN"]);
  i18n.global.mergeLocaleMessage("en", collaborationMessages.en);
  i18n.global.locale.value = "en";
});

async function mountSection(path: string, section: string) {
  setSession({ id: "user-1", identifier: "user@example.test" });
  sectionUnderTest = section;
  const Host = defineComponent({
    setup: () => () =>
      h(RepositoryCollaboration, {
        repository,
        section: sectionUnderTest,
      }),
  });
  const routeName = `repository-collaboration-${routeSequence++}`;
  const routePath = section === "wiki" ? "/_verify/wiki/:slug" : "/_verify/:section/:number?";
  router.addRoute({
    path: routePath,
    name: routeName,
    component: Host,
    meta: { public: true },
  });
  const detailRouteName = `${routeName}-detail`;
  router.addRoute({
    path: `/${repository.owner}/${repository.name}/${section}/${section === "wiki" ? ":slug?" : ":number?"}`,
    name: detailRouteName,
    component: Host,
    meta: { public: true },
  });
  await router.push(path);
  await router.isReady();
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(Host);
  app.use(router);
  app.use(i18n);
  app.use(fluentUi);
  app.mount(root);
  await settle();
  let active = true;
  const unmount = () => {
    if (!active) return;
    active = false;
    app.unmount();
    root.remove();
    router.removeRoute(routeName);
    router.removeRoute(detailRouteName);
  };
  pendingUnmounts.push(unmount);
  return {
    root,
    async navigate(to: string) {
      await router.push(to);
      await settle();
    },
    unmount,
  };
}

afterEach(async () => {
  for (const unmount of pendingUnmounts.splice(0)) unmount();
  await router.push("/dashboard");
  vi.restoreAllMocks();
  clearSession();
  i18n.global.locale.value = "en";
  document.body.innerHTML = "";
});

describe("RepositoryCollaboration rendered workflows", () => {
  it("filters loaded issues by state and search text with real state counts", async () => {
    vi.spyOn(api, "issues").mockResolvedValue({
      items: [
        issue({ number: 7, title: "Parser regression", labels: ["bug"] }),
        issue({
          id: "issue-2",
          number: 8,
          title: "Document setup",
          state: "closed",
          labels: ["docs"],
        }),
      ],
      truncated: false,
    });
    const mounted = await mountSection("/_verify/issues", "issues");

    expect(mounted.root.querySelectorAll(".item-link")).toHaveLength(1);
    expect(mounted.root.querySelectorAll(".filter-button .tab-count")[0]?.textContent).toBe("1");
    expect(mounted.root.querySelectorAll(".filter-button .tab-count")[1]?.textContent).toBe("1");

    mounted.root.querySelectorAll<HTMLElement>(".filter-button")[1]?.click();
    await settle();
    expect(mounted.root.querySelectorAll(".item-link")).toHaveLength(1);
    expect(mounted.root.textContent).toContain("Document setup");

    fill(control(mounted.root, ".search-field input"), "missing text");
    await settle();
    expect(mounted.root.querySelectorAll(".item-link")).toHaveLength(0);
    expect(mounted.root.textContent).toContain("No items match the current filters.");
    mounted.unmount();
  });

  it("filters issues by the signed-in assignee and author, and sorts recent activity", async () => {
    vi.spyOn(api, "issues").mockResolvedValue({
      items: [
        issue({
          number: 7,
          title: "Assigned to me",
          actor: { kind: "agent", id: "agent-1", name: "Build agent" },
          assignees: [{ kind: "user", id: "user-1", name: "user@example.test" }],
          updatedAt: 20,
        }),
        issue({
          number: 8,
          title: "Created by me",
          assignees: [{ kind: "user", id: "user-2", name: "another-user" }],
          updatedAt: 100,
        }),
        issue({
          id: "issue-3",
          number: 9,
          title: "Another issue",
          actor: { kind: "agent", id: "agent-2", name: "Review agent" },
          assignees: [],
          updatedAt: 40,
        }),
      ],
      truncated: false,
    });
    const mounted = await mountSection("/_verify/issues", "issues");
    const railButtons = mounted.root.querySelectorAll<HTMLElement>(".issue-rail button");

    railButtons[1]?.click();
    await settle();
    expect(mounted.root.querySelectorAll(".item-link")).toHaveLength(1);
    expect(mounted.root.textContent).toContain("Assigned to me");

    railButtons[2]?.click();
    await settle();
    expect(mounted.root.querySelectorAll(".item-link")).toHaveLength(1);
    expect(mounted.root.textContent).toContain("Created by me");

    railButtons[3]?.click();
    await settle();
    expect(mounted.root.querySelector(".item-link strong")?.textContent).toBe("Created by me");
    mounted.unmount();
  });

  it("warns when a list is truncated and clears the warning in other sections", async () => {
    vi.spyOn(api, "repository").mockResolvedValue(repository);
    vi.spyOn(api, "issues").mockResolvedValue({ items: [issue()], truncated: true });
    const mounted = await mountSection("/_verify/issues", "issues");
    expect(mounted.root.textContent).toContain(
      "This list exceeds 500 entries; only part of it is shown"
    );
    mounted.unmount();
    vi.spyOn(api, "issues").mockResolvedValue({ items: [issue()], truncated: false });
    const complete = await mountSection("/_verify/issues", "issues");
    expect(complete.root.textContent).not.toContain("This list exceeds 500 entries");
    complete.unmount();
  });

  it("creates an issue with labels, edits it, comments, and closes it", async () => {
    const initial = issue();
    let latest = initial;
    let comments: Comment[] = [];
    vi.spyOn(api, "repository").mockResolvedValue(repository);
    const issuesSpy = vi.spyOn(api, "issues").mockResolvedValue({ items: [], truncated: false });
    const createIssueSpy = vi.spyOn(api, "createIssue").mockImplementation(async (_id, payload) => {
      latest = issue({
        number: 7,
        title: payload.title,
        body: payload.body,
        labels: payload.labels ?? [],
      });
      return latest;
    });
    vi.spyOn(api, "issue").mockImplementation(async () => latest);
    const updateIssueSpy = vi
      .spyOn(api, "updateIssue")
      .mockImplementation(async (_id, _number, patch) => {
        latest = issue({ ...latest, ...patch });
        return latest;
      });
    const commentsSpy = vi
      .spyOn(api, "comments")
      .mockImplementation(async () => ({ items: comments, truncated: false }));
    const createCommentSpy = vi
      .spyOn(api, "createComment")
      .mockImplementation(async (_id, _resource, _number, body) => {
        const created = comment({ body });
        comments = [created];
        return created;
      });
    const mounted = await mountSection("/_verify/issues", "issues");

    findButton(mounted.root, "New issue").click();
    await settle();
    const createForm = mounted.root.querySelector<HTMLFormElement>(".create-form");
    if (!createForm) throw new Error("Issue creation form did not open.");
    const createInputs = createForm.querySelectorAll<HTMLElement>("input");
    fill(createInputs[0], "Parser regression");
    fill(control(createForm, "textarea"), "Steps to reproduce");
    fill(createInputs[1], "bug, regression");
    submit(createForm);
    await settle();

    expect(createIssueSpy).toHaveBeenCalledWith("repo-1", {
      title: "Parser regression",
      body: "Steps to reproduce",
      labels: ["bug", "regression"],
    });
    await vi.waitFor(
      () =>
        expect(mounted.root.querySelector(".detail-titlebar h2")?.textContent).toContain(
          "Parser regression"
        ),
      { timeout: 10000 }
    );
    expect(issuesSpy).toHaveBeenCalled();

    findButton(mounted.root, "Edit").click();
    await settle();
    const editForm = mounted.root.querySelector<HTMLFormElement>(".item-edit");
    if (!editForm) throw new Error("Issue edit form did not open.");
    fill(control(editForm, "input"), "Parser regression fixed");
    fill(control(editForm, "textarea"), "Updated reproduction details");
    fill(editForm.querySelectorAll<HTMLElement>("input")[1], "bug, fixed");
    submit(editForm);
    await settle();
    expect(updateIssueSpy).toHaveBeenCalledWith("repo-1", 7, {
      title: "Parser regression fixed",
      body: "Updated reproduction details",
      labels: ["bug", "fixed"],
    });
    expect(mounted.root.querySelector(".detail-titlebar h2")?.textContent).toContain(
      "Parser regression fixed"
    );

    const commentForm = mounted.root.querySelector<HTMLFormElement>(".comments-panel form");
    if (!commentForm) throw new Error("Issue comment form was not rendered.");
    fill(control(commentForm, "textarea"), "Confirmed on latest build");
    submit(commentForm);
    await settle();
    expect(createCommentSpy).toHaveBeenCalledWith(
      "repo-1",
      "issues",
      7,
      "Confirmed on latest build"
    );
    expect(commentsSpy).toHaveBeenCalled();
    expect(mounted.root.textContent).toContain("Confirmed on latest build");

    findButton(mounted.root, "Close item").click();
    await settle();
    expect(updateIssueSpy).toHaveBeenLastCalledWith("repo-1", 7, { state: "closed" });
    expect(mounted.root.querySelector(".detail-state-row .badge")?.textContent).toContain("Closed");
    mounted.unmount();
  });

  it("binds PR reviews and checks to commits, marks stale results, and shows the merged state", async () => {
    const openPull = pull();
    const mergedPull = pull({ state: "merged", mergedOid: "merged-commit-oid" });
    let reviews: Review[] = [
      {
        id: "review-old",
        body: "Old approval",
        state: "approved",
        commitOid: "old-head",
        actor: human,
        createdAt: 12,
      },
    ];
    let checks: CheckRun[] = [
      {
        id: "check-old",
        name: "unit tests",
        commitOid: "old-head",
        status: "completed",
        conclusion: "success",
        summary: "Passed",
        detailsUrl: null,
        actor: human,
        createdAt: 12,
        updatedAt: 12,
      },
    ];
    const comparison: GitComparison = {
      baseOid: "base-current-oid",
      headOid: "head-current-oid",
      mergeBaseOid: "merge-base-oid",
      commits: [],
      files: [],
      truncated: false,
    };
    vi.spyOn(api, "pull").mockImplementation(async () =>
      vi.mocked(api.mergePull).mock.calls.length ? mergedPull : openPull
    );
    vi.spyOn(api, "comments").mockResolvedValue({ items: [], truncated: false });
    vi.spyOn(api, "reviews").mockImplementation(async () => reviews);
    vi.spyOn(api, "checks").mockImplementation(async () => checks);
    vi.spyOn(api, "pullDiff").mockResolvedValue(comparison);
    const createReviewSpy = vi
      .spyOn(api, "createReview")
      .mockImplementation(async (_id, _number, payload) => {
        reviews = [
          ...reviews,
          {
            id: "review-new",
            body: payload.body,
            state: payload.state,
            commitOid: payload.commitOid,
            actor: human,
            createdAt: 13,
          },
        ];
        return reviews[reviews.length - 1];
      });
    const createCheckSpy = vi
      .spyOn(api, "createCheck")
      .mockImplementation(async (_id, _number, payload) => {
        const created: CheckRun = {
          id: "check-new",
          name: payload.name,
          commitOid: payload.commitOid,
          status: payload.status,
          conclusion: payload.conclusion,
          summary: payload.summary,
          detailsUrl: null,
          actor: human,
          createdAt: 13,
          updatedAt: 13,
        };
        checks = [...checks, created];
        return created;
      });
    const mergePullSpy = vi.spyOn(api, "mergePull").mockResolvedValue(mergedPull);
    const mounted = await mountSection("/_verify/pulls/12", "pulls");

    expect(mounted.root.querySelector(".detail-titlebar h2")?.textContent).toContain(
      openPull.title
    );
    expect(mounted.root.querySelector(".detail-card h2")).toBeNull();
    expect(mounted.root.textContent).toContain("Review is for an older head");
    mounted.root.querySelectorAll<HTMLElement>(".pull-tabs button")[2]?.click();
    await settle();
    expect(mounted.root.querySelector(".pull-review")).toBeNull();
    expect(mounted.root.querySelector(".checks-panel")).not.toBeNull();
    expect(mounted.root.textContent).toContain("Check is for an older commit");
    mounted.root.querySelectorAll<HTMLElement>(".pull-tabs button")[0]?.click();
    await settle();

    const reviewForm = mounted.root.querySelector<HTMLFormElement>(".review-panel form");
    if (!reviewForm) throw new Error("Review form was not rendered.");
    fill(control(reviewForm, "select"), "approved");
    fill(control(reviewForm, "textarea"), "Approved current head");
    submit(reviewForm);
    await settle();
    expect(createReviewSpy).toHaveBeenCalledWith("repo-1", 12, {
      commitOid: "head-current-oid",
      state: "approved",
      body: "Approved current head",
    });

    mounted.root.querySelectorAll<HTMLElement>(".pull-tabs button")[2]?.click();
    await settle();
    const checkForm = mounted.root.querySelector<HTMLFormElement>(".checks-panel form");
    if (!checkForm) throw new Error("CI check form was not rendered.");
    const checkInputs = checkForm.querySelectorAll<HTMLElement>("input");
    fill(checkInputs[0], "integration");
    fill(checkInputs[1], "head-current-oid");
    fill(control(checkForm, "textarea"), "All integration tests passed");
    submit(checkForm);
    await settle();
    expect(createCheckSpy).toHaveBeenCalledWith("repo-1", 12, {
      name: "integration",
      commitOid: "head-current-oid",
      status: "completed",
      conclusion: "success",
      summary: "All integration tests passed",
    });
    expect(mounted.root.textContent).toContain("All integration tests passed");
    expect(mounted.root.textContent).toContain("Check is for an older commit");

    mounted.root.querySelectorAll<HTMLElement>(".pull-tabs button")[1]?.click();
    await settle();
    expect(mounted.root.querySelector(".pull-review")).not.toBeNull();
    expect(mounted.root.querySelector(".checks-panel")).toBeNull();
    const mergeSelect = control(mounted.root, ".merge-actions select");
    expect([...mergeSelect.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "merge",
      "squash",
      "rebase",
    ]);
    fill(mergeSelect, "squash");
    findButton(mounted.root, "Merge pull request").click();
    await settle();
    expect(mergePullSpy).toHaveBeenCalledWith("repo-1", 12, {
      expectedBaseOid: "base-current-oid",
      expectedHeadOid: "head-current-oid",
      method: "squash",
    });
    expect(mounted.root.textContent).toContain("Merge commit merged-c");
    expect(mounted.root.querySelector(".merge-actions")).toBeNull();
    mounted.unmount();
  });

  it("reloads the diff after a stale merge and maps merge policy codes", async () => {
    const openPull = pull();
    const diffs: GitComparison[] = [
      {
        baseOid: "base-old-oid",
        headOid: "head-old-oid",
        mergeBaseOid: "merge-base-oid",
        commits: [],
        files: [],
        truncated: false,
      },
      {
        baseOid: "base-new-oid",
        headOid: "head-new-oid",
        mergeBaseOid: "merge-base-oid",
        commits: [],
        files: [],
        truncated: false,
      },
    ];
    vi.spyOn(api, "pull").mockResolvedValue(openPull);
    vi.spyOn(api, "comments").mockResolvedValue({ items: [], truncated: false });
    vi.spyOn(api, "reviews").mockResolvedValue([]);
    vi.spyOn(api, "checks").mockResolvedValue([]);
    const diffSpy = vi
      .spyOn(api, "pullDiff")
      .mockImplementation(async () => diffs[Math.min(diffSpy.mock.calls.length - 1, 1)]);
    const mergeSpy = vi
      .spyOn(api, "mergePull")
      .mockRejectedValueOnce(
        new ApiError(409, "Git refs changed; reload before retrying.", "conflict")
      )
      .mockRejectedValueOnce(new ApiError(409, "Needs approvals.", "approvals_required"));
    const mounted = await mountSection("/_verify/pulls/12", "pulls");
    mounted.root.querySelectorAll<HTMLElement>(".pull-tabs button")[1]?.click();
    await settle();

    findButton(mounted.root, "Merge pull request").click();
    await settle();
    expect(diffSpy.mock.calls.length).toBeGreaterThan(1);
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "The pull request or branches changed."
    );

    findButton(mounted.root, "Merge pull request").click();
    await settle();
    expect(mergeSpy).toHaveBeenLastCalledWith("repo-1", 12, {
      expectedBaseOid: "base-new-oid",
      expectedHeadOid: "head-new-oid",
      method: "merge",
    });
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "needs more human approvals"
    );
    mounted.unmount();
  });

  it("marks a discussion comment as the accepted answer", async () => {
    const answer = comment({ id: "answer-9", body: "Use the stable branch API." });
    let current = discussion();
    vi.spyOn(api, "discussion").mockImplementation(async () => current);
    vi.spyOn(api, "comments").mockResolvedValue({ items: [answer], truncated: false });
    const updateDiscussionSpy = vi
      .spyOn(api, "updateDiscussion")
      .mockImplementation(async (_id, _number, patch) => {
        current = discussion({ ...current, ...patch });
        return current;
      });
    const mounted = await mountSection("/_verify/discussions/4", "discussions");

    expect(mounted.root.textContent).toContain("How does this work?");
    findButton(mounted.root, "Mark as answer").click();
    await settle();

    expect(updateDiscussionSpy).toHaveBeenCalledWith("repo-1", 4, { answerCommentId: "answer-9" });
    expect(mounted.root.querySelector(".answer-panel")?.textContent).toContain(
      "Use the stable branch API."
    );
    mounted.root
      .querySelectorAll<HTMLButtonElement>(".comment-row .fluent-button")
      .item(2)
      ?.click();
    await settle();
    expect(updateDiscussionSpy).toHaveBeenLastCalledWith("repo-1", 4, { answerCommentId: null });
    expect(mounted.root.querySelector(".answer-panel")).toBeNull();
    mounted.unmount();
  });

  it("recovers from a wiki revision conflict, saves against the refreshed revision, and restores history", async () => {
    const original = page({ revision: 1, title: "Guide v1", content: "Original docs" });
    let current = page({ revision: 2 });
    let history = [original, current];
    let updates = 0;
    vi.spyOn(api, "wikiPage").mockImplementation(async () => current);
    vi.spyOn(api, "wikiHistory").mockImplementation(async () => ({
      items: history,
      truncated: false,
    }));
    vi.spyOn(api, "wiki").mockResolvedValue({ items: [current], truncated: false });
    vi.spyOn(api, "wikiRevision").mockImplementation(async (_id, _slug, revision) => {
      const found = history.find((entry) => entry.revision === revision);
      if (!found) throw new ApiError(404, "Wiki revision was not found");
      return found;
    });
    const updateWikiSpy = vi
      .spyOn(api, "updateWikiPage")
      .mockImplementation(async (_id, _slug, patch) => {
        updates += 1;
        if (updates === 1) {
          current = page({
            revision: 3,
            title: "Guide updated elsewhere",
            content: "Remote latest",
          });
          history = [...history, current];
          throw new ApiError(409, "Wiki page revision has changed.", "conflict");
        }
        current = page({
          revision: updates + 2,
          title: patch.title,
          content: patch.content,
          updatedAt: 30 + updates,
        });
        history = [...history, current];
        return current;
      });
    const restoreSpy = vi
      .spyOn(api, "restoreWikiRevision")
      .mockImplementation(async (_id, _slug, revision) => {
        const found = history.find((entry) => entry.revision === revision);
        if (!found) throw new ApiError(404, "Wiki revision was not found");
        current = page({ ...found, revision: history.length + 1 });
        history = [...history, current];
        return current;
      });
    const mounted = await mountSection("/_verify/wiki/guide", "wiki");

    findButton(mounted.root, "Edit").click();
    await settle();
    const wikiEdit = mounted.root.querySelector<HTMLFormElement>(".wiki-edit-actions form");
    if (!wikiEdit) throw new Error("Wiki editor did not open.");
    fill(control(wikiEdit, "textarea"), "Draft based on stale page");
    submit(wikiEdit);
    await settle();
    const wikiAlert = mounted.root.querySelector('[role="alert"]')?.textContent ?? "";
    expect(wikiAlert).toContain("The content changed. Refresh and try again.");
    expect(wikiAlert).not.toContain("pull request");
    expect(wikiAlert).not.toContain("Wiki page revision");

    findButton(mounted.root, "Reload latest").click();
    await settle();
    expect(mounted.root.querySelector(".detail-titlebar h2")?.textContent).toContain(
      "Guide updated elsewhere"
    );

    findButton(mounted.root, "Edit").click();
    await settle();
    const retryEditor = mounted.root.querySelector<HTMLFormElement>(".wiki-edit-actions form");
    if (!retryEditor)
      throw new Error("Wiki editor did not reopen after reloading the latest revision.");
    fill(control(retryEditor, "textarea"), "Saved against latest revision");
    submit(retryEditor);
    await settle();
    expect(updateWikiSpy).toHaveBeenNthCalledWith(2, "repo-1", "guide", {
      title: "Guide updated elsewhere",
      content: "Saved against latest revision",
      expectedRevision: 3,
    });
    expect(mounted.root.querySelector(".body-content")?.textContent).toContain(
      "Saved against latest revision"
    );

    const firstHistoryRow = mounted.root.querySelector<HTMLElement>(".wiki-history .item-row");
    if (!firstHistoryRow) throw new Error("Wiki revision history was not rendered.");
    expect(restoreSpy).not.toHaveBeenCalled();
    findButton(firstHistoryRow, "Restore revision").click();
    await settle();
    expect(restoreSpy).toHaveBeenCalledWith("repo-1", "guide", 1, 4);
    expect(mounted.root.querySelector(".body-content")?.textContent).toContain("Original docs");
    expect(mounted.root.querySelector(".detail-state-row .badge")?.textContent).toContain("r5");
    mounted.unmount();
  });
  it("keeps PR creation available when repository agents are disabled", async () => {
    const sessions = vi.spyOn(api, "repositorySessions");
    vi.spyOn(api, "pulls").mockResolvedValue({ items: [], truncated: false });
    repository.agentsEnabled = false;
    try {
      const mounted = await mountSection("/_verify/pulls", "pulls");
      findButton(mounted.root, "New pull request").click();
      await settle();
      expect(sessions).not.toHaveBeenCalled();
      expect(mounted.root.querySelector(".create-form")).not.toBeNull();
      expect(mounted.root.querySelector(".create-form")?.textContent).not.toContain("Session fork");
    } finally {
      repository.agentsEnabled = true;
    }
  });
  it("refreshes late CI results without reloading the PR draft", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const pullSpy = vi.spyOn(api, "pull").mockResolvedValue(pull());
    vi.spyOn(api, "comments").mockResolvedValue({ items: [], truncated: false });
    vi.spyOn(api, "reviews").mockResolvedValue([]);
    vi.spyOn(api, "pullDiff").mockResolvedValue({
      baseOid: "a".repeat(40),
      headOid: "b".repeat(40),
      mergeBaseOid: "a".repeat(40),
      commits: [],
      files: [],
      truncated: false,
    });
    const check: CheckRun = {
      id: "ci",
      name: "verify",
      commitOid: "b".repeat(40),
      status: "completed",
      conclusion: "success",
      summary: "Live result",
      detailsUrl: null,
      actor: { kind: "ci", id: "gitedge-actions", name: "GitEdge Actions" },
      createdAt: 1,
      updatedAt: 2,
    };
    const checks = vi.spyOn(api, "checks").mockResolvedValueOnce([]).mockResolvedValue([check]);
    const mounted = await mountSection("/_verify/pulls/12", "pulls");
    mounted.root.querySelectorAll<HTMLElement>(".pull-tabs button")[2]?.click();
    await new Promise((resolve) => setTimeout(resolve, 5100));
    await settle();
    expect(checks.mock.calls.length).toBeGreaterThan(1);
    expect(pullSpy).toHaveBeenCalledTimes(1);
    expect(mounted.root.textContent).toContain("Live result");
    expect(mounted.root.textContent).toContain("Completed");
  }, 10000);
  it("applies repository issue templates only to empty draft fields", async () => {
    vi.spyOn(api, "issues").mockResolvedValue({ items: [], truncated: false });
    vi.mocked(api.repositoryCommunity).mockResolvedValue({
      files: [],
      pullRequestTemplate: null,
      truncated: false,
      issueTemplates: [
        {
          kind: "issue_template",
          title: "Bug report",
          repositoryId: "defaults",
          owner: "acme",
          repository: ".github",
          ref: "main",
          path: ".github/ISSUE_TEMPLATE/bug.md",
          inherited: true,
          truncated: false,
          content: "---\nname: Bug report\ntitle: Bug\n---\n## Reproduce\n",
        },
      ],
    });
    const mounted = await mountSection("/_verify/issues", "issues");
    findButton(mounted.root, "New issue").click();
    await settle();
    const form = mounted.root.querySelector<HTMLFormElement>(".create-form");
    if (!form) throw new Error("Missing creation form");
    const title = control(form, "input"),
      body = control(form, "textarea");
    fill(title, "Existing title");
    fill(body, "Existing body");
    findButton(mounted.root, "Use template").click();
    await settle();
    expect(Reflect.get(title, "value")).toBe("Existing title");
    expect(Reflect.get(body, "value")).toBe("Existing body");
    fill(title, "");
    fill(body, "");
    findButton(mounted.root, "Use template").click();
    await settle();
    expect(Reflect.get(title, "value")).toBe("Bug");
    expect(Reflect.get(body, "value")).toBe("## Reproduce\n");
  });
});

describe("RepositoryCollaboration action errors, ownership and review aids", () => {
  const other: Actor = { kind: "user", id: "user-2", name: "Other User" };
  function detailMocks(opts: { item?: Issue; comments?: Comment[] } = {}) {
    vi.spyOn(api, "issue").mockResolvedValue(opts.item ?? issue());
    vi.spyOn(api, "comments").mockResolvedValue({
      items: opts.comments ?? [],
      truncated: false,
    });
  }

  it("keeps the issue visible and shows an inline alert when a comment fails", async () => {
    detailMocks();
    vi.spyOn(api, "createComment").mockRejectedValue(new ApiError(500, "boom"));
    const mounted = await mountSection("/_verify/issues/7", "issues");
    fill(control(mounted.root, ".comments-panel textarea"), "hello");
    submit(control(mounted.root, ".comments-panel form") as HTMLFormElement);
    await settle();
    expect(mounted.root.querySelector(".detail-titlebar h2")?.textContent).toContain(
      "Initial issue"
    );
    expect(mounted.root.querySelector('[role="alert"], .fluent-notice')).not.toBeNull();
    expect(mounted.root.textContent).not.toContain("Retry");
    mounted.unmount();
  });

  it("lets a non-member author edit and delete only their own comment and issue", async () => {
    repository.canWrite = false;
    try {
      detailMocks({
        item: issue({ actor: human }),
        comments: [
          comment({ id: "mine", actor: human }),
          comment({ id: "theirs", actor: other, body: "Not mine" }),
        ],
      });
      const mounted = await mountSection("/_verify/issues/7", "issues");
      const rows = mounted.root.querySelectorAll<HTMLElement>(".comment-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain("Edit");
      expect(rows[0]?.textContent).toContain("Delete");
      expect(rows[1]?.textContent).not.toContain("Edit");
      expect(rows[1]?.textContent).not.toContain("Delete");
      const update = vi.spyOn(api, "updateIssue").mockResolvedValue(issue());
      findButton(mounted.root, "Close").click();
      await settle();
      expect(update).toHaveBeenNthCalledWith(1, "repo-1", 7, { state: "closed" });
      findButton(mounted.root, "Edit").click();
      await settle();
      const editForm = control(mounted.root, ".item-edit") as HTMLFormElement;
      expect(editForm.textContent).not.toContain("Labels");
      submit(editForm);
      await settle();
      expect(update).toHaveBeenCalledTimes(2);
      expect(Object.keys(update.mock.calls[1]?.[2] ?? {})).not.toContain("labels");
      mounted.unmount();

      for (const restriction of ["private", "archived"] as const) {
        const previous = { visibility: repository.visibility, archived: repository.archived };
        if (restriction === "private") repository.visibility = "private";
        else repository.archived = true;
        try {
          detailMocks({ item: issue({ actor: human }), comments: [comment({ actor: human })] });
          const restricted = await mountSection("/_verify/issues/7", "issues");
          expect(restricted.root.querySelector(".detail-actions")).toBeNull();
          if (restriction === "archived") {
            const row = restricted.root.querySelector<HTMLElement>(".comment-row");
            expect(row?.textContent).not.toContain("Edit");
            expect(row?.textContent).not.toContain("Delete");
          }
          restricted.unmount();
        } finally {
          repository.visibility = previous.visibility;
          repository.archived = previous.archived;
        }
      }

      detailMocks({ item: issue({ actor: other }) });
      const foreign = await mountSection("/_verify/issues/7", "issues");
      expect(foreign.root.querySelector(".detail-actions")).toBeNull();
      foreign.unmount();
    } finally {
      repository.canWrite = true;
    }
  });

  it("warns about truncated pull request diffs and labels omitted patches", async () => {
    vi.spyOn(api, "pull").mockResolvedValue(pull());
    vi.spyOn(api, "comments").mockResolvedValue({ items: [], truncated: false });
    vi.spyOn(api, "reviews").mockResolvedValue([]);
    vi.spyOn(api, "checks").mockResolvedValue([]);
    vi.spyOn(api, "pullDiff").mockResolvedValue({
      baseOid: "a".repeat(40),
      headOid: "b".repeat(40),
      mergeBaseOid: null,
      commits: [],
      truncated: true,
      files: [
        {
          path: "big.txt",
          type: "modified",
          oldOid: "c".repeat(40),
          newOid: "d".repeat(40),
          binary: false,
          patch: null,
        },
        {
          path: "logo.png",
          type: "added",
          oldOid: null,
          newOid: "e".repeat(40),
          binary: true,
          patch: null,
        },
      ],
    } satisfies GitComparison);
    const mounted = await mountSection("/_verify/pulls/12", "pulls");
    const tabs = mounted.root.querySelectorAll<HTMLElement>(".pull-tabs button");
    tabs[1]?.click();
    await settle();
    const text = mounted.root.querySelector(".pull-review")?.textContent ?? "";
    expect(text).toContain("This comparison is too large");
    expect(text).toContain("Diff omitted because the comparison exceeded");
    expect(text).toContain("Binary files do not have a text preview");
    mounted.unmount();
  });

  it("creates a pull request from branch selects with the draft option", async () => {
    vi.spyOn(api, "pulls").mockResolvedValue({ items: [], truncated: false });
    vi.spyOn(api, "repositorySessions").mockResolvedValue([]);
    vi.spyOn(api, "repositoryBranches").mockResolvedValue([
      { name: "main", oid: "1", protected: false, rules: [], isDefault: true },
      { name: "feature", oid: "2", protected: false, rules: [], isDefault: false },
    ]);
    const create = vi.spyOn(api, "createPullRequest").mockResolvedValue(pull());
    vi.spyOn(api, "pull").mockResolvedValue(pull());
    const mounted = await mountSection("/_verify/pulls", "pulls");
    findButton(mounted.root, "New pull request").click();
    await settle();
    const form = control(mounted.root, ".create-form") as HTMLFormElement;
    const selects = form.querySelectorAll<HTMLSelectElement>("select");
    expect(Array.from(selects[0]?.options ?? []).map((option) => option.value)).toContain(
      "feature"
    );
    fill(control(form, 'input[type="text"], input:not([type])'), "Title");
    fill(selects[0] as HTMLElement, "feature");
    const draft = form.querySelector<HTMLInputElement>("#create-draft");
    expect(draft).not.toBeNull();
    draft?.click();
    submit(form);
    await settle();
    expect(create).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ headRef: "feature", baseRef: "main", draft: true })
    );
    mounted.unmount();
  });

  it("shows a historical wiki revision with a diff against the current page", async () => {
    const current = page({ revision: 2, content: "New line" });
    vi.spyOn(api, "wikiPage").mockResolvedValue(current);
    vi.spyOn(api, "wiki").mockResolvedValue({ items: [current], truncated: false });
    vi.spyOn(api, "wikiHistory").mockResolvedValue({
      items: [page({ revision: 1 }), current],
      truncated: false,
    });
    const revision = vi
      .spyOn(api, "wikiRevision")
      .mockResolvedValue(page({ revision: 1, content: "Old line" }));
    const mounted = await mountSection("/_verify/wiki/guide", "wiki");
    findButton(mounted.root, "View revision").click();
    await settle();
    expect(revision).toHaveBeenCalledWith("repo-1", "guide", 1);
    const view = mounted.root.querySelector(".wiki-revision-view");
    expect(view?.textContent).toContain("Old line");
    expect(view?.querySelector(".diff-deletion")?.textContent).toContain("Old line");
    expect(view?.querySelector(".diff-addition")?.textContent).toContain("New line");
    expect(view?.querySelector("table th")).not.toBeNull();
    mounted.unmount();
  });

  it("shows a no-changes message when a revision matches the current content", async () => {
    const current = page({ revision: 2, content: "Same" });
    vi.spyOn(api, "wikiPage").mockResolvedValue(current);
    vi.spyOn(api, "wiki").mockResolvedValue({ items: [current], truncated: false });
    vi.spyOn(api, "wikiHistory").mockResolvedValue({
      items: [page({ revision: 1, content: "Same" }), current],
      truncated: false,
    });
    vi.spyOn(api, "wikiRevision").mockResolvedValue(page({ revision: 1, content: "Same" }));
    const mounted = await mountSection("/_verify/wiki/guide", "wiki");
    findButton(mounted.root, "View revision").click();
    await settle();
    const view = mounted.root.querySelector(".wiki-revision-view");
    expect(view?.textContent).toContain("same content as the current page");
    expect(view?.querySelector("table")).toBeNull();
    expect(view?.querySelector("pre")).toBeNull();
    mounted.unmount();
  });

  it("opens and prefills the pull request form from query parameters", async () => {
    vi.spyOn(api, "pulls").mockResolvedValue({ items: [], truncated: false });
    vi.spyOn(api, "repositorySessions").mockResolvedValue([]);
    vi.spyOn(api, "repositoryBranches").mockResolvedValue([
      { name: "main", oid: "1", protected: false, rules: [], isDefault: true },
      { name: "feature", oid: "2", protected: false, rules: [], isDefault: false },
    ]);
    const mounted = await mountSection("/_verify/pulls?new=1&base=main&head=feature", "pulls");
    const form = control(mounted.root, ".create-form") as HTMLFormElement;
    const selects = form.querySelectorAll<HTMLSelectElement>("select");
    expect(selects[0]?.value).toBe("feature");
    expect(selects[1]?.value).toBe("main");
    mounted.unmount();
  });
});

function reviewComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "rc-1",
    inReplyTo: null,
    reviewId: null,
    commitOid: "head-current-oid",
    path: "src/a.ts",
    side: "RIGHT",
    line: 2,
    startLine: null,
    diffHunk: "@@ -1,2 +1,3 @@\n keep\n+new",
    body: "Rename this",
    actor: human,
    pending: false,
    outdated: false,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: 20,
    updatedAt: 20,
    ...overrides,
  };
}

describe("RepositoryCollaboration review threads", () => {
  const comparison: GitComparison = {
    baseOid: "base-current-oid",
    headOid: "head-current-oid",
    mergeBaseOid: "merge-base-oid",
    commits: [],
    files: [
      {
        path: "src/a.ts",
        type: "modified",
        oldOid: "1",
        newOid: "2",
        binary: false,
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+added\n",
      },
    ],
    truncated: false,
  };

  function mockPull(threads: ReviewComment[]) {
    vi.spyOn(api, "pull").mockResolvedValue(pull());
    vi.spyOn(api, "comments").mockResolvedValue({ items: [], truncated: false });
    vi.spyOn(api, "reviews").mockResolvedValue([]);
    vi.spyOn(api, "checks").mockResolvedValue([]);
    vi.spyOn(api, "pullDiff").mockResolvedValue(comparison);
    return vi.spyOn(api, "reviewComments").mockResolvedValue({ items: threads, truncated: false });
  }

  async function openFiles(mounted: Awaited<ReturnType<typeof mountSection>>) {
    mounted.root.querySelectorAll<HTMLElement>(".pull-tabs button")[1]?.click();
    await settle();
  }

  it("starts a pending review from a line gutter and keeps the thread keyboard reachable", async () => {
    mockPull([]);
    const createSpy = vi.spyOn(api, "createReviewThread").mockResolvedValue(reviewComment());
    const mounted = await mountSection("/_verify/pulls/12", "pulls");
    await openFiles(mounted);

    const gutter = mounted.root.querySelectorAll<HTMLButtonElement>(".diff-comment-button");
    expect([...gutter].map((button) => button.getAttribute("aria-label"))).toEqual([
      "Add a comment on line 1",
      "Add a comment on line 2",
      "Add a comment on line 2",
      "Add a comment on line 3",
    ]);
    expect(gutter[0]?.localName).toBe("button");
    gutter[3]?.click();
    await settle();
    const composer = mounted.root.querySelector<HTMLFormElement>(".review-composer");
    if (!composer) throw new Error("Composer did not open.");
    fill(control(composer, "textarea"), "Please document this");
    await settle();
    findButton(composer, "Start a review").click();
    await settle();
    expect(createSpy).toHaveBeenCalledWith(
      "repo-1",
      12,
      "head-current-oid",
      expect.objectContaining({
        body: "Please document this",
        path: "src/a.ts",
        side: "RIGHT",
        line: 3,
        pending: true,
      })
    );
    expect(mounted.root.querySelector(".review-composer")).toBeNull();
    mounted.unmount();
  });

  it("selects a line range with shift and posts a single comment immediately", async () => {
    mockPull([]);
    const createSpy = vi.spyOn(api, "createReviewThread").mockResolvedValue(reviewComment());
    const mounted = await mountSection("/_verify/pulls/12", "pulls");
    await openFiles(mounted);

    const gutter = mounted.root.querySelectorAll<HTMLButtonElement>(".diff-comment-button");
    gutter[2]?.click();
    await settle();
    gutter[3]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await settle();
    const composer = mounted.root.querySelector<HTMLFormElement>(".review-composer");
    if (!composer) throw new Error("Composer did not open.");
    expect(composer.textContent).toContain("Comment on lines 2-3");
    fill(control(composer, "textarea"), "Both lines");
    submit(composer);
    await settle();
    expect(createSpy).toHaveBeenCalledWith(
      "repo-1",
      12,
      "head-current-oid",
      expect.objectContaining({
        startLine: 2,
        line: 3,
        pending: false,
        diffHunk: "@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+added",
      })
    );
    mounted.unmount();
  });

  it("extends a range from the keyboard and keeps the draft when posting fails", async () => {
    mockPull([]);
    const createSpy = vi
      .spyOn(api, "createReviewThread")
      .mockRejectedValueOnce(
        new ApiError(409, "The commit is no longer the pull request head.", "stale_commit")
      );
    const mounted = await mountSection("/_verify/pulls/12", "pulls");
    await openFiles(mounted);

    const gutter = mounted.root.querySelectorAll<HTMLButtonElement>(".diff-comment-button");
    gutter[0]?.click();
    await settle();
    gutter[3]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })
    );
    await settle();
    const composer = mounted.root.querySelector<HTMLFormElement>(".review-composer");
    if (!composer) throw new Error("Composer did not open.");
    expect(composer.textContent).toContain("Comment on lines 1-3");
    fill(control(composer, "textarea"), "Keep me");
    submit(composer);
    await settle();
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(mounted.root.querySelector(".review-composer textarea")).toHaveProperty(
      "value",
      "Keep me"
    );
    expect(mounted.root.textContent).toContain("The content changed. Refresh and try again.");
    mounted.unmount();
  });

  it("renders threads inline, lists unresolved ones, and marks outdated threads away from the diff", async () => {
    const reloaded = mockPull([
      reviewComment(),
      reviewComment({ id: "rc-2", inReplyTo: "rc-1", body: "Done in a follow-up", createdAt: 21 }),
      reviewComment({ id: "rc-3", line: 1, outdated: true, body: "Old context", createdAt: 22 }),
      reviewComment({
        id: "rc-4",
        line: 3,
        body: "Settled",
        resolvedAt: 30,
        resolvedBy: human,
        createdAt: 23,
      }),
    ]);
    const resolveSpy = vi
      .spyOn(api, "setReviewThreadResolved")
      .mockResolvedValue(reviewComment({ resolvedAt: 40, resolvedBy: human }));
    const mounted = await mountSection("/_verify/pulls/12", "pulls");
    await openFiles(mounted);

    const summary = mounted.root.querySelector(".thread-summary");
    expect(summary?.textContent).toContain("Unresolved conversations: 2");
    expect(mounted.root.querySelector(".merge-status")?.textContent).toContain(
      "Unresolved review conversations: 2"
    );
    expect(summary?.textContent).toContain("Outdated");
    const inline = mounted.root.querySelectorAll(".diff-thread .review-thread");
    expect(inline).toHaveLength(2);
    expect(inline[0]?.textContent).toContain("Rename this");
    expect(inline[0]?.textContent).toContain("Done in a follow-up");
    expect(mounted.root.querySelector(".diff-thread")?.textContent).not.toContain("Old context");
    const settled = inline[1];
    expect(settled?.textContent).toContain("Resolved");
    expect(settled?.textContent).not.toContain("Settled");

    findButton(inline[0] as HTMLElement, "Resolve conversation").click();
    await settle();
    expect(resolveSpy).toHaveBeenCalledWith("repo-1", 12, "rc-1", true);
    expect(reloaded.mock.calls.length).toBeGreaterThan(1);

    mounted.root.querySelectorAll<HTMLElement>(".pull-tabs button")[0]?.click();
    await settle();
    const conversation = mounted.root.querySelector(".review-threads-panel");
    expect(conversation?.textContent).toContain("Old context");
    expect(conversation?.textContent).toContain("Outdated");
    expect(conversation?.textContent).toContain("@@ -1,2 +1,3 @@");
    mounted.unmount();
  });

  it("offers to finish a pending review and reports unresolved threads next to the merge controls", async () => {
    mockPull([reviewComment({ pending: true })]);
    const mounted = await mountSection("/_verify/pulls/12", "pulls");
    await openFiles(mounted);

    expect(mounted.root.querySelector(".pending-review")?.textContent).toContain(
      "Pending comments: 1."
    );
    expect(mounted.root.querySelector(".merge-status")?.textContent).toContain(
      "All review conversations are resolved"
    );
    findButton(mounted.root, "Finish your review").click();
    await settle();
    expect(mounted.root.querySelector(".review-panel")?.textContent).toContain(
      "Pending comments published with this review: 1"
    );
    mounted.unmount();
  });

  it("lists linked pull requests and the closing event on an issue", async () => {
    vi.spyOn(api, "issue").mockResolvedValue(issue({ state: "closed" }));
    vi.spyOn(api, "comments").mockResolvedValue({
      items: [comment({ id: "late", body: "Thanks for the fix", createdAt: 500 })],
      truncated: false,
    });
    vi.spyOn(api, "issueReferences").mockResolvedValue({
      pullRequests: [{ number: 12, title: "Update parser", state: "merged", closes: true }],
      events: [
        {
          id: "event-1",
          kind: "closed_by_pull_request",
          pullRequestNumber: 12,
          actor: human,
          createdAt: 100,
        },
      ],
      truncated: false,
    });
    const mounted = await mountSection("/_verify/issues/7", "issues");
    const sidebar = mounted.root.querySelector(".detail-sidebar");
    expect(sidebar?.textContent).toContain("Linked pull requests");
    expect(sidebar?.textContent).toContain("#12 Update parser");
    expect(sidebar?.textContent).toContain("Closes this issue");
    const text = mounted.root.querySelector(".timeline")?.textContent ?? "";
    expect(text).toContain("closed this issue through pull request #12");
    expect(text.indexOf("closed this issue")).toBeLessThan(text.indexOf("Thanks for the fix"));
    mounted.unmount();
  });
});
