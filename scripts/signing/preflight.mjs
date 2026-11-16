import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 15_000;

export class PreflightError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.reason = reason;
    if (detail) this.detail = detail;
  }
}

const COMMON_DEPENDENCIES = ["zod", "archiver"];
const DEPENDENCIES = {
  windows: ["yauzl", "electron-builder", "electron-winstaller"],
  ios: ["yauzl"],
  dmg: ["@electron/asar", "@electron/fuses", "@electron/osx-sign"],
  macos: ["@electron/asar", "@electron/fuses", "@electron/osx-sign"],
};
const MACOS_BINARIES = ["codesign", "security", "ditto", "plutil", "lipo", "tar", "spctl"];
const BINARY_DIRECTORY = { spctl: "/usr/sbin" };
const TOOLS = {
  macos: { binaries: MACOS_BINARIES, xcrun: ["notarytool", "stapler"] },
  dmg: { binaries: [...MACOS_BINARIES, "hdiutil"], xcrun: ["notarytool", "stapler"] },
  ios: { binaries: ["codesign", "security", "lipo", "openssl"], xcrun: ["vtool", "xcodebuild"] },
};

function pythonCommand() {
  return process.env.PYTHON || "python3";
}

async function checkPython() {
  let output;
  try {
    const { stdout, stderr } = await execFileAsync(pythonCommand(), ["--version"], {
      timeout: PROBE_TIMEOUT_MS,
    });
    output = `${stdout}${stderr}`;
  } catch {
    throw new PreflightError("preflight_python", "not_found");
  }
  const match = /Python (\d+)\.(\d+)/.exec(output);
  if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 12))
    throw new PreflightError("preflight_python", match ? `${match[1]}.${match[2]}` : "unknown");
}

async function checkTool(name, probe) {
  try {
    await probe();
  } catch {
    throw new PreflightError(`preflight_tool_${name.toLowerCase()}`);
  }
}

export async function preflight(family) {
  const key = family.windows ? "windows" : family.ios ? "ios" : family.dmg ? "dmg" : "macos";
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new PreflightError("preflight_node", process.versions.node);
  for (const name of [...COMMON_DEPENDENCIES, ...DEPENDENCIES[key]]) {
    try {
      import.meta.resolve(name);
    } catch {
      throw new PreflightError("preflight_dependency", name);
    }
  }
  if (key === "windows") {
    await checkTool("pwsh", () =>
      execFileAsync("pwsh.exe", ["-NoProfile", "-Command", "exit 0"], { timeout: PROBE_TIMEOUT_MS })
    );
    return;
  }
  await checkPython();
  const { binaries, xcrun } = TOOLS[key];
  for (const name of binaries)
    await checkTool(name, () =>
      access(`${BINARY_DIRECTORY[name] ?? "/usr/bin"}/${name}`, constants.X_OK)
    );
  for (const name of xcrun)
    await checkTool(name, () =>
      execFileAsync("/usr/bin/xcrun", ["--find", name], { timeout: PROBE_TIMEOUT_MS })
    );
}
