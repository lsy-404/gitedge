import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
  statfs,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { createHypervVm, recoverHypervVm } from "./runner-vm/hyperv.mjs";
import { createQemuVm, recoverQemuVm } from "./runner-vm/qemu.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const mebibyte = 1_048_576;

async function privatePath(file, directory = false) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()))
    throw new Error("VM state must use private regular files and directories.");
  if (process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    throw new Error("VM state must be private to the broker account.");
  return info;
}

function hostPath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\r\n]/.test(value))
    throw new Error(`${name} must be an absolute host path.`);
  return value;
}

export function guestPaths(config) {
  return config.guest.platform === "windows" ? path.win32 : path.posix;
}

function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  return value;
}

export async function loadVmPools(state, profiles) {
  const file = path.join(state, "vm.json");
  const info = await lstat(file).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) {
    if (profiles?.some((profile) => ["hyperv", "qemu"].includes(profile.execution)))
      throw new Error("A registered VM profile requires vm.json; host execution is disabled.");
    return undefined;
  }
  await privatePath(file);
  if (info.size > 65_536) throw new Error("VM pool configuration is too large.");
  const value = JSON.parse(await readFile(file, "utf8"));
  if (
    value.version !== 1 ||
    !["hyperv", "qemu"].includes(value.driver) ||
    !value.pools ||
    Array.isArray(value.pools)
  )
    throw new Error("Invalid VM pool configuration.");
  if (
    (value.driver === "hyperv" && (process.platform !== "win32" || os.arch() !== "x64")) ||
    (value.driver === "qemu" && (process.platform !== "linux" || os.arch() !== "x64"))
  )
    throw new Error(`${value.driver} pools require a matching x64 host.`);
  hostPath(value.vmRoot, "vmRoot");
  if (
    path.dirname(value.vmRoot) === value.vmRoot ||
    path.resolve(value.vmRoot) === path.resolve(state)
  )
    throw new Error("VM storage must have its own private directory.");
  const reserveMemoryMiB = integer(
    value.reserveMemoryMiB,
    value.driver === "qemu" ? 1024 : 4096,
    Math.floor(os.totalmem() / mebibyte) - 1024,
    "reserveMemoryMiB"
  );
  const reserveCpus = integer(value.reserveCpus, 1, os.cpus().length - 1, "reserveCpus");
  const reserveDiskMiB = integer(value.reserveDiskMiB, 4096, 1_048_576, "reserveDiskMiB");
  const configs = new Map();
  const addresses = new Set();
  const selectedProfiles = profiles ?? Object.keys(value.pools).map((id) => ({ id }));
  for (const profile of selectedProfiles) {
    const config = value.pools[profile.id];
    if (
      !config ||
      !(value.driver === "qemu"
        ? config.guest?.platform === "macos"
        : ["windows", "linux"].includes(config.guest?.platform)) ||
      config.guest.arch !== "x64"
    )
      throw new Error(`Profile ${profile.id} requires a supported VM guest pool.`);
    config.id = profile.id;
    config.vmRoot = value.vmRoot;
    config.driver = value.driver;
    integer(config.slots, 1, 16, "pool.slots");
    integer(config.machine?.cpus, 1, os.cpus().length - reserveCpus, "machine.cpus");
    integer(
      config.machine?.memoryMiB,
      1024,
      Math.floor(os.totalmem() / mebibyte) - reserveMemoryMiB,
      "machine.memoryMiB"
    );
    integer(config.machine?.diskMiB, 8192, 2_097_152, "machine.diskMiB");
    hostPath(config.machine.baseImage, "machine.baseImage");
    if (value.driver === "qemu") {
      for (const key of ["openCoreImage", "systemImage", "runnerDataImage"])
        hostPath(config.machine[key], `machine.${key}`);
      if (path.resolve(config.machine.baseImage) !== path.resolve(config.machine.systemImage))
        throw new Error("QEMU machine.baseImage must be the sealed macOS system image.");
      for (const key of [
        "qemu",
        "qemuImg",
        "xorriso",
        "ssh",
        "sshKeygen",
        "firmwareCode",
        "nvramTemplate",
        "smcConfig",
        "qemuWorkingDirectory",
      ]) {
        hostPath(value[key], key);
        config[key] = value[key];
      }
      if (
        config.slots !== 2 ||
        !Array.isArray(config.addresses) ||
        config.addresses.length !== config.slots ||
        !Array.isArray(config.slotNetwork) ||
        config.slotNetwork.length !== config.slots ||
        config.slotNetwork.some(
          (entry, index) =>
            !entry ||
            entry.address !== ["10.253.247.2", "10.253.247.3"][index] ||
            entry.address !== config.addresses[index] ||
            entry.tap !== ["gemac1", "gemac2"][index] ||
            entry.mac !== ["52:54:00:74:00:01", "52:54:00:74:00:02"][index]
        ) ||
        new Set(config.slotNetwork.map((entry) => entry.tap)).size !== config.slots ||
        new Set(config.slotNetwork.map((entry) => entry.mac.toLowerCase())).size !== config.slots
      )
        throw new Error("Each QEMU slot requires a pre-provisioned TAP, MAC, and guest address.");
      if (
        config.machine.guestNetwork?.address !== "10.253.247.2" ||
        config.machine.guestNetwork?.prefixLength !== 29 ||
        config.machine.guestNetwork?.gateway !== "10.253.247.1" ||
        !Array.isArray(config.machine.guestNetwork.dns) ||
        config.machine.guestNetwork.dns.length !== 0 ||
        config.machine.cachePort !== 3129 ||
        config.machine.egressProxyPort !== 3128
      )
        throw new Error("QEMU guest networking must match the isolated bridge policy.");
      if (config.guest.sshUser !== "gitedge-runner")
        throw new Error("The macOS guest account must use the prepared gitedge-runner identity.");
      for (const key of ["root", "node", "runtimeRoot", "runnerPath"]) {
        const entry = config.guest[key];
        if (
          typeof entry !== "string" ||
          !/^\/Volumes\/RunnerData\/Users\/gitedge-runner(?:\/[A-Za-z0-9._-]+)*$/.test(entry) ||
          entry.split("/").some((part) => part === "." || part === "..")
        )
          throw new Error(`guest.${key} must stay on the private RunnerData volume.`);
      }
    }
    const guestPath = guestPaths(config);
    for (const key of [
      "root",
      "node",
      "runtimeRoot",
      "runnerPath",
      ...(config.guest.platform === "windows" ? ["entrypoint"] : []),
    ]) {
      const entry = config.guest[key];
      if (typeof entry !== "string" || !guestPath.isAbsolute(entry) || /[\0\r\n]/.test(entry))
        throw new Error(`guest.${key} must be an absolute guest path.`);
    }
    if (
      !config.guest.environment ||
      Array.isArray(config.guest.environment) ||
      Object.entries(config.guest.environment).some(
        ([key, entry]) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== "string" || entry.includes("\0")
      )
    )
      throw new Error("The image must declare its non-secret guest environment.");
    if (!Array.isArray(config.addresses) || config.addresses.length !== config.slots)
      throw new Error("Each VM slot requires one unique guest address.");
    for (const address of config.addresses) {
      if (addresses.has(address)) throw new Error("Guest addresses must be unique across pools.");
      addresses.add(address);
    }
    configs.set(profile.id, config);
  }
  if (Object.keys(value.pools).length !== selectedProfiles.length)
    throw new Error("VM pools must match the registered profiles exactly.");
  await mkdir(value.vmRoot, { recursive: true, mode: 0o700 });
  await privatePath(value.vmRoot, true);
  if ((await realpath(value.vmRoot)) !== path.resolve(value.vmRoot))
    throw new Error("VM storage must not contain symbolic links.");
  const ownerPath = path.join(value.vmRoot, ".broker-owner.json");
  await writeFile(ownerPath, JSON.stringify({ version: 1, state: await realpath(state) }), {
    flag: "wx",
    mode: 0o600,
  }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  await privatePath(ownerPath);
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  if (owner.version !== 1 || owner.state !== (await realpath(state)))
    throw new Error("VM storage belongs to another broker state.");
  const disk = await statfs(value.vmRoot, { bigint: true });
  const diskBudgetMiB = Number((disk.bavail * disk.bsize) / BigInt(mebibyte)) - reserveDiskMiB;
  if (
    [...configs.values()].reduce(
      (sum, config) => sum + config.slots * config.machine.memoryMiB,
      0
    ) >
      os.totalmem() / mebibyte - reserveMemoryMiB ||
    [...configs.values()].reduce((sum, config) => sum + config.slots * config.machine.cpus, 0) >
      os.cpus().length - reserveCpus ||
    [...configs.values()].reduce((sum, config) => sum + config.slots, 0) > 16
  )
    throw new Error("The VM pools exceed the shared host resource budget.");
  return {
    ...value,
    configs,
    diskBudgetMiB,
    memoryBudgetMiB: Math.floor(os.totalmem() / mebibyte) - reserveMemoryMiB,
    cpuBudget: os.cpus().length - reserveCpus,
  };
}

