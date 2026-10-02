import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { vueOptions } from "./vue-options.ts";

export default defineConfig({
  plugins: [vue(vueOptions)],
  server: { port: 4173 },
});
