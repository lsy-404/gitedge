import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import AccountRunners from "../../apps/web/src/components/AccountRunners.vue";
import AccountRunnerSigningProfiles from "../../apps/web/src/components/AccountRunnerSigningProfiles.vue";
import { api } from "../../apps/web/src/lib/api";
import { i18n } from "../../apps/web/src/i18n";
import { router } from "../../apps/web/src/router";
import type { RunnerOverview } from "../../packages/contracts/src/runners";
import {
  findButton,
  mountAt,
  repository as baseRepository,
  settle,
  unmountAll,
} from "./task-support";

function overview(overrides: Partial<RunnerOverview> = {}): RunnerOverview {
  return {
    generatedAt: Date.now(),
    runners: [
      {
        id: "runner-1",
        name: "amd-small",
        scope: { owner: "ada" },
        labels: ["linux", "x64"],
        executionClass: "ordinary",
        signingPlatform: null,
        dedicatedHostConfirmed: false,
        operatorApprovedAt: null,
        operatorApprovedBy: null,
        createdAt: Date.now() - 10_000,
        lastSeenAt: Date.now(),
        revokedAt: null,
        state: "held",
        capacity: {
          os: "linux",
          arch: "x64",
          cpus: 2,
          load1: 0.3,
          memTotalMb: 2000,
          memFreeMb: 630,
          diskFreeMb: 10000,
          tools: ["node"],
          slots: 1,
          busy: 0,
        },
        capacityReportedAt: Date.now(),
        budget: { dailyMinutes: 240, maxJobMinutes: 60, cost: 10 },
        usedMinutes24h: 120,
        heldUntil: Date.now() + 60_000,
        consecutiveFailures: 3,
        current: null,
        stats24h: { success: 2, failure: 1, cancelled: 0, busyMinutes: 120 },
        samples: [{ minute: 1, load1: 0.2, memFreeMb: 600, busy: false }],
      },
    ],
    github: [
      {
        connectionId: "connection-1",
        repository: "ada/project",
        remote: "ada/project-mirror",
        enabled: false,
        runnerEnabled: true,
        errorCode: "github_auth_failed",
        failureCount: 2,
        lastSyncedAt: null,
        queued: 1,
        oldestQueuedAt: Date.now() - 20_000,
        pendingCleanup: 1,
        lastJobAt: Date.now() - 30_000,
      },
    ],
    queue: [
      {
        kind: "github",
        id: "job-1",
        repository: "ada/project",
        labels: ["self-hosted", "need-mem-4g"],
        claim: {
          labels: ["self-hosted"],
          memMb: 4096,
          cpus: 1,
          diskMb: 0,
          tools: [],
          minutes: 360,
          valid: true,
        },
        createdAt: Date.now() - 15_000,
        blockedBy: { "runner-1": ["mem", "peer-preferred"] },
      },
    ],
    truncated: false,
    ...overrides,
  };
}

