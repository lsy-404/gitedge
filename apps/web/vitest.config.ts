import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: { fs: { allow: ["../.."] } },
  test: {
    environment: "jsdom",
    include: ["../../test/ui/**/*.test.ts"],
  },
});
