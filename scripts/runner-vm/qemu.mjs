import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createSshGuest } from "./ssh-guest.mjs";

const run = promisify(execFile);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function uuid(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new Error("Invalid VM run id.");
  return value;
}

async function privateDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("QEMU run storage must be a private directory.");
}

function safeText(value, label) {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value))
    throw new Error(`${label} is invalid.`);
  return value;
}

function hostEnvironment(directory) {
  return {
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: directory,
    TMPDIR: directory,
    LANG: "C",
    LC_ALL: "C",
  };
}

function qmp(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const pending = [];
    let ready = false;
    const fail = (error) => {
      if (!ready) reject(error);
      while (pending.length) pending.shift().reject(error);
    };
    socket.setTimeout(5000, () => socket.destroy(new Error("QEMU monitor timed out.")));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.QMP) {
          socket.write(`${JSON.stringify({ execute: "qmp_capabilities" })}\r\n`);
          continue;
        }
        if (message.return !== undefined || message.error) {
          if (!ready) {
            if (message.error) return reject(new Error("QEMU monitor negotiation failed."));
            ready = true;
            resolve({
              async command(execute) {
                await new Promise((done, fail) => {
                  const item = { resolve: done, reject: fail };
                  pending.push(item);
                  socket.write(`${JSON.stringify({ execute })}\r\n`, (error) => {
                    if (!error) return;
                    const index = pending.indexOf(item);
                    if (index >= 0) pending.splice(index, 1);
                    fail(error);
                  });
                });
              },
              close() {
                socket.end();
              },
            });
            continue;
          }
          const item = pending.shift();
          if (item)
            message.error ? item.reject(new Error("QEMU monitor command failed.")) : item.resolve();
        }
      }
    });
    socket.once("connect", () => {});
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("QEMU monitor closed.")));
  });
}

async function waitForChild(child, timeoutMs = 30_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  try {
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("QEMU did not stop.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForChild(child, 5000);
  } catch {
    child.kill("SIGKILL");
    await waitForChild(child, 5000);
  }
}

async function createOverlay(config, base, output) {
  await run(config.qemuImg, ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", base, output], {
    timeout: 120_000,
    windowsHide: true,
    env: hostEnvironment(path.dirname(output)),
  });
}

async function makeSeed(config, context, directory, sshHostKey, sshHostPublic, clientPublic) {
  const seedDirectory = path.join(directory, "seed");
  await mkdir(seedDirectory, { mode: 0o700 });
  const network = config.machine.guestNetwork;
  const hostPublicKey = sshHostPublic.trim().split(/\s+/).slice(0, 2).join(" ");
  const runInfo = {
    version: 1,
    id: context.id,
    network: {
      address: network.address,
      prefixLength: network.prefixLength,
      gateway: network.gateway,
      mac: config.machine.mac,
    },
    sshUser: config.machine.sshUser,
    sshHostPublicKey: hostPublicKey,
    brokerRuntime: config.machine.guestRuntime,
    node: config.machine.guestNode,
    guestAgent: config.machine.guestAgent,
  };
  await writeFile(path.join(seedDirectory, "run.json"), `${JSON.stringify(runInfo)}\n`, {
    mode: 0o600,
  });
  const forcedCommand = `/usr/bin/sudo -n -- '${config.machine.guestNode}' '${config.machine.guestAgent}'`;
  await writeFile(
    path.join(seedDirectory, "authorized_keys"),
    `restrict,command="${forcedCommand}" ${clientPublic.trim()}\n`,
    { mode: 0o600 }
  );
  await copyFile(sshHostKey, path.join(seedDirectory, "ssh_host_ed25519_key"));
  await copyFile(`${sshHostKey}.pub`, path.join(seedDirectory, "ssh_host_ed25519_key.pub"));
  await run(
    config.xorriso,
    [
      "-as",
      "mkisofs",
      "-volid",
      "GITEDGE_SEED",
      "-iso-level",
      "3",
      "-J",
      "-R",
      "-o",
      path.join(directory, "seed.iso"),
      seedDirectory,
    ],
    {
      timeout: 60_000,
      windowsHide: true,
      env: hostEnvironment(directory),
    }
  );
  await rm(seedDirectory, { recursive: true });
}

function qemuArguments(config, context, files) {
  const machine = config.machine;
  const devices = [
    "-uuid",
    context.id,
    "-accel",
    "kvm",
    "-machine",
    "q35",
    "-cpu",
    "Skylake-Client,-hle,-rtm,kvm=on,vendor=GenuineIntel,+invtsc,vmware-cpuid-freq=on,+ssse3,+sse4.2,+popcnt,+avx,+aes,+xsave,+xsaveopt,check",
    "-m",
    String(machine.memoryMiB),
    "-smp",
    `cpus=${machine.cpus},cores=${machine.cpus},sockets=1`,
    "-readconfig",
    config.smcConfig,
    "-drive",
    `if=pflash,format=raw,readonly=on,file=${config.firmwareCode}`,
    "-drive",
    `if=pflash,format=raw,file=${files.nvram}`,
    "-smbios",
    "type=2",
    "-device",
    "qemu-xhci,id=xhci",
    "-device",
    "usb-kbd,bus=xhci.0",
    "-device",
    "usb-tablet,bus=xhci.0",
    "-device",
    "usb-ehci,id=ehci",
    "-device",
    "ich9-intel-hda",
    "-device",
    "hda-duplex",
    "-device",
    "ich9-ahci,id=sata",
  ];
  for (const [id, file, bus] of [
    ["opencore", files.openCore, "sata.2"],
    ["seed", files.seed, "sata.3"],
    ["system", files.system, "sata.4"],
    ["runner-data", files.runnerData, "sata.5"],
  ]) {
    devices.push(
      "-drive",
      `if=none,id=${id},file=${file},format=${id === "seed" ? "raw" : "qcow2"},readonly=${id === "seed" ? "on" : "off"}`
    );
    devices.push("-device", `${id === "seed" ? "ide-cd" : "ide-hd"},drive=${id},bus=${bus}`);
  }
  devices.push(
    "-netdev",
    `tap,id=net0,ifname=${machine.tap},script=no,downscript=no`,
    "-device",
    `virtio-net-pci,netdev=net0,mac=${machine.mac}`,
    "-display",
    "none",
    "-qmp",
    `unix:${files.qmp},server=on,wait=off`,
    "-no-reboot"
  );
  return devices;
}

