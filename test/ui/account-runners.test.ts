import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import AccountRunners from "../../apps/web/src/components/AccountRunners.vue";
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
    await settle();
    expect(mounted.root.textContent).toContain("Request failed. Try again later.");
    findButton(mounted.root, "Retry").click();
    await settle();
    expect(get).toHaveBeenCalledTimes(2);
    expect(mounted.root.textContent).toContain("No account Runner repository exists yet.");
  });
});
