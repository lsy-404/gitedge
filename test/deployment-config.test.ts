import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const WorkerConfigSchema = z.object({
  workers_dev: z.boolean(),
  compatibility_date: z.string(),
  account_id: z.string(),
  artifacts: z.array(z.object({ binding: z.string(), namespace: z.string() })).optional(),
  services: z.array(z.object({ binding: z.string(), service: z.string() })).optional(),
  routes: z.array(z.unknown()).optional(),
  r2_buckets: z.array(z.unknown()).optional(),
  assets: z.object({ html_handling: z.string() }).optional(),
});
const services = ["gateway", "auth", "forge", "git", "deploy", "limits", "actions"];

describe("deployment isolation", () => {
  it("exposes one public Gateway and binds the same Artifacts namespace", () => {
    for (const service of services) {
      const path = new URL(`../workers/${service}/wrangler.jsonc`, import.meta.url);
      const config = WorkerConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      expect(config.workers_dev).toBe(false);
      expect(config.compatibility_date).toBe(service === "actions" ? "2026-10-03" : "2026-10-01");
      if (service !== "gateway") expect(config.routes ?? []).toEqual([]);
      if (["auth", "forge", "git"].includes(service))
        expect(config.artifacts).toEqual([{ binding: "ARTIFACTS", namespace: "gitedge" }]);
      if (service === "git") expect(config.r2_buckets).toBeUndefined();
      if (service === "gateway") {
        expect(config.routes).toHaveLength(1);
        expect(config.assets?.html_handling).toBe("none");
        expect(config.services?.map((entry) => entry.binding).sort()).toEqual([
          "ACTIONS",
          "AUTH",
          "DEPLOY",
          "FORGE",
          "GIT",
        ]);
      }
    }
  });
});
