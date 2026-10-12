import { afterEach, describe, expect, it, vi } from "vitest";
import { h, nextTick, ref } from "vue";
import PullMergeRequirements from "../../apps/web/src/components/PullMergeRequirements.vue";
import { api } from "../../apps/web/src/lib/api";
import { i18n } from "../../apps/web/src/i18n";
import type { MergeRequirements } from "../../packages/contracts/src/merge-requirements";
import { mountAt, settle, unmountAll } from "./task-support";

const HEAD = "a".repeat(40);
const result: MergeRequirements = {
  headOid: HEAD,
  ready: false,
  requirements: [
    {
      id: "approvals",
      status: "unsatisfied",
      detail: "server explanation",
      actualCount: 0,
      requiredCount: 1,
    },
    { id: "required_checks", status: "unsatisfied", detail: "server explanation" },
    { id: "no_conflicts", status: "checked_at_merge", detail: "server explanation" },
  ],
  excludedApprovals: [{ name: "example-reviewer", reason: "last_pusher" }],
};
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Shared merge requirements", () => {
  it("renders simultaneous server conditions, excluded approvals and merge-time checks in the selected language", async () => {
    i18n.global.locale.value = "en";
    const read = vi.spyOn(api, "mergeRequirements").mockResolvedValue(result);
    const evaluated = vi.fn();
    const mounted = await mountAt("/_verify/requirements", "/_verify/requirements", () =>
      h(PullMergeRequirements, {
        repositoryId: "repo-1",
        number: 1,
        headOid: HEAD,
        method: "squash",
        onEvaluated: evaluated,
      })
    );
    expect(read).toHaveBeenCalledWith("repo-1", 1, HEAD, "squash");
    expect(mounted.root.textContent).toContain("0 of 1 approvals");
    expect(mounted.root.textContent).toContain("Required named checks — Not satisfied");
    expect(mounted.root.textContent).toContain("No merge conflicts — Checked at merge");
    expect(mounted.root.textContent).toContain("last pusher of this head");
    expect(mounted.root.textContent).not.toContain("server explanation");
    expect(evaluated).toHaveBeenLastCalledWith(false);
    i18n.global.locale.value = "zh-CN";
    await nextTick();
    expect(mounted.root.textContent).toContain("合并时检查");
    expect(mounted.root.textContent).toContain("最后推送者");
  });

  it("does not accept an earlier head's ready result after the selection changes", async () => {
    let finishOld: ((value: MergeRequirements) => void) | undefined;
    const first = new Promise<MergeRequirements>((resolve) => {
      finishOld = resolve;
    });
    vi.spyOn(api, "mergeRequirements").mockImplementation(async (_repo, _number, oid) =>
      oid === HEAD ? first : result
    );
    const head = ref(HEAD);
    const evaluated = vi.fn();
    const mounted = await mountAt("/_verify/requirements", "/_verify/requirements", () =>
      h(PullMergeRequirements, {
        repositoryId: "repo-1",
        number: 1,
        headOid: head.value,
        method: "squash",
        onEvaluated: evaluated,
      })
    );
    head.value = "b".repeat(40);
    await settle();
    finishOld?.({ ...result, ready: true });
    await settle();
    expect(evaluated).not.toHaveBeenCalledWith(true);
    expect(mounted.root.textContent).toContain("0");
  });
});
