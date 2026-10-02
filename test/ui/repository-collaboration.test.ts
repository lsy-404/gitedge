import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { i18n } from "../../apps/web/src/i18n";
import collaborationMessages from "../../apps/web/src/i18n/collaboration";
import { ApiError, api } from "../../apps/web/src/lib/api";
import { clearSession, setSession } from "../../apps/web/src/lib/session";
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
  artifactName: "acme/project",
  remote: "https://git.example/acme/project.git",
  description: "A test repository",
  visibility: "public",
  defaultBranch: "main",
  createdAt: 1,
  updatedAt: 2,
  canWrite: true,
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

/** Fluent controls are custom elements; without their definitions they are plain HTMLElements. */
function control(root: ParentNode, selector: string): HTMLElement {
  const field = root.querySelector<HTMLElement>(selector);
  if (!field) throw new Error(`Expected control: ${selector}`);
  return field;
}

function findButton(root: HTMLElement, text: string): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>("fluent-button")).find((button) =>
    button.textContent?.replace(/\s+/g, " ").includes(text)
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
    vi.spyOn(api, "issues").mockResolvedValue([
      issue({ number: 7, title: "Parser regression", labels: ["bug"] }),
      issue({
        id: "issue-2",
        number: 8,
        title: "Document setup",
        state: "closed",
        labels: ["docs"],
      }),
    ]);
    const mounted = await mountSection("/_verify/issues", "issues");

    expect(mounted.root.querySelectorAll(".item-link")).toHaveLength(1);
    expect(mounted.root.querySelectorAll(".filter-count")[0]?.textContent).toBe("1");
    expect(mounted.root.querySelectorAll(".filter-count")[1]?.textContent).toBe("1");

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
    vi.spyOn(api, "issues").mockResolvedValue([
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
    ]);
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

  it("creates an issue with labels, edits it, comments, and closes it", async () => {
    const initial = issue();
    let latest = initial;
    let comments: Comment[] = [];
    vi.spyOn(api, "repository").mockResolvedValue(repository);
    const issuesSpy = vi.spyOn(api, "issues").mockResolvedValue([]);
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
    const commentsSpy = vi.spyOn(api, "comments").mockImplementation(async () => comments);
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
    vi.spyOn(api, "comments").mockResolvedValue([]);
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
    findButton(mounted.root, "Merge pull request").click();
    await settle();
    expect(mergePullSpy).toHaveBeenCalledWith("repo-1", 12, {
      expectedBaseOid: "base-current-oid",
      expectedHeadOid: "head-current-oid",
    });
    expect(mounted.root.textContent).toContain("Merge commit merged-c");
    expect(mounted.root.querySelector(".merge-actions")).toBeNull();
    mounted.unmount();
  });

  it("marks a discussion comment as the accepted answer", async () => {
    const answer = comment({ id: "answer-9", body: "Use the stable branch API." });
    let current = discussion();
    vi.spyOn(api, "discussion").mockImplementation(async () => current);
    vi.spyOn(api, "comments").mockResolvedValue([answer]);
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
    mounted.root.querySelectorAll<HTMLElement>(".comment-row fluent-button").item(2)?.click();
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
    vi.spyOn(api, "wikiHistory").mockImplementation(async () => history);
    vi.spyOn(api, "wiki").mockResolvedValue([current]);
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
          throw new ApiError(409, "Wiki revision changed");
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
    const mounted = await mountSection("/_verify/wiki/guide", "wiki");

    findButton(mounted.root, "Edit").click();
    await settle();
    const wikiEdit = mounted.root.querySelector<HTMLFormElement>(".wiki-edit-actions form");
    if (!wikiEdit) throw new Error("Wiki editor did not open.");
    fill(control(wikiEdit, "textarea"), "Draft based on stale page");
    submit(wikiEdit);
    await settle();
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "Request failed. Try again later."
    );

    findButton(mounted.root, "Retry").click();
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
    firstHistoryRow.querySelector<HTMLElement>("fluent-button")?.click();
    await settle();
    expect(updateWikiSpy).toHaveBeenLastCalledWith("repo-1", "guide", {
      title: "Guide v1",
      content: "Original docs",
      expectedRevision: 4,
    });
    expect(mounted.root.querySelector(".body-content")?.textContent).toContain("Original docs");
    expect(mounted.root.querySelector(".detail-state-row .badge")?.textContent).toContain("r5");
    mounted.unmount();
  });
});