beforeEach(() => {
  i18n.global.locale.value = "en";
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

describe("AccountRunners", () => {
  it("shows runner states, bounded capacity, queue claims, and reason codes", async () => {
    vi.spyOn(api, "runnerOverview").mockResolvedValue(overview());
    vi.spyOn(api, "accountRunner").mockResolvedValue({ repository: null });
    const mounted = await mountAt("/_verify/runners", "/_verify/runners", () => h(AccountRunners));
    await settle();
    expect(mounted.root.textContent).toContain("Held");
    expect(mounted.root.textContent).toContain("630 / 2000 MB");
    expect(mounted.root.textContent).toContain("ada/project");
    expect(mounted.root.textContent).toContain("Not enough free memory");
    expect(mounted.root.textContent).toContain("Waiting briefly for a better-fit runner");
    expect(mounted.root.textContent).toContain("github_auth_failed");
    expect(mounted.root.textContent).not.toContain("credential");
  });

  it("renders the empty state when there are no runners or waiting jobs", async () => {
    vi.spyOn(api, "runnerOverview").mockResolvedValue(
      overview({ runners: [], github: [], queue: [] })
    );
    vi.spyOn(api, "accountRunner").mockResolvedValue({ repository: null });
    const mounted = await mountAt("/_verify/runners-empty", "/_verify/runners-empty", () =>
      h(AccountRunners)
    );
    await settle();
    expect(mounted.root.textContent).toContain("No account Runner repository exists yet.");
    findButton(mounted.root, "Create Runner repository");
    expect(mounted.root.textContent).toContain("No self-hosted runners are registered yet.");
    expect(mounted.root.textContent).toContain(
      "No GitHub connections route jobs to self-hosted runners."
    );
  });

  it("provisions the private service repository and opens its Actions page", async () => {
    vi.spyOn(api, "runnerOverview").mockResolvedValue(
      overview({ runners: [], github: [], queue: [] })
    );
    vi.spyOn(api, "accountRunner").mockResolvedValue({ repository: null });
    const accountRunnerRepository = {
      ...baseRepository,
      id: "account-runner",
      owner: "ada",
      name: "Runner",
      slug: "runner",
      visibility: "private" as const,
      systemKind: "account_runner" as const,
    };
    vi.spyOn(api, "createAccountRunner").mockResolvedValue(accountRunnerRepository);
    const mounted = await mountAt("/_verify/account-runner", "/_verify/account-runner", () =>
      h(AccountRunners)
    );
    await settle();
    const navigation = vi.spyOn(router, "push");
    findButton(mounted.root, "Create Runner repository").click();
    await settle();
    expect(api.createAccountRunner).toHaveBeenCalledOnce();
    expect(navigation).toHaveBeenCalledWith("/ada/runner/actions");
  });

  it("shows private repository links and workflow guidance for an existing owner", async () => {
    vi.spyOn(api, "runnerOverview").mockResolvedValue(
      overview({ runners: [], github: [], queue: [] })
    );
    const accountRunnerRepository = {
      ...baseRepository,
      id: "account-runner",
      owner: "ada",
      name: "Runner",
      slug: "runner",
      visibility: "private" as const,
      systemKind: "account_runner" as const,
    };
    vi.spyOn(api, "accountRunner").mockResolvedValue({ repository: accountRunnerRepository });
    const mounted = await mountAt(
      "/_verify/account-runner-owner",
      "/_verify/account-runner-owner",
      () => h(AccountRunners)
    );
    await settle();
    expect(mounted.root.textContent).toContain("Only this account owner can access the repository");
    expect(mounted.root.textContent).toContain(
      "Runner workflows support manual runs and up to five UTC cron schedules"
    );
    expect(mounted.root.querySelector('a[href="/ada/runner/actions"]')?.textContent).toContain(
      "Open Actions and run results"
    );
    expect(
      mounted.root.querySelector('a[href="/ada/runner/tree/.github/workflows"]')?.textContent
    ).toContain("Edit or add service workflows");
  });

  it("offers signing approval only for the owner's private Runner registration", async () => {
    const runner = {
      ...overview().runners[0]!,
      scope: { owner: "ada", repository: "runner" },
    };
    const repository = {
      ...baseRepository,
      id: "account-runner",
      owner: "ada",
      name: "Runner",
      slug: "runner",
      visibility: "private" as const,
      systemKind: "account_runner" as const,
    };
    vi.spyOn(api, "runnerOverview").mockResolvedValue(
      overview({ runners: [runner], github: [], queue: [] })
    );
    vi.spyOn(api, "accountRunner").mockResolvedValue({ repository });
    const approve = vi.spyOn(api, "approveRunnerSigning").mockResolvedValue({
      runner: {
        id: runner.id,
        name: runner.name,
        scope: runner.scope,
        labels: runner.labels,
        executionClass: "signing",
        signingPlatform: "windows",
        dedicatedHostConfirmed: true,
        operatorApprovedAt: Date.now(),
        operatorApprovedBy: "user-1",
        createdAt: runner.createdAt,
        lastSeenAt: runner.lastSeenAt,
        revokedAt: runner.revokedAt,
      },
    });
    const mounted = await mountAt("/_verify/signing-approval", "/_verify/signing-approval", () =>
      h(AccountRunners)
    );
    await settle();
    expect(mounted.root.textContent).toContain("Signing execution approval");
    expect(mounted.root.textContent).toContain("operator declaration, not hardware proof");
    const confirm = mounted.root.querySelector<HTMLInputElement>(
      ".runner-signing-confirm input[type=checkbox]"
    );
    expect(confirm).not.toBeNull();
    confirm!.checked = true;
    confirm!.dispatchEvent(new Event("input", { bubbles: true }));
    confirm!.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    findButton(mounted.root, "Approve signing node").click();
    await settle();
    expect(approve).toHaveBeenCalledWith(runner.id, {
      platform: "windows",
      dedicatedHostConfirmed: true,
    });
  });

  it("approves a named Runner profile and installs source credentials without rendering the token", async () => {
    const profile = {
      name: "release",
      revision: "a".repeat(40),
      platform: "windows" as const,
      workflowOid: "b".repeat(40),
      workflowPath: ".github/workflows/sign.yml",
      enabled: true,
      approvedAt: Date.now(),
    };
    vi.spyOn(api, "signingProfiles").mockResolvedValue({ profiles: [profile] });
    vi.spyOn(api, "signingCredentialStatus").mockImplementation(async (_id, name, platform) => ({
      name,
      revision: profile.revision,
      platform,
      configured: false,
      updatedAt: null,
    }));
    const approveProfile = vi.spyOn(api, "approveSigningProfile").mockResolvedValue(profile);
    const install = vi.spyOn(api, "installSigningCredentials").mockResolvedValue({
      name: profile.name,
      revision: profile.revision,
      platform: "github-source",
      configured: true,
      updatedAt: Date.now(),
    });
    const mounted = await mountAt("/_verify/signing-profiles", "/_verify/signing-profiles", () =>
      h(AccountRunnerSigningProfiles, { repositoryId: "runner-repository" })
    );
    await settle();
    expect(mounted.root.textContent).toContain(".github/workflows/sign.yml");

    const name = mounted.root.querySelector<HTMLInputElement>("#runner-signing-profile-name")!;
    name.value = "release";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    name.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    findButton(mounted.root, "Approve profile").click();
    await settle();
    expect(approveProfile).toHaveBeenCalledWith("runner-repository", "release");

    const fileInput = Array.from(
      mounted.root.querySelectorAll<HTMLInputElement>('input[type="file"]')
    )[1]!;
    const secretFile = new File(
      [JSON.stringify({ token: "source-token-not-rendered" })],
      "source.json",
      {
        type: "application/json",
      }
    );
    Object.defineProperty(fileInput, "files", { value: [secretFile], configurable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(install).toHaveBeenCalledWith("runner-repository", "release", "github-source", {
      token: "source-token-not-rendered",
    });
    expect(mounted.root.textContent).not.toContain("source-token-not-rendered");
  });

  it("keeps a profile approval failure visible without treating the profile as approved", async () => {
    vi.spyOn(api, "signingProfiles").mockResolvedValue({ profiles: [] });
    vi.spyOn(api, "signingCredentialStatus").mockResolvedValue({
      name: "release",
      revision: "a".repeat(40),
      platform: "windows",
      configured: false,
      updatedAt: null,
    });
    const approveProfile = vi
      .spyOn(api, "approveSigningProfile")
      .mockRejectedValue(new Error("Runner workflow YAML is unavailable."));
    const mounted = await mountAt(
      "/_verify/signing-profile-error",
      "/_verify/signing-profile-error",
      () => h(AccountRunnerSigningProfiles, { repositoryId: "runner-repository" })
    );
    await settle();

    const name = mounted.root.querySelector<HTMLInputElement>("#runner-signing-profile-name")!;
    name.value = "release";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    name.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    findButton(mounted.root, "Approve profile").click();
    await settle();

    expect(approveProfile).toHaveBeenCalledWith("runner-repository", "release");
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "Request failed. Try again later."
    );
    expect(name.value).toBe("release");
    expect(mounted.root.querySelectorAll(".signing-profile")).toHaveLength(0);
  });

  it("shows an account Runner load error and retries the owner lookup", async () => {
    const get = vi
      .spyOn(api, "accountRunner")
      .mockRejectedValueOnce(new Error("Runner service unavailable"))
      .mockResolvedValueOnce({ repository: null });
    vi.spyOn(api, "runnerOverview").mockResolvedValue(
      overview({ runners: [], github: [], queue: [] })
    );
    const mounted = await mountAt(
      "/_verify/account-runner-error",
      "/_verify/account-runner-error",
      () => h(AccountRunners)
    );
    await vi
      .waitFor(() => {
        expect(
          mounted.root.querySelector(".account-runner-services [role=alert]")?.textContent
        ).toContain("Request failed. Try again later.");
        return findButton(mounted.root, "Retry");
      })
      .then((retry) => retry.click());
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(mounted.root.textContent).toContain("No account Runner repository exists yet.")
    );
  });
});
