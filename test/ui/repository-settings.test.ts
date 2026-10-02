import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import RepositorySettings from "../../apps/web/src/components/RepositorySettings.vue";
import { i18n } from "../../apps/web/src/i18n";
import repositorySettingsMessages from "../../apps/web/src/i18n/repositorySettings";
import { ApiError, api } from "../../apps/web/src/lib/api";
import { clearSession } from "../../apps/web/src/lib/session";
import { router } from "../../apps/web/src/router";
import type { Repository } from "../../packages/contracts/src/forge";
import type { RepositorySettings as Settings } from "../../packages/contracts/src/tasks";
import {
  control,
  fill,
  isDisabled,
  mountAt,
  repository,
  settle,
  submit,
  unmountAll,
} from "./task-support";

vi.mock("../../apps/web/src/components/AppIcon.vue", () => ({
  default: { template: "<span />" },
}));

const settings: Settings = {
  name: "project",
  slug: "project",
  description: "A test repository",
  visibility: "public",
  defaultBranch: "main",
  archived: false,
  issuesEnabled: true,
  pullsEnabled: true,
  discussionsEnabled: true,
  wikiEnabled: true,
  requiredApprovals: 0,
  requirePassingChecks: false,
  memoryVisibility: "members",
  agentAssignmentPolicy: "owner",
  canManage: true,
};

function mountSettings(repo: Repository, onUpdated?: (value: Settings) => void) {
  return mountAt("/acme/:repo/settings", "/acme/project/settings", () =>
    h(RepositorySettings, { repository: repo, onUpdated })
  );
}

function combo(root: ParentNode, label: string): HTMLElement {
  return control(root, `[role="combobox"][aria-label="${label}"]`);
}

async function choose(root: ParentNode, label: string, value: string): Promise<void> {
  combo(root, label).click();
  await settle();
  const option = Array.from(document.body.querySelectorAll<HTMLElement>("[role='option']")).find(
    (candidate) => candidate.textContent?.trim() === value
  );
  if (!option) throw new Error(`Could not find option: ${value}`);
  option.click();
  await settle();
}

function navigation(root: ParentNode, label: string): HTMLElement {
  const button = Array.from(root.querySelectorAll<HTMLElement>(".settings-nav button")).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!button) throw new Error(`Could not find settings section: ${label}`);
  return button;
}

beforeEach(() => {
  i18n.global.locale.value = "en";
  i18n.global.mergeLocaleMessage("en", repositorySettingsMessages.en);
  vi.spyOn(api, "refs").mockResolvedValue([
    { name: "refs/heads/main", oid: "a".repeat(40) },
    { name: "refs/heads/topic", oid: "b".repeat(40) },
  ]);
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
  clearSession();
  document.body.innerHTML = "";
});

