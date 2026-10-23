import si from "systeminformation";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function normalizeGpuControllers(controllers) {
  if (!Array.isArray(controllers) || controllers.length > 16)
    throw new Error("Invalid GPU inventory.");
  return controllers.map((controller) => {
    const identity = `${controller.vendor ?? ""} ${controller.model ?? ""}`.toLowerCase();
    const vendor = /\bnvidia\b/.test(identity)
      ? "nvidia"
      : /\b(?:amd|ati|advanced micro devices)\b/.test(identity)
        ? "amd"
        : /\bintel\b/.test(identity)
          ? "intel"
          : /\bapple\b/.test(identity)
            ? "apple"
            : "unknown";
    const memory = controller.memoryTotal ?? controller.vram;
    const vramMb =
      controller.vramDynamic !== true &&
      Number.isFinite(memory) &&
      memory > 0 &&
      memory <= 1_048_576
        ? Math.floor(memory)
        : null;
    return { vendor, vramMb };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const graphics = await si.graphics();
  process.stdout.write(JSON.stringify(normalizeGpuControllers(graphics.controllers)));
}
