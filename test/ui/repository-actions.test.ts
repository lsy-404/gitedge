import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import RepositoryActions from "../../apps/web/src/components/RepositoryActions.vue";
import { i18n } from "../../apps/web/src/i18n";
import { api, type ActionRun } from "../../apps/web/src/lib/api";
import {
  confirmClick,
  control,
  fill,
  findButton,
  isDisabled,
  mountAt,
  settle,
  unmountAll,
} from "./task-support";

vi.mock("../../apps/web/src/components/AppIcon.vue", () => ({ default: { template: "<span />" } }));

const workflow = {
  path: ".github/workflows/verify.yml",
  name: "Verify",
  triggers: ["workflow_dispatch"] as Array<"workflow_dispatch" | "push">,
  supported: true,
  jobs: [],
};

function run(
  status: ActionRun["status"],
  conclusion: ActionRun["conclusion"],
  log: string
): ActionRun {
  return {
    id: "run-1",
    repositoryId: "repo-1",
    commitOid: "a".repeat(40),
    workflowPath: workflow.path,
    workflowName: workflow.name,
    ref: "refs/heads/main",
    createdBy: "user-1",
    createdAt: 10,
    startedAt: status === "queued" ? null : 11,
    status,
    conclusion,
    outputTruncated: false,
    jobs: [
      {
        id: "verify",
        name: "Verify",
        status,
        conclusion,
        steps: [
          {
            name: "Run checks",
            status,
            conclusion,
            exitCode: status === "completed" ? 0 : null,
            log,
            outputTruncated: false,
          },
        ],
      },
    ],
  };
}

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("RepositoryActions", () => {
  it("dispatches the exact listed commit, displays logs and cancels a live run", async () => {
    i18n.global.locale.value = "en";
    vi.spyOn(api, "refs").mockResolvedValue([{ name: "refs/heads/main", oid: "a".repeat(40) }]);
    vi.spyOn(api, "actionWorkflows").mockResolvedValue({
      oid: "a".repeat(40),
      workflows: [workflow],
    });
    vi.spyOn(api, "actionRuns").mockResolvedValue([]);
    vi.spyOn(api, "actionRun").mockResolvedValue(run("running", null, "still working"));
    const start = vi.spyOn(api, "startActionRun").mockResolvedValue({
      id: "run-1",
      commitOid: "a".repeat(40),
      workflowPath: workflow.path,
      workflowName: workflow.name,
      ref: "refs/heads/main",
      createdBy: "user-1",
      createdAt: 10,
      status: "queued",
      conclusion: null,
    });
    const cancel = vi
      .spyOn(api, "cancelActionRun")
      .mockResolvedValue(run("completed", "cancelled", "process stopped"));
    const mounted = await mountAt("/_verify/actions", "/_verify/actions", () =>
      h(RepositoryActions, { repositoryId: "repo-1", defaultBranch: "main", canWrite: true })
    );

    findButton(mounted.root, "Run workflow").click();
    await settle();

    expect(start).toHaveBeenCalledWith("repo-1", {
      workflowPath: workflow.path,
      ref: "main",
      expectedOid: "a".repeat(40),
    });
    expect(api.actionWorkflows).toHaveBeenCalledWith("repo-1", "main", "a".repeat(40));
    expect(mounted.root.textContent).toContain("still working");
    await confirmClick(findButton(mounted.root, "Cancel run"));

    expect(cancel).toHaveBeenCalledWith("run-1");
    expect(mounted.root.textContent).toContain("process stopped");
    expect(mounted.root.textContent).toContain("Cancelled");
    mounted.unmount();
  });

  it("explains disabled network access and prevents dispatch from an archived repository", async () => {
    i18n.global.locale.value = "en";
    vi.spyOn(api, "refs").mockResolvedValue([{ name: "refs/heads/main", oid: "a".repeat(40) }]);
    vi.spyOn(api, "actionWorkflows").mockResolvedValue({
      oid: "a".repeat(40),
      workflows: [workflow],
    });
    vi.spyOn(api, "actionRuns").mockResolvedValue([]);
    const mounted = await mountAt("/_verify/actions-archived", "/_verify/actions-archived", () =>
      h(RepositoryActions, {
        repositoryId: "repo-1",
        defaultBranch: "main",
        canWrite: true,
        archived: true,
        actionsNetworkEnabled: false,
      })
    );

    expect(mounted.root.textContent).toContain("Actions network access is disabled");
    expect(isDisabled(findButton(mounted.root, "Run workflow"))).toBe(true);
    mounted.unmount();
  });

  it("shows workflow load errors alongside existing runs instead of an empty state", async () => {
    i18n.global.locale.value = "en";
    vi.spyOn(api, "refs").mockResolvedValue([{ name: "refs/heads/main", oid: "a".repeat(40) }]);
    vi.spyOn(api, "actionWorkflows").mockRejectedValue(new Error("snapshot failed"));
    vi.spyOn(api, "actionRuns").mockResolvedValue([
      {
        id: "run-1",
        commitOid: "a".repeat(40),
        workflowPath: workflow.path,
        workflowName: workflow.name,
        ref: "refs/heads/main",
        createdBy: "user-1",
        createdAt: 10,
        status: "completed",
        conclusion: "success",
      },
    ]);
    vi.spyOn(api, "actionRun").mockResolvedValue(run("completed", "success", "done"));
    const mounted = await mountAt("/_verify/actions-error", "/_verify/actions-error", () =>
      h(RepositoryActions, { repositoryId: "repo-1", defaultBranch: "main" })
    );

    expect(mounted.root.textContent).toContain("Unable to load Actions data.");
    expect(mounted.root.textContent).not.toContain("There are no workflow files");
    mounted.unmount();
  });

  it("discards stale workflow responses when refs change quickly", async () => {
    i18n.global.locale.value = "en";
    vi.spyOn(api, "refs").mockResolvedValue([
      { name: "HEAD", oid: "0".repeat(40) },
      { name: "refs/heads/main", oid: "a".repeat(40) },
      { name: "refs/heads/dev", oid: "b".repeat(40) },
      { name: "refs/tags/main", oid: "c".repeat(40), peeledOid: "d".repeat(40) },
    ]);
    let resolveDev!: (value: { oid: string; workflows: (typeof workflow)[] }) => void;
    vi.spyOn(api, "actionWorkflows").mockImplementation((_repositoryId, ref) => {
      if (ref === "dev") {
        return new Promise((resolve) => {
          resolveDev = resolve;
        });
      }
      return Promise.resolve({ oid: "a".repeat(40), workflows: [workflow] });
    });
    vi.spyOn(api, "actionRuns").mockResolvedValue([]);
    const mounted = await mountAt("/_verify/actions-refs", "/_verify/actions-refs", () =>
      h(RepositoryActions, { repositoryId: "repo-1", defaultBranch: "main", canWrite: true })
    );

    const refSelect = control(mounted.root, "select");
    expect(Array.from(refSelect.querySelectorAll("option")).map((option) => option.value)).toEqual([
      "",
      "main",
      "dev",
      "refs/tags/main",
    ]);
    fill(refSelect, "dev");
    await settle();
    expect(isDisabled(findButton(mounted.root, "Run workflow"))).toBe(true);
    fill(refSelect, "main");
    await settle();
    resolveDev({ oid: "b".repeat(40), workflows: [{ ...workflow, name: "Stale" }] });
    await settle();

    expect(mounted.root.textContent).toContain("Verify");
    expect(mounted.root.textContent).not.toContain("Stale");
    expect(api.actionWorkflows).toHaveBeenCalledWith("repo-1", "dev", "b".repeat(40));
    expect(api.actionWorkflows).toHaveBeenLastCalledWith("repo-1", "main", "a".repeat(40));
    fill(refSelect, "refs/tags/main");
    await settle();
    expect(api.actionWorkflows).toHaveBeenLastCalledWith(
      "repo-1",
      "refs/tags/main",
      "d".repeat(40)
    );
    mounted.unmount();
  });
});
