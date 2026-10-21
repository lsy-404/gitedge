import type { JobClaim, RunnerBudget, RunnerCapacity } from "./src/runners.js";

export function hasNeedLabels(labels: unknown): boolean;
export function parseJobClaim(labels: unknown, defaultMinutes?: number): JobClaim;
export function matchesLabels(required: unknown, available: unknown): boolean;
export function matchesCapacity(
  capacity: RunnerCapacity | null,
  claim: JobClaim,
  options?: { allowUnknownLegacy?: boolean; explicitNeeds?: boolean }
): boolean;
export function eligibilityReasons(
  capacity: RunnerCapacity | null,
  budget: RunnerBudget | null,
  usedMinutes24h: number,
  claim: JobClaim,
  options?: { allowUnknownLegacy?: boolean; explicitNeeds?: boolean }
): string[];
export function scoreRunner(
  capacity: RunnerCapacity | null,
  budget: RunnerBudget | null,
  usedMinutes24h: number,
  claim: JobClaim
): number;
