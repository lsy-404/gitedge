import { describe, expect, it } from "vitest";
import {
  createToolProbeCache,
  createGpuProbeCache,
  localExecutionMinutes,
  parseRunnerBudget,
  runnerCapacityInternals,
  validateLocalJobClaim,
} from "../scripts/runner-capacity.mjs";
import { buildRunnerBrokerUnit } from "../scripts/runner-systemd-unit.mjs";
import { createGitEdgeExecutionArgs } from "../scripts/runner-broker-execution.mjs";
import { normalizeGpuControllers } from "../scripts/runner-gpu-probe.mjs";

describe("runner capacity probes", () => {
  it("reports one dedicated VRAM size per detected card and never claims shared system memory", () => {
    expect(
      normalizeGpuControllers([
        { vendor: "NVIDIA Corporation", vram: 4096, memoryTotal: 8192, vramDynamic: false },
        { vendor: "Advanced Micro Devices, Inc.", vram: 16384, vramDynamic: false },
        { vendor: "Apple", model: "Apple M4", vram: 24576, vramDynamic: true },
        { vendor: "Intel", vram: -1 },
      ])
    ).toEqual([
      { vendor: "nvidia", vramMb: 8192 },
      { vendor: "amd", vramMb: 16384 },
      { vendor: "apple", vramMb: null },
      { vendor: "intel", vramMb: null },
    ]);
  });

  it("bounds the GPU probe, caches its result and fails closed on probe errors", async () => {
    let now = 1000;
    let calls = 0;
    const getGpus = createGpuProbeCache({
      now: () => now,
      execute: async (_command, args, options) => {
        expect(args[0]).toContain("runner-gpu-probe.mjs");
        expect(options).toMatchObject({ timeout: 8000, maxBuffer: 16384, windowsHide: true });
        calls++;
        if (calls > 1) throw new Error("probe timed out");
        return { stdout: '[{"vendor":"nvidia","vramMb":8192}]' };
      },
    });
    expect(await getGpus()).toEqual([{ vendor: "nvidia", vramMb: 8192 }]);
    await getGpus();
    expect(calls).toBe(1);
    now += 600001;
    expect(await getGpus()).toBeNull();
    expect(calls).toBe(2);
    expect(() =>
      validateLocalJobClaim(
        ["GPU-NVIDIA", "VRAM-8G"],
        {
          cpus: 2,
          memFreeMb: 4096,
          diskFreeMb: 50000,
          load1: null,
          tools: [],
          gpus: null,
        },
        360
      )
    ).toThrow("capacity");
  });
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

  it("builds an unprivileged systemd unit without host-specific resource caps", () => {
    const unit = buildRunnerBrokerUnit({
      username: "gitedge",
      groupId: "1001",
      homeDir: "/var/lib/gitedge",
      installDir: "/opt/gitedge",
      stateDir: "/var/lib/gitedge/runner-broker",
      nodePath: "/usr/bin/node",
    });
    expect(unit).toContain("User=gitedge\nGroup=1001");
    expect(unit).toContain("TimeoutStopSec=60s\nKillMode=mixed");
    expect(unit).toContain("Restart=on-failure\nRestartPreventExitStatus=78\n");
    expect(unit).not.toMatch(/CPUQuota=|Memory(?:High|Max)=|TasksMax=/);
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/gitedge/scripts/runner-broker.mjs");
    expect(unit).not.toContain("Environment=HOME=");
    expect(unit).toContain("Environment=CARGO_HOME=/var/lib/gitedge/runner-broker/.cargo");
    expect(unit).toContain("Environment=RUSTUP_HOME=/var/lib/gitedge/runner-broker/.rustup");
    expect(unit).toContain("ReadWritePaths=/var/lib/gitedge /var/lib/gitedge/runner-broker");
    expect(() =>
      buildRunnerBrokerUnit({
        username: "gitedge",
        groupId: "1001",
        homeDir: "/var/lib/gitedge",
        installDir: "/opt/gitedge\nExecStart=/bin/sh",
        stateDir: "/var/lib/gitedge/runner-broker",
        nodePath: "/usr/bin/node",
      })
    ).toThrow("install path");
  });

  it("uses the single normalized native-signing budget for the CLI and registered labels", () => {
    const capacity = {
      cpus: 2,
      memFreeMb: 900,
      diskFreeMb: 5000,
      load1: 0.2,
      tools: ["docker"],
    };
    const jobClaim = validateLocalJobClaim(
      ["self-hosted", "need-time-90m", "need-tool-docker"],
      capacity,
      120
    );
    const args = createGitEdgeExecutionArgs({
      runnerScript: "C:/gitedge/scripts/actions-runner.mjs",
      profile: {
        origin: "https://git.example.com",
        runnerPath: "/opt/actions-runner",
        labels: ["self-hosted", "ubuntu24", "x64", "ubuntu24-1gb-light"],
      },
      run: {
        repository: "acme/app",
        sha: "a".repeat(40),
        ref: "refs/heads/main",
        event: "push",
        timeoutMinutes: 90,
      },
      workflowFile: "/var/lib/gitedge/runs/lease/.github/workflows/check.yml",
      actionsState: "/opt/gitedge/work/actions",
      jobClaim,
      demandLabels: ["self-hosted", "ubuntu24-1gb-light", "need-time-90m", "need-tool-docker"],
    });
    expect(args).toContain("--timeout-minutes");
    expect(args[args.indexOf("--timeout-minutes") + 1]).toBe("90");
    const labels = args.flatMap((arg, index) => (arg === "--label" ? [args[index + 1]] : []));
    expect(labels).toEqual([
      "self-hosted",
      "ubuntu24",
      "x64",
      "ubuntu24-1gb-light",
      "need-time-90m",
      "need-tool-docker",
    ]);
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
