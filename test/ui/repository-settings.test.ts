import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import RepositorySettings from "../../apps/web/src/components/RepositorySettings.vue";
import { i18n } from "../../apps/web/src/i18n";
import { ApiError, api } from "../../apps/web/src/lib/api";
import { clearSession } from "../../apps/web/src/lib/session";
import type { Repository } from "../../packages/contracts/src/forge";
import type { RepositorySettings as Settings } from "../../packages/contracts/src/tasks";
import {
  control,
  fill,
  isDisabled,
  findButton,
  mountAt,
  repository,
  settle,
  submit,
  unmountAll,
} from "./task-support";

const settings: Settings = {
  memoryVisibility: "members",
  agentAssignmentPolicy: "owner",
  canManage: true,
};

function mountSettings(repo: Repository) {
  return mountAt("/_verify/settings", "/_verify/settings", () =>
    h(RepositorySettings, { repository: repo })
  );
}

function option(root: ParentNode, value: string): HTMLElement {
  return control(root, `option[value='${value}']`);
}

beforeEach(() => {
  i18n.global.locale.value = "en";
});

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  clearSession();
  document.body.innerHTML = "";
});

describe("RepositorySettings", () => {
  it("disables public visibility for private repositories", async () => {
    vi.spyOn(api, "repositorySettings").mockResolvedValue(settings);
    const mounted = await mountSettings({ ...repository, visibility: "private" });

    expect(isDisabled(option(mounted.root, "public"))).toBe(true);
    expect(isDisabled(option(mounted.root, "members"))).toBe(false);
    expect(mounted.root.textContent).toContain("Private repositories can only use Members only");
    mounted.unmount();
  });

  it("saves memory visibility and agent policy for public repositories", async () => {
    vi.spyOn(api, "repositorySettings").mockResolvedValue(settings);
    const updateSpy = vi.spyOn(api, "updateRepositorySettings").mockResolvedValue({
      memoryVisibility: "public",
      agentAssignmentPolicy: "members",
      canManage: true,
    });
    const mounted = await mountSettings(repository);

    expect(isDisabled(option(mounted.root, "public"))).toBe(false);
    expect(isDisabled(findButton(mounted.root, "Save"))).toBe(true);
    const dropdowns = mounted.root.querySelectorAll<HTMLElement>("select");
    fill(dropdowns[0], "public");
    fill(dropdowns[1], "members");
    await settle();
    submit(control(mounted.root, "form"));
    await settle();

    expect(updateSpy).toHaveBeenCalledWith("repo-1", {
      memoryVisibility: "public",
      agentAssignmentPolicy: "members",
    });
    expect(mounted.root.querySelector('[role="status"]')?.textContent).toContain("Settings saved");
    mounted.unmount();
  });

  it("shows the server rejection when public exposure is refused", async () => {
    vi.spyOn(api, "repositorySettings").mockResolvedValue(settings);
    vi.spyOn(api, "updateRepositorySettings").mockRejectedValue(new ApiError(400, "bad_request"));
    const mounted = await mountSettings(repository);

    fill(mounted.root.querySelectorAll<HTMLElement>("select")[0], "public");
    await settle();
    submit(control(mounted.root, "form"));
    await settle();
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "Only public repositories can expose tasks and memory publicly"
    );
    mounted.unmount();
  });

  it("is read only for members who do not own the namespace", async () => {
    vi.spyOn(api, "repositorySettings").mockResolvedValue({ ...settings, canManage: false });
    const mounted = await mountSettings(repository);

    expect(mounted.root.textContent).toContain(
      "Only the repository owner can change these settings"
    );
    expect(
      mounted.root.querySelector("button[type='submit'], fluent-button[type='submit']")
    ).toBeNull();
    for (const dropdown of mounted.root.querySelectorAll("select"))
      expect(isDisabled(dropdown)).toBe(true);
    mounted.unmount();
  });
});
