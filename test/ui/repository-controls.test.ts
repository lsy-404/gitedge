import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import BranchProtectionSettings from "../../apps/web/src/components/BranchProtectionSettings.vue";
import RepositoryCollaborators from "../../apps/web/src/components/RepositoryCollaborators.vue";
import RepositorySettings from "../../apps/web/src/components/RepositorySettings.vue";
import DashboardView from "../../apps/web/src/pages/DashboardView.vue";
import { i18n } from "../../apps/web/src/i18n";
import { api } from "../../apps/web/src/lib/api";
import { router } from "../../apps/web/src/router";
import type {
  BranchProtectionRule,
  RepositoryCollaborator,
} from "../../packages/contracts/src/repository-controls";
import type { RepositorySettings as Settings } from "../../packages/contracts/src/tasks";
import {
  control,
  fill,
  findButton,
  mountAt,
  repository,
  settle,
  confirmClick,
  submit,
  unmountAll,
} from "./task-support";

const rule: BranchProtectionRule = {
  id: "rule-1",
  pattern: "main",
  enabled: true,
  locked: false,
  requiredApprovals: 1,
  requirePassingChecks: true,
  requiredStatusChecks: ["unit"],
  requireLinearHistory: false,
  requireSignedCommits: false,
  createdAt: 1,
  updatedAt: 2,
};
const collaborator: RepositoryCollaborator = {
  id: "user-2",
  identifier: "octocat",
  role: "read",
  inherited: false,
};
const repositorySettings: Settings = {
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

beforeEach(() => {
  i18n.global.locale.value = "en";
});

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "showPopover", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value() {},
  });
});

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("branch protection controls", () => {
  it("exposes branch protection and collaborators in the repository settings sidebar", async () => {
    vi.spyOn(api, "repositorySettings").mockResolvedValue(repositorySettings);
    vi.spyOn(api, "refs").mockResolvedValue([]);
    vi.spyOn(api, "branchRules").mockResolvedValue([]);
    vi.spyOn(api, "repositoryCollaborators").mockResolvedValue([]);
    const mounted = await mountAt("/_verify/settings-sidebar", "/_verify/settings-sidebar", () =>
      h(RepositorySettings, { repository })
    );
    Array.from(mounted.root.querySelectorAll<HTMLButtonElement>(".settings-nav button"))
      .find((button) => button.textContent?.trim() === "Branch protection")
      ?.click();
    await settle();
    expect(mounted.root.textContent).toContain(
      "Enabled rules require PRs and block native direct pushes and online edits."
    );
    Array.from(mounted.root.querySelectorAll<HTMLButtonElement>(".settings-nav button"))
      .find((button) => button.textContent?.trim() === "Collaborators")
      ?.click();
    await settle();
    expect(mounted.root.textContent).toContain("Grant users read, write, or admin access");
    mounted.unmount();
  });

  it("creates, edits, and removes rules through their actual controls", async () => {
    vi.spyOn(api, "branchRules").mockResolvedValue([structuredClone(rule)]);
    const update = vi.spyOn(api, "updateBranchRule").mockResolvedValue({
      ...rule,
      pattern: "release/*",
      requiredStatusChecks: ["build", "unit"],
    });
    const remove = vi.spyOn(api, "deleteBranchRule").mockResolvedValue();
    const mounted = await mountAt("/_verify/branch-controls", "/_verify/branch-controls", () =>
      h(BranchProtectionSettings, { repositoryId: repository.id, canManage: true })
    );

    findButton(mounted.root, "Edit").click();
    await settle();
    fill(control(mounted.root, ".branch-rule-form input"), "release/*");
    fill(control(mounted.root, ".branch-rule-form textarea"), "build\nunit");
    findButton(mounted.root, "Save rule").click();
    await settle();
    expect(update).toHaveBeenCalledWith(repository.id, rule.id, {
      pattern: "release/*",
      enabled: true,
      locked: false,
      requiredApprovals: 1,
      requirePassingChecks: true,
      requiredStatusChecks: ["build", "unit"],
      requireLinearHistory: false,
      requireSignedCommits: false,
    });

    await confirmClick(findButton(mounted.root, "Delete"));
    expect(remove).toHaveBeenCalledWith(repository.id, rule.id);
    expect(mounted.root.textContent).toContain("Branch protection rule deleted.");
    mounted.unmount();
  });

  it("validates rule patterns and reports read and write failures", async () => {
    vi.spyOn(api, "branchRules")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([]);
    const create = vi.spyOn(api, "createBranchRule").mockRejectedValue(new Error("invalid"));
    const mounted = await mountAt("/_verify/branch-errors", "/_verify/branch-errors", () =>
      h(BranchProtectionSettings, { repositoryId: repository.id, canManage: true })
    );
    expect(mounted.root.textContent).toContain("Could not load branch protection rules.");
    findButton(mounted.root, "Retry").click();
    await settle();
    fill(control(mounted.root, ".branch-rule-form input"), "../invalid");
    findButton(mounted.root, "Add rule").click();
    await settle();
    expect(create).not.toHaveBeenCalled();
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not save the branch rule"
    );
    fill(control(mounted.root, ".branch-rule-form input"), "main");
    findButton(mounted.root, "Add rule").click();
    await settle();
    expect(create).toHaveBeenCalled();
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not save the branch rule"
    );
    mounted.unmount();
  });
});

