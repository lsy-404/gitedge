import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import App from "../../apps/web/src/App.vue";
import { i18n } from "../../apps/web/src/i18n";
import { api, type Organization, type Repository, type User } from "../../apps/web/src/lib/api";
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
const organization: Organization = {
  slug: "octo-team",
  displayName: "Octo Team",
  description: "A team space",
  role: "owner",
};

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
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

describe("workspace entry points", () => {
  it("hydrates dashboard search from q and opens repository creation from new=1", async () => {
    vi.spyOn(api, "repositories").mockResolvedValue([repository]);
    vi.spyOn(api, "organizations").mockResolvedValue([]);
    const mounted = await mount("/dashboard?q=sample&new=1");

    expect(mounted.root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      Array.from(mounted.root.querySelectorAll<HTMLInputElement>('input[type="search"]')).map(
        (input) => input.value
      )
    ).toEqual(["sample", "sample"]);
    expect(mounted.root.textContent).toContain("octocat / sample");

    mounted.unmount();
  });

  it("opens organization creation from the shared new=1 entry point", async () => {
    vi.spyOn(api, "organizations").mockResolvedValue([organization]);
    const mounted = await mount("/organizations?new=1");

    expect(mounted.root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mounted.root.textContent).toContain("New organization");
    expect(mounted.root.textContent).toContain("Octo Team");

    mounted.unmount();
  });

  it("opens agent creation from the settings new=1 entry point", async () => {
    vi.spyOn(api, "agents").mockResolvedValue([]);
    vi.spyOn(api, "repositories").mockResolvedValue([repository]);
    const mounted = await mount("/settings/agents?new=1");

    expect(mounted.root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mounted.root.textContent).toContain("Create agent");

    mounted.unmount();
  });
});
