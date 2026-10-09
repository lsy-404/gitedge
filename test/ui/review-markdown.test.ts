import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../apps/web/src/lib/markdown";
import { groupThreads, splitSuggestions } from "../../apps/web/src/lib/reviewThreads";
import type { ReviewComment } from "../../packages/contracts/src/review-comments";

const repository = { owner: "acme", slug: "project" };

describe("issue references in Markdown", () => {
  it("links #n and same-repository owner/repo#n", () => {
    const html = renderMarkdown(
      "Fixes #12 and acme/project#3, see also Other/Repo#4.",
      undefined,
      false,
      repository
    );
    expect(html).toContain('<a href="/acme/project/issues/12" rel="noreferrer noopener">#12</a>');
    expect(html).toContain('href="/acme/project/issues/3"');
    expect(html).not.toContain("issues/4");
    expect(html).toContain("Other/Repo#4");
  });

  it("leaves code, existing links and words alone", () => {
    const html = renderMarkdown(
      "`#1`\n\n```\n#2\n```\n\n[#3](https://example.com)\n\nabc#4 and C#5 and &#39;",
      undefined,
      false,
      repository
    );
    expect(html).not.toContain("/issues/");
    expect(html).toContain('href="https://example.com"');
  });

  it("does nothing without a repository", () => {
    expect(renderMarkdown("Fixes #12")).not.toContain("<a");
  });
});

describe("review thread helpers", () => {
  const base: ReviewComment = {
    id: "a",
    inReplyTo: null,
    reviewId: null,
    commitOid: "x",
    path: "f",
    side: "RIGHT",
    line: 1,
    startLine: null,
    diffHunk: "",
    body: "",
    actor: { kind: "user", id: "u", name: "u" },
    pending: false,
    outdated: false,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: 1,
    updatedAt: 1,
  };

  it("groups replies under their root in order", () => {
    const groups = groupThreads([
      base,
      { ...base, id: "b" },
      { ...base, id: "c", inReplyTo: "a" },
      { ...base, id: "d", inReplyTo: "b" },
      { ...base, id: "e", inReplyTo: "a" },
    ]);
    expect(groups.map((group) => [group.root.id, group.replies.map((row) => row.id)])).toEqual([
      ["a", ["c", "e"]],
      ["b", ["d"]],
    ]);
  });

  it("separates suggestion blocks from prose", () => {
    expect(
      splitSuggestions("Try this:\n```suggestion\nconst a = 1;\nconst b = 2;\n```\nThanks")
    ).toEqual([
      { kind: "markdown", text: "Try this:\n" },
      { kind: "suggestion", lines: ["const a = 1;", "const b = 2;"] },
      { kind: "markdown", text: "\nThanks" },
    ]);
    expect(splitSuggestions("```suggestion\n```")).toEqual([{ kind: "suggestion", lines: [] }]);
    expect(splitSuggestions("plain")).toEqual([{ kind: "markdown", text: "plain" }]);
  });
});
