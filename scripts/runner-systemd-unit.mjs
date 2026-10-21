import path from "node:path";

function safeUnitValue(value, label) {
  if (!/^[A-Za-z0-9_./-]+$/.test(value))
    throw new Error(
      `${label} may contain only letters, numbers, dot, underscore, slash, and hyphen.`
    );
  return value;
}

export function buildRunnerBrokerUnit({ username, groupId, installDir, stateDir, nodePath }) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username) || !/^\d+$/.test(String(groupId)))
    throw new Error("Invalid systemd service account.");
  const install = safeUnitValue(installDir, "install path");
  const state = safeUnitValue(stateDir, "state path");
  const node = safeUnitValue(nodePath, "Node path");
  const broker = safeUnitValue(
    path.posix.join(install, "scripts", "runner-broker.mjs"),
    "broker path"
  );
  const actions = safeUnitValue(path.posix.join(install, "work", "actions"), "actions state path");
  return `[Unit]\nDescription=GitEdge runner broker\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${username}\nGroup=${groupId}\nWorkingDirectory=${install}\nEnvironment=HOME=${state}\nEnvironment=PATH=${path.posix.dirname(node)}:/usr/local/bin:/usr/bin:/bin\nExecStart=${node} ${broker} serve --state-dir ${state}\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=60s\nKillMode=mixed\nCPUQuota=75%\nMemoryHigh=700M\nMemoryMax=800M\nTasksMax=128\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\nReadWritePaths=${state} ${actions}\n\n[Install]\nWantedBy=multi-user.target\n`;
}