export async function createQemuVm(config, context) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("The QEMU macOS provider requires a Linux x64 KVM host.");
  const id = uuid(context.id);
  const directory = path.resolve(safeText(context.directory, "run directory"));
  if (path.basename(directory) !== id) throw new Error("QEMU run directory must match the run id.");
  await privateDirectory(directory);
  const machine = config.machine;
  const files = {
    nvram: path.join(directory, "nvram.fd"),
    openCore: path.join(directory, "opencore.qcow2"),
    system: path.join(directory, "system.qcow2"),
    runnerData: path.join(directory, "runner-data.qcow2"),
    seed: path.join(directory, "seed.iso"),
    qmp: path.join(directory, "qmp.sock"),
    pid: path.join(directory, "qemu.pid"),
    clientKey: path.join(directory, "controller_ed25519"),
    hostKey: path.join(directory, "guest_host_ed25519"),
  };
  let child;
  let disposed = false;
  try {
    const runEnv = hostEnvironment(directory);
    await Promise.all([
      createOverlay(config, machine.openCoreImage, files.openCore),
      createOverlay(config, machine.systemImage, files.system),
      createOverlay(config, machine.runnerDataImage, files.runnerData),
      copyFile(config.nvramTemplate, files.nvram),
    ]);
    await run(
      config.sshKeygen,
      ["-q", "-t", "ed25519", "-N", "", "-C", `controller-${id}`, "-f", files.clientKey],
      { timeout: 30_000, env: runEnv }
    );
    await run(
      config.sshKeygen,
      ["-q", "-t", "ed25519", "-N", "", "-C", `guest-${id}`, "-f", files.hostKey],
      { timeout: 30_000, env: runEnv }
    );
    const [clientPublic, hostPublic] = await Promise.all([
      readFile(`${files.clientKey}.pub`, "utf8"),
      readFile(`${files.hostKey}.pub`, "utf8"),
    ]);
    const hostKey = hostPublic.trim().split(/\s+/).slice(0, 2).join(" ");
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+=*$/.test(hostKey))
      throw new Error("Invalid generated guest host key.");
    await makeSeed(config, context, directory, files.hostKey, hostPublic, clientPublic);
    child = spawn(config.qemu, qemuArguments(config, context, files), {
      cwd: config.qemuWorkingDirectory,
      stdio: "ignore",
      env: runEnv,
      detached: true,
      shell: false,
    });
    const processExited = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal }))
    );
    child.once("error", () => {});
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      await processExited;
      throw new Error("QEMU could not start a host process.");
    }
    const processFailed = new Promise((_, reject) => child.once("error", reject));
    child.unref();
    await writeFile(files.pid, `${child.pid}\n`, { flag: "wx", mode: 0o600 });
    const vm = await Promise.race([
      createSshGuest(
        {
          guestRoot: machine.guestRoot,
          guestNode: machine.guestNode,
          guestRuntime: machine.guestRuntime,
          guestAgent: machine.guestAgent,
          guestNetwork: machine.guestNetwork,
          sshUser: machine.sshUser,
          sshHostKey: hostKey,
          sshKeyPath: files.clientKey,
          sshHostKeyPath: files.hostKey,
          sshAgentPath: machine.guestAgent,
          sshExecutable: config.ssh,
          sshBindAddress: machine.guestNetwork.gateway,
          hostEnvironment: runEnv,
        },
        { id, directory, signal: context.signal },
        async () => stop()
      ),
      processFailed,
      processExited.then(({ code, signal }) => {
        throw new Error(
          `QEMU exited before guest SSH readiness (status ${code ?? signal ?? "unknown"}).`
        );
      }),
    ]);
    async function stop() {
      if (disposed) return;
      disposed = true;
      try {
        const monitor = await qmp(files.qmp);
        await monitor.command("system_powerdown");
        monitor.close();
        await waitForChild(child);
      } catch {
        await terminateChild(child);
      }
    }
    return {
      ...vm,
      async dispose() {
        await vm.dispose();
      },
    };
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
}

export async function recoverQemuVm(machine, context) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("QEMU recovery requires a Linux x64 host.");
  const id = uuid(context.id);
  const directory = path.resolve(context.directory);
  if (path.basename(directory) !== id)
    throw new Error("QEMU recovery directory does not match its run id.");
  const pidText = await readFile(path.join(directory, "qemu.pid"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const monitorPath = path.join(directory, "qmp.sock");
  let pid;
  if (pidText === undefined) {
    const found = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const commandLine = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
      if (commandLine.includes(monitorPath)) found.push(Number(entry));
    }
    if (found.length > 1)
      throw new Error("Multiple QEMU processes reference one VM run directory.");
    if (!found.length) return;
    [pid] = found;
  } else {
    pid = Number(pidText.trim());
  }
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid QEMU process metadata.");
  const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (commandLine === undefined) return;
  if (!commandLine.includes(monitorPath))
    throw new Error("The recorded QEMU process does not own this run directory.");
  const monitor = await qmp(monitorPath);
  await monitor.command("system_powerdown");
  monitor.close();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Recovered QEMU guest did not shut down before cleanup.");
}
