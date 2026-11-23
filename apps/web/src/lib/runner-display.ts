import type {
  RunnerJobKind,
  RunnerOverviewRunner,
  RunnerType,
} from "../../../../packages/contracts/src/runners";

export type BadgeTone = "neutral" | "success" | "danger" | "brand" | "warning";

export function stateTone(state: RunnerOverviewRunner["state"]): BadgeTone {
  if (state === "idle") return "success";
  if (state === "busy") return "brand";
  if (state === "held") return "warning";
  return "danger";
}

export function deviceHealthTone(
  status: RunnerOverviewRunner["deviceHealth"]["status"]
): BadgeTone {
  if (status === "online") return "success";
  if (status === "degraded" || status === "pending") return "warning";
  if (status === "offline") return "danger";
  return "neutral";
}

export function typeKey(type: RunnerType): string {
  return `runnerType_${type.replaceAll("-", "_")}`;
}

export function jobKey(kind: RunnerJobKind): string {
  return kind === "github" ? "runnerGitHubJob" : "runnerGitEdgeJob";
}

export function healthPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 10) / 10}%`;
}

export function loadPath(points: RunnerOverviewRunner["samples"]): string {
  const finite = points
    .map((point) => point.load1)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (finite.length < 2) return "";
  const max = Math.max(1, ...finite);
  return finite
    .map(
      (value, index) =>
        `${index ? "L" : "M"} ${(index * 100) / (finite.length - 1)} ${32 - (Math.min(value, max) / max) * 28}`
    )
    .join(" ");
}

export interface SlotCount {
  used: number;
  total: number;
}

export function slotCount(runner: RunnerOverviewRunner): SlotCount | null {
  if (!runner.capacity) return null;
  return { used: runner.capacity.busy, total: runner.capacity.slots };
}

// Offline and held runners contribute no usable slots.
export function availableSlots(runners: RunnerOverviewRunner[], type: RunnerType): number {
  return runners
    .filter(
      (runner) => runner.type === type && (runner.state === "idle" || runner.state === "busy")
    )
    .reduce((sum, runner) => {
      const count = slotCount(runner);
      return count ? sum + Math.max(0, count.total - count.used) : sum;
    }, 0);
}
