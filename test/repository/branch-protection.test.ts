import { describe, expect, it } from "vitest";
import {
  BranchProtectionInputSchema,
  type BranchProtectionRule,
} from "../../packages/contracts/src/repository-controls";
import {
  matchingBranchRules,
  matchingTagRules,
  reservedRef,
  tagChangeForbidden,
} from "../../src/worker/common/branch-protection";

function rule(
  pattern: string,
  overrides: Partial<BranchProtectionRule> = {}
): BranchProtectionRule {
  return {
    id: pattern,
    target: "branch",
    pattern,
    enabled: true,
    locked: false,
    requiredApprovals: 0,
    requirePassingChecks: false,
    requiredStatusChecks: [],
    requireLinearHistory: false,
    requireSignedCommits: false,
    requireConversationResolution: false,
    requireMergeQueue: false,
    forbidTagUpdate: false,
    forbidTagDeletion: false,
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

describe("tag protection rules", () => {
  const tagRule: BranchProtectionRule = {
    ...rule("release/**"),
    target: "tag",
    forbidTagUpdate: true,
    forbidTagDeletion: false,
  };

  it("keeps branch and tag patterns in separate namespaces", () => {
    expect(matchingBranchRules([tagRule], "release/v1")).toEqual([]);
    expect(matchingTagRules([rule("release/**"), tagRule], "release/v1")).toEqual([tagRule]);
    expect(tagChangeForbidden([tagRule], "release/v1", "update")).toBe(true);
    expect(tagChangeForbidden([tagRule], "release/v1", "delete")).toBe(false);
  });

  it("requires a tag rule to forbid at least one tag operation", () => {
    expect(
      BranchProtectionInputSchema.safeParse({ target: "tag", pattern: "release/*" }).success
    ).toBe(false);
    expect(
      BranchProtectionInputSchema.safeParse({
        target: "tag",
        pattern: "release/*",
        forbidTagDeletion: true,
      }).success
    ).toBe(true);
  });

  it("recognizes the server-owned ref namespace", () => {
    expect(reservedRef("refs/gitedge/sessions/one")).toBe(true);
    expect(reservedRef("refs/tags/v1")).toBe(false);
  });
});
