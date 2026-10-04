import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import App from "../../apps/web/src/App.vue";
import { i18n } from "../../apps/web/src/i18n";
import { ApiError, api, type Repository, type User } from "../../apps/web/src/lib/api";
import type { AccountProfile } from "../../packages/contracts/src/account";
import { clearSession, setSession } from "../../apps/web/src/lib/session";
import { router } from "../../apps/web/src/router";
import { fluentUi } from "../../apps/web/src/ui/fluent";

const user: User = { id: "user-1", identifier: "octocat" };
const profile: AccountProfile = {
  identifier: "octocat",
  displayName: "Octocat",
  bio: "",
  location: "",
  website: "",
  preferences: {
    theme: "system",
    locale: "en",
    density: "comfortable",
    tabSize: 2,
    lineWrap: false,
  },
};
const repository: Repository = {
  id: "repo-1",
  namespaceId: "namespace-1",
  owner: "octocat",
  name: "sample",
  slug: "sample",
  artifactName: "octocat/sample",
  remote: "https://git.example/octocat/sample.git",
  description: "A sample project",
  visibility: "private",
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

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mount(path: string) {
  setSession(user);
  vi.spyOn(api, "browserSession").mockResolvedValue({ user, view: { kind: "account" } });
  vi.spyOn(api, "accountProfile").mockResolvedValue(structuredClone(profile));
  await router.push(path);
  await router.isReady();
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(App);
  app.use(router);
  app.use(i18n);
  app.use(fluentUi);
  app.mount(root);
  await settle();
  return {
    root,
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  clearSession();
  await router.push("/dashboard");
  document.body.innerHTML = "";
  i18n.global.locale.value = "en";
});

describe("repository access states", () => {
  it("shows a localized access-denied page for a direct 403 response", async () => {
    vi.spyOn(api, "repository").mockRejectedValue(
      new ApiError(403, "Repository access is denied.")
    );
    const mounted = await mount("/octocat/sample");

    expect(mounted.root.textContent).toContain("Repository access denied");
    expect(mounted.root.textContent).toContain(
      "The current account does not have access to this repository."
    );
    expect(mounted.root.textContent).not.toContain("Repository access is denied.");

    i18n.global.locale.value = "zh-CN";
    await settle();
    expect(mounted.root.textContent).toContain("无法访问此仓库");

    mounted.unmount();
  });

  it("keeps 404 responses on the generic not-found state", async () => {
    vi.spyOn(api, "repository").mockRejectedValue(new ApiError(404, "Not found"));
    const mounted = await mount("/octocat/unknown");

    expect(mounted.root.textContent).toContain("Repository not found");
    expect(mounted.root.textContent).not.toContain("Repository access denied");

    mounted.unmount();
  });

  it("removes loaded repository details when navigation changes to a denied repository", async () => {
    const repositoryRequest = vi
      .spyOn(api, "repository")
      .mockResolvedValueOnce(repository)
      .mockRejectedValueOnce(new ApiError(403, "Repository access is denied."));
    vi.spyOn(api, "issues").mockResolvedValue([]);
    vi.spyOn(api, "pulls").mockResolvedValue([]);
    vi.spyOn(api, "discussions").mockResolvedValue([]);
    const mounted = await mount("/octocat/sample");

    expect(mounted.root.textContent).toContain("octocat / sample");
    await router.push("/private-owner/secret-repo");
    await settle();

    expect(repositoryRequest).toHaveBeenCalledTimes(2);
    expect(mounted.root.textContent).toContain("Repository access denied");
    expect(mounted.root.textContent).not.toContain("octocat / sample");
    expect(mounted.root.querySelector(".repository-heading")).toBeNull();

    mounted.unmount();
  });
});
