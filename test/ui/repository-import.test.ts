import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { i18n } from "../../apps/web/src/i18n";
import { api } from "../../apps/web/src/lib/api";
import { fluentUi } from "../../apps/web/src/ui/fluent";
import { router } from "../../apps/web/src/router";
import RepositoryImportDialog from "../../apps/web/src/components/RepositoryImportDialog.vue";
import type { RepositoryImport } from "../../packages/contracts/src/imports";

const base: RepositoryImport = {
  id: "job-1",
  owner: "acme",
  slug: "widgets",
  visibility: "private",
  description: "",
  sourceUrl: "https://example.com/acme/widgets.git",
  status: "queued",
  progress: "queued",
  errorCode: null,
  error: null,
  attempt: 0,
  repositoryId: null,
  createdAt: 1,
  updatedAt: 1,
  finishedAt: null,
};
const unmounts: Array<() => void> = [];

async function mount() {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(RepositoryImportDialog, {
    open: true,
    owners: [{ value: "acme", label: "Acme" }],
    defaultOwner: "acme",
  });
  app.use(i18n).use(router).use(fluentUi);
  app.mount(root);
  unmounts.push(() => {
    app.unmount();
    root.remove();
  });
  await nextTick();
  return root;
}
async function type(root: HTMLElement, selector: string, value: string) {
  const input = root.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`missing ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  return input;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const unmount of unmounts.splice(0)) unmount();
});

describe("Repository import dialog", () => {
  it("fills the name from the URL, polls to failure and retries", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "repositoryImports").mockResolvedValue([]);
    const start = vi.spyOn(api, "importRepository").mockResolvedValue(base);
    const status = vi
      .spyOn(api, "repositoryImport")
      .mockResolvedValue({ ...base, status: "failed", errorCode: "upstream_unavailable" });
    const retry = vi
      .spyOn(api, "retryRepositoryImport")
      .mockResolvedValue({ ...base, status: "running", attempt: 2 });
    const root = await mount();
    await type(root, "input[type=url]", "https://github.com/acme/Widgets.git");
    const name = root.querySelectorAll<HTMLInputElement>("input")[1];
    expect(name.value).toBe("widgets");
    root.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", slug: "widgets", visibility: "private" })
    );
    await vi.advanceTimersByTimeAsync(2100);
    expect(status).toHaveBeenCalledWith("job-1");
    expect(root.textContent).toContain(i18n.global.t("importError_upstream_unavailable"));
    const retryButton = [...root.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === i18n.global.t("importRetry")
    );
    retryButton?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(retry).toHaveBeenCalledWith("job-1");
    expect(root.textContent).toContain(i18n.global.t("importRunning"));
  });
  it("lists unfinished imports and resumes polling one", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "repositoryImports").mockResolvedValue([
      { ...base, status: "running", progress: "starting", attempt: 1 },
    ]);
    const status = vi
      .spyOn(api, "repositoryImport")
      .mockResolvedValue({ ...base, status: "running", progress: "importing", attempt: 1 });
    const root = await mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.textContent).toContain(i18n.global.t("importUnfinished"));
    const view = [...root.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === i18n.global.t("importView")
    );
    view?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.textContent).toContain(i18n.global.t("importStarting"));
    await vi.advanceTimersByTimeAsync(2100);
    expect(status).toHaveBeenCalledWith("job-1");
    expect(root.textContent).toContain(i18n.global.t("importRunning"));
  });
});
