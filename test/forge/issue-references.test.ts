import { describe, expect, it } from "vitest";
import { closingIssueNumbers, parseIssueReferences } from "../../packages/contracts/src/references";

const repository = { owner: "Alice", slug: "demo" };

describe("issue reference parsing", () => {
  it.each([
    ["closes #1", [1]],
    ["Closed #2", [2]],
    ["CLOSE #3", [3]],
    ["fix #4", [4]],
    ["Fixes #5", [5]],
    ["fixed: #6", [6]],
    ["resolve #7", [7]],
    ["RESOLVES #8", [8]],
    ["resolved #9", [9]],
    ["Fixes alice/demo#10", [10]],
    ["fixes ALICE/Demo#11", [11]],
  ])("treats %s as closing", (text, numbers) => {
    expect(closingIssueNumbers([text], repository)).toEqual(numbers);
  });

  it.each([
    "see #1",
    "prefixes #2",
    "unfixes #3",
    "closes other/repo#4",
    "fixes alice/other#5",
    "closes\n#6",
    "closes #0",
    "closes C#7",
    "fixes #8abc",
    "closes https://example.com/x#9",
    "`closes #10`",
    "```\nfixes #11\n```",
    "fixes",
  ])("does not close anything for %j", (text) => {
    expect(closingIssueNumbers([text], repository)).toEqual([]);
  });

  it("separates mentions from closing references and merges duplicates", () => {
    expect(parseIssueReferences("Refs #1, fixes #2, then #2 again and see #3", repository)).toEqual(
      [
        { number: 1, closes: false },
        { number: 2, closes: true },
        { number: 3, closes: false },
      ]
    );
  });

  it("collects closing numbers across texts and bounds their count", () => {
    expect(closingIssueNumbers(["Fixes #1", "closes #1 and fixes #2"], repository)).toEqual([1, 2]);
    const many = Array.from({ length: 80 }, (_, index) => `fixes #${index + 1}`).join("\n");
    expect(closingIssueNumbers([many], repository)).toHaveLength(50);
  });
});
