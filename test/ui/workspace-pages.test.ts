import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import App from "../../apps/web/src/App.vue";
import { i18n } from "../../apps/web/src/i18n";
import {
  ApiError,
  api,
  type Agent,
  type AgentProfile,
  type AgentSession,
  type Organization,
  type Repository,
  type User,
} from "../../apps/web/src/lib/api";
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
  topics: [],
  starCount: 0,
  forkCount: 0,
  forkOf: null,
  id: "repo-1",
  namespaceId: "namespace-1",
  owner: "octocat",
  name: "sample",
  slug: "sample",
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

    expect(mounted.root.querySelector("dialog[open]")).not.toBeNull();
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

    expect(mounted.root.querySelector("dialog[open]")).not.toBeNull();
    expect(mounted.root.textContent).toContain("New organization");
    expect(mounted.root.textContent).toContain("Octo Team");

    mounted.unmount();
  });

  it("opens agent creation from the settings new=1 entry point", async () => {
    vi.spyOn(api, "agents").mockResolvedValue([]);
    vi.spyOn(api, "repositories").mockResolvedValue([repository]);
    const mounted = await mount("/settings/agents?new=1");

    expect(mounted.root.querySelector("dialog[open]")).not.toBeNull();
    expect(mounted.root.textContent).toContain("Create agent");

    mounted.unmount();
  });
});

const agent: Agent = {
  id: "agent-1",
  owner: "octocat",
  handle: "helper",
  profilePath: "/octocat/@helper",
  name: "Helper",
  description: "Does chores",
  profilePublic: false,
  createdAt: 1,
  updatedAt: 2,
  disabledAt: null,
};
const session: AgentSession = {
  id: "session-1",
  agentId: "agent-1",
  agentName: "Helper",
  repositoryId: "repo-1",
  workspaceName: "helper-fork-1",
  remote: "https://example.test/git",
  baseRef: "main",
  baseOid: null,
  permission: "write",
  status: "active",
  createdAt: 1,
  expiresAt: Date.now() + 3_600_000,
};

function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function controlOf<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

describe("header menus", () => {
  it("keeps one menu open and closes it on an outside pointerdown", async () => {
    vi.spyOn(api, "repositories").mockResolvedValue([]);
    vi.spyOn(api, "organizations").mockResolvedValue([]);
    const mounted = await mount("/dashboard");
    const create = controlOf<HTMLDetailsElement>(mounted.root, "details.create-menu");
    const account = controlOf<HTMLDetailsElement>(mounted.root, "details.user-menu");

    create.open = true;
    create.dispatchEvent(new Event("toggle"));
    await settle();
    expect(controlOf(create, "summary").getAttribute("aria-expanded")).toBe("true");
    account.open = true;
    account.dispatchEvent(new Event("toggle"));
    await settle();
    expect(create.open).toBe(false);
    expect(account.open).toBe(true);

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(account.open).toBe(false);

    mounted.unmount();
  });

  it("names the preference groups and tags the language options", async () => {
    vi.spyOn(api, "repositories").mockResolvedValue([]);
    vi.spyOn(api, "organizations").mockResolvedValue([]);
    const mounted = await mount("/dashboard");
    mounted.root.querySelector<HTMLButtonElement>(".preference-group-toggle")?.click();
    await settle();

    const group = controlOf(mounted.root, ".preference-options");
    expect(group.getAttribute("role")).toBe("group");
    expect(Array.from(group.querySelectorAll("button")).map((b) => b.lang)).toEqual([
      "zh-CN",
      "en",
    ]);

    mounted.unmount();
  });
});

describe("create dialogs close on cancel", () => {
  async function expectCancelClears(path: string, mocks: () => void) {
    mocks();
    const mounted = await mount(path);
    const dialog = controlOf<HTMLDialogElement>(mounted.root, "dialog[open]");
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    expect(mounted.root.querySelector("dialog[open]")).toBeNull();
    expect(router.currentRoute.value.query.new).toBeUndefined();
    mounted.unmount();
  }

  it("closes the dashboard repository dialog", async () => {
    await expectCancelClears("/dashboard?new=1", () => {
      vi.spyOn(api, "repositories").mockResolvedValue([repository]);
      vi.spyOn(api, "organizations").mockResolvedValue([]);
    });
  });

  it("closes the organization dialog", async () => {
    await expectCancelClears("/organizations?new=1", () => {
      vi.spyOn(api, "organizations").mockResolvedValue([organization]);
    });
  });

  it("closes the agent dialog", async () => {
    await expectCancelClears("/settings/agents?new=1", () => {
      vi.spyOn(api, "agents").mockResolvedValue([agent]);
      vi.spyOn(api, "agentSessions").mockResolvedValue([]);
      vi.spyOn(api, "repositories").mockResolvedValue([repository]);
    });
  });
});

