import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import RepositoryActions from "../../apps/web/src/components/RepositoryActions.vue";
import { i18n } from "../../apps/web/src/i18n";
import { api, type ActionRun } from "../../apps/web/src/lib/api";
import { findButton, isDisabled, mountAt, settle, unmountAll } from "./task-support";

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
      ref: "refs/heads/main",
      expectedOid: "a".repeat(40),
    });
    expect(mounted.root.textContent).toContain("still working");
    findButton(mounted.root, "Cancel run").click();
    await settle();

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
});
