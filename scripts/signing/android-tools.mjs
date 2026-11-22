import { spawnSync } from "node:child_process";
import { access, constants, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// apksigner gained APK Signature Scheme v3 in build-tools 28; older tools cannot meet the contract.
const MINIMUM_BUILD_TOOLS_MAJOR = 30;

export function androidSdkRoots(
  env = process.env,
  platform = process.platform,
  home = os.homedir()
) {
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(
    (value) => typeof value === "string" && path.isAbsolute(value)
  );
  if (platform === "darwin") roots.push(path.join(home, "Library", "Android", "sdk"));
  if (platform === "linux") roots.push(path.join(home, "Android", "Sdk"));
  return [...new Set(roots)];
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export async function findAndroidBuildTools({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  if (platform !== "darwin" && platform !== "linux") return null;
  for (const root of androidSdkRoots(env, platform, home)) {
    let versions;
    try {
      versions = await readdir(path.join(root, "build-tools"));
    } catch {
      continue;
    }
    const candidates = versions
      .filter(
        (version) =>
          /^\d+(?:\.\d+){0,3}$/.test(version) &&
          Number(version.split(".")[0]) >= MINIMUM_BUILD_TOOLS_MAJOR
      )
      .sort(compareVersions)
      .reverse();
    for (const version of candidates) {
      const directory = path.join(root, "build-tools", version);
      const tools = {
        version,
        aapt2: path.join(directory, "aapt2"),
        zipalign: path.join(directory, "zipalign"),
        apksignerJar: path.join(directory, "lib", "apksigner.jar"),
      };
      try {
        await access(tools.aapt2, constants.X_OK);
        await access(tools.zipalign, constants.X_OK);
        await access(tools.apksignerJar, constants.R_OK);
        return tools;
      } catch {
        /* try the next installed version */
      }
    }
  }
  return null;
}

export function javaCommand(env = process.env) {
  return typeof env.JAVA_HOME === "string" && path.isAbsolute(env.JAVA_HOME)
    ? path.join(env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
}

async function probe() {
  const tools = await findAndroidBuildTools();
  if (!tools) return false;
  const options = { stdio: "ignore", timeout: 4_500 };
  return (
    spawnSync(tools.aapt2, ["version"], options).status === 0 &&
    spawnSync(javaCommand(), ["-jar", tools.apksignerJar, "--version"], options).status === 0
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await probe()) ? 0 : 1;
}
