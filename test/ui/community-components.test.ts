import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import CommunityTemplatePicker from "../../apps/web/src/components/CommunityTemplatePicker.vue";
import RepositoryCommunityView from "../../apps/web/src/components/RepositoryCommunity.vue";
import UserProfileView from "../../apps/web/src/pages/UserProfileView.vue";
import { i18n } from "../../apps/web/src/i18n";
import { api, type PublicProfile } from "../../apps/web/src/lib/api";
import type {
  RepositoryCommunity,
  RepositoryCommunityFile,
} from "../../packages/contracts/src/repository-controls";
import { control, findButton, mountAt, repository, settle, unmountAll } from "./task-support";

const sourceFile: RepositoryCommunityFile = {
  kind: "security",
  title: "Security policy",
  repositoryId: "github-repo",
  owner: "octocat",
  repository: ".github",
  ref: "main",
  path: "SECURITY.md",
  inherited: true,
  content: "<script>alert('not executable')</script>\n\n[unsafe](javascript:alert(1))",
  truncated: false,
};
const community: RepositoryCommunity = {
  files: [sourceFile],
  issueTemplates: [],
  pullRequestTemplate: null,
  truncated: false,
};

beforeEach(() => {
  i18n.global.locale.value = "en";
});

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("repository community files", () => {
  it("shows inherited source links and sanitizes community markdown", async () => {
    vi.spyOn(api, "repositoryCommunity").mockResolvedValue(structuredClone(community));
    const mounted = await mountAt("/_verify/community", "/_verify/community", () =>
      h(RepositoryCommunityView, { repositoryId: "repo-1", refName: "main" })
    );

    expect(mounted.root.textContent).toContain("Inherited from octocat/.github");
    expect(mounted.root.querySelector(".community-source")?.getAttribute("href")).toBe(
      "/octocat/.github/blob/SECURITY.md?ref=main"
    );
    control(mounted.root, ".community-file summary").click();
    await settle();
    expect(mounted.root.querySelector(".markdown-body script")).toBeNull();
    for (const link of mounted.root.querySelectorAll<HTMLAnchorElement>(".markdown-body a"))
      expect(link.href.startsWith("javascript:")).toBe(false);
    mounted.unmount();
  });

  it("warns when the response or an individual resource is truncated", async () => {
    const partialFile = { ...sourceFile, truncated: true };
    const partialResponse = { ...community, files: [partialFile], truncated: true };
    vi.spyOn(api, "repositoryCommunity").mockResolvedValue(partialResponse);
    const mounted = await mountAt(
      "/_verify/community-truncated",
      "/_verify/community-truncated",
      () => h(RepositoryCommunityView, { repositoryId: "repo-1", refName: "main" })
    );

    expect(mounted.root.textContent).toContain(
      "Content was truncated; only a bounded portion is shown here."
    );
    expect(mounted.root.textContent).toContain("View source file");
    mounted.unmount();
  });

  it("renders the selected README only when showReadme is enabled", async () => {
    const readme: RepositoryCommunityFile = {
      kind: "readme",
      title: "README",
      repositoryId: "repo-1",
      owner: "octocat",
      repository: "project",
      ref: "main",
      path: "README.md",
      inherited: false,
      content: "# Repository README",
      truncated: false,
    };
    vi.spyOn(api, "repositoryCommunity")
      .mockResolvedValueOnce({ ...community, files: [readme] })
      .mockResolvedValueOnce({ ...community, files: [readme] });
    const defaultView = await mountAt("/_verify/readme-default", "/_verify/readme-default", () =>
      h(RepositoryCommunityView, { repositoryId: "repo-1", refName: "main" })
    );
    expect(defaultView.root.querySelector(".community-readme")).toBeNull();
    expect(defaultView.root.querySelector(".community-file summary")?.textContent).toContain(
      "README"
    );
    defaultView.unmount();

    const profileReadme = await mountAt("/_verify/profile-readme", "/_verify/profile-readme", () =>
      h(RepositoryCommunityView, {
        repositoryId: "repo-1",
        refName: "main",
        showReadme: true,
      })
    );
    expect(profileReadme.root.querySelector(".community-readme h3")?.textContent).toBe("README");
    expect(
      profileReadme.root.querySelector(".community-readme .markdown-body")?.textContent
    ).toContain("Repository README");
    expect(profileReadme.root.querySelector(".community-file-list")).toBeNull();
    profileReadme.unmount();
  });
});

describe("public user profiles", () => {
  it("renders the matching repository README safely and lists only public repositories", async () => {
    const profile: PublicProfile = {
      owner: "octocat",
      displayName: "Octocat",
      bio: "A curious developer",
      location: "Toronto",
      website: "javascript:alert(1)",
      truncated: true,
      readme: {
        content: "# About\n\n<script>alert('unsafe')</script>",
        repositoryId: repository.id,
        path: "README.md",
      },
      repositories: [
        { ...repository, owner: "octocat", name: "sample", slug: "sample" },
        {
          ...repository,
          id: "private-repo",
          owner: "octocat",
          name: "secret",
          slug: "secret",
          visibility: "private",
        },
      ],
    };
    vi.spyOn(api, "publicProfile").mockResolvedValue(profile);
    const mounted = await mountAt("/_verify/profile", "/_verify/profile", () =>
      h(UserProfileView, { owner: "octocat" })
    );

    expect(mounted.root.querySelector("h1")?.textContent).toBe("Octocat");
    expect(mounted.root.textContent).toContain("A curious developer");
    expect(mounted.root.textContent).toContain(
      "There are more public repositories than the display limit"
    );
    expect(mounted.root.textContent).toContain("octocat/sample");
    expect(mounted.root.textContent).not.toContain("octocat/secret");
    expect(mounted.root.querySelector(".profile-detail a")).toBeNull();
    expect(mounted.root.querySelector(".profile-readme script")).toBeNull();
    expect(mounted.root.querySelector(".profile-panel-heading a")?.getAttribute("href")).toBe(
      "/octocat/sample/blob/README.md?ref=main"
    );
    mounted.unmount();
  });
});

