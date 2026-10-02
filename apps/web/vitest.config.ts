import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { vueOptions } from "./vue-options.ts";

export default defineConfig({
  plugins: [vue(vueOptions)],
  server: { fs: { allow: ["../.."] } },
  test: {
    environment: "jsdom",
    include: ["../../test/ui/**/*.test.ts"],
  },
});
