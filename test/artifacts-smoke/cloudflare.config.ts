import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "gitedge-artifacts-smoke",
    entrypoint: "./worker.ts",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    env: { ARTIFACTS: bindings.artifacts({ namespace: "gitedge", dev: { remote: true } }) },
  },
});
