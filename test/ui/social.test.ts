import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExploreView from "../../apps/web/src/pages/ExploreView.vue";
import StarredView from "../../apps/web/src/pages/StarredView.vue";
import RepositoryForkOrigin from "../../apps/web/src/components/RepositoryForkOrigin.vue";
import RepositoryForks from "../../apps/web/src/components/RepositoryForks.vue";
import RepositorySocialBar from "../../apps/web/src/components/RepositorySocialBar.vue";
import RepositoryTopicsEditor from "../../apps/web/src/components/RepositoryTopicsEditor.vue";
import { i18n } from "../../apps/web/src/i18n";
import { ApiError, api, type ExploreRepository, type Repository } from "../../apps/web/src/lib/api";
import { fill, h, mountAt, repository, settle, submit, unmountAll } from "./task-support";

function item(overrides: Partial<ExploreRepository> = {}): ExploreRepository {
  return {
    id: "r1",
    owner: "acme",
    name: "lib",
    description: "A library",
    topics: ["rust", "cli"],
    starCount: 3,
    updatedAt: 1_790_000_000_000,
    forkOf: null,
    ...overrides,
  };
}
function button(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((candidate) =>
    candidate.textContent?.replace(/\s+/g, " ").includes(text)
  );
  if (!found) throw new Error(`Could not find button containing: ${text}`);
  return found;
}

beforeEach(() => {
  i18n.global.locale.value = "en";
  vi.spyOn(api, "exploreTopics").mockResolvedValue([{ topic: "rust", repositories: 4 }]);
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("explore page", () => {
  it("lists repositories with topics, stars and fork origin, and pages by cursor", async () => {
    const explore = vi
      .spyOn(api, "explore")
      .mockResolvedValueOnce({
        items: [
          item(),
          item({ id: "r2", name: "fork", forkOf: { id: "r1", owner: "acme", name: "lib" } }),
        ],
        nextCursor: "9:r2",
      })
      .mockResolvedValueOnce({ items: [item({ id: "r3", name: "third" })], nextCursor: null });
    const mounted = await mountAt("/_verify/explore", "/_verify/explore", () => h(ExploreView));
    const links = Array.from(mounted.root.querySelectorAll<HTMLAnchorElement>(".box a")).map((a) =>
      a.getAttribute("href")
    );
    expect(links).toContain("/acme/lib");
    expect(mounted.root.textContent).toContain("3 stars");
    expect(mounted.root.textContent).toContain("Forked from");
    expect(mounted.root.querySelector("a.topic-chip")?.getAttribute("href")).toContain(
      "topic=rust"
    );
    button(mounted.root, "Load more").click();
    await settle();
    expect(explore).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "9:r2" }));
    expect(mounted.root.querySelectorAll(".box article")).toHaveLength(3);
    expect(mounted.root.textContent).not.toContain("Load more");
  });

  it("applies the topic and sort filters from the address", async () => {
    const explore = vi.spyOn(api, "explore").mockResolvedValue({ items: [], nextCursor: null });
    const mounted = await mountAt(
      "/_verify/explore-filtered",
      "/_verify/explore-filtered?topic=rust&sort=stars&q=lib",
      () => h(ExploreView)
    );
    expect(explore).toHaveBeenCalledWith({
      sort: "stars",
      q: "lib",
      topic: "rust",
      cursor: undefined,
    });
    expect(mounted.root.textContent).toContain("Topic: rust");
    expect(mounted.root.textContent).toContain("No public repositories match.");
  });

  it("reports a load failure with retry", async () => {
    vi.spyOn(api, "explore").mockRejectedValue(new Error("offline"));
    const mounted = await mountAt("/_verify/explore-error", "/_verify/explore-error", () =>
      h(ExploreView)
    );
    expect(mounted.root.textContent).toContain("Public repositories could not be loaded.");
  });
});

describe("starred page", () => {
  it("shows the empty state and the starred list", async () => {
    vi.spyOn(api, "starredRepositories").mockResolvedValueOnce({ items: [], nextCursor: null });
    const empty = await mountAt("/_verify/stars-empty", "/_verify/stars-empty", () =>
      h(StarredView)
    );
    expect(empty.root.textContent).toContain("You have not starred any repository yet.");
    empty.unmount();
    vi.spyOn(api, "starredRepositories").mockResolvedValue({ items: [item()], nextCursor: null });
    const full = await mountAt("/_verify/stars-full", "/_verify/stars-full", () => h(StarredView));
    expect(full.root.textContent).toContain("acme/lib");
  });
});