export async function recoverJobVms(pool) {
  const root = path.join(pool.vmRoot, "runs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await privatePath(root, true);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !uuid.test(entry.name))
      throw new Error("Unexpected content in the VM run directory.");
    const directory = path.join(root, entry.name);
    await privatePath(directory, true);
    if (!(await readdir(directory)).length) {
      await rmdir(directory);
      continue;
    }
    const markerPath = path.join(directory, ".runner-vm.json");
    const info = await privatePath(markerPath);
    if (info.size > 65_536) throw new Error("Invalid VM recovery metadata.");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    const config = pool.configs.get(marker.pool);
    const slotNetwork =
      config?.driver === "qemu"
        ? config.slotNetwork.find((slot) => slot.address === marker.machine?.guestNetwork?.address)
        : undefined;
    if (
      marker.version !== 1 ||
      marker.driver !== config?.driver ||
      marker.id !== entry.name ||
      marker.machine?.vmRoot !== pool.vmRoot ||
      !config ||
      marker.machine.baseImage !== config.machine.baseImage ||
      !config.addresses.includes(marker.machine.guestNetwork.address) ||
      (marker.driver === "qemu" &&
        (!slotNetwork ||
          marker.machine.tap !== slotNetwork.tap ||
          marker.machine.mac !== slotNetwork.mac ||
          marker.machine.openCoreImage !== config.machine.openCoreImage ||
          marker.machine.systemImage !== config.machine.systemImage ||
          marker.machine.runnerDataImage !== config.machine.runnerDataImage))
    )
      throw new Error("VM recovery metadata does not belong to this broker pool.");
    if (marker.driver === "hyperv")
      await recoverHypervVm(marker.machine, { id: entry.name, directory });
    else if (marker.driver === "qemu")
      await recoverQemuVm(marker.machine, { id: entry.name, directory });
    else throw new Error("Unknown VM recovery provider.");
    await rm(directory, { recursive: true });
  }
  const disk = await statfs(pool.vmRoot, { bigint: true });
  pool.diskBudgetMiB = Number((disk.bavail * disk.bsize) / BigInt(mebibyte)) - pool.reserveDiskMiB;
  const requested = [...pool.configs.values()].reduce(
    (sum, config) => sum + config.slots * config.machine.diskMiB,
    0
  );
  if (requested > pool.diskBudgetMiB)
    throw new Error("The configured VM disks exceed available host storage.");
}

