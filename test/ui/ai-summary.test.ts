import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import PullRequestAiSummary from "../../apps/web/src/components/PullRequestAiSummary.vue";
import RepositorySettings from "../../apps/web/src/components/RepositorySettings.vue";
import { i18n } from "../../apps/web/src/i18n";
import aiSummaryMessages from "../../apps/web/src/i18n/aiSummary";
import { ApiError, api } from "../../apps/web/src/lib/api";
import { clearSession } from "../../apps/web/src/lib/session";
import type { AiSummaryState } from "../../packages/contracts/src/ai-summary";
import type { Repository } from "../../packages/contracts/src/forge";
import type { RepositorySettings as Settings } from "../../packages/contracts/src/tasks";
import { findButton, mountAt, repository, settle, unmountAll } from "./task-support";

vi.mock("../../apps/web/src/components/AppIcon.vue", () => ({
  default: { template: "<span />" },
}));

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function state(overrides: Partial<AiSummaryState> = {}): AiSummaryState {
  return {
    unavailable: null,
    job: null,
    summary: {
      id: "s1",
      author: { kind: "system", name: "AI summary" },
      headOid: HEAD,
      model: "@cf/test/model",
      truncated: false,
      generatedAt: 1_700_000_000_000,
      content: {
        overview: "Renames a helper.",
        notableChanges: ["Renamed helper"],
        riskAreas: ["Callers outside the repository"],
        reviewerFocus: [],
      },
    },
    ...overrides,
  };
}