describe("repository social bar", () => {
  const state = {
    starCount: 1,
    starred: false,
    watchLevel: "participating",
    forkCount: 2,
  } as const;

  it("stars, unstars and changes the watch level", async () => {
    vi.spyOn(api, "repositorySocial").mockResolvedValue(state);
    const setStar = vi
      .spyOn(api, "setStar")
      .mockResolvedValueOnce({ ...state, starCount: 2, starred: true })
      .mockResolvedValueOnce(state);
    const watch = vi.spyOn(api, "setWatchLevel").mockResolvedValue({ ...state, watchLevel: "all" });
    const mounted = await mountAt("/_verify/social", "/_verify/social", () =>
      h(RepositorySocialBar, { repository })
    );
    const star = button(mounted.root, "Star");
    expect(star.getAttribute("aria-pressed")).toBe("false");
    star.click();
    await settle();
    expect(setStar).toHaveBeenLastCalledWith(repository.id, true);
    expect(button(mounted.root, "Starred").getAttribute("aria-pressed")).toBe("true");
    expect(mounted.root.textContent).toContain("2");
    button(mounted.root, "Starred").click();
    await settle();
    expect(setStar).toHaveBeenLastCalledWith(repository.id, false);

    const select = mounted.root.querySelector("select");
    if (!select) throw new Error("Missing watch select");
    fill(select, "all");
    await settle();
    expect(watch).toHaveBeenCalledWith(repository.id, "all");
    expect(select.value).toBe("all");
    expect(mounted.root.querySelector("a[href$='/forks']")?.textContent).toContain("2");
  });

  it("reports a failed star", async () => {
    vi.spyOn(api, "repositorySocial").mockResolvedValue(state);
    vi.spyOn(api, "setStar").mockRejectedValue(new ApiError(500, "boom"));
    const mounted = await mountAt("/_verify/social-error", "/_verify/social-error", () =>
      h(RepositorySocialBar, { repository })
    );
    button(mounted.root, "Star").click();
    await settle();
    expect(mounted.root.querySelector("[role='alert']")?.textContent).toBe(
      "The star could not be updated."
    );
  });
});