describe("community template picker", () => {
  it("uses supported issue frontmatter and emits title with the markdown body only on selection", async () => {
    const issueTemplate: RepositoryCommunityFile = {
      kind: "issue-template",
      title: "Bug report",
      repositoryId: "repo-1",
      owner: "octocat",
      repository: "project",
      ref: "main",
      path: ".github/ISSUE_TEMPLATE/bug.md",
      inherited: false,
      truncated: false,
      content:
        "---\nname: Bug report\nabout: Report a problem\ntitle: '[Bug] '\n---\n\nDescribe the bug here.",
    };
    vi.spyOn(api, "repositoryCommunity").mockResolvedValue({
      ...community,
      files: [],
      issueTemplates: [issueTemplate],
    });
    const select = vi.fn();
    const mounted = await mountAt("/_verify/issue-template", "/_verify/issue-template", () =>
      h(CommunityTemplatePicker, {
        repositoryId: "repo-1",
        refName: "main",
        kind: "issue",
        onSelect: select,
      })
    );

    expect(mounted.root.textContent).toContain("Report a problem");
    expect(mounted.root.textContent).toContain(
      "Only simple single-line YAML name, about, and title fields are read"
    );
    expect(mounted.root.querySelector(".template-source a")?.getAttribute("href")).toBe(
      "/octocat/project/blob/.github/ISSUE_TEMPLATE/bug.md?ref=main"
    );
    expect(select).not.toHaveBeenCalled();
    findButton(mounted.root, "Use template").click();
    await settle();
    expect(select).toHaveBeenCalledWith({
      title: "[Bug] ",
      body: "\nDescribe the bug here.",
    });
    mounted.unmount();
  });

  it("requires explicit pull request template selection before it changes a draft", async () => {
    const pullTemplate: RepositoryCommunityFile = {
      kind: "pull-request-template",
      title: "Default pull request",
      repositoryId: "repo-1",
      owner: "octocat",
      repository: "project",
      ref: "main",
      path: ".github/PULL_REQUEST_TEMPLATE.md",
      inherited: false,
      content: "## Summary\n\nDescribe the changes.",
      truncated: false,
    };
    vi.spyOn(api, "repositoryCommunity").mockResolvedValue({
      ...community,
      files: [],
      pullRequestTemplate: pullTemplate,
    });
    const draft = ref({ title: "Existing title", body: "Existing draft" });
    const DraftHost = defineComponent({
      setup() {
        return () =>
          h("div", [
            h(CommunityTemplatePicker, {
              repositoryId: "repo-1",
              refName: "main",
              kind: "pull-request",
              onSelect: (value: { title: string; body: string }) => {
                draft.value = value;
              },
            }),
            h("output", { id: "draft-title" }, draft.value.title),
            h("output", { id: "draft-body" }, draft.value.body),
          ]);
      },
    });
    const mounted = await mountAt("/_verify/pr-template", "/_verify/pr-template", () =>
      h(DraftHost)
    );

    expect(control(mounted.root, "#draft-title").textContent).toBe("Existing title");
    expect(control(mounted.root, "#draft-body").textContent).toBe("Existing draft");
    findButton(mounted.root, "Use template").click();
    await settle();
    expect(control(mounted.root, "#draft-title").textContent).toBe("");
    expect(control(mounted.root, "#draft-body").textContent).toBe(
      "## Summary\n\nDescribe the changes."
    );
    mounted.unmount();
  });

  it("shows empty states and disables unsupported YAML issue forms", async () => {
    vi.spyOn(api, "repositoryCommunity")
      .mockResolvedValueOnce({ ...community, issueTemplates: [] })
      .mockResolvedValueOnce({ ...community, pullRequestTemplate: null })
      .mockResolvedValueOnce({
        ...community,
        issueTemplates: [
          {
            ...sourceFile,
            kind: "issue-form",
            title: "Bug form",
            path: ".github/ISSUE_TEMPLATE/bug.yml",
            content: "name: Bug\ndescription: Report a bug\nbody: []",
          },
        ],
      });
    const empty = await mountAt("/_verify/no-templates", "/_verify/no-templates", () =>
      h(CommunityTemplatePicker, {
        repositoryId: "repo-1",
        refName: "main",
        kind: "issue",
      })
    );
    expect(empty.root.textContent).toContain("This repository has no issue templates.");
    empty.unmount();

    const noPullRequestTemplate = await mountAt(
      "/_verify/no-pull-template",
      "/_verify/no-pull-template",
      () =>
        h(CommunityTemplatePicker, {
          repositoryId: "repo-1",
          refName: "main",
          kind: "pull-request",
        })
    );
    expect(noPullRequestTemplate.root.textContent).toContain(
      "This repository has no default pull request template."
    );
    noPullRequestTemplate.unmount();

    const form = await mountAt("/_verify/yaml-form", "/_verify/yaml-form", () =>
      h(CommunityTemplatePicker, {
        repositoryId: "repo-1",
        refName: "main",
        kind: "issue",
      })
    );
    expect(form.root.textContent).toContain("YAML issue forms are not supported here");
    expect(findButton(form.root, "Use template").hasAttribute("disabled")).toBe(true);
    form.unmount();
  });
});
