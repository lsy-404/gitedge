import { describe, expect, it } from "vitest";
import type { BranchProtectionRule } from "../../packages/contracts/src/repository-controls";
import { matchingBranchRules } from "../../src/worker/common/branch-protection";

function rule(
  pattern: string,
  overrides: Partial<BranchProtectionRule> = {}
): BranchProtectionRule {
  return {
    id: pattern,
    pattern,
    enabled: true,
    locked: false,
    requiredApprovals: 0,
    requirePassingChecks: false,
    requiredStatusChecks: [],
    requireLinearHistory: false,
    requireSignedCommits: false,
    requireConversationResolution: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function matches(pattern: string, branch: string, overrides?: Partial<BranchProtectionRule>) {
  return matchingBranchRules([rule(pattern, overrides)], branch).length === 1;
}

describe("matchingBranchRules", () => {
  it("matches exact names only", () => {
    expect(matches("main", "main")).toBe(true);
    expect(matches("main", "main2")).toBe(false);
  });

  it("limits a single star to one path segment and a double star to many", () => {
    expect(matches("release/*", "release/1.0")).toBe(true);
    expect(matches("release/*", "release/1/x")).toBe(false);
    expect(matches("release/**", "release/1/x")).toBe(true);
  });

  it("matches dot-prefixed branches with a wildcard", () => {
    expect(matches("*", ".hidden")).toBe(true);
  });

  it("treats negation and extglob syntax as literal text", () => {
    expect(matches("!main", "feature")).toBe(false);
    expect(matches("+(a|b)", "a")).toBe(false);
  });

  it("ignores disabled rules", () => {
    expect(matches("main", "main", { enabled: false })).toBe(false);
  });
});