describe("agent webhook settings", () => {
  it("keeps the form and error visible when a test fails, and disables test while pending", async () => {
    vi.spyOn(api, "agentWebhook").mockResolvedValue({
      url: "",
      events: [],
      enabled: true,
    } as Awaited<ReturnType<typeof api.agentWebhook>>);
    vi.spyOn(api, "agentWebhookDeliveries").mockResolvedValue([]);
    let reject: (cause: unknown) => void = () => undefined;
    vi.spyOn(api, "testAgentWebhook").mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      })
    );
    const mounted = await mount("/settings/agents/agent-1/webhook");

    const testButton = Array.from(mounted.root.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Send test event")
    );
    if (!testButton) throw new Error("Missing test button");
    testButton.click();
    await settle();
    expect(testButton.disabled).toBe(true);

    reject(new ApiError(500, "boom"));
    await settle();
    expect(mounted.root.querySelector("form")).not.toBeNull();
    expect(mounted.root.querySelector('[role="alert"]')).not.toBeNull();
    expect(testButton.disabled).toBe(false);

    mounted.unmount();
  });
});

describe("dashboard partial failure", () => {
  it("keeps repositories visible when organizations fail", async () => {
    vi.spyOn(api, "repositories").mockResolvedValue([repository]);
    vi.spyOn(api, "organizations").mockRejectedValue(new Error("down"));
    const mounted = await mount("/dashboard");

    expect(mounted.root.textContent).toContain("octocat / sample");
    const panel = controlOf(mounted.root, ".dashboard-organizations");
    expect(panel.querySelector(".state-error")).not.toBeNull();
    expect(panel.textContent).toContain("Retry");

    mounted.unmount();
  });
});

describe("agent settings", () => {
  it("keeps the page and shows an inline error when creating an agent fails", async () => {
    vi.spyOn(api, "agents").mockResolvedValue([agent]);
    vi.spyOn(api, "agentSessions").mockResolvedValue([]);
    vi.spyOn(api, "repositories").mockResolvedValue([repository]);
    vi.spyOn(api, "createAgent").mockRejectedValue(new ApiError(409, "taken"));
    const mounted = await mount("/settings/agents?new=1");

    const dialog = controlOf<HTMLDialogElement>(mounted.root, "dialog[open]");
    fill(controlOf<HTMLInputElement>(dialog, "input[required]"), "Another");
    controlOf<HTMLFormElement>(dialog, "form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    await settle();

    expect(dialog.textContent).toContain("already in use");
    expect(mounted.root.textContent).toContain("Helper");

    mounted.unmount();
  });

  it("edits the agent profile and reports a handle conflict", async () => {
    vi.spyOn(api, "agents").mockResolvedValue([agent]);
    vi.spyOn(api, "agentSessions").mockResolvedValue([]);
    vi.spyOn(api, "repositories").mockResolvedValue([repository]);
    const update = vi
      .spyOn(api, "updateAgent")
      .mockRejectedValueOnce(new ApiError(409, "taken"))
      .mockResolvedValueOnce({ ...agent, name: "Renamed" });
    const mounted = await mount("/settings/agents");

    const form = controlOf<HTMLFormElement>(mounted.root, ".agent-profile-form");
    const inputs = form.querySelectorAll<HTMLInputElement>("input.text-field-input, input");
    const nameInput = Array.from(inputs).find((input) => input.value === "Helper");
    if (!nameInput) throw new Error("Missing name input");
    fill(nameInput, "Renamed");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(form.textContent).toContain("already in use");

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(update).toHaveBeenLastCalledWith("agent-1", {
      handle: "helper",
      name: "Renamed",
      description: "Does chores",
      profilePublic: false,
    });
    expect(mounted.root.querySelector("#agent-summary-title")?.textContent).toBe("Renamed");

    mounted.unmount();
  });
});

describe("agent profile page", () => {
  it("shows the newest profile when responses arrive out of order", async () => {
    const resolvers: Record<string, (value: AgentProfile) => void> = {};
    vi.spyOn(api, "agentProfile").mockImplementation(
      (_owner, handle) =>
        new Promise<AgentProfile>((resolve) => {
          resolvers[handle] = resolve;
        })
    );
    const mounted = await mount("/octocat/@first");
    await router.push("/octocat/@second");
    await settle();
    const profile = (handle: string): AgentProfile => ({
      owner: "octocat",
      handle,
      name: handle,
      description: "",
      createdAt: 1,
      updatedAt: 1,
    });
    resolvers.second(profile("second"));
    await settle();
    resolvers.first(profile("first"));
    await settle();

    expect(mounted.root.querySelector("h1")?.textContent).toBe("second");

    mounted.unmount();
  });
});

describe("repository agents tab", () => {
  it("shows the workspace and revokes an active session", async () => {
    vi.spyOn(api, "repository").mockResolvedValue(repository);
    vi.spyOn(api, "issues").mockResolvedValue({ items: [], truncated: false });
    vi.spyOn(api, "pulls").mockResolvedValue({ items: [], truncated: false });
    vi.spyOn(api, "discussions").mockResolvedValue({ items: [], truncated: false });
    const list = vi.spyOn(api, "repositorySessions").mockResolvedValue([session]);
    const revoke = vi.spyOn(api, "revokeAgentSession").mockResolvedValue(undefined);
    const mounted = await mount("/octocat/sample/agents");

    expect(mounted.root.textContent).toContain("helper-fork-1");
    const button = Array.from(mounted.root.querySelectorAll("button")).find((item) =>
      item.textContent?.includes("Revoke session")
    );
    button?.click();
    await settle();

    expect(revoke).toHaveBeenCalledWith("agent-1", "session-1");
    expect(list).toHaveBeenCalledTimes(2);

    mounted.unmount();
  });
});
