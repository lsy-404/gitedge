import { describe, expect, it } from "vitest";
import { extractMentions, findMentions, stripMarkdownCode } from "../../packages/contracts/src";

describe("mention parsing", () => {
  it("finds user mentions and agent mentions in either form", () => {
    expect(
      extractMentions("Ping @Alice and @bob-2, plus owner/@helper and @acme/@reviewer.")
    ).toEqual({
      users: ["alice", "bob-2"],
      agents: [
        { owner: "owner", handle: "helper" },
        { owner: "acme", handle: "reviewer" },
      ],
    });
  });

  it("ignores emails, scoped packages, paths and too-short names", () => {
    const mentions = extractMentions(
      "mail me@example.com, install @types/node, see https://host/@alice and @ab"
    );
    expect(mentions).toEqual({ users: [], agents: [] });
  });

  it("skips fenced blocks, indented code and inline code spans", () => {
    const body = [
      "Hello @visible",
      "```",
      "@fenced",
      "```",
      "~~~text",
      "@tilde",
      "~~~",
      "    @indented",
      "inline `@spanned` and ``@double`` done @after",
    ].join("\n");
    expect(extractMentions(body).users).toEqual(["visible", "after"]);
    expect(stripMarkdownCode("`@x`")).not.toContain("@x");
  });

  it("deduplicates and reports positions for linking", () => {
    expect(extractMentions("@alice @ALICE @alice").users).toEqual(["alice"]);
    const text = "hi @alice!";
    const [mention] = findMentions(text);
    expect(mention).toMatchObject({ kind: "user", login: "alice" });
    expect(text.slice(mention.start, mention.end)).toBe("@alice");
  });
});
