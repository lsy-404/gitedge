import { describe, expect, it } from "vitest";
import { nextCronTime, parseCronSchedules } from "../../workers/actions/src/cron";
import { parseRunnerWorkflow } from "../../workers/actions/src/runner-workflow";

describe("Runner UTC cron", () => {
  it("computes UTC occurrences independently of the host timezone", () => {
    expect(nextCronTime("0 9 * * MON-FRI", Date.parse("2026-10-23T09:00:00Z"))).toBe(
      Date.parse("2026-10-26T09:00:00Z")
    );
  });
  it("rejects invalid and non-POSIX schedules", () => {
    for (const value of ["* * * * * *", "61 * * * *", "@hourly", "H * * * *", "0 0 L * *"])
      expect(() => parseCronSchedules([{ cron: value }])).toThrow();
    expect(() => parseCronSchedules([])).toThrow();
    expect(() =>
      parseCronSchedules(Array.from({ length: 6 }, () => ({ cron: "0 * * * *" })))
    ).toThrow();
  });
  it("retains both manual and scheduled runner triggers", () => {
    const definition = parseRunnerWorkflow(
      ".github/workflows/service.yml",
      `name: Service
on:
  workflow_dispatch: {}
  schedule:
    - cron: '0 * * * *'
jobs:
  task:
    runs-on: [self-hosted]
    steps:
      - run: echo ready
`
    );
    expect(definition.workflow.triggers).toEqual(["workflow_dispatch", "schedule"]);
    expect(definition.workflow.schedules).toEqual(["0 * * * *"]);
  });
});
