import { z } from "zod";
import type { RunnerDeviceHealth } from "../../../packages/contracts/src/runners";
import { createLogger, type Logger } from "../../../src/worker/common/logger";

const HealthStatusSchema = z.enum([
  "online",
  "degraded",
  "offline",
  "pending",
  "planned",
  "disabled",
]);
const DeviceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_#-]*$/);

const HealthCheckSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: z.enum(["tcp", "http", "systemd", "windows-service", "launchd"]),
    ok: z.boolean(),
    latencyMs: z.number().finite().nonnegative().optional(),
    error: z.string().max(2048).optional(),
  })
  .strict();

const DeviceMetricsSchema = z
  .object({
    cpuPercent: z.number().finite().min(0).max(100).nullable(),
    memoryPercent: z.number().finite().min(0).max(100).nullable(),
    memoryTotalBytes: z.number().int().nonnegative().nullable(),
    uptimeSeconds: z.number().finite().nonnegative().nullable(),
    disks: z
      .array(
        z
          .object({
            path: z.string().max(512),
            totalBytes: z.number().int().nonnegative(),
            usedPercent: z.number().finite().min(0).max(100),
          })
          .strip()
      )
      .max(64),
    network: z
      .object({
        bytesSent: z.number().int().nonnegative(),
        bytesRecv: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strip();

const MonitoredServiceSchema = z
  .object({
    id: z.string().min(1).max(256),
    source: z.enum(["agent", "network"]),
    status: z.enum(["healthy", "unhealthy", "unknown"]),
    observedAt: z.number().int().nonnegative(),
    error: z.string().max(2048).optional(),
    appliedRevision: z.number().int().nonnegative().optional(),
    certificateExpiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();

const DeviceSchema = z
  .object({
    id: DeviceIdSchema,
    label: z.string().max(256),
    kind: z.enum(["cloud", "physical"]),
    region: z.string().max(256),
    roles: z.array(z.string().max(256)).max(64),
    lifecycle: z.enum(["active", "planned", "retired"]),
    enrolled: z.boolean(),
    revoked: z.boolean(),
    status: HealthStatusSchema,
    lastSeen: z.number().int().nonnegative().nullable(),
    platform: z.string().max(256).nullable(),
    arch: z.string().max(256).nullable(),
    hostname: z.string().max(256).nullable(),
    agentVersion: z.string().max(256).nullable(),
    metrics: DeviceMetricsSchema.nullable(),
    checks: z.array(HealthCheckSchema).max(64),
    services: z.array(MonitoredServiceSchema).max(64),
  })
  .strip();

export const HealthSnapshotSchema = z
  .object({
    schema: z.literal(1),
    source: z.literal("devices"),
    now: z.number().int().nonnegative(),
    devices: z.array(DeviceSchema).max(500),
    totals: z
      .object({
        online: z.number().int().nonnegative(),
        degraded: z.number().int().nonnegative(),
        offline: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
        planned: z.number().int().nonnegative(),
        disabled: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const DeviceMappingSchema = z.record(z.uuid(), DeviceIdSchema);

export interface DeviceHealthEnv {
  DEVICES_HEALTH: Fetcher;
  RUNNER_DEVICE_IDS?: string;
  LOG_LEVEL?: string;
}

export interface DeviceHealthSnapshot {
  availability: "available" | "unavailable";
  checkedAt: number;
  byRunner: Map<string, RunnerDeviceHealth>;
}

function runnerDeviceMapping(raw: string | undefined, logger: Logger) {
  if (!raw) return {};
  try {
    const parsed = DeviceMappingSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // The operator value is optional; an invalid value leaves devices unknown.
  }
  logger.warn("runner-device-mapping-invalid");
  return {};
}

export async function readRunnerDeviceHealth(
  env: DeviceHealthEnv,
  runnerIds: string[]
): Promise<DeviceHealthSnapshot> {
  const checkedAt = Date.now();
  const logger = createLogger(env.LOG_LEVEL, { service: "actions" });
  const mapping = runnerDeviceMapping(env.RUNNER_DEVICE_IDS, logger);
  const byRunner = new Map<string, RunnerDeviceHealth>();
  try {
    const response = await env.DEVICES_HEALTH.fetch("https://devices.internal/api/health", {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`status:${response.status}`);
    const parsed = HealthSnapshotSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("invalid-snapshot");
    const devices = new Map(parsed.data.devices.map((device) => [device.id, device]));
    for (const runnerId of runnerIds) {
      const device = devices.get(mapping[runnerId]);
      byRunner.set(runnerId, {
        deviceId: mapping[runnerId] ?? null,
        status: device?.status ?? "unknown",
        lastSeen: device?.lastSeen ?? null,
        cpuPercent: device?.metrics?.cpuPercent ?? null,
        memoryPercent: device?.metrics?.memoryPercent ?? null,
        disks: device?.metrics?.disks ?? [],
      });
    }
    return { availability: "available", checkedAt, byRunner };
  } catch (error) {
    logger.warn("runner-device-health-unavailable", {
      error: error instanceof Error ? error.message : "unknown",
    });
    for (const runnerId of runnerIds)
      byRunner.set(runnerId, {
        deviceId: mapping[runnerId] ?? null,
        status: "unknown",
        lastSeen: null,
        cpuPercent: null,
        memoryPercent: null,
        disks: [],
      });
    return { availability: "unavailable", checkedAt, byRunner };
  }
}
