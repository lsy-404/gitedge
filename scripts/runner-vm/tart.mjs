import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const run = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumOutput = 64 * 1024;

export function tartVmName(id) {
  if (!uuid.test(id)) throw new Error("Invalid Tart VM run id.");
  return `gitedge-job-${id}`;
}

export function validateTartPool(config) {
  const machine = config.machine;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(machine.baseImage) ||
    machine.baseImage.startsWith("gitedge-job-")
  )
    throw new Error("Tart requires a local, prepared base VM name.");
  if (
    config.slots !== 1 ||
    config.addresses?.length !== 1 ||
    config.addresses[0] !== "127.0.0.1" ||
    machine.guestNetwork?.gateway !== "127.0.0.1" ||
    machine.cachePort !== 3129
  )
    throw new Error("Tart pools require one slot and a loopback cache tunnel on port 3129.");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(config.guest.sshUser))
    throw new Error("Tart requires an existing guest SSH user.");
  if (
    !Number.isSafeInteger(machine.cpus) ||
    machine.cpus < 1 ||
    !Number.isSafeInteger(machine.memoryMiB) ||
    machine.memoryMiB < 1024
  )
    throw new Error("Invalid Tart VM resources.");
}

export function tartRunArguments(name) {
  return [
    "run",
    name,
    "--no-graphics",
    "--no-audio",
    "--no-clipboard",
    "--no-usb-accessories",
    "--net-softnet",
    "--net-softnet-block",
    "out @host,out @peers,in 0.0.0.0/0",
    "--net-softnet-allow",
    "in proto tcp @host port 22,out proto udp @host port 53,out proto tcp @host port 53",
  ];
}

