import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "cloudflare:workers": path.resolve(
        import.meta.dirname,
        "./test/support/cloudflare-workers-node.ts"
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [
      "test/**/*.worker.test.ts",
      "**/node_modules/**",
      "**/.wrangler/**",
      "**/.cloudflare/**",
    ],
  },
});