describe("repository collaborator controls", () => {
  it("adds, changes, and removes direct collaborator permissions", async () => {
    vi.spyOn(api, "repositoryCollaborators").mockResolvedValue([structuredClone(collaborator)]);
    const put = vi
      .spyOn(api, "putRepositoryCollaborator")
      .mockImplementation(async (_id, payload) => ({
        ...collaborator,
        identifier: payload.identifier,
        role: payload.role,
      }));
    const remove = vi.spyOn(api, "deleteRepositoryCollaborator").mockResolvedValue({
      deleted: true,
      revocationIncomplete: false,
    });
    const mounted = await mountAt("/_verify/collaborators", "/_verify/collaborators", () =>
      h(RepositoryCollaborators, { repositoryId: repository.id, canManage: true })
    );

    const roleSelect = control(mounted.root, ".collaborator-row [role='combobox']");
    roleSelect.click();
    await settle();
    Array.from(document.body.querySelectorAll<HTMLElement>("[role='option']"))
      .find((option) => option.textContent?.trim() === "Write")
      ?.click();
    await settle();
    expect(put).toHaveBeenCalledWith(repository.id, { identifier: "octocat", role: "write" });

    fill(control(mounted.root, ".collaborator-form input"), "octo-friend");
    const formRole = control(mounted.root, ".collaborator-form [role='combobox']");
    formRole.click();
    await settle();
    Array.from(document.body.querySelectorAll<HTMLElement>("[role='option']"))
      .find((option) => option.textContent?.trim() === "Admin")
      ?.click();
    await settle();
    findButton(mounted.root, "Add or update collaborator").click();
    await settle();
    expect(put).toHaveBeenLastCalledWith(repository.id, {
      identifier: "octo-friend",
      role: "admin",
    });

    await confirmClick(findButton(mounted.root, "Remove"));
    expect(remove).toHaveBeenCalledWith(repository.id, collaborator.id);
    mounted.unmount();
  });

  it("keeps inherited members read only and reports API failures", async () => {
    const inherited: RepositoryCollaborator = { ...collaborator, id: "user-3", inherited: true };
    const direct: RepositoryCollaborator = {
      ...collaborator,
      id: "user-4",
      identifier: "another-user",
    };
    vi.spyOn(api, "repositoryCollaborators")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([inherited, direct]);
    const put = vi.spyOn(api, "putRepositoryCollaborator").mockRejectedValue(new Error("denied"));
    const remove = vi
      .spyOn(api, "deleteRepositoryCollaborator")
      .mockRejectedValue(new Error("denied"));
    const mounted = await mountAt(
      "/_verify/collaborator-errors",
      "/_verify/collaborator-errors",
      () => h(RepositoryCollaborators, { repositoryId: repository.id, canManage: true })
    );
    expect(mounted.root.textContent).toContain("Could not load repository collaborators.");
    findButton(mounted.root, "Retry").click();
    await settle();
    expect(
      control(mounted.root, ".collaborator-row [role='combobox']").hasAttribute("disabled")
    ).toBe(true);
    const inheritedRow = Array.from(mounted.root.querySelectorAll(".collaborator-row")).find(
      (row) => row.textContent?.includes("Inherited from organization")
    );
    expect(inheritedRow?.querySelector("button")?.hasAttribute("disabled")).toBe(true);

    fill(control(mounted.root, ".collaborator-form input"), "octo-friend");
    await settle();
    findButton(mounted.root, "Add or update collaborator").click();
    await settle();
    expect(put).toHaveBeenCalled();
    expect(mounted.root.textContent).toContain("Could not save the collaborator");
    const directRow = Array.from(
      mounted.root.querySelectorAll<HTMLElement>(".collaborator-row")
    ).find((row) => row.textContent?.includes("another-user"));
    await confirmClick(findButton(directRow ?? mounted.root, "Remove"));
    expect(remove).toHaveBeenCalledWith(repository.id, direct.id);
    expect(mounted.root.textContent).toContain("Could not remove the repository collaborator");
    mounted.unmount();
  });
});

describe("repository creation form", () => {
  it("accepts dotted names and forwards README initialization", async () => {
    vi.spyOn(api, "repositories").mockResolvedValue([]);
    vi.spyOn(api, "organizations").mockResolvedValue([]);
    const create = vi.spyOn(api, "createRepository").mockResolvedValue(repository);
    const mounted = await mountAt(
      "/_verify/create-repository",
      "/_verify/create-repository?new=1",
      () => h(DashboardView)
    );
    fill(control(mounted.root, ".workspace-modal input"), ".github");
    control(mounted.root, ".fluent-checkbox__input").click();
    await settle();
    submit(control(mounted.root, ".workspace-modal form"));
    await settle();

    expect(create).toHaveBeenCalledWith({
      name: ".github",
      owner: "user@example.test",
      description: "",
      visibility: "private",
      initializeReadme: true,
    });
    mounted.unmount();
  });

  it("rejects invalid names through the canonical repository slug schema", async () => {
    vi.spyOn(api, "repositories").mockResolvedValue([]);
    vi.spyOn(api, "organizations").mockResolvedValue([]);
    const create = vi.spyOn(api, "createRepository").mockResolvedValue(repository);
    const mounted = await mountAt("/_verify/create-invalid", "/_verify/create-invalid?new=1", () =>
      h(DashboardView)
    );
    fill(control(mounted.root, ".workspace-modal input"), "trailing.");
    await settle();
    submit(control(mounted.root, ".workspace-modal form"));
    await settle();

    expect(create).not.toHaveBeenCalled();
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "Invalid repository name"
    );
    mounted.unmount();
  });
});
