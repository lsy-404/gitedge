import { describe, expect, it } from "vitest";
import {
  createGitEdgeExecutionArgs,
  runnerJobMatches,
  runnerProfileForClaim,
} from "../scripts/runner-broker-execution.mjs";

describe("server-authoritative runner label snapshots", () => {
  it("replaces stale local tags and applies AND matching to native and GitHub jobs", () => {
    const localProfile = {
      labels: ["self-hosted", "Linux", "X64", "old-label"],
    };
    const claim = {
      runnerLabels: ["self-hosted", "Linux", "X64", "device", "ip-residential", "gpu"],
    };
    const executionProfile = runnerProfileForClaim(localProfile, claim);
    const hostLabels = new Set(["self-hosted", "Linux", "linux", "X64", "x64"]);

    expect(executionProfile.labels).toEqual(claim.runnerLabels);
    expect(localProfile.labels).toEqual(["self-hosted", "Linux", "X64", "old-label"]);
    const args = createGitEdgeExecutionArgs({
      runnerScript: "actions-runner.mjs",
      profile: executionProfile,
      run: {
        repository: "owner/repo",
        sha: "a".repeat(40),
        ref: "refs/heads/main",
        event: "push",
        timeoutMinutes: 30,
      },
      workflowFile: "workflow.yml",
      actionsState: "actions",
      jobClaim: { minutes: 30 },
      demandLabels: ["self-hosted", "Linux", "X64", "device", "ip-residential"],
    });
    const nativeLabels = args.flatMap((argument, index) =>
      argument === "--label" ? [args[index + 1]] : []
    );
    expect(nativeLabels).toContain("ip-residential");
    expect(nativeLabels).not.toContain("old-label");
    for (const requested of [
      ["self-hosted", "Linux", "X64", "device", "ip-residential"],
      ["self-hosted", "Linux", "X64", "device", "gpu"],
    ])
      expect(runnerJobMatches(requested, executionProfile.labels, hostLabels)).toBe(true);
    expect(
      runnerJobMatches(
        ["self-hosted", "Linux", "X64", "device", "ip-datacenter"],
        executionProfile.labels,
        hostLabels
      )
    ).toBe(false);
    expect(
      runnerJobMatches(
        ["self-hosted", "Linux", "X64", "old-label"],
        executionProfile.labels,
        hostLabels
      )
    ).toBe(false);
  });

  it("requires a well-formed server snapshot instead of falling back to local labels", () => {
    const profile = { labels: ["self-hosted", "Linux", "X64", "old-label"] };
    expect(() => runnerProfileForClaim(profile, { run: null })).toThrow(
      "GitEdge returned an invalid runner label snapshot."
    );
    expect(() =>
      runnerProfileForClaim(profile, {
        runnerLabels: ["self-hosted", "Linux", "X64", "device", "DEVICE"],
      })
    ).toThrow("GitEdge returned an invalid runner label snapshot.");
  });
});
