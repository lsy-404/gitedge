import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import PullMergeAutomation from "../../apps/web/src/components/PullMergeAutomation.vue";
import { i18n } from "../../apps/web/src/i18n";
import { ApiError, api } from "../../apps/web/src/lib/api";
import { clearSession } from "../../apps/web/src/lib/session";
import type {
  AutoMergeStatus,
  PullMergeQueueStatus,
} from "../../packages/contracts/src/auto-merge";
import { findButton, mountAt, settle, unmountAll } from "./task-support";

const HEAD = "a".repeat(40);
const off: AutoMergeStatus = {
  enabled: false,
  method: null,
  enabledBy: null,
  enabledAt: null,
  expectedHeadOid: null,
  waitingOn: null,
};
const noQueue: PullMergeQueueStatus = {
  required: false,
  position: null,
  length: 0,
  processing: false,
};

function mountPanel(onQueueRequired?: (required: boolean) => void) {
  return mountAt("/_verify/merge-automation", "/_verify/merge-automation", () =>
    h(PullMergeAutomation, {
      repositoryId: "repo-1",
      number: 4,
      headOid: HEAD,
      method: "squash",
      draft: false,
      onQueueRequired,
    })
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

describe("PullMergeAutomation", () => {
  it("enables auto-merge with the selected method and the shown head", async () => {
    vi.spyOn(api, "pullMergeQueue").mockResolvedValue(noQueue);
    const status = vi.spyOn(api, "autoMerge").mockResolvedValue(off);
    const enable = vi.spyOn(api, "enableAutoMerge").mockResolvedValue({
      ...off,
      enabled: true,
      method: "squash",
      enabledBy: "example-user",
    });
    const mounted = await mountPanel();

    status.mockResolvedValue({
      ...off,
      enabled: true,
      method: "squash",
      enabledBy: "example-user",
      expectedHeadOid: HEAD,
      waitingOn: { code: "approvals_required", message: "server text" },
    });
    findButton(mounted.root, "Enable auto-merge").click();
    await settle();

    expect(enable).toHaveBeenCalledWith("repo-1", 4, { method: "squash", expectedHeadOid: HEAD });
    const text = mounted.root.textContent ?? "";
    expect(text).toContain("example-user enabled auto-merge (Squash and merge)");
    expect(text).toContain("The current commit needs more human approvals before it can merge.");
    expect(text).not.toContain("server text");
  });

  it("shows the queue position and reports a busy entry when removal is refused", async () => {
    vi.spyOn(api, "autoMerge").mockResolvedValue(off);
    vi.spyOn(api, "pullMergeQueue").mockResolvedValue({
      required: true,
      position: 2,
      length: 3,
      processing: false,
    });
    vi.spyOn(api, "dequeuePull").mockRejectedValue(
      new ApiError(409, "The pull request is being merged right now.", "conflict")
    );
    const required = vi.fn();
    const mounted = await mountPanel(required);

    expect(required).toHaveBeenCalledWith(true);
    expect(mounted.root.textContent).toContain("Position 2 of 3 in the queue");
    expect(mounted.root.textContent).not.toContain("Enable auto-merge");
    findButton(mounted.root, "Remove from queue").click();
    await settle();
    expect(mounted.root.textContent).toContain(
      "This pull request is being merged and cannot be removed right now."
    );
  });

  it("explains why the queue refused a pull request", async () => {
    vi.spyOn(api, "autoMerge").mockResolvedValue(off);
    vi.spyOn(api, "pullMergeQueue").mockResolvedValue({ ...noQueue, required: true });
    vi.spyOn(api, "enqueuePull").mockRejectedValue(
      new ApiError(409, "server text", "checks_required")
    );
    const mounted = await mountPanel();
    findButton(mounted.root, "Add to merge queue").click();
    await settle();
    const text = mounted.root.textContent ?? "";
    expect(text).toContain(
      "Could not update the merge queue. The current commit needs a passing check."
    );
  });
});
