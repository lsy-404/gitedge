import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import DeletedRepositories from "../../apps/web/src/components/DeletedRepositories.vue";
import OrganizationView from "../../apps/web/src/pages/OrganizationView.vue";
import RepositoryDangerActions from "../../apps/web/src/components/RepositoryDangerActions.vue";
import { i18n } from "../../apps/web/src/i18n";
import { ApiError, api, type DeletedRepository } from "../../apps/web/src/lib/api";
import { clearSession } from "../../apps/web/src/lib/session";
// Lazily loaded routes import preferences, which resets the locale when first evaluated.
import "../../apps/web/src/lib/preferences";
import { router } from "../../apps/web/src/router";
import {
  confirmClick,
  control,
  fill,
  findButton,
  isDisabled,
  mountAt,
  repository,
  settle,
  submit,
  unmountAll,
} from "./task-support";

const deleted: DeletedRepository = {
  id: "repo-9",
  owner: "acme",
  name: "legacy",
  deletedAt: Date.now() - 1000,
  purgeAfter: Date.now() + 86_400_000,
  deletedBy: "owner",
  purging: false,
};

beforeEach(() => {
  i18n.global.locale.value = "en";
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  clearSession();
  document.body.innerHTML = "";
});

function mountDanger(canManage = true) {
  return mountAt("/acme/:repo/settings", "/acme/project/settings", () =>
    h(RepositoryDangerActions, { repository, canManage })
  );
}

describe("RepositoryDangerActions", () => {
  it("enables deletion only after the full repository name is typed", async () => {
    vi.spyOn(api, "organizations").mockResolvedValue([]);
    const remove = vi.spyOn(api, "deleteRepository").mockResolvedValue({
      deletedAt: 1,
      purgeAfter: 2,
    });
    const replace = vi.spyOn(router, "replace");
    const mounted = await mountDanger();
    const field = control(mounted.root, "input");
    const action = findButton(mounted.root, "Delete this repository");
    expect(isDisabled(action)).toBe(true);
    fill(field, "acme/proj");
    await settle();
    expect(isDisabled(findButton(mounted.root, "Delete this repository"))).toBe(true);
    fill(field, `${repository.owner}/${repository.name}`);
    await settle();
    findButton(mounted.root, "Delete this repository").click();
    await settle();
    expect(remove).toHaveBeenCalledWith(repository.id, `${repository.owner}/${repository.name}`);
    expect(replace).toHaveBeenCalledWith("/dashboard");
    mounted.unmount();
  });

  it("asks for a fresh identity confirmation and then retries the deletion", async () => {
    vi.spyOn(api, "organizations").mockResolvedValue([]);
    vi.spyOn(api, "security").mockResolvedValue({
      passwordEnabled: true,
      email: null,
      emailAvailable: false,
      totp: { enabled: false, available: true },
      passkeys: [],
      recoveryCodesRemaining: 0,
      secondFactorEnabled: false,
      recentAuth: { valid: false, expiresAt: null, methods: ["password"] },
    });
    const reauthenticate = vi
      .spyOn(api, "reauthenticate")
      .mockResolvedValue({ recentAuthAt: 1, expiresAt: 2 });
    const remove = vi
      .spyOn(api, "deleteRepository")
      .mockRejectedValueOnce(new ApiError(403, "Confirm your identity.", "reauth_required"))
      .mockResolvedValueOnce({ deletedAt: 1, purgeAfter: 2 });
    const replace = vi.spyOn(router, "replace");
    const mounted = await mountDanger();
    fill(control(mounted.root, "input"), `${repository.owner}/${repository.name}`);
    await settle();
    findButton(mounted.root, "Delete this repository").click();
    const form = await vi.waitFor(() =>
      control(mounted.root, "#reauth-title").closest("section")!.querySelector("form")!
    );
    expect(replace).not.toHaveBeenCalled();
    fill(form.querySelector("input")!, "secret-value");
    await settle();
    submit(form);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    expect(reauthenticate).toHaveBeenCalledWith({ method: "password", password: "secret-value" });
    expect(remove).toHaveBeenCalledTimes(2);
    mounted.unmount();
  });

  it("transfers to an owned organization and follows the new address", async () => {
    vi.spyOn(api, "organizations").mockResolvedValue([
      { slug: "platform", displayName: "Platform", role: "owner" },
      { slug: "guest-org", displayName: "Guest", role: "member" },
    ]);
    const transfer = vi.spyOn(api, "transferRepository").mockResolvedValue({
      ...repository,
      owner: "platform",
    });
    const replace = vi.spyOn(router, "replace");
    const mounted = await mountDanger();
    const options = Array.from(mounted.root.querySelectorAll("option")).map((o) => o.value);
    expect(options).toContain("platform");
    expect(options).not.toContain("guest-org");
    fill(control(mounted.root, "select"), "platform");
    await settle();
    findButton(mounted.root, "Transfer…").click();
    await settle();
    fill(control(mounted.root, "input"), `${repository.owner}/${repository.name}`);
    await settle();
    findButton(mounted.root, "Transfer to platform").click();
    await settle();
    expect(transfer).toHaveBeenCalledWith(repository.id, {
      owner: "platform",
      confirm: `${repository.owner}/${repository.name}`,
    });
    expect(replace).toHaveBeenCalledWith(`/platform/${repository.name}/settings`);
    mounted.unmount();
  });

  it("shows a localized message when the target name is taken", async () => {
    vi.spyOn(api, "organizations").mockResolvedValue([
      { slug: "platform", displayName: "Platform", role: "owner" },
    ]);
    vi.spyOn(api, "transferRepository").mockRejectedValue(new ApiError(409, "conflict"));
    const mounted = await mountDanger();
    fill(control(mounted.root, "select"), "platform");
    await settle();
    findButton(mounted.root, "Transfer…").click();
    await settle();
    fill(control(mounted.root, "input"), `${repository.owner}/${repository.name}`);
    await settle();
    findButton(mounted.root, "Transfer to platform").click();
    await settle();
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "already has a repository with this name"
    );
    mounted.unmount();
  });
});

