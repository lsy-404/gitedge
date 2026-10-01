import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./workers/forge/src/index.ts",
      wrangler: { configPath: "./workers/forge/wrangler.test.jsonc" },
      miniflare: { isolatedStorage: true, d1Persist: false, compatibilityDate: "2026-08-22" },
    }),
  ],
  test: { include: ["test/forge/**/*.worker.test.ts"] },
});
