import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const WorkerConfigSchema = z.object({
  name: z.string(),
  workers_dev: z.boolean(),
  compatibility_date: z.string(),
  compatibility_flags: z.array(z.string()).default([]),
  account_id: z.string(),
  artifacts: z.array(z.object({ binding: z.string(), namespace: z.string() })).optional(),
  services: z.array(z.object({ binding: z.string(), service: z.string() })).optional(),
  durable_objects: z
    .object({
      bindings: z.array(
        z.object({ name: z.string(), class_name: z.string(), script_name: z.string().optional() })
      ),
    })
    .optional(),
  migrations: z
    .array(
      z.object({
        tag: z.string(),
        new_sqlite_classes: z.array(z.string()).default([]),
        new_classes: z.array(z.string()).default([]),
        renamed_classes: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
        deleted_classes: z.array(z.string()).default([]),
      })
    )
    .default([]),
  exports: z.record(z.string(), z.unknown()).default({}),
  routes: z.array(z.unknown()).optional(),
  r2_buckets: z.array(z.unknown()).optional(),
  assets: z.object({ html_handling: z.string() }).optional(),
});
const COMPATIBILITY_DATE = "2026-10-01";
type WorkerConfig = z.infer<typeof WorkerConfigSchema>;
const services = ["gateway", "auth", "forge", "git", "deploy", "limits", "actions", "mcp"];

function parseJsonc(path: URL): unknown {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""));
}

describe("deployment isolation", () => {
  it("exposes one public Gateway and binds the same Artifacts namespace", () => {
    for (const service of services) {
      const path = new URL(`../workers/${service}/wrangler.jsonc`, import.meta.url);
      const config = WorkerConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      expect(config.workers_dev).toBe(false);
      expect(config.compatibility_date).toBe(COMPATIBILITY_DATE);
      if (service === "auth")
        expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
      if (service !== "gateway") expect(config.routes ?? []).toEqual([]);
      if (["auth", "forge", "git"].includes(service))
        expect(config.artifacts).toEqual([{ binding: "ARTIFACTS", namespace: "gitedge" }]);
      if (service !== "forge") expect(config.r2_buckets).toBeUndefined();
      if (service === "gateway") {
        expect(config.routes).toHaveLength(1);
        expect(config.assets?.html_handling).toBe("none");
        expect(config.services?.map((entry) => entry.binding).sort()).toEqual([
          "ACTIONS",
          "AUTH",
          "DEPLOY",
          "FORGE",
          "GIT",
          "MCP",
        ]);
      }
      if (service === "mcp")
        expect(config.services).toEqual([{ binding: "GATEWAY", service: "gitedge-gateway" }]);
    }
  });

  it("keeps the Forge test configuration on the shared compatibility date", () => {
    const path = new URL("../workers/forge/wrangler.test.jsonc", import.meta.url);
    const config = z.object({ compatibility_date: z.string() }).parse(parseJsonc(path));
    expect(config.compatibility_date).toBe(COMPATIBILITY_DATE);
  });

  it("resolves every service and Durable Object binding to a deployed Worker", () => {
    const configs = new Map<string, { directory: string; config: WorkerConfig }>();
    for (const service of services) {
      const path = new URL(`../workers/${service}/wrangler.jsonc`, import.meta.url);
      const config = WorkerConfigSchema.parse(parseJsonc(path));
      configs.set(config.name, { directory: service, config });
    }

    for (const { directory, config } of configs.values()) {
      for (const entry of config.services ?? []) {
        expect(configs.has(entry.service), `${directory} binds ${entry.service}`).toBe(true);
      }
      for (const binding of config.durable_objects?.bindings ?? []) {
        const owner = configs.get(binding.script_name ?? config.name);
        expect(owner, `${directory} binds ${binding.name}`).toBeDefined();
        if (!owner) continue;
        const live = new Set<string>(Object.keys(owner.config.exports));
        for (const migration of owner.config.migrations) {
          for (const name of [...migration.new_sqlite_classes, ...migration.new_classes])
            live.add(name);
          for (const rename of migration.renamed_classes) {
            live.delete(rename.from);
            live.add(rename.to);
          }
          for (const name of migration.deleted_classes) live.delete(name);
        }
        expect(
          live.has(binding.class_name),
          `${owner.directory} migrates ${binding.class_name}`
        ).toBe(true);
        const source = readFileSync(
          new URL(`../workers/${owner.directory}/src/index.ts`, import.meta.url),
          "utf8"
        );
        expect(source).toMatch(
          new RegExp(
            `(export class ${binding.class_name}\\b|as ${binding.class_name}\\s*\\}|export \\{ ${binding.class_name} \\} from)`
          )
        );
      }
    }
  });
});
