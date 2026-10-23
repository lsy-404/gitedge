import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import AccountRunners from "../../apps/web/src/components/AccountRunners.vue";
import AccountRunnerSigningProfiles from "../../apps/web/src/components/AccountRunnerSigningProfiles.vue";
import { api, ApiError } from "../../apps/web/src/lib/api";
import { applyAccountPreferences } from "../../apps/web/src/lib/preferences";
import { DefaultAccountPreferences } from "../../packages/contracts/src/account";
import { router } from "../../apps/web/src/router";
import type { RunnerOverview } from "../../packages/contracts/src/runners";
import {
  findButton,
  fill,
  mountAt,
  repository as baseRepository,
  settle,
  submit,
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
  applyAccountPreferences({ ...DefaultAccountPreferences, locale: "en" });
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

  it("saves explicit custom routing labels without exposing system labels for editing", async () => {
    vi.spyOn(api, "runnerOverview").mockResolvedValue(overview());
    vi.spyOn(api, "accountRunner").mockResolvedValue({ repository: null });
    const updateLabels = vi
      .spyOn(api, "updateRunnerLabels")
      .mockResolvedValue({ labels: ["linux", "x64", "server-tokyo", "ip-mobile"] });
    const mounted = await mountAt("/_verify/runner-labels", "/_verify/runner-labels", () =>
      h(AccountRunners)
    );
    await settle();
    const input = mounted.root.querySelector<HTMLInputElement>(
      'input[id="runner-labels-runner-1"]'
    );
    expect(input).not.toBeNull();
    expect(input?.value).toBe("");
    fill(input!, "server-tokyo, ip-mobile");
    findButton(mounted.root, "Save labels").click();
    await settle();
    expect(updateLabels).toHaveBeenCalledWith("runner-1", ["server-tokyo", "ip-mobile"]);
    expect(mounted.root.textContent).toContain("server-tokyo");
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
    const signingProfiles = vi.spyOn(api, "signingProfiles").mockResolvedValue({ profiles: [] });
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
    expect(mounted.root.querySelector("#runner-signing-profile-name")).not.toBeNull();
    expect(signingProfiles).toHaveBeenCalledWith("account-runner");
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
    const install = vi
      .spyOn(api, "installSigningCredentials")
      .mockImplementation(async (_id, name, platform) => ({
        name,
        revision: profile.revision,
        platform,
        configured: true,
        updatedAt: Date.now(),
      }));
    const mounted = await mountAt("/_verify/signing-profiles", "/_verify/signing-profiles", () =>
      h(AccountRunnerSigningProfiles, { repositoryId: "runner-repository" })
    );
    await settle();
    expect(mounted.root.textContent).toContain(".github/workflows/sign.yml");
    findButton(mounted.root, "Enter Windows credentials").click();
    await settle();
    const windowsFields = {
      tenant: mounted.root.querySelector<HTMLInputElement>(
        "#runner-signing-windows-tenant-release"
      )!,
      client: mounted.root.querySelector<HTMLInputElement>(
        "#runner-signing-windows-client-release"
      )!,
      secret: mounted.root.querySelector<HTMLInputElement>(
        "#runner-signing-windows-secret-release"
      )!,
    };
    fill(windowsFields.tenant, "11111111-1111-4111-8111-111111111111");
    fill(windowsFields.client, "22222222-2222-4222-8222-222222222222");
    fill(windowsFields.secret, "test-client-secret");
    submit(mounted.root.querySelector<HTMLFormElement>(".windows-credentials-form")!);
    await settle();
    expect(install).toHaveBeenCalledWith("runner-repository", "release", "windows", {
      tenant_id: "11111111-1111-4111-8111-111111111111",
      client_id: "22222222-2222-4222-8222-222222222222",
      client_secret: "test-client-secret",
    });
    expect(mounted.root.querySelector(".windows-credentials-form")).toBeNull();
    expect(mounted.root.textContent).not.toContain("test-client-secret");

    const name = mounted.root.querySelector<HTMLInputElement>("#runner-signing-profile-name")!;
    name.value = "release";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    name.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    findButton(mounted.root, "Approve profile").click();
    await settle();
    expect(approveProfile).toHaveBeenCalledWith("runner-repository", "release");

    const fileInput = mounted.root.querySelector<HTMLInputElement>('input[type="file"]')!;
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

  it("retries Windows credential installation after recent-auth confirmation", async () => {
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
    const install = vi
      .spyOn(api, "installSigningCredentials")
      .mockRejectedValueOnce(new ApiError(403, "reauth", "reauth_required"))
      .mockResolvedValue({
        name: profile.name,
        revision: profile.revision,
        platform: "windows",
        configured: true,
        updatedAt: Date.now(),
      });
    vi.spyOn(api, "security").mockResolvedValue({
      passwordEnabled: true,
      email: null,
      emailAvailable: true,
      totp: { enabled: false, available: true },
      passkeys: [],
      recoveryCodesRemaining: 0,
      secondFactorEnabled: false,
      recentAuth: { valid: false, expiresAt: null, methods: ["password"] },
    });
    const reauthenticate = vi.spyOn(api, "reauthenticate").mockResolvedValue({
      recentAuthAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    });
    const mounted = await mountAt("/_verify/signing-reauth", "/_verify/signing-reauth", () =>
      h(AccountRunnerSigningProfiles, { repositoryId: "runner-repository" })
    );
    await settle();
    findButton(mounted.root, "Enter Windows credentials").click();
    await settle();
    fill(
      mounted.root.querySelector<HTMLInputElement>("#runner-signing-windows-tenant-release")!,
      "11111111-1111-4111-8111-111111111111"
    );
    fill(
      mounted.root.querySelector<HTMLInputElement>("#runner-signing-windows-client-release")!,
      "22222222-2222-4222-8222-222222222222"
    );
    fill(
      mounted.root.querySelector<HTMLInputElement>("#runner-signing-windows-secret-release")!,
      "test-client-secret"
    );
    submit(mounted.root.querySelector<HTMLFormElement>(".windows-credentials-form")!);
    await settle();
    expect(install).toHaveBeenCalledTimes(1);
    expect(mounted.root.textContent).toContain("Confirm it is you");

    fill(
      mounted.root.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!,
      "recent-auth-test"
    );
    submit(mounted.root.querySelector<HTMLFormElement>(".box-form")!);
    await settle();
    expect(reauthenticate).toHaveBeenCalledWith({
      method: "password",
      password: "recent-auth-test",
    });
    expect(install).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenLastCalledWith("runner-repository", "release", "windows", {
      tenant_id: "11111111-1111-4111-8111-111111111111",
      client_id: "22222222-2222-4222-8222-222222222222",
      client_secret: "test-client-secret",
    });
    expect(mounted.root.querySelector(".windows-credentials-form")).toBeNull();
    expect(mounted.root.textContent).not.toContain("test-client-secret");
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
