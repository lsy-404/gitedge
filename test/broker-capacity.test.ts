import { describe, expect, it } from "vitest";
import {
  createToolProbeCache,
  localExecutionMinutes,
  parseRunnerBudget,
  runnerCapacityInternals,
  validateLocalJobClaim,
} from "../scripts/runner-capacity.mjs";
import { buildRunnerBrokerUnit } from "../scripts/runner-systemd-unit.mjs";

describe("runner capacity probes", () => {
  it("validates profile budget bounds and enforces need-label capacity plus local timeout", () => {
    expect(
      parseRunnerBudget({ "max-job-minutes": "60", "daily-minutes": "240", cost: "10" })
    ).toEqual({
      maxJobMinutes: 60,
      dailyMinutes: 240,
      cost: 10,
    });
    expect(() => parseRunnerBudget({ cost: "101" })).toThrow("between 0 and 100");

    const capacity = {
      cpus: 2,
      memFreeMb: 900,
      diskFreeMb: 5000,
      load1: 0.2,
      tools: ["docker"],
    };
    const claim = validateLocalJobClaim(
      [
        "self-hosted",
        "need-mem-768m",
        "need-cpu-2",
        "need-disk-2g",
        "need-tool-docker",
        "need-time-45m",
      ],
      capacity,
      120
    );
    expect(claim.labels).toEqual(["self-hosted"]);
    expect(localExecutionMinutes(claim, 30)).toBe(30);
    expect(() => validateLocalJobClaim(["self-hosted", "need-mem-2g"], capacity, 60)).toThrow(
      "capacity"
    );
    expect(() => validateLocalJobClaim(["self-hosted", "need-tool-unknown"], capacity, 60)).toThrow(
      "capacity"
    );
  });

  it("builds a bounded unprivileged systemd unit and rejects paths that could inject directives", () => {
    const unit = buildRunnerBrokerUnit({
      username: "gitedge",
      groupId: "1001",
      installDir: "/opt/gitedge",
      stateDir: "/var/lib/gitedge/runner-broker",
      nodePath: "/usr/bin/node",
    });
    expect(unit).toContain("User=gitedge\nGroup=1001");
    expect(unit).toContain("MemoryMax=800M");
    expect(unit).toContain("TimeoutStopSec=60s\nKillMode=mixed");
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/gitedge/scripts/runner-broker.mjs");
    expect(() =>
      buildRunnerBrokerUnit({
        username: "gitedge",
        groupId: "1001",
        installDir: "/opt/gitedge\nExecStart=/bin/sh",
        stateDir: "/var/lib/gitedge/runner-broker",
        nodePath: "/usr/bin/node",
      })
    ).toThrow("install path");
  });

  it("reads Linux available memory and unprivileged disk space in MiB", async () => {
    await expect(
      runnerCapacityInternals.linuxAvailableMemoryMb(
        async () => "MemTotal: 4194304 kB\nMemAvailable: 655360 kB\n"
      )
    ).resolves.toBe(640);
    await expect(
      runnerCapacityInternals.freeDiskMb("/work", async (_directory, options) => {
        expect(options).toEqual({ bigint: true });
        return { bavail: 4096n, bsize: 4096n };
      })
    ).resolves.toBe(16);
  });

  it("fails closed when the Linux available-memory metric is missing", async () => {
    await expect(
      runnerCapacityInternals.linuxAvailableMemoryMb(
        async () => "MemTotal: 4194304 kB\nMemFree: 1 kB\n"
      )
    ).rejects.toThrow("MemAvailable");
  });

  it("caps reported available memory at the systemd cgroup's remaining memory limit", async () => {
    const read = async (file: string) => {
      if (file === "/proc/meminfo") return "MemAvailable: 1048576 kB\n";
      if (file === "/proc/self/cgroup") return "0::/system.slice/gitedge-runner-broker.service\n";
      if (file.endsWith("/memory.max")) return "838860800\n";
      if (file.endsWith("/memory.current")) return "209715200\n";
      throw new Error("unexpected file");
    };
    await expect(runnerCapacityInternals.linuxAvailableMemoryMb(read)).resolves.toBe(600);
  });

  it("caches allowlisted tool probes for ten minutes and excludes an unavailable Docker daemon", async () => {
    let now = 1_000;
    let calls = 0;
    const getTools = createToolProbeCache({
      now: () => now,
      probe: async (command) => {
        calls++;
        return command !== "docker";
      },
    });

    const first = await getTools();
    const second = await getTools();
    expect(first).toEqual(second);
    expect(first).not.toContain("docker");
    expect(first).toContain("node");
    expect(calls).toBe(7);

    now += 10 * 60_000 + 1;
    await getTools();
    expect(calls).toBe(14);
  });

  it("bounds command probes and reports a nonzero or missing command as unavailable", async () => {
    await expect(
      runnerCapacityInternals.runProbe(process.execPath, ["--version"], 3_000)
    ).resolves.toBe(true);
    await expect(
      runnerCapacityInternals.runProbe("gitedge-no-such-probe", [], 3_000)
    ).resolves.toBe(false);
    await expect(
      runnerCapacityInternals.runProbe(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 50)
    ).resolves.toBe(false);
  });
});
