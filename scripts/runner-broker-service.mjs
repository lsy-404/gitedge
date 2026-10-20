import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const label = "com.gitedge.runner-broker";
const [action, ...args] = process.argv.slice(2);
const { values } = parseArgs({
  args,
  strict: true,
  options: {
    "install-dir": { type: "string" },
    "state-dir": { type: "string" },
  },
});

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchctl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/launchctl", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`launchctl ${args[0]} failed with status ${code ?? 1}.`))
    );
  });
}

async function main() {
  if (process.platform !== "darwin")
    throw new Error("launchd service management is available only on macOS.");
  if (!values["install-dir"]) throw new Error("--install-dir is required.");
  const installDir = path.resolve(values["install-dir"]);
  const broker = path.join(installDir, "scripts", "runner-broker.mjs");
  const node = process.execPath;
  await Promise.all([access(broker), access(node, constants.X_OK)]);
  const state = path.resolve(values["state-dir"] ?? path.join(installDir, "work", "runner-broker"));
  const home = os.homedir();
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  const logs = path.join(state, "logs");
  const plist = path.join(launchAgents, `${label}.plist`);
  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) throw new Error("Could not determine the current macOS user ID.");
  if (action === "install") {
    await mkdir(launchAgents, { recursive: true, mode: 0o700 });
    await mkdir(logs, { recursive: true, mode: 0o700 });
    await chmod(logs, 0o700);
    const environment = {
      HOME: home,
      PATH: [path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(
        ":"
      ),
    };
    const entries = Object.entries(environment)
      .map(([key, value]) => `    <key>${key}</key><string>${escapeXml(value)}</string>`)
      .join("\n");
    const document = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key><array><string>${escapeXml(node)}</string><string>${escapeXml(broker)}</string><string>serve</string><string>--state-dir</string><string>${escapeXml(state)}</string></array>\n  <key>WorkingDirectory</key><string>${escapeXml(installDir)}</string>\n  <key>EnvironmentVariables</key><dict>\n${entries}\n  </dict>\n  <key>RunAtLoad</key><false/>\n  <key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>${escapeXml(path.join(logs, "runner-broker.out.log"))}</string>\n  <key>StandardErrorPath</key><string>${escapeXml(path.join(logs, "runner-broker.err.log"))}</string>\n</dict></plist>\n`;
    await writeFile(plist, document, { mode: 0o600 });
    await chmod(plist, 0o600);
    console.log(`Installed ${label} at ${plist}. Run service start to load it.`);
    return;
  }
  if (action === "start") {
    await readFile(plist);
    await launchctl(["bootstrap", `gui/${uid}`, plist]);
    console.log(`Started ${label}.`);
    return;
  }
  if (action === "stop") {
    await launchctl(["bootout", `gui/${uid}/${label}`]);
    console.log(`Stopped ${label}.`);
    return;
  }
  if (action === "status") {
    await launchctl(["print", `gui/${uid}/${label}`]);
    return;
  }
  throw new Error("Expected service install, start, stop, or status.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Runner broker service failed.");
  process.exitCode = 1;
});