function environment(config, directory) {
  return {
    PATH: `${path.dirname(config.softnet)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: os.homedir(),
    TMPDIR: directory,
    LANG: "en_US.UTF-8",
    TART_HOME: config.tartHome,
    TART_NO_AUTO_PRUNE: "1",
    CI: "1",
  };
}

async function privateDirectory(directory) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(directory)) !== path.resolve(directory)
  )
    throw new Error("Tart storage must be a private real directory owned by the broker.");
}

function command(config, args, directory, signal, timeout = 60_000) {
  return run(config.tart, args, {
    env: environment(config, directory),
    timeout,
    signal,
    maxBuffer: maximumOutput,
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Tart process did not stop.")), 10_000);
      }),
    ]);
  } catch {
    child.kill("SIGKILL");
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

function guestCommand(config, context, name, args, input = Buffer.alloc(0)) {
  context.signal?.throwIfAborted();
  const child = spawn(config.tart, ["exec", "-i", name, ...args], {
    env: environment(config, context.directory),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  for (const stream of ["stdout", "stderr"])
    child[stream].on("data", (chunk) => {
      output[stream] = Buffer.concat([output[stream], chunk]).subarray(-maximumOutput);
    });
  const abort = () => child.kill("SIGTERM");
  context.signal?.addEventListener("abort", abort, { once: true });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      context.signal?.removeEventListener("abort", abort);
      resolve({ code: code ?? 1, signal, ...output });
    });
  });
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") child.kill();
  });
  child.stdin.end(input, () => input.fill(0));
  return { child, done };
}

// Read only the guest's public host key; controller private keys never leave the host.
const installTunnelKey = `
const fs=require('node:fs'),cp=require('node:child_process');
let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
 const {user,key}=JSON.parse(input);
 if(!/^[a-z][a-z0-9_-]{0,31}$/.test(user)||!/^ssh-ed25519 [A-Za-z0-9+/]+=*(?: .*)?$/.test(key))process.exit(1);
 const home='/Users/'+user,dir=home+'/.ssh';
 if(fs.lstatSync(home).isSymbolicLink())process.exit(1);
 fs.mkdirSync(dir,{recursive:true,mode:448});
 if(fs.lstatSync(dir).isSymbolicLink())process.exit(1);fs.chmodSync(dir,448);
 const file=dir+'/authorized_keys';
 if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())process.exit(1);
 fs.writeFileSync(file,'restrict,port-forwarding,command="/usr/bin/false",permitlisten="127.0.0.1:3129" '+key+'\\n',{mode:384});
 fs.chmodSync(file,384);cp.execFileSync('/usr/sbin/chown',['-R',user,dir]);
 process.stdout.write(fs.readFileSync('/etc/ssh/ssh_host_ed25519_key.pub','utf8'));
});`;

async function cacheTunnel(config, context, name) {
  const clientKey = path.join(context.directory, "cache-controller");
  await run("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKey], {
    timeout: 30_000,
    signal: context.signal,
  });
  const publicKey = (await readFile(`${clientKey}.pub`, "utf8")).trim();
  const setup = guestCommand(
    config,
    context,
    name,
    ["/usr/bin/sudo", "-n", config.machine.guestNode, "-e", installTunnelKey],
    Buffer.from(JSON.stringify({ user: config.machine.sshUser, key: publicKey }))
  );
  const setupResult = await setup.done;
  const hostKey = setupResult.stdout.toString("utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  if (setupResult.code || !/^ssh-ed25519 [A-Za-z0-9+/]+=*$/.test(hostKey))
    throw new Error("Tart guest cache tunnel preparation failed.");
  const { stdout } = await command(
    config,
    ["ip", name, "--wait", "60", "--resolver", "agent"],
    context.directory,
    context.signal
  );
  const address = stdout.trim();
  if (
    !/^(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(
      address
    ) ||
    address.split(".").some((part) => Number(part) > 255)
  )
    throw new Error("Tart did not return a private guest IPv4 address.");
  const knownHosts = path.join(context.directory, "cache-known-hosts");
  await writeFile(knownHosts, `${name} ${hostKey}\n`, { flag: "wx", mode: 0o600 });
  const tunnel = spawn(
    "/usr/bin/ssh",
    [
      "-N",
      "-T",
      "-F",
      "/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      `HostKeyAlias=${name}`,
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "UpdateHostKeys=no",
      "-i",
      clientKey,
      "-R",
      "127.0.0.1:3129:127.0.0.1:3129",
      `${config.machine.sshUser}@${address}`,
    ],
    {
      env: environment(config, context.directory),
      stdio: "ignore",
    }
  );
  let failure;
  tunnel.once("error", (error) => {
    failure = error;
  });
  tunnel.once("close", () => {
    failure ??= new Error("Tart cache tunnel closed.");
  });
  const deadline = Date.now() + 30_000;
  try {
    while (true) {
      context.signal?.throwIfAborted();
      if (failure) {
        await stopProcess(tunnel);
        throw new Error("Tart cache tunnel could not start.");
      }
      const probe = guestCommand(config, context, name, [
        config.machine.guestNode,
        "-e",
        `const n=require('node:net').connect(3129,'127.0.0.1');n.setTimeout(1000);n.on('connect',()=>{n.end();process.exit(0)});n.on('error',()=>process.exit(1));n.on('timeout',()=>process.exit(1));`,
      ]);
      if ((await probe.done).code === 0) return { process: tunnel, failure: () => failure };
      if (Date.now() >= deadline) {
        await stopProcess(tunnel);
        throw new Error("Tart cache tunnel readiness timed out.");
      }
      await delay(500, undefined, { signal: context.signal });
    }
  } catch (error) {
    await stopProcess(tunnel);
    throw error;
  }
}

export async function recoverTartVm(config, context) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Tart recovery requires an Apple Silicon macOS host.");
  const name = tartVmName(context.id);
  if (path.basename(context.directory) !== context.id)
    throw new Error("Invalid Tart run directory.");
  await privateDirectory(context.directory);
  await privateDirectory(config.tartHome);
  const vmPath = path.join(config.tartHome, "vms", name);
  const info = await lstat(vmPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unexpected Tart job storage.");
  const { stdout } = await command(config, ["list", "--format", "json"], context.directory);
  const entry = JSON.parse(stdout).find((vm) => vm.Name === name && vm.Source === "local");
  if (!entry || typeof entry.Running !== "boolean")
    throw new Error("Could not establish the Tart job VM state.");
  if (entry.Running) await command(config, ["stop", name], context.directory);
  await command(config, ["delete", name], context.directory);
}

export async function createTartVm(config, context, { openCacheTunnel = cacheTunnel } = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Tart requires an Apple Silicon macOS host.");
  const name = tartVmName(context.id);
  if (path.basename(context.directory) !== context.id)
    throw new Error("Invalid Tart run directory.");
  await privateDirectory(context.directory);
  await privateDirectory(config.tartHome);
  let running;
  let tunnel;
  let active;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    await stopProcess(active);
    await stopProcess(tunnel?.process);
    await stopProcess(running);
    await recoverTartVm(config, context);
    disposed = true;
  };
  try {
    await command(
      config,
      ["clone", config.machine.baseImage, name],
      context.directory,
      context.signal,
      120_000
    );
    await command(
      config,
      [
        "set",
        name,
        "--cpu",
        String(config.machine.cpus),
        "--memory",
        String(config.machine.memoryMiB),
      ],
      context.directory,
      context.signal
    );
    running = spawn(config.tart, tartRunArguments(name), {
      env: environment(config, context.directory),
      stdio: "ignore",
    });
    let bootFailure;
    running.once("error", (error) => {
      bootFailure = error;
    });
    running.once("close", () => {
      bootFailure ??= new Error("Tart VM exited.");
    });
    const bootContext = {
      ...context,
      signal: AbortSignal.any([
        ...(context.signal ? [context.signal] : []),
        AbortSignal.timeout(240_000),
      ]),
    };
    while (true) {
      bootContext.signal.throwIfAborted();
      if (bootFailure) throw new Error("Tart VM failed before guest readiness.");
      const probe = guestCommand(config, bootContext, name, ["/usr/bin/id", "-un"]);
      active = probe.child;
      const result = await probe.done;
      if (result.code === 0) {
        if (result.stdout.toString("utf8").trim() !== config.guest.sshUser)
          throw new Error("Tart guest agent must execute as the configured guest user.");
        break;
      }
      await delay(1000, undefined, { signal: bootContext.signal });
    }
    tunnel = await openCacheTunnel(config, bootContext, name);
    let started = false;
    return {
      name,
      guestRoot: config.machine.guestRoot,
      async start({ command: executable, args, cwd, env, input }) {
        if (started) throw new Error("Each disposable Tart VM accepts one job.");
        context.signal?.throwIfAborted();
        if (bootFailure || tunnel.failure())
          throw new Error("Tart VM or cache tunnel is unavailable.");
        started = true;
        const payload = Buffer.from(
          JSON.stringify({
            op: "exec",
            command: executable,
            args,
            cwd,
            env,
            input: Buffer.from(input).toString("base64"),
          })
        );
        if (payload.length > 2 * 1024 * 1024) throw new Error("Guest request exceeds its limit.");
        const task = guestCommand(
          config,
          context,
          name,
          [config.machine.guestNode, config.machine.guestAgent],
          payload
        );
        active = task.child;
        return { done: task.done };
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
