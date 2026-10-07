import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, resolveComponent } from "vue";
import AccountProfilePanel from "../../apps/web/src/components/AccountProfilePanel.vue";
import BrowserSessions from "../../apps/web/src/components/BrowserSessions.vue";
import ConfirmButton from "../../apps/web/src/components/ConfirmButton.vue";
import RepositoryActions from "../../apps/web/src/components/RepositoryActions.vue";
import RepositoryCollaborators from "../../apps/web/src/components/RepositoryCollaborators.vue";
import RepositorySettings from "../../apps/web/src/components/RepositorySettings.vue";
import OrganizationView from "../../apps/web/src/pages/OrganizationView.vue";
import { i18n } from "../../apps/web/src/i18n";
import { api, type ActionRun } from "../../apps/web/src/lib/api";
import { router } from "../../apps/web/src/router";
import type { AccountProfile } from "../../packages/contracts/src/account";
import type { RepositorySettings as Settings } from "../../packages/contracts/src/tasks";
import {
  confirmClick,
  control,
  fill,
  findButton,
  mountAt,
  repository,
  settle,
  unmountAll,
} from "./task-support";

vi.mock("../../apps/web/src/components/AppIcon.vue", () => ({ default: { template: "<span />" } }));

beforeEach(() => {
  i18n.global.locale.value = "en";
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("inline confirmation", () => {
  it("makes no request until confirmed and restores the trigger on Escape", async () => {
    vi.spyOn(api, "browserSessions").mockResolvedValue([
      { id: "other", createdAt: 1, expiresAt: Date.now() + 100000, isCurrent: false },
    ]);
    const revoke = vi
      .spyOn(api, "revokeBrowserSession")
      .mockResolvedValue({ revoked: true, isCurrent: false });
    const mounted = await mountAt("/_verify/sessions", "/_verify/sessions", () =>
      h(BrowserSessions)
    );

    findButton(mounted.root, "Sign out session").click();
    await settle();
    expect(revoke).not.toHaveBeenCalled();
    const group = control(mounted.root, "[role='group']");
    expect(group.getAttribute("aria-label")).toContain("End this session");
    expect(document.activeElement?.textContent).toContain("Confirm");

    group.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(mounted.root.querySelector("[role='group']")).toBeNull();
    expect(document.activeElement?.textContent).toContain("Sign out session");
    expect(revoke).not.toHaveBeenCalled();

    await confirmClick(findButton(mounted.root, "Sign out session"));
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("emits one confirm event per confirmation", async () => {
    const onConfirm = vi.fn();
    const mounted = await mountAt("/_verify/confirm", "/_verify/confirm", () =>
      h(ConfirmButton, { label: "Remove", prompt: "Sure?", onConfirm })
    );
    await confirmClick(findButton(mounted.root, "Remove"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(mounted.root.querySelector("[role='group']")).toBeNull();
  });
});

describe("revocation warnings", () => {
  it("warns when removing a collaborator leaves agent sessions active", async () => {
    vi.spyOn(api, "repositoryCollaborators").mockResolvedValue([
      { id: "user-2", identifier: "octocat", role: "read", inherited: false },
    ]);
    vi.spyOn(api, "deleteRepositoryCollaborator").mockResolvedValue({
      deleted: true,
      revocationIncomplete: true,
    });
    const mounted = await mountAt("/_verify/collab-warning", "/_verify/collab-warning", () =>
      h(RepositoryCollaborators, { repositoryId: repository.id, canManage: true })
    );
    await confirmClick(findButton(mounted.root, "Remove"));
    expect(mounted.root.textContent).toContain("some agent sessions could not be revoked");
  });

  it("warns when disabling agents could not revoke every session", async () => {
    const settings: Settings = {
      name: repository.name,
      slug: repository.slug,
      description: repository.description,
      visibility: repository.visibility,
      defaultBranch: repository.defaultBranch,
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
      memoryVisibility: "members",
      agentAssignmentPolicy: "owner",
      canManage: true,
    };
    vi.spyOn(api, "repositorySettings").mockResolvedValue(settings);
    vi.spyOn(api, "refs").mockResolvedValue([]);
    vi.spyOn(api, "updateRepositorySettings").mockResolvedValue({
      ...settings,
      description: "changed",
      revocationIncomplete: true,
    });
    const mounted = await mountAt("/_verify/settings-warning", "/_verify/settings-warning", () =>
      h(RepositorySettings, { repository })
    );
    const description = control(mounted.root, "textarea");
    fill(description, "changed");
    await settle();
    findButton(mounted.root, "Save").click();
    await settle();
    expect(mounted.root.textContent).toContain("some agent sessions could not be revoked");
  });

  it("warns when removing an organization member leaves agent sessions active", async () => {
    vi.spyOn(api, "organization").mockResolvedValue({
      id: "org-1",
      slug: "acme",
      displayName: "Acme",
      description: "",
      role: "owner",
    });
    vi.spyOn(api, "organizationMembers").mockResolvedValue([
      { identifier: "alice", role: "owner" },
      { identifier: "bob", role: "member" },
    ]);
    const remove = vi.spyOn(api, "removeOrganizationMember").mockResolvedValue(true);
    const mounted = await mountAt("/organizations/:slug", "/organizations/acme", () =>
      h(OrganizationView)
    );
    const bobRow = Array.from(
      mounted.root.querySelectorAll<HTMLElement>(".organization-member-row")
    ).find((row) => row.textContent?.includes("bob"));
    await confirmClick(findButton(bobRow ?? mounted.root, "Remove member"));
    expect(remove).toHaveBeenCalledWith("acme", "bob");
    expect(mounted.root.textContent).toContain("some agent sessions could not be revoked");
  });
});

describe("OrganizationView loading", () => {
  it("clears the stale error after a successful retry", async () => {
    const organization = vi
      .spyOn(api, "organization")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        id: "org-1",
        slug: "acme",
        displayName: "Acme",
        description: "",
        role: "member",
      });
    vi.spyOn(api, "organizationMembers").mockResolvedValue([]);
    const mounted = await mountAt("/organizations/:slug", "/organizations/acme", () =>
      h(OrganizationView)
    );
    expect(mounted.root.querySelector(".organization-layout")).toBeNull();
    findButton(mounted.root, "Retry").click();
    await settle();
    expect(organization).toHaveBeenCalledTimes(2);
    expect(mounted.root.querySelector(".organization-layout")).not.toBeNull();
  });
});

describe("unsaved changes", () => {
  const profile: AccountProfile = {
    identifier: "workspace",
    displayName: "Maintainer",
    bio: "",
    location: "",
    website: "",
    preferences: {
      theme: "light",
      locale: "en",
      density: "comfortable",
      tabSize: 2,
      lineWrap: false,
    },
  };

  it("asks before leaving a dirty profile form and stays when declined", async () => {
    vi.spyOn(api, "accountProfile").mockResolvedValue(structuredClone(profile));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const mounted = await mountAt(
      "/_verify/profile",
      "/_verify/profile",
      () => h(resolveComponent("RouterView")),
      () => h(AccountProfilePanel, { section: "profile" })
    );
    fill(control(mounted.root, "input"), "renamed");
    await settle();

    await router.push("/dashboard").catch(() => undefined);
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(router.currentRoute.value.path).toBe("/_verify/profile");

    confirm.mockReturnValue(true);
    await router.push("/dashboard").catch(() => undefined);
    await settle();
    expect(router.currentRoute.value.path).toBe("/dashboard");
  });

  it("does not ask while the form is clean", async () => {
    vi.spyOn(api, "accountProfile").mockResolvedValue(structuredClone(profile));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await mountAt(
      "/_verify/profile-clean",
      "/_verify/profile-clean",
      () => h(resolveComponent("RouterView")),
      () => h(AccountProfilePanel, { section: "profile" })
    );
    await router.push("/dashboard").catch(() => undefined);
    await settle();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("Actions run state", () => {
  const workflow = {
    path: ".github/workflows/verify.yml",
    name: "Verify",
    triggers: ["workflow_dispatch", "push"] as Array<"workflow_dispatch" | "push">,
    supported: true,
    jobs: [],
  };
  function detail(id: string, status: ActionRun["status"]): ActionRun {
    return {
      id,
      repositoryId: "repo-1",
      commitOid: "a".repeat(40),
      workflowPath: workflow.path,
      workflowName: `Run ${id}`,
      ref: "refs/heads/main",
      createdBy: "user-1",
      createdAt: 10,
      startedAt: 11,
      status,
      conclusion: null,
      outputTruncated: false,
      jobs: [],
    };
  }
  function summary(id: string): Awaited<ReturnType<typeof api.actionRuns>>[number] {
    const { jobs: _jobs, repositoryId: _repositoryId, ...rest } = detail(id, "running");
    return rest;
  }

  it("keeps the detail of the run selected last when responses arrive out of order", async () => {
    vi.spyOn(api, "refs").mockResolvedValue([{ name: "refs/heads/main", oid: "a".repeat(40) }]);
    vi.spyOn(api, "actionWorkflows").mockResolvedValue({
      oid: "a".repeat(40),
      workflows: [workflow],
    });
    vi.spyOn(api, "actionRuns").mockResolvedValue([summary("run-a"), summary("run-b")]);
    const resolvers = new Map<string, (value: ActionRun) => void>();
    let initial = true;
    vi.spyOn(api, "actionRun").mockImplementation((id) => {
      if (initial) return Promise.resolve(detail(id, "running"));
      return new Promise((resolve) => resolvers.set(id, resolve));
    });
    const mounted = await mountAt("/_verify/actions-race", "/_verify/actions-race", () =>
      h(RepositoryActions, { repositoryId: "repo-1", defaultBranch: "main", canWrite: true })
    );
    initial = false;

    const buttons = Array.from(mounted.root.querySelectorAll<HTMLElement>(".actions-run-button"));
    buttons[0]?.click();
    buttons[1]?.click();
    await settle();
    resolvers.get("run-b")?.(detail("run-b", "running"));
    await settle();
    resolvers.get("run-a")?.(detail("run-a", "running"));
    await settle();

    expect(mounted.root.querySelector(".actions-run-detail h3")?.textContent).toBe("Run run-b");
  });

  it("lists supported syntax and each workflow's triggers", async () => {
    vi.spyOn(api, "refs").mockResolvedValue([{ name: "refs/heads/main", oid: "a".repeat(40) }]);
    vi.spyOn(api, "actionWorkflows").mockResolvedValue({
      oid: "a".repeat(40),
      workflows: [workflow],
    });
    vi.spyOn(api, "actionRuns").mockResolvedValue([]);
    const mounted = await mountAt("/_verify/actions-syntax", "/_verify/actions-syntax", () =>
      h(RepositoryActions, { repositoryId: "repo-1", defaultBranch: "main", canWrite: true })
    );
    const details = control(mounted.root, "details.actions-syntax");
    expect(details.textContent).toContain("workflow_dispatch");
    expect(details.textContent).toContain("6 runs per hour");
    expect(mounted.root.textContent).toContain("Triggers: workflow_dispatch, push");
    expect(mounted.root.querySelector("[aria-label='Workflows']")).not.toBeNull();
  });
});
