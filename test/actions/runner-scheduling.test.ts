import { describe, expect, it } from "vitest";
import {
  eligibilityReasons,
  hasNeedLabels,
  matchesCapacity,
  matchesLabels,
  parseJobClaim,
  scoreRunner,
} from "../../packages/contracts/runner-scheduling.mjs";
import type { RunnerBudget, RunnerCapacity } from "../../packages/contracts/src/runners";
import { RUNNER_DEFERRAL_AGE_MS } from "../../packages/contracts/src/runners";
import { betterPeerExists, type RunnerPeer } from "../../workers/actions/src/runner-scheduler";

const capacity = (overrides: Partial<RunnerCapacity> = {}): RunnerCapacity => ({
  os: "linux",
  arch: "x64",
  cpus: 2,
  load1: 0.2,
  memTotalMb: 2048,
  memFreeMb: 1024,
  diskFreeMb: 10_240,
  tools: ["node", "pnpm"],
  slots: 1,
  busy: 0,
  ...overrides,
});

describe("runner scheduling contracts", () => {
  it("parses ordinary labels and combines resource claims conservatively", () => {
    expect(
      parseJobClaim(
        [
          "self-hosted",
          "Linux",
          "need-mem-1g",
          "need-mem-1536m",
          "need-cpu-2",
          "need-cpu-4",
          "need-disk-20g",
          "need-tool-node",
          "need-tool-pnpm",
          "need-time-30m",
          "need-time-60m",
        ],
        45
      )
    ).toEqual({
      labels: ["self-hosted", "linux"],
      memMb: 1536,
      cpus: 4,
      diskMb: 20_480,
      tools: ["node", "pnpm"],
      minutes: 60,
      valid: true,
    });
  });

  it("uses the supplied default runtime only when no time label exists", () => {
    expect(parseJobClaim(["self-hosted"], 25).minutes).toBe(25);
    expect(parseJobClaim(["self-hosted", "need-time-10m"], 360).minutes).toBe(10);
  });

  it.each(["need-memory-1g", "need-cpu-0", "need-disk-1m", "need-time-361m", "need-tool-!"])(
    "marks unsupported or out-of-range claim %s invalid",
    (label) => {
      expect(parseJobClaim(["self-hosted", label]).valid).toBe(false);
    }
  );

  it("matches resource minima, tool names, and load gate", () => {
    const claim = parseJobClaim([
      "need-mem-512m",
      "need-cpu-2",
      "need-disk-2g",
      "need-tool-PNPM",
      "need-time-15m",
    ]);
    expect(matchesCapacity(capacity(), claim)).toBe(true);
    expect(matchesCapacity(capacity({ memFreeMb: 511 }), claim)).toBe(false);
    expect(matchesCapacity(capacity({ tools: ["node"] }), claim)).toBe(false);
    expect(matchesCapacity(capacity({ load1: 3.1 }), claim)).toBe(false);
  });

  it("allows an unknown-capacity legacy runner only when explicitly enabled without need labels", () => {
    const plain = parseJobClaim(["self-hosted"]);
    const required = parseJobClaim(["self-hosted", "need-mem-512m"]);
    expect(matchesCapacity(null, plain, { allowUnknownLegacy: true, explicitNeeds: false })).toBe(
      true
    );
    expect(matchesCapacity(null, required, { allowUnknownLegacy: true, explicitNeeds: true })).toBe(
      false
    );
    expect(hasNeedLabels(["Linux", "NEED-MEM-512M"])).toBe(true);
  });

  it("returns budget and capacity reason codes and ranks tighter fits first", () => {
    const claim = parseJobClaim(["need-mem-1g", "need-time-30m"]);
    const budget: RunnerBudget = { maxJobMinutes: 20, dailyMinutes: 45, cost: 40 };
    expect(eligibilityReasons(capacity({ memFreeMb: 900 }), budget, 20, claim)).toEqual([
      "mem",
      "budget-job",
      "budget-daily",
    ]);

    const small = capacity({ memTotalMb: 1024, memFreeMb: 700, cpus: 2 });
    const large = capacity({ memTotalMb: 8192, memFreeMb: 7000, cpus: 8 });
    const simpleClaim = parseJobClaim(["self-hosted"]);
    expect(scoreRunner(small, null, 0, simpleClaim)).toBeLessThan(
      scoreRunner(large, null, 0, simpleClaim)
    );
  });

  it("compares ordinary labels without case sensitivity", () => {
    expect(matchesLabels(["Self-Hosted", "linux"], ["self-hosted", "Linux", "ci"])).toBe(true);
    expect(matchesLabels(["arm64"], ["linux", "x64"])).toBe(false);
  });

  it("defers a usable job to a materially better peer only until the aging threshold", () => {
    const claim = parseJobClaim(["self-hosted"]);
    const peer: RunnerPeer = {
      id: "peer",
      repository_id: null,
      labels_json: '["self-hosted"]',
      capacity_json: JSON.stringify(capacity({ memTotalMb: 1024, memFreeMb: 630, cpus: 2 })),
      budget_json: null,
      used_minutes_24h: 0,
    };
    const own = capacity({ memTotalMb: 8192, memFreeMb: 7000, cpus: 8 });
    expect(betterPeerExists([peer], ["self-hosted"], claim, own, null, 0, 0, 10_000)).toBe(true);
    expect(
      betterPeerExists(
        [peer],
        ["self-hosted"],
        claim,
        own,
        null,
        0,
        10_000,
        10_000 + RUNNER_DEFERRAL_AGE_MS
      )
    ).toBe(false);
  });
});
