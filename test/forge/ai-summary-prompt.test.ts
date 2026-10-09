import { describe, expect, it } from "vitest";
import { AI_SUMMARY_PROMPT_CHARS, type GitDiffFile } from "../../packages/contracts/src/index";
import {
  buildSummaryPrompt,
  type SummaryPromptInput,
} from "../../workers/forge/src/ai-summary-prompt";

function file(path: string, lines: number, overrides: Partial<GitDiffFile> = {}): GitDiffFile {
  return {
    path,
    type: "modified",
    oldOid: null,
    newOid: null,
    patch: "@@ -1 +1 @@\n" + "+added line\n".repeat(lines),
    binary: false,
    ...overrides,
  };
}
function input(
  files: GitDiffFile[],
  overrides: Partial<SummaryPromptInput> = {}
): SummaryPromptInput {
  return {
    title: "Change",
    body: "Body",
    baseRef: "main",
    headRef: "topic",
    commitMessages: ["First\n\ndetails"],
    files,
    comparisonTruncated: false,
    ...overrides,
  };
}
const text = (prompt: ReturnType<typeof buildSummaryPrompt>) =>
  prompt.messages.map((message) => message.content).join("\n");

describe("summary prompt", () => {
  it("includes the whole diff when it fits the budget", () => {
    const prompt = buildSummaryPrompt(input([file("a.ts", 3), file("b.ts", 2)]), 10_000);
    expect(prompt.truncated).toBe(false);
    expect(text(prompt)).toContain("Input is complete.");
    expect(text(prompt)).toContain("modified a.ts (+3 -0)");
    expect(text(prompt)).not.toContain("[patch truncated]");
  });

  it("keeps the prompt inside the budget and says what was cut", () => {
    const files = [file("small.ts", 2), file("huge.ts", 5000), file("large.ts", 2000)];
    const prompt = buildSummaryPrompt(input(files), 5000);
    const user = prompt.messages[1].content;
    expect(prompt.truncated).toBe(true);
    expect(prompt.partialFiles).toBe(2);
    expect(user).toContain("Input truncated");
    expect(user).toContain("[patch truncated]");
    expect(user).toContain("--- small.ts");
    expect(user.length).toBeLessThanOrEqual(5000);
  });

  it("omits patches that cannot get a useful share and lists every file", () => {
    const files = Array.from({ length: 30 }, (_, index) => file(`f${index}.ts`, 100));
    const prompt = buildSummaryPrompt(input(files), 3000);
    expect(prompt.omittedFiles).toBeGreaterThan(0);
    expect(prompt.truncated).toBe(true);
    for (const entry of files) expect(text(prompt)).toContain(`modified ${entry.path}`);
  });

  it("flags a comparison the Git service already cut off", () => {
    const prompt = buildSummaryPrompt(
      input([file("a.ts", 1)], { comparisonTruncated: true }),
      10_000
    );
    expect(prompt.truncated).toBe(true);
    expect(text(prompt)).toContain("comparison itself was cut off");
  });

  it("skips binary files and marks the diff as untrusted", () => {
    const prompt = buildSummaryPrompt(
      input([file("logo.png", 1, { binary: true, patch: null })]),
      10_000
    );
    expect(text(prompt)).toContain("binary");
    expect(prompt.messages[0].content).toContain("untrusted");
    expect(prompt.truncated).toBe(false);
  });

  it("stays inside the production budget when every field is at its limit", () => {
    const longPath = (index: number) => `${"deep/".repeat(80)}file-${index}.ts`;
    const files = Array.from({ length: 2000 }, (_, index) => file(longPath(index), 500));
    const prompt = buildSummaryPrompt(
      input(files, {
        title: "t".repeat(5000),
        body: "b".repeat(50_000),
        baseRef: "r".repeat(1000),
        headRef: "h".repeat(1000),
        commitMessages: Array.from({ length: 500 }, () => "m".repeat(1000)),
      }),
      AI_SUMMARY_PROMPT_CHARS
    );
    expect(prompt.messages[1].content.length).toBeLessThanOrEqual(AI_SUMMARY_PROMPT_CHARS);
    expect(prompt.truncated).toBe(true);
    expect(prompt.messages[1].content).toMatch(/Input truncated: \d+ files were not listed/);
  });
});
