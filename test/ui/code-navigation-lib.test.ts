import { describe, expect, it } from "vitest";
import {
  formatLineAnchor,
  nextLineSelection,
  parseLineAnchor,
  permalinkLocation,
  resolveCommitOid,
  splitHighlightedLines,
} from "../../apps/web/src/lib/codeAnchor";
import { fuzzyFilter, fuzzyMatch } from "../../apps/web/src/lib/fuzzy";
import { highlightedCode } from "../../apps/web/src/lib/markdown";
import { relativeAge } from "../../apps/web/src/lib/relativeTime";
import { splitLines } from "../../packages/contracts/src/text-lines";

describe("line anchors", () => {
  it("parses single lines and ranges", () => {
    expect(parseLineAnchor("#L10")).toEqual({ start: 10, end: 10 });
    expect(parseLineAnchor("#L10-L20")).toEqual({ start: 10, end: 20 });
  });

  it("normalizes reversed ranges and rejects invalid anchors", () => {
    expect(parseLineAnchor("#L20-L10")).toEqual({ start: 10, end: 20 });
    for (const hash of [
      "",
      "#",
      "#L",
      "#L0",
      "#L1-L0",
      "#L-3",
      "#L1.5",
      "#l5",
      "#L5-",
      "#L5-10",
      "#Lx",
      "#L123456789",
      "#section",
    ])
      expect(parseLineAnchor(hash), hash).toBeNull();
  });

  it("formats anchors that parse back to the same range", () => {
    expect(formatLineAnchor({ start: 3, end: 3 })).toBe("#L3");
    expect(formatLineAnchor({ start: 3, end: 9 })).toBe("#L3-L9");
    expect(parseLineAnchor(formatLineAnchor({ start: 3, end: 9 }))).toEqual({ start: 3, end: 9 });
  });

  it("selects a line on click and extends from the anchor line on shift click", () => {
    expect(nextLineSelection(null, 5, false)).toEqual({ start: 5, end: 5 });
    expect(nextLineSelection(null, 5, true)).toEqual({ start: 5, end: 5 });
    expect(nextLineSelection({ start: 5, end: 5 }, 9, true)).toEqual({ start: 5, end: 9 });
    expect(nextLineSelection({ start: 5, end: 9 }, 2, true)).toEqual({ start: 2, end: 5 });
    expect(nextLineSelection({ start: 5, end: 9 }, 7, false)).toEqual({ start: 7, end: 7 });
  });
});

describe("permalinks", () => {
  const oid = "a".repeat(40);
  const tag = "b".repeat(40);
  const peeled = "c".repeat(40);

  it("rewrites the ref to the full commit id and keeps the line range", () => {
    expect(
      permalinkLocation({
        owner: "o",
        repository: "r",
        path: "src/a b/c#.ts",
        commitOid: oid,
        range: { start: 4, end: 8 },
      })
    ).toEqual({ path: "/o/r/blob/src/a%20b/c%23.ts", query: { ref: oid }, hash: "#L4-L8" });
    expect(
      permalinkLocation({ owner: "o", repository: "r", path: "a", commitOid: oid, range: null })
        .hash
    ).toBe("");
  });

  it("resolves branches, tags (peeled) and commit ids to a commit id", () => {
    const refs = [
      { name: "refs/heads/main", oid },
      { name: "refs/tags/v1", oid: tag, peeledOid: peeled },
      { name: "refs/tags/light", oid: tag },
    ];
    expect(resolveCommitOid(refs, "main")).toBe(oid);
    expect(resolveCommitOid(refs, "v1")).toBe(peeled);
    expect(resolveCommitOid(refs, "light")).toBe(tag);
    expect(resolveCommitOid(refs, peeled)).toBe(peeled);
    expect(resolveCommitOid(refs, "missing")).toBeNull();
  });
});

describe("highlighted line splitting", () => {
  it("matches the line count of splitLines", () => {
    for (const text of ["", "a", "a\n", "a\nb", "a\n\nb\n", "\n"])
      expect(
        splitHighlightedLines(highlightedCode(text, "x.txt")),
        JSON.stringify(text)
      ).toHaveLength(splitLines(text).length);
  });

  it("closes and reopens spans that cross a line break", () => {
    const lines = splitHighlightedLines('<span class="c">a\nb</span>c\nd');
    expect(lines).toEqual(['<span class="c">a</span>', '<span class="c">b</span>c', "d"]);
  });

  it("produces balanced markup for real highlighted code", () => {
    const source = "/* one\ntwo */\nconst a = `x\ny`;\n";
    const lines = splitHighlightedLines(highlightedCode(source, "a.js"));
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line.match(/<span\b/g)?.length ?? 0).toBe(line.match(/<\/span>/g)?.length ?? 0);
    }
  });
});

describe("fuzzy finder scoring", () => {
  it("requires a case-insensitive subsequence", () => {
    expect(fuzzyMatch("rcv", "src/RepositoryCode.vue")).not.toBeNull();
    expect(fuzzyMatch("vcr", "src/RepositoryCode.vue")).toBeNull();
    expect(fuzzyMatch("zzz", "src/a.ts")).toBeNull();
  });

  it("reports matched positions", () => {
    expect(fuzzyMatch("api", "src/lib/api.ts")?.indices).toEqual([8, 9, 10]);
    // "İ" lowercases to two units; indices must still point into the original path.
    expect(fuzzyMatch("ab", "İ/ab.ts")?.indices).toEqual([2, 3]);
  });

  it("prefers basename, word-start and consecutive matches", () => {
    const paths = [
      "src/domain/avue.ts",
      "src/main.vue",
      "docs/guide/mainframe.md",
      "vendor/m/a/i/n.vue",
    ];
    expect(fuzzyFilter("main", paths, 10)[0]?.path).toBe("src/main.vue");
    expect(fuzzyFilter("mainvue", paths, 10).map((item) => item.path)[0]).toBe("src/main.vue");
  });

  it("limits results and keeps order for an empty query", () => {
    const paths = ["a", "b", "c"];
    expect(fuzzyFilter("", paths, 2).map((item) => item.path)).toEqual(["a", "b"]);
    expect(fuzzyFilter("  ", paths, 10)).toHaveLength(3);
    expect(fuzzyFilter("a", paths, 10).map((item) => item.path)).toEqual(["a"]);
  });
});

describe("relative age", () => {
  const now = Date.UTC(2026, 9, 9);
  const seconds = now / 1000;

  it("picks the largest whole unit", () => {
    expect(relativeAge(seconds - 30, now, "en")).toBe("30 seconds ago");
    expect(relativeAge(seconds - 3 * 3600, now, "en")).toBe("3 hours ago");
    expect(relativeAge(seconds - 3 * 86_400, now, "en")).toBe("3 days ago");
    expect(relativeAge(seconds - 400 * 86_400, now, "en")).toBe("last year");
  });

  it("follows the interface locale", () => {
    expect(relativeAge(seconds - 3 * 86_400, now, "zh-CN")).toBe("3天前");
  });
});
