import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RepositoryPages from "../../apps/web/src/components/RepositoryPages.vue";
import { i18n } from "../../apps/web/src/i18n";
import { api } from "../../apps/web/src/lib/api";
import type { PagesSettings } from "../../packages/contracts/src/pages";
import { control, fill, findButton, h, mountAt, settle, unmountAll } from "./task-support";

const oid = "a".repeat(40);
const pages: PagesSettings = {
  enabled: true,
  available: true,
  branch: "main",
  folder: "/",
  notFoundPath: "404.html",
  spaFallback: false,
  lastPublishedOid: oid,
  lastPublishedAt: 1_790_000_000_000,
  pathUrl: "/owner/site/-/site/",
  hostUrl: "https://owner.sites.example.com/site/",
  canManage: true,
};

beforeEach(() => {
  i18n.global.locale.value = "en";
  vi.spyOn(api, "refs").mockResolvedValue([
    { name: "refs/heads/main", oid },
    { name: "refs/heads/gh-pages", oid },
  ]);
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function mountPages(props: Partial<{ canManage: boolean; pagesEnabled: boolean }> = {}) {
  return mountAt("/_verify/pages", "/_verify/pages", () =>
    h(RepositoryPages, {
      repositoryId: "repo-1",
      owner: "owner",
      name: "site",
      canManage: true,
      pagesEnabled: true,
      ...props,
    })
  );
}

describe("repository pages settings", () => {
  it("shows the live url, the path url and the last published commit", async () => {
    vi.spyOn(api, "pagesSettings").mockResolvedValue({ ...pages });
    const mounted = await mountPages();
    const text = mounted.root.textContent ?? "";
    expect(text).toContain("https://owner.sites.example.com/site/");
    expect(text).toContain("/owner/site/-/site/");
    expect(text).toContain(oid.slice(0, 12));
    const links = [...mounted.root.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links).toContain(`${window.location.origin}/owner/site/-/preview/${oid}/`);
    mounted.unmount();
  });

  it("saves edited settings", async () => {
    vi.spyOn(api, "pagesSettings").mockResolvedValue({ ...pages, hostUrl: null });
    const save = vi
      .spyOn(api, "updatePages")
      .mockResolvedValue({ ...pages, hostUrl: null, folder: "/docs", spaFallback: true });
    const mounted = await mountPages();
    fill(control(mounted.root, "#pages-folder"), "docs");
    await settle();
    findButton(mounted.root, "Save Pages settings").click();
    await settle();
    expect(save).toHaveBeenCalledWith("repo-1", {
      branch: "main",
      folder: "/docs",
      notFoundPath: "404.html",
      spaFallback: false,
    });
    expect(mounted.root.textContent).toContain("Pages settings saved.");
    mounted.unmount();
  });

  it("warns that private repositories cannot publish", async () => {
    vi.spyOn(api, "pagesSettings").mockResolvedValue({
      ...pages,
      enabled: false,
      available: false,
    });
    const mounted = await mountPages({ pagesEnabled: false });
    expect(mounted.root.textContent).toContain("public repositories only");
    mounted.unmount();
  });
});