function mountPanel(repo: Repository = repository, headOid = HEAD, open = true) {
  return mountAt("/acme/:repo/pulls/:number", "/acme/project/pulls/3", () =>
    h(PullRequestAiSummary, { repository: repo, number: 3, headOid, open })
  );
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

describe("PullRequestAiSummary", () => {
  it("renders nothing when the feature is unavailable", async () => {
    vi.spyOn(api, "aiSummary").mockResolvedValue({
      unavailable: "site_disabled",
      summary: null,
      job: null,
    });
    const mounted = await mountPanel();
    expect(mounted.root.querySelector(".ai-summary")).toBeNull();
  });

  it("labels the summary as a system note that is not a review", async () => {
    vi.spyOn(api, "aiSummary").mockResolvedValue(state());
    const mounted = await mountPanel();
    const text = mounted.root.textContent ?? "";
    expect(text).toContain("AI summary — not a review, does not count as approval.");
    expect(text).toContain("Not a review");
    expect(text).toContain("Renames a helper.");
    expect(text).toContain("Callers outside the repository");
    expect(text).not.toContain("Reviewer focus");
    expect(mounted.root.querySelector(".fluent-notice")).toBeNull();
  });

  it("warns about truncation and an outdated head", async () => {
    const base = state();
    vi.spyOn(api, "aiSummary").mockResolvedValue({
      ...base,
      summary: base.summary && { ...base.summary, truncated: true, headOid: OLD },
    });
    const mounted = await mountPanel();
    const text = mounted.root.textContent ?? "";
    expect(text).toContain("saw only part of it");
    expect(text).toContain("bbbbbbbb");
  });

  it("shows a generating state and a failure", async () => {
    vi.spyOn(api, "aiSummary").mockResolvedValue(
      state({ summary: null, job: { status: "running", errorCode: null, updatedAt: 1 } })
    );
    const running = await mountPanel();
    expect(running.root.textContent).toContain("being generated");
    expect(findButton(running.root, "Generating").disabled).toBe(true);
    running.unmount();

    vi.spyOn(api, "aiSummary").mockResolvedValue(
      state({ summary: null, job: { status: "failed", errorCode: "rate_limited", updatedAt: 1 } })
    );
    const failed = await mountPanel();
    expect(failed.root.textContent).toContain("hourly summary limit");
  });

  it("offers regenerate only to writers of an open pull request", async () => {
    vi.spyOn(api, "aiSummary").mockResolvedValue(state());
    const readOnly = await mountPanel({ ...repository, canWrite: false });
    expect(readOnly.root.querySelector("button.fluent-button")).toBeNull();
    readOnly.unmount();
    const closed = await mountPanel(repository, HEAD, false);
    expect(closed.root.querySelector("button.fluent-button")).toBeNull();
    closed.unmount();

    const regenerate = vi
      .spyOn(api, "regenerateAiSummary")
      .mockResolvedValue(state({ job: { status: "queued", errorCode: null, updatedAt: 2 } }));
    const writer = await mountPanel();
    findButton(writer.root, "Regenerate").click();
    await settle();
    expect(regenerate).toHaveBeenCalledWith(repository.id, 3);
    expect(writer.root.textContent).toContain("being generated");
  });

  it("explains a rejected regeneration", async () => {
    vi.spyOn(api, "aiSummary").mockResolvedValue(state());
    vi.spyOn(api, "regenerateAiSummary").mockRejectedValue(
      new ApiError(429, "limit", "rate_limited", { retryAfter: 120 })
    );
    const mounted = await mountPanel();
    findButton(mounted.root, "Regenerate").click();
    await settle();
    expect(mounted.root.textContent).toContain("120");
  });

  it("has English and Chinese text for every key", () => {
    expect(Object.keys(aiSummaryMessages.en).sort()).toEqual(
      Object.keys(aiSummaryMessages["zh-CN"]).sort()
    );
  });
});

describe("AI summary repository settings", () => {
  const settings: Settings = {
    name: "project",
    slug: "project",
    description: "",
    visibility: "public",
    defaultBranch: "main",
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
    aiSummariesAvailable: true,
    aiSummariesEnabled: false,
    aiSummariesPrivateConsent: false,
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
  beforeAll(() => {
    for (const method of ["showPopover", "hidePopover", "scrollIntoView"])
      Object.defineProperty(HTMLElement.prototype, method, { configurable: true, value() {} });
  });
  beforeEach(() => {
    vi.spyOn(api, "refs").mockResolvedValue([{ name: "refs/heads/main", oid: HEAD }]);
  });
  async function mountSettings(value: Settings) {
    vi.spyOn(api, "repositorySettings").mockResolvedValue(value);
    const mounted = await mountAt("/acme/:repo/settings", "/acme/project/settings", () =>
      h(RepositorySettings, { repository: { ...repository, visibility: value.visibility } })
    );
    Array.from(mounted.root.querySelectorAll<HTMLElement>(".settings-nav button"))
      .find((button) => button.textContent?.trim() === "Features")
      ?.click();
    await settle();
    return mounted;
  }

  it("hides the toggle when the site cannot run summaries", async () => {
    const mounted = await mountSettings({ ...settings, aiSummariesAvailable: false });
    expect(mounted.root.textContent).not.toContain("AI pull request summaries");
  });

  it("shows the cost and privacy note, and no consent for public repositories", async () => {
    const mounted = await mountSettings(settings);
    expect(mounted.root.textContent).toContain("AI pull request summaries");
    expect(mounted.root.textContent).toContain("sent to Workers AI inside this Cloudflare account");
    expect(mounted.root.textContent).not.toContain("private repository's code diffs");
  });

  it("asks for explicit consent before a private repository can be enabled", async () => {
    const mounted = await mountSettings({ ...settings, visibility: "private" });
    expect(mounted.root.textContent).toContain("private repository's code diffs");
    const switches = mounted.root.querySelectorAll<HTMLElement>("[role='switch']");
    const enable = Array.from(switches).find((item) =>
      item.closest(".settings-row")?.textContent?.includes("Generate a summary with Workers AI")
    );
    enable?.click();
    await settle();
    expect(mounted.root.textContent).toContain("needs the consent to send code diffs");
    expect(mounted.root.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(
      true
    );
  });

  it("blocks saving a private repository whose stored summaries lack consent", async () => {
    const mounted = await mountSettings({
      ...settings,
      visibility: "private",
      aiSummariesEnabled: true,
      aiSummariesPrivateConsent: false,
    });
    expect(mounted.root.textContent).toContain("needs the consent to send code diffs");
    expect(mounted.root.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(
      true
    );
  });
});
