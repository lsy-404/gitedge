import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRunnerBrokerUnit } from "./runner-systemd-unit.mjs";

const label = "com.gitedge.runner-broker";
const [action, ...args] = process.argv.slice(2);
const { values } = parseArgs({
  args,
  strict: true,
  options: {
    "install-dir": { type: "string" },
    "state-dir": { type: "string" },
    "run-as-user": { type: "string" },
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
  if (process.platform === "linux") return linuxMain();
  if (process.platform !== "darwin")
    throw new Error("launchd service management is available only on macOS.");
  if (!values["install-dir"]) throw new Error("--install-dir is required.");
  const installDir = path.resolve(values["install-dir"]);
  const broker = path.join(installDir, "scripts", "runner-broker.mjs");
  const node = process.execPath;
  await Promise.all([access(broker), access(node, constants.X_OK)]);
  const state = path.resolve(values["state-dir"] ?? path.join(installDir, "work", "runner-broker"));
  const userHome = os.homedir();
  const launchAgents = path.join(userHome, "Library", "LaunchAgents");
  const logs = path.join(state, "logs");
  const plist = path.join(launchAgents, `${label}.plist`);
  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) throw new Error("Could not determine the current macOS user ID.");
  if (action === "install") {
    await mkdir(launchAgents, { recursive: true, mode: 0o700 });
    await mkdir(logs, { recursive: true, mode: 0o700 });
    await chmod(logs, 0o700);
    const gitConfig = path.join(state, "gitconfig");
    await writeFile(gitConfig, "", { mode: 0o600 });
    await chmod(gitConfig, 0o600);
    const environment = {
      HOME: userHome,
      LANG: "en_US.UTF-8",
      NVM_BIN: path.dirname(node),
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: [
        path.dirname(node),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        path.join(userHome, ".cargo", "bin"),
      ].join(":"),
    };
    const entries = Object.entries(environment)
      .map(([key, value]) => `    <key>${key}</key><string>${escapeXml(value)}</string>`)
      .join("\n");
    const document = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key><array><string>${escapeXml(node)}</string><string>${escapeXml(broker)}</string><string>serve</string><string>--state-dir</string><string>${escapeXml(state)}</string><string>--supersede-exit-status</string><string>0</string></array>\n  <key>WorkingDirectory</key><string>${escapeXml(installDir)}</string>\n  <key>EnvironmentVariables</key><dict>\n${entries}\n  </dict>\n  <key>RunAtLoad</key><false/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>StandardOutPath</key><string>${escapeXml(path.join(logs, "runner-broker.out.log"))}</string>\n  <key>StandardErrorPath</key><string>${escapeXml(path.join(logs, "runner-broker.err.log"))}</string>\n</dict></plist>\n`;
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

function systemctl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/systemctl", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`systemctl ${args[0]} failed with status ${code ?? 1}.`))
    );
  });
}

async function linuxMain() {
  if (!values["install-dir"]) throw new Error("--install-dir is required.");
  if (action === "install" && process.getuid?.() !== 0)
    throw new Error(
      "Linux system service installation requires root; execution uses --run-as-user."
    );
  const installDir = path.resolve(values["install-dir"]);
  const broker = path.join(installDir, "scripts", "runner-broker.mjs");
  const node = process.execPath;
  const state = path.resolve(values["state-dir"] ?? path.join(installDir, "work", "runner-broker"));
  const unitPath = "/etc/systemd/system/gitedge-runner-broker.service";
  if (action === "install") {
    const username = values["run-as-user"];
    if (!username || !/^[a-z_][a-z0-9_-]{0,31}$/.test(username))
      throw new Error("Linux service install requires a valid --run-as-user account.");
    const passwd = (await readFile("/etc/passwd", "utf8"))
      .split("\n")
      .map((line) => line.split(":"))
      .find((fields) => fields[0] === username);
    if (!passwd || !/^\d+$/.test(passwd[3])) throw new Error("The service user was not found.");
    await Promise.all([access(broker), access(node, constants.X_OK)]);
    const stateInfo = await stat(state);
    if (
      !stateInfo.isDirectory() ||
      stateInfo.uid !== Number(passwd[2]) ||
      stateInfo.gid !== Number(passwd[3]) ||
      (stateInfo.mode & 0o077) !== 0
    )
      throw new Error("The broker state directory must be private and owned by --run-as-user.");
    const unit = buildRunnerBrokerUnit({
      username,
      groupId: passwd[3],
      homeDir: passwd[5],
      installDir,
      stateDir: state,
      nodePath: node,
    });
    await writeFile(unitPath, unit, { mode: 0o644 });
    await systemctl(["daemon-reload"]);
    console.log(`Installed ${label} at ${unitPath}. Run service start to enable it.`);
    return;
  }
  if (action === "start") {
    await systemctl(["enable", "--now", "gitedge-runner-broker.service"]);
    return;
  }
  if (action === "stop") {
    await systemctl(["disable", "--now", "gitedge-runner-broker.service"]);
    return;
  }
  if (action === "status") {
    await systemctl(["status", "gitedge-runner-broker.service"]);
    return;
  }
  throw new Error("Expected service install, start, stop, or status.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Runner broker service failed.");
  process.exitCode = 1;
});