describe("DeletedRepositories", () => {
  it("stays hidden when nothing was deleted", async () => {
    vi.spyOn(api, "deletedRepositories").mockResolvedValue({ items: [], truncated: false });
    const mounted = await mountAt("/dashboard", "/dashboard", () => h(DeletedRepositories));
    expect(mounted.root.querySelector(".deleted-repositories")).toBeNull();
    mounted.unmount();
  });

  it("restores a repository and reports a name conflict", async () => {
    const list = vi
      .spyOn(api, "deletedRepositories")
      .mockResolvedValue({ items: [deleted], truncated: false });
    const restore = vi
      .spyOn(api, "restoreRepository")
      .mockRejectedValueOnce(new ApiError(409, "conflict"))
      .mockResolvedValueOnce(repository);
    const onRestored = vi.fn();
    const mounted = await mountAt("/dashboard", "/dashboard", () =>
      h(DeletedRepositories, { onRestored })
    );
    expect(mounted.root.textContent).toContain("acme / legacy");

    await confirmClick(findButton(mounted.root, "Restore"));
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "another repository uses this name"
    );
    list.mockResolvedValue({ items: [], truncated: false });
    await confirmClick(findButton(mounted.root, "Restore"));
    expect(restore).toHaveBeenCalledTimes(2);
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(mounted.root.querySelector(".deleted-repositories")).toBeNull();
    mounted.unmount();
  });

  it("requires typing the name before purging immediately", async () => {
    vi.spyOn(api, "deletedRepositories").mockResolvedValue({ items: [deleted], truncated: false });
    const purge = vi.spyOn(api, "purgeRepository").mockResolvedValue({ purged: true });
    const mounted = await mountAt("/dashboard", "/dashboard", () => h(DeletedRepositories));
    findButton(mounted.root, "Delete permanently now").click();
    await settle();
    expect(isDisabled(findButton(mounted.root, "Delete permanently now"))).toBe(true);
    fill(control(mounted.root, "input"), "acme/legacy");
    await settle();
    findButton(mounted.root, "Delete permanently now").click();
    await settle();
    expect(purge).toHaveBeenCalledWith("repo-9", "acme/legacy");
    mounted.unmount();
  });
});

describe("DeletedRepositories purge state", () => {
  it("blocks restore once the purge has started", async () => {
    vi.spyOn(api, "deletedRepositories").mockResolvedValue({
      items: [{ ...deleted, purging: true }],
      truncated: false,
    });
    const mounted = await mountAt("/dashboard", "/dashboard", () => h(DeletedRepositories));
    await vi.waitFor(() => findButton(mounted.root, "Restore"));
    expect(isDisabled(findButton(mounted.root, "Restore"))).toBe(true);
    expect(mounted.root.textContent).toContain("can no longer be restored");
    mounted.unmount();
  });
});

describe("OrganizationView danger zone", () => {
  function mockOrganization(role: "owner" | "member") {
    vi.spyOn(api, "organization").mockResolvedValue({
      id: "org-1",
      slug: "acme",
      displayName: "Acme",
      description: "",
      role,
    });
    vi.spyOn(api, "organizationMembers").mockResolvedValue([{ identifier: "alice", role }]);
  }

  it("is hidden from members", async () => {
    mockOrganization("member");
    const mounted = await mountAt("/organizations/:slug", "/organizations/acme", () =>
      h(OrganizationView)
    );
    await vi.waitFor(() => expect(mounted.root.textContent).toContain("alice"));
    expect(mounted.root.querySelector(".type-to-confirm")).toBeNull();
    mounted.unmount();
  });

  it("deletes after the slug is typed and explains a non-empty organization", async () => {
    mockOrganization("owner");
    const remove = vi
      .spyOn(api, "deleteOrganization")
      .mockRejectedValueOnce(new ApiError(409, "organization_not_empty"))
      .mockResolvedValueOnce(undefined);
    const replace = vi.spyOn(router, "replace");
    const mounted = await mountAt("/organizations/:slug", "/organizations/acme", () =>
      h(OrganizationView)
    );
    const confirm = await vi.waitFor(() => control(mounted.root, ".type-to-confirm"));
    expect(isDisabled(findButton(confirm, "Delete this organization"))).toBe(true);
    fill(control(confirm, "input"), "acme");
    await settle();
    findButton(confirm, "Delete this organization").click();
    await vi.waitFor(() => expect(mounted.root.textContent).toContain("still has repositories"));
    expect(remove).toHaveBeenCalledWith("acme", "acme");
    const retry = await vi.waitFor(() => {
      const button = findButton(mounted.root, "Delete this organization");
      expect(isDisabled(button)).toBe(false);
      return button;
    });
    retry.click();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/organizations"));
    mounted.unmount();
  });
});