describe("forks", () => {
  const fork: Repository = {
    ...repository,
    id: "fork-1",
    owner: "octo",
    name: "project",
    slug: "project",
    forkOf: { id: repository.id, owner: repository.owner, name: repository.name },
  };

  it("lists forks and creates one into a chosen owner", async () => {
    vi.spyOn(api, "forks").mockResolvedValue({ items: [fork], truncated: false });
    vi.spyOn(api, "organizations").mockResolvedValue([
      { slug: "guild", displayName: "Guild", role: "owner" },
      { slug: "club", displayName: "Club", role: "member" },
    ]);
    const create = vi.spyOn(api, "forkRepository").mockResolvedValue(fork);
    const mounted = await mountAt("/_verify/forks", "/_verify/forks", () =>
      h(RepositoryForks, { repository })
    );
    expect(mounted.root.textContent).toContain("octo/project");
    const options = Array.from(mounted.root.querySelectorAll("select option")).map(
      (option) => option.textContent
    );
    expect(options).toEqual(["user@example.test", "guild"]);
    const select = mounted.root.querySelector("select");
    if (!select) throw new Error("Missing owner select");
    fill(select, "guild");
    const form = mounted.root.querySelector<HTMLElement>("form.fork-form");
    if (!form) throw new Error("Missing fork form");
    submit(form);
    await settle();
    expect(create).toHaveBeenCalledWith(repository.id, { owner: "guild", name: "project" });
  });

  it("offers only the caller's account and the parent's organization for a private repository", async () => {
    vi.spyOn(api, "forks").mockResolvedValue({ items: [], truncated: false });
    vi.spyOn(api, "organizations").mockResolvedValue([
      { slug: "guild", displayName: "Guild", role: "owner" },
      { slug: repository.owner, displayName: "Parent", role: "owner" },
    ]);
    vi.spyOn(api, "forkRepository").mockRejectedValue(
      new ApiError(403, "not allowed", "fork_owner_not_allowed")
    );
    const mounted = await mountAt("/_verify/forks-private", "/_verify/forks-private", () =>
      h(RepositoryForks, { repository: { ...repository, visibility: "private" } })
    );
    const options = Array.from(mounted.root.querySelectorAll("select option")).map(
      (option) => option.textContent
    );
    expect(options).toEqual(["user@example.test", repository.owner]);
    const form = mounted.root.querySelector<HTMLElement>("form.fork-form");
    if (!form) throw new Error("Missing fork form");
    submit(form);
    await settle();
    expect(mounted.root.textContent).toContain(
      "A private repository can only be forked into your own account"
    );
  });

  it("explains a taken name", async () => {
    vi.spyOn(api, "forks").mockResolvedValue({ items: [], truncated: false });
    vi.spyOn(api, "organizations").mockResolvedValue([]);
    vi.spyOn(api, "forkRepository").mockRejectedValue(new ApiError(409, "conflict", "conflict"));
    const mounted = await mountAt("/_verify/forks-taken", "/_verify/forks-taken", () =>
      h(RepositoryForks, { repository })
    );
    expect(mounted.root.textContent).toContain("No visible forks yet.");
    const form = mounted.root.querySelector<HTMLElement>("form.fork-form");
    if (!form) throw new Error("Missing fork form");
    submit(form);
    await settle();
    expect(mounted.root.textContent).toContain(
      "That owner already has a repository with this name."
    );
  });

  it("syncs a fork and links to a pull request against the upstream", async () => {
    const sync = vi
      .spyOn(api, "syncFork")
      .mockResolvedValueOnce({ status: "fast_forwarded", branch: "main", oid: "a".repeat(40) })
      .mockRejectedValueOnce(new ApiError(409, "diverged", "not_fast_forward"));
    const mounted = await mountAt("/_verify/fork-origin", "/_verify/fork-origin", () =>
      h(RepositoryForkOrigin, { repository: fork })
    );
    const pull = mounted.root.querySelector<HTMLAnchorElement>("a.btn[href*='/pulls']");
    expect(pull?.getAttribute("href")).toContain("headRepositoryId=fork-1");
    expect(pull?.getAttribute("href")).toContain("/acme/project/pulls");
    button(mounted.root, "Sync fork").click();
    await settle();
    expect(sync).toHaveBeenCalledWith("fork-1", "main");
    expect(mounted.root.textContent).toContain("Fast-forwarded main");
    button(mounted.root, "Sync fork").click();
    await settle();
    expect(mounted.root.querySelector("[role='alert']")?.textContent).toContain("diverged");
  });

  it("renders nothing for a repository that is not a fork", async () => {
    const mounted = await mountAt("/_verify/fork-none", "/_verify/fork-none", () =>
      h(RepositoryForkOrigin, { repository })
    );
    expect(mounted.root.querySelector(".repository-fork-origin")).toBeNull();
  });
});

describe("topics editor", () => {
  it("validates and saves normalized topics", async () => {
    const save = vi
      .spyOn(api, "setRepositoryTopics")
      .mockResolvedValue({ topics: ["cli", "rust"] });
    const mounted = await mountAt("/_verify/topics", "/_verify/topics", () =>
      h(RepositoryTopicsEditor, { repository })
    );
    const input = mounted.root.querySelector("input");
    if (!input) throw new Error("Missing topics input");
    fill(input, "Rust, cli rust");
    await settle();
    expect(mounted.root.querySelectorAll("a.topic-chip")).toHaveLength(2);
    submit(mounted.root.querySelector<HTMLElement>("form") ?? mounted.root);
    await settle();
    expect(save).toHaveBeenCalledWith(repository.id, ["rust", "cli"]);
    expect(mounted.root.textContent).toContain("Topics saved.");

    fill(input, "bad_topic");
    await settle();
    expect(mounted.root.textContent).toContain("lowercase letters, digits and hyphens");
    expect(button(mounted.root, "Save topics").disabled).toBe(true);
    fill(input, Array.from({ length: 21 }, (_, index) => `t${index}`).join(" "));
    await settle();
    expect(button(mounted.root, "Save topics").disabled).toBe(true);
  });
});