export async function createJobVm(config, signal, address = config.addresses[0]) {
  const id = randomUUID();
  const directory = path.join(config.vmRoot, "runs", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await privatePath(directory, true);
  const slotNetwork =
    config.driver === "qemu"
      ? config.slotNetwork.find((entry) => entry.address === address)
      : undefined;
  if (config.driver === "qemu" && !slotNetwork)
    throw new Error("The QEMU slot has no network assignment.");
  const machine = {
    ...config.machine,
    vmRoot: config.vmRoot,
    guestPlatform: config.guest.platform,
    guestRoot: config.guest.root,
    guestNode: config.guest.node,
    guestRuntime: config.guest.runtimeRoot,
    guestAgent: guestPaths(config).join(
      config.guest.runtimeRoot,
      "scripts",
      "runner-vm",
      "guest.mjs"
    ),
    sshUser: config.guest.sshUser,
    arch: config.guest.arch,
    ...(config.guest.platform === "linux"
      ? {
          sshAgentPath: guestPaths(config).join(
            config.guest.runtimeRoot,
            "scripts",
            "runner-vm",
            "guest.mjs"
          ),
        }
      : {}),
    guestNetwork: { ...config.machine.guestNetwork, address },
    ...(slotNetwork ? { tap: slotNetwork.tap, mac: slotNetwork.mac } : {}),
  };
  const provider = { ...config, machine };
  await writeFile(
    path.join(directory, ".runner-vm.json"),
    JSON.stringify({
      version: 1,
      driver: config.driver,
      pool: config.id,
      id,
      createdAt: new Date().toISOString(),
      hostPid: process.pid,
      machine,
    }),
    { flag: "wx", mode: 0o600 }
  );
  let vm;
  try {
    vm =
      config.driver === "hyperv"
        ? await createHypervVm(machine, { id, directory, signal })
        : await createQemuVm(provider, { id, directory, signal });
    return {
      ...vm,
      async dispose() {
        await vm.dispose();
        await rm(directory, { recursive: true });
      },
    };
  } catch (error) {
    try {
      if (config.driver === "hyperv") await recoverHypervVm(machine, { id, directory });
      else await recoverQemuVm(machine, { id, directory });
      await rm(directory, { recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `VM cleanup requires attention: ${directory}`
      );
    }
    throw error;
  }
}

export function guestEnvironment(config, scoped = {}) {
  const proxy =
    config.driver === "qemu"
      ? `http://${config.machine.guestNetwork.gateway}:${config.machine.egressProxyPort}`
      : undefined;
  return {
    ...config.guest.environment,
    ...(proxy
      ? {
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          http_proxy: proxy,
          https_proxy: proxy,
          NODE_USE_ENV_PROXY: "1",
          NO_PROXY: `127.0.0.1,localhost,::1,${config.machine.guestNetwork.gateway}`,
          no_proxy: `127.0.0.1,localhost,::1,${config.machine.guestNetwork.gateway}`,
        }
      : {}),
    ...scoped,
  };
}

async function runtimeDigest(root) {
  const fs = await import("node:fs/promises");
  const paths = await import("node:path");
  const crypto = await import("node:crypto");
  const hash = crypto.createHash("sha256");
  const visit = async (relative) => {
    const file = paths.join(root, ...relative.split("/"));
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) throw new Error("Broker runtime must not contain symbolic links.");
    if (info.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(`${relative}/${name}`);
    } else if (info.isFile()) {
      hash
        .update(relative)
        .update("\0")
        .update(await fs.readFile(file))
        .update("\0");
    } else throw new Error("Unexpected broker runtime file.");
  };
  for (const relative of ["package.json", "pnpm-lock.yaml", "scripts", "packages/contracts"])
    await visit(relative);
  return hash.digest("hex");
}

export async function verifyVmImage(config, signal) {
  const guestPath = guestPaths(config);
  const brokerHash = await runtimeDigest(fileURLToPath(new URL("../", import.meta.url)));
  const vm = await createJobVm(config, signal);
  try {
    const probe = `
      (async()=>{
      const os=require('node:os'),fs=require('node:fs'),cp=require('node:child_process');
      const available=(command,args)=>{try{return cp.spawnSync(command,args,{timeout:60000,stdio:'ignore'}).status===0}catch{return false}};
      if(process.platform==='linux'&&available('docker',['--version'])){
        const deadline=Date.now()+60000;
        while(!available('docker',['info'])){
          if(Date.now()>=deadline)throw new Error('Guest Docker daemon did not become ready.');
          await new Promise(resolve=>setTimeout(resolve,2000));
        }
      }
      if(await (${runtimeDigest.toString()})(${JSON.stringify(config.guest.runtimeRoot)})!==${JSON.stringify(brokerHash)})throw new Error('Guest broker runtime does not match this host release.');
      fs.accessSync(${JSON.stringify(guestPath.join(config.guest.runtimeRoot, "scripts", "actions-runner.mjs"))});
      fs.accessSync(${JSON.stringify(guestPath.join(config.guest.runnerPath, "bin", config.guest.platform === "windows" ? "Runner.Listener.exe" : "Runner.Listener"))});
      const commands={pnpm:process.platform==='win32'?['cmd.exe',['/d','/c','pnpm.cmd','--version']]:['pnpm',['--version']],git:['git',['--version']],docker:['docker',['version','--format','{{.Server.Version}}']],python:[process.platform==='win32'?'python':'python3',['--version']],go:['go',['version']],rust:['rustc',['--version']]};
      const tools=['node',...Object.entries(commands).filter(([,v])=>available(...v)).map(([k])=>k)];
      const disk=fs.statfsSync(${JSON.stringify(config.guest.root)},{bigint:true});
      console.log(JSON.stringify({platform:process.platform==='win32'?'windows':process.platform,arch:os.arch(),node:process.versions.node,tools,memFreeMb:Math.floor(os.freemem()/1048576),diskFreeMb:Number(disk.bavail*disk.bsize/1048576n)}));
      })().catch(error=>{console.error(error.message);process.exitCode=1});`;
    const task = await vm.start({
      command: config.guest.node,
      args: ["-e", probe],
      cwd: config.guest.root,
      env: guestEnvironment(config),
      input: new Uint8Array(),
    });
    const result = await task.done;
    if (result.code !== 0)
      throw new Error(
        `VM image verification failed: ${Buffer.from(result.stderr).toString("utf8")}`
      );
    let report;
    try {
      report = JSON.parse(Buffer.from(result.stdout).toString("utf8"));
    } catch {
      throw new Error(`VM image ${config.id} returned invalid verification output.`);
    }
    if (
      (report.platform === "darwin" ? "macos" : report.platform) !== config.guest.platform ||
      report.arch !== config.guest.arch ||
      !/^24\./.test(report.node) ||
      !report.tools.includes("git") ||
      !report.tools.includes("pnpm")
    )
      throw new Error("Guest platform, Node 24, Git and pnpm must be verified.");
    config.verified = report;
    return report;
  } finally {
    await vm.dispose();
  }
}

export function vmSlot(pool, config, sharedSlot, ledger) {
  const held = new Map();
  const availableMemoryMiB = () => {
    if (config.driver !== "qemu") return os.freemem() / mebibyte;
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (!match) throw new Error("Linux MemAvailable is unavailable for QEMU admission.");
    return Number(match[1]) / 1024;
  };
  const canAllocate = () =>
    held.size < config.slots &&
    ledger.memory + config.machine.memoryMiB <= pool.memoryBudgetMiB &&
    ledger.cpus + config.machine.cpus <= pool.cpuBudget &&
    availableMemoryMiB() >= config.machine.memoryMiB + (config.driver === "hyperv" ? 8192 : 0);
  return {
    size: config.slots,
    busy: () => (canAllocate() ? held.size : config.slots),
    subscribe: (listener) => sharedSlot.subscribe(listener),
    claimAddress() {
      const entry = [...held].find(([, running]) => !running);
      if (!entry) throw new Error("The VM job has no reserved address.");
      held.set(entry[0], true);
      return entry[0];
    },
    async tryAcquire() {
      if (!canAllocate()) return undefined;
      const address = config.addresses.find((entry) => !held.has(entry));
      held.set(address, false);
      ledger.memory += config.machine.memoryMiB;
      ledger.cpus += config.machine.cpus;
      const undo = () => {
        held.delete(address);
        ledger.memory -= config.machine.memoryMiB;
        ledger.cpus -= config.machine.cpus;
      };
      let release;
      try {
        release = await sharedSlot.tryAcquire();
      } catch (error) {
        undo();
        throw error;
      }
      if (!release) {
        undo();
        return undefined;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        undo();
        await release();
      };
    },
  };
}

export async function getVmCapacity(config, slot) {
  if (!config.verified) throw new Error("The VM image has not passed startup verification.");
  const disk = await statfs(config.vmRoot, { bigint: true });
  return {
    os: config.guest.platform,
    arch: config.guest.arch,
    isolation: "vm",
    cpus: config.machine.cpus,
    memTotalMb: config.machine.memoryMiB,
    memFreeMb: config.verified.memFreeMb,
    diskFreeMb: Math.min(
      config.verified.diskFreeMb,
      Number((disk.bavail * disk.bsize) / BigInt(mebibyte))
    ),
    load1: 0,
    tools: [...config.verified.tools],
    gpus: [],
    slots: slot.size,
    busy: slot.busy(),
  };
}
