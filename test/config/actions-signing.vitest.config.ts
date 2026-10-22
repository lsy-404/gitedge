import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./workers/actions/src/index.ts",
      wrangler: { configPath: "./test/config/actions-signing.wrangler.jsonc" },
      miniflare: { isolatedStorage: true, d1Persist: false },
    }),
  ],
  test: {
    include: ["test/signing-runtime/actions.worker.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