describe("RepositorySettings", () => {
  it("shows fetched branches and keeps public memory unavailable for private repositories", async () => {
    vi.spyOn(api, "repositorySettings").mockResolvedValue({ ...settings, visibility: "private" });
    const mounted = await mountSettings({ ...repository, visibility: "private" });

    expect(combo(mounted.root, "Default branch").textContent).toContain("main");
    navigation(mounted.root, "Agents & memory").click();
    await settle();
    combo(mounted.root, "Task and project memory visibility").click();
    await settle();
    const publicOption = Array.from(
      document.body.querySelectorAll<HTMLElement>("[role='option']")
    ).find((candidate) => candidate.textContent?.trim() === "Public");
    expect(publicOption).toBeDefined();
    expect(isDisabled(publicOption!)).toBe(true);
    expect(mounted.root.textContent).toContain(
      "Task and project memory in a private repository is limited to members"
    );
    mounted.unmount();
  });

  it("saves settings across sections, emits the saved snapshot, and updates the route after rename", async () => {
    vi.spyOn(api, "repositorySettings").mockResolvedValue(settings);
    const updated: Settings = {
      ...settings,
      name: "renamed",
      slug: "renamed",
      description: "Updated project description",
      visibility: "private",
      defaultBranch: "topic",
      issuesEnabled: false,
      requiredApprovals: 2,
      requirePassingChecks: true,
      agentAssignmentPolicy: "members",
    };
    const updateSpy = vi.spyOn(api, "updateRepositorySettings").mockResolvedValue(updated);
    const onUpdated = vi.fn();
    const mounted = await mountSettings(repository, onUpdated);

    const name = control(mounted.root, "#repository-name");
    fill(name, "renamed");
    fill(control(mounted.root, "textarea"), "Updated project description");
    await choose(mounted.root, "Default branch", "topic");
    await choose(mounted.root, "Visibility", "Private");

    navigation(mounted.root, "Features").click();
    await settle();
    const issuesSwitch = Array.from(
      mounted.root.querySelectorAll<HTMLElement>("[role='switch']")
    ).find((button) => button.closest(".settings-row")?.textContent?.includes("Issues"));
    issuesSwitch?.click();

    navigation(mounted.root, "Merge rules").click();
    await settle();
    await choose(mounted.root, "Required approvals", "2");
    const checkSwitch = Array.from(
      mounted.root.querySelectorAll<HTMLElement>("[role='switch']")
    ).find((button) =>
      button.closest(".settings-row")?.textContent?.includes("Require passing checks")
    );
    checkSwitch?.click();

    navigation(mounted.root, "Agents & memory").click();
    await settle();
    await choose(mounted.root, "Agent assignment policy", "Any repository member");

    expect(isDisabled(control(mounted.root, "button[type='submit']"))).toBe(false);
    submit(control(mounted.root, "form"));
    await settle();

    expect(updateSpy).toHaveBeenCalledWith("repo-1", {
      name: "renamed",
      slug: "renamed",
      description: "Updated project description",
      visibility: "private",
      defaultBranch: "topic",
      archived: false,
      issuesEnabled: false,
      pullsEnabled: true,
      discussionsEnabled: true,
      wikiEnabled: true,
      requiredApprovals: 2,
      requirePassingChecks: true,
      memoryVisibility: "members",
      agentAssignmentPolicy: "members",
    });
    expect(onUpdated).toHaveBeenCalledWith(updated);
    expect(router.currentRoute.value.path).toBe("/acme/renamed/settings");
    expect(isDisabled(control(mounted.root, "button[type='submit']"))).toBe(true);
    expect(mounted.root.querySelector('[role="status"]')?.textContent).toContain("Settings saved");
    mounted.unmount();
  });

  it("allows owners to restore an archived repository and leaves failed drafts editable", async () => {
    vi.spyOn(api, "repositorySettings").mockResolvedValue({ ...settings, archived: true });
    const updateSpy = vi
      .spyOn(api, "updateRepositorySettings")
      .mockRejectedValueOnce(new ApiError(409, "conflict"))
      .mockResolvedValueOnce({ ...settings, archived: false });
    const mounted = await mountSettings(repository);

    navigation(mounted.root, "Archive").click();
    await settle();
    expect(mounted.root.textContent).toContain(
      "This repository is archived. Writes, merges, and new write credentials are disabled"
    );
    const archiveSwitch = control(mounted.root, "[role='switch']");
    expect(archiveSwitch.getAttribute("aria-checked")).toBe("true");
    archiveSwitch.click();
    await settle();
    submit(control(mounted.root, "form"));
    await settle();
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "That repository name is taken"
    );
    expect(control(mounted.root, "[role='switch']").getAttribute("aria-checked")).toBe("false");
    submit(control(mounted.root, "form"));
    await settle();
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[1]?.[1].archived).toBe(false);
    expect(control(mounted.root, "button[type='submit']").hasAttribute("disabled")).toBe(true);
    mounted.unmount();
  });

  it("keeps every setting read only for members who cannot manage the repository", async () => {
    vi.spyOn(api, "repositorySettings").mockResolvedValue({ ...settings, canManage: false });
    const mounted = await mountSettings(repository);

    expect(mounted.root.textContent).toContain(
      "Only the repository owner can change these settings"
    );
    for (const section of ["Features", "Merge rules", "Agents & memory", "Archive"]) {
      navigation(mounted.root, section).click();
      await settle();
      for (const selector of ["input", "textarea", "[role='combobox']", "[role='switch']"])
        for (const field of mounted.root.querySelectorAll<HTMLElement>(selector))
          expect(isDisabled(field), `${section} ${selector}`).toBe(true);
    }
    expect(isDisabled(control(mounted.root, "button[type='submit']"))).toBe(true);
    mounted.unmount();
  });
});
