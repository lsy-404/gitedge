import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSshGuest } from "./ssh-guest.mjs";

const scriptPath = fileURLToPath(new URL("./hyperv.ps1", import.meta.url));
const maxReadBytes = 16 * 1024 * 1024;
const maxInputBytes = 16 * 1024 * 1024;
const maxOutputBytes = 64 * 1024;
const maxProtocolLineBytes = 32 * 1024 * 1024;
const readyTimeoutMs = 5 * 60 * 1000;
const rpcTimeoutMs = 2 * 60 * 1000;
const disposeTimeoutMs = 30 * 1000;
const recoveryTimeoutMs = 5 * 60 * 1000;
const deniedIPv4Cidrs = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.31.196.0/24",
  "192.52.193.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "192.175.48.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "168.63.129.16/32",
];

function fail(message) {
  throw new Error(message);
}

function absoluteWindowsPath(value, label) {
  if (
    typeof value !== "string" ||
    /[\x00-\x1f<>"|?*]/.test(value) ||
    !/^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("\\\\?\\") ||
    value.startsWith("\\\\.\\") ||
    value.includes(":", 2) ||
    value.split(/[\\/]+/).includes("..")
  )
    fail(`${label} must be an absolute local Windows path.`);
  return path.win32.normalize(value);
}

function assertGuestPath(value, root, label, allowRoot = false) {
  const candidate = absoluteWindowsPath(value, label);
  const relative = path.win32.relative(root, candidate);
  if (allowRoot && relative === "") return candidate;
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.win32.sep}`) ||
    path.win32.isAbsolute(relative)
  )
    fail(`${label} must be a child of guestRoot.`);
  return candidate;
}

function guestPath(value, platform, label) {
  if (platform === "windows") return absoluteWindowsPath(value, label);
  if (
    typeof value !== "string" ||
    !path.posix.isAbsolute(value) ||
    /[\0\r\n]/.test(value) ||
    value.split("/").includes("..")
  )
    fail(`${label} must be an absolute Linux guest path.`);
  return path.posix.normalize(value);
}

function assertUuid(value) {
  if (
    typeof value !== "string" ||
    value !== value.toLowerCase() ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    fail("context.id must be a lowercase canonical UUID.");
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function stableMachine(machine) {
  const normalized = canonicalize(machine);
  for (const key of [
    "vmRoot",
    "baseImage",
    ...(machine.guestPlatform === "windows" ? ["guestRoot", "guestNode"] : []),
  ]) {
    if (typeof normalized[key] === "string")
      normalized[key] = path.win32.resolve(normalized[key]).toLowerCase();
  }
  return stableJson(normalized);
}

function ipv4Integer(value, label) {
  if (typeof value !== "string" || isIP(value) !== 4)
    fail(`${label} must be a canonical IPv4 address.`);
  const parts = value.split(".");
  if (parts.some((part) => String(Number(part)) !== part))
    fail(`${label} must be a canonical IPv4 address.`);
  return parts.reduce((result, part) => (result << 8n) | BigInt(part), 0n);
}

function ipv4InCidr(address, cidr) {
  const [networkText, prefixText] = cidr.split("/");
  const shift = BigInt(32 - Number(prefixText));
  return (
    ipv4Integer(address, "IPv4 address") >> shift ===
    ipv4Integer(networkText, "IPv4 network") >> shift
  );
}

function validateGuestNetwork(network) {
  const fields = ["address", "dns", "gateway", "prefixLength"];
  if (
    !network ||
    typeof network !== "object" ||
    Array.isArray(network) ||
    Object.keys(network).sort().join(",") !== fields.join(",") ||
    !Number.isSafeInteger(network.prefixLength) ||
    network.prefixLength < 1 ||
    network.prefixLength > 30 ||
    !Array.isArray(network.dns) ||
    network.dns.length < 1 ||
    network.dns.length > 4
  )
    fail(
      "machine.guestNetwork must contain address, prefixLength, gateway, and public IPv4 dns entries."
    );

  const address = ipv4Integer(network.address, "machine.guestNetwork.address");
  const gateway = ipv4Integer(network.gateway, "machine.guestNetwork.gateway");
  const shift = BigInt(32 - network.prefixLength);
  const networkBase = (address >> shift) << shift;
  const broadcast = networkBase + (1n << shift) - 1n;
  const inRange = (value) => value >> shift === gateway >> shift;
  const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
  const privateRange = privateRanges.find(
    (cidr) => ipv4InCidr(network.address, cidr) && ipv4InCidr(network.gateway, cidr)
  );
  if (
    !privateRange ||
    network.prefixLength < Number(privateRange.split("/")[1]) ||
    !inRange(address) ||
    address === gateway ||
    address === networkBase ||
    address === broadcast ||
    gateway === networkBase ||
    gateway === broadcast
  )
    fail(
      "machine.guestNetwork.address and gateway must be distinct hosts in the same RFC1918 subnet."
    );

  const dns = network.dns.map((value, index) => {
    ipv4Integer(value, `machine.guestNetwork.dns[${index}]`);
    if (deniedIPv4Cidrs.some((cidr) => ipv4InCidr(value, cidr)))
      fail("machine.guestNetwork.dns entries must be public IPv4 addresses.");
    return value;
  });
  if (new Set(dns).size !== dns.length) fail("machine.guestNetwork.dns entries must be unique.");
  return {
    address: network.address,
    prefixLength: network.prefixLength,
    gateway: network.gateway,
    dns,
  };
}

function validateRunDirectory(directory, id, machine) {
  const vmRoot = absoluteWindowsPath(machine?.vmRoot, "machine.vmRoot");
  if (path.win32.resolve(vmRoot) === path.win32.parse(vmRoot).root)
    fail("machine.vmRoot must be a private VM root, not a drive root.");
  const expected = path.win32.join(vmRoot, "runs", id);
  if (path.win32.resolve(directory).toLowerCase() !== path.win32.resolve(expected).toLowerCase())
    fail("context.directory must be vmRoot/runs/<UUID>.");
}

async function readRunMetadata(machine, context) {
  const markerPath = path.win32.join(context.directory, ".runner-vm.json");
  let metadata;
  try {
    const markerBytes = await readFile(markerPath);
    if (markerBytes.byteLength > 65536) fail("The private runner VM metadata is too large.");
    metadata = JSON.parse(markerBytes.toString("utf8"));
  } catch {
    fail("The private runner VM metadata is unavailable or invalid.");
  }
  if (
    !metadata ||
    metadata.version !== 1 ||
    metadata.driver !== "hyperv" ||
    metadata.id !== context.id ||
    typeof metadata.createdAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.createdAt)) ||
    !Number.isSafeInteger(metadata.hostPid) ||
    metadata.hostPid < 1 ||
    !metadata.machine ||
    typeof metadata.machine !== "object" ||
    Array.isArray(metadata.machine)
  )
    fail("The private runner VM metadata does not match this Hyper-V job.");
  validateRunDirectory(context.directory, context.id, metadata.machine);
  validateGuestNetwork(metadata.machine.guestNetwork);
  if (machine && stableMachine(machine) !== stableMachine(metadata.machine))
    fail("The recovery machine does not match the private runner VM metadata.");
  return metadata.machine;
}

function assertMachineMatchesConfig(machine, config) {
  validateGuestNetwork(machine.guestNetwork);
  const machineBaseImage = absoluteWindowsPath(machine.baseImage, "machine.baseImage");
  const machineGuestRoot = guestPath(machine.guestRoot, machine.guestPlatform, "machine.guestRoot");
  const machineGuestNode = guestPath(machine.guestNode, machine.guestPlatform, "machine.guestNode");
  const guestPaths = machine.guestPlatform === "windows" ? path.win32 : path.posix;
  if (
    path.win32.resolve(machineBaseImage).toLowerCase() !==
      path.win32.resolve(config.baseImage).toLowerCase() ||
    guestPaths.resolve(machineGuestRoot) !== guestPaths.resolve(config.guestRoot) ||
    guestPaths.resolve(machineGuestNode) !== guestPaths.resolve(config.guestNode) ||
    machine.guestPlatform !== config.guestPlatform ||
    machine.cpus !== config.cpus ||
    machine.memoryMiB !== config.memoryMiB ||
    machine.egressProxyPort !== config.egressProxyPort ||
    machine.cachePort !== config.cachePort ||
    machine.switchName !== config.switchName
  )
    fail("The create config does not match the private runner VM metadata.");
}

function validateConfig(config, context) {
  if (process.platform !== "win32") fail("The Hyper-V provider requires a Windows host.");
  if (!config || typeof config !== "object" || Array.isArray(config)) fail("config is required.");
  if (!context || typeof context !== "object" || Array.isArray(context))
    fail("context is required.");

  const baseImage = absoluteWindowsPath(config.baseImage, "config.baseImage");
  if (path.win32.extname(baseImage).toLowerCase() !== ".vhdx")
    fail("config.baseImage must name a VHDX file.");
  if (!["windows", "linux"].includes(config.guestPlatform))
    fail("A Windows or Linux guest platform is required.");
  const credentialPath =
    config.guestPlatform === "windows"
      ? absoluteWindowsPath(config.credentialPath, "config.credentialPath")
      : undefined;
  if (credentialPath && path.win32.extname(credentialPath).toLowerCase() !== ".json")
    fail("config.credentialPath must name a machine-protected credential file.");
  const guestRoot = guestPath(config.guestRoot, config.guestPlatform, "config.guestRoot");
  const guestPaths = config.guestPlatform === "windows" ? path.win32 : path.posix;
  if (guestPaths.resolve(guestRoot) === guestPaths.parse(guestRoot).root)
    fail("config.guestRoot must be a workspace directory, not a drive root.");
  const guestNode = guestPath(config.guestNode, config.guestPlatform, "config.guestNode");
  let ssh;
  if (config.guestPlatform === "linux") {
    if (
      !/^[a-z_][a-z0-9_-]{0,31}$/.test(config.sshUser) ||
      !/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(config.sshHostKey) ||
      !/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(config.sshAuthorizedKey)
    )
      fail("Linux guests require a pinned host key and an authorized controller key.");
    ssh = {
      sshUser: config.sshUser,
      sshHostKey: config.sshHostKey,
      sshAuthorizedKey: config.sshAuthorizedKey,
      sshKeyPath: absoluteWindowsPath(config.sshKeyPath, "sshKeyPath"),
      sshAgentPath: guestPath(config.sshAgentPath, "linux", "sshAgentPath"),
    };
  }
  if (!Number.isSafeInteger(config.cpus) || config.cpus < 1 || config.cpus > 512)
    fail("config.cpus must be an integer from 1 through 512.");
  if (
    config.egressProxyPort !== undefined &&
    (!Number.isSafeInteger(config.egressProxyPort) ||
      config.egressProxyPort < 1 ||
      config.egressProxyPort > 65535)
  )
    fail("config.egressProxyPort must be a TCP port.");
  if (
    config.cachePort !== undefined &&
    (!Number.isSafeInteger(config.cachePort) || config.cachePort < 1 || config.cachePort > 65535)
  )
    fail("config.cachePort must be a TCP port.");
  if (
    !Number.isSafeInteger(config.memoryMiB) ||
    config.memoryMiB < 1 ||
    config.memoryMiB > Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024))
  )
    fail("config.memoryMiB must be a positive safe integer.");
  if (
    typeof config.switchName !== "string" ||
    config.switchName.length < 1 ||
    config.switchName.length > 100 ||
    /[\0\r\n]/.test(config.switchName)
  )
    fail("config.switchName is invalid.");
  if (typeof context.directory !== "string") fail("context.directory is required.");
  const directory = absoluteWindowsPath(context.directory, "context.directory");
  if (path.win32.resolve(directory) === path.win32.parse(directory).root)
    fail("context.directory must be a private run directory, not a drive root.");
  const id = assertUuid(context.id);
  if (path.win32.basename(directory).toLowerCase() !== id)
    fail("context.directory must be named with context.id.");
  if (context.signal !== undefined && !(context.signal instanceof AbortSignal))
    fail("context.signal must be an AbortSignal.");

  return {
    config: {
      baseImage,
      cpus: config.cpus,
      memoryMiB: config.memoryMiB,
      switchName: config.switchName,
      guestRoot,
      guestNode,
      guestPlatform: config.guestPlatform,
      ...(config.egressProxyPort === undefined ? {} : { egressProxyPort: config.egressProxyPort }),
      ...(config.cachePort === undefined ? {} : { cachePort: config.cachePort }),
      ...(credentialPath ? { credentialPath } : ssh),
    },
    context: { id, directory, signal: context.signal },
  };
}

function abortError() {
  const error = new Error("The Hyper-V job was aborted.");
  error.name = "AbortError";
  return error;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function powershellExecutable() {
  if (process.env.GITEDGE_HYPERV_POWERSHELL)
    return absoluteWindowsPath(process.env.GITEDGE_HYPERV_POWERSHELL, "GITEDGE_HYPERV_POWERSHELL");
  const root = process.env.SystemRoot;
  if (typeof root !== "string" || !/^[a-zA-Z]:[\\/]/.test(root))
    fail("Windows SystemRoot is unavailable.");
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function startPowerShell() {
  return spawn(
    powershellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] }
  );
}

function createProtocol(child) {
  let lineChunks = [];
  let lineLength = 0;
  let nextId = 0;
  let closed = false;
  let rpcTail = Promise.resolve();
  let queuedReady;
  const pending = new Map();
  const closePromise = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ code, signal });
      queuedReady?.reject(new Error("The PowerShell host exited before setup completed."));
      queuedReady = undefined;
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("The PowerShell host exited unexpectedly."));
      }
      pending.clear();
    })
  );
  const ready = new Promise((resolve, reject) => {
    queuedReady = { resolve, reject };
  });

  child.stderr.on("data", () => {});

  function protocolFailure(error) {
    queuedReady?.reject(error);
    queuedReady = undefined;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    child.kill();
  }

  child.on("error", () => protocolFailure(new Error("Could not start the PowerShell host.")));
  child.stdout.on("data", (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (end > offset) {
        const part = chunk.subarray(offset, end);
        lineChunks.push(part);
        lineLength += part.length;
      }
      if (lineLength > maxProtocolLineBytes) {
        protocolFailure(new Error("The PowerShell response exceeded the size limit."));
        return;
      }
      if (newline < 0) return;
      const line = Buffer.concat(lineChunks, lineLength);
      lineChunks = [];
      lineLength = 0;
      offset = newline + 1;
      if (!line.length) continue;
      let message;
      try {
        message = JSON.parse(line.toString("utf8"));
      } catch {
        protocolFailure(new Error("The PowerShell host returned an invalid response."));
        return;
      }
      if (message.type === "ready" || message.type === "cleaned" || message.type === "recovered") {
        queuedReady?.resolve(message);
        queuedReady = undefined;
        continue;
      }
      if (message.type === "fatal") {
        const error = new Error(
          typeof message.error === "string" ? message.error : "Hyper-V setup failed."
        );
        queuedReady?.reject(error);
        queuedReady = undefined;
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.result);
      else
        waiter.reject(
          new Error(
            typeof message.error === "string" ? message.error : "The Hyper-V operation failed."
          )
        );
    }
  });

  function writeLine(value) {
    if (closed || child.stdin.destroyed)
      return Promise.reject(new Error("The PowerShell host is closed."));
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, "utf8") > maxProtocolLineBytes)
      return Promise.reject(new Error("The Hyper-V request exceeded the size limit."));
    return new Promise((resolve, reject) => {
      child.stdin.write(line, "utf8", (error) => (error ? reject(error) : resolve()));
    });
  }

  function request(op, payload = {}, timeoutMs = rpcTimeoutMs, urgent = false) {
    const run = async () => {
      if (closed) throw new Error("The PowerShell host is closed.");
      const id = ++nextId;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("The PowerShell operation timed out."));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
      });
      try {
        await writeLine({ id, op, ...payload });
      } catch (error) {
        const waiter = pending.get(id);
        if (waiter) clearTimeout(waiter.timer);
        pending.delete(id);
        throw error;
      }
      return response;
    };
    if (urgent) return run();
    const result = rpcTail.then(run);
    rpcTail = result.catch(() => {});
    return result;
  }

  return {
    ready,
    request,
    writeLine,
    closePromise,
    get closed() {
      return closed;
    },
  };
}

async function waitForClose(protocol, timeoutMs) {
  return withTimeout(
    protocol.closePromise.then(() => true),
    timeoutMs,
    "PowerShell close timed out."
  ).catch(() => false);
}

async function stopPowerShell(protocol, child) {
  if (await waitForClose(protocol, 5000)) return;
  child.kill();
  if (!(await waitForClose(protocol, 5000)))
    throw new Error("The PowerShell host did not exit after cleanup.");
}

async function sendInitial(child, payload) {
  const protocol = createProtocol(child);
  try {
    await protocol.writeLine(payload);
    return protocol;
  } catch (error) {
    child.kill();
    await waitForClose(protocol, 5000);
    throw error;
  }
}

async function cleanupWithNewHost(machine, context) {
  const child = startPowerShell();
  const protocol = await sendInitial(child, {
    op: "cleanup",
    machine,
    context: { id: context.id, directory: context.directory },
  });
  const timer = setTimeout(() => child.kill(), disposeTimeoutMs);
  try {
    const message = await protocol.ready;
    if (message.type !== "cleaned") throw new Error("Hyper-V cleanup was not confirmed.");
    await stopPowerShell(protocol, child);
  } finally {
    clearTimeout(timer);
  }
}

export async function createHypervVm(config, context) {
  const validated = validateConfig(config, context);
  const { config: safeConfig, context: safeContext } = validated;
  if (safeContext.signal?.aborted) throw abortError();
  const machine = await readRunMetadata(null, safeContext);
  assertMachineMatchesConfig(machine, safeConfig);

  const guestAgent = await readFile(new URL("./guest.mjs", import.meta.url), "utf8");
  const child = startPowerShell();
  let protocol;
  try {
    protocol = await sendInitial(child, {
      op: "create",
      config: safeConfig,
      machine,
      context: { id: safeContext.id, directory: safeContext.directory },
      guestAgent,
    });
  } catch (error) {
    await cleanupWithNewHost(machine, safeContext);
    throw error;
  }
  let abortListener;
  let disposed = false;
  let disposePromise;
  let readyComplete = false;
  let jobRunning = false;
  let jobStarted = false;

  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposed = true;
    if (abortListener) safeContext.signal?.removeEventListener("abort", abortListener);
    disposePromise = (async () => {
      let cleaned = false;
      if (!protocol.closed && !readyComplete) {
        try {
          await protocol.writeLine({ op: "cancel" });
          await waitForClose(protocol, 5000);
        } catch {}
      } else if (!protocol.closed) {
        try {
          await protocol.request("dispose", {}, disposeTimeoutMs, true);
          await stopPowerShell(protocol, child);
          cleaned = true;
        } catch {
          child.kill();
        }
      }
      if (!cleaned) {
        if (!protocol.closed) {
          child.kill();
          if (!(await waitForClose(protocol, 5000)))
            throw new Error("The PowerShell host did not exit; VM cleanup is unconfirmed.");
        }
        await cleanupWithNewHost(machine, safeContext);
      }
      jobRunning = false;
    })();
    return disposePromise;
  };

  abortListener = () => {
    void dispose().catch(() => {});
  };
  safeContext.signal?.addEventListener("abort", abortListener, { once: true });

  let startupAbortListener;
  const startupAbort = safeContext.signal
    ? new Promise((_, reject) => {
        startupAbortListener = () => reject(abortError());
        safeContext.signal.addEventListener("abort", startupAbortListener, { once: true });
        if (safeContext.signal.aborted) startupAbortListener();
      })
    : new Promise(() => {});
  try {
    const readyMessage = await withTimeout(
      Promise.race([protocol.ready, startupAbort]),
      readyTimeoutMs,
      "Hyper-V guest readiness timed out."
    );
    if (readyMessage.type !== "ready") throw new Error("Hyper-V guest setup was not confirmed.");
    readyComplete = true;
  } catch (error) {
    if (!protocol.closed) {
      try {
        await protocol.writeLine({ op: "cancel" });
      } catch {}
    }
    try {
      await dispose();
    } catch {
      throw new Error("Hyper-V startup failed and VM cleanup was not confirmed.");
    }
    throw error;
  } finally {
    if (startupAbortListener)
      safeContext.signal?.removeEventListener("abort", startupAbortListener);
  }

  if (safeConfig.guestPlatform === "linux") {
    try {
      return await createSshGuest(
        { ...safeConfig, guestNetwork: machine.guestNetwork },
        safeContext,
        dispose
      );
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  const perform = async (op, payload = {}) => {
    if (disposed) throw abortError();
    if (safeContext.signal?.aborted) {
      await dispose();
      throw abortError();
    }
    return protocol.request(op, payload);
  };

  const vm = {
    name: `ge-${safeContext.id}`,
    guestRoot: safeConfig.guestRoot,
    async mkdir(absoluteGuestPath) {
      try {
        const guestPath = assertGuestPath(absoluteGuestPath, safeConfig.guestRoot, "guest path");
        await perform("mkdir", { path: guestPath });
      } catch (error) {
        try {
          await dispose();
        } catch {
          throw new Error("The Hyper-V operation failed and VM cleanup was not confirmed.");
        }
        throw error;
      }
    },
    async writeFile(absoluteGuestPath, data) {
      try {
        const guestPath = assertGuestPath(absoluteGuestPath, safeConfig.guestRoot, "guest path");
        if (!(data instanceof Uint8Array)) fail("writeFile data must be a Uint8Array.");
        if (data.byteLength > maxInputBytes) fail("writeFile data exceeds the transfer limit.");
        await perform("writeFile", {
          path: guestPath,
          data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"),
        });
      } catch (error) {
        try {
          await dispose();
        } catch {
          throw new Error("The Hyper-V operation failed and VM cleanup was not confirmed.");
        }
        throw error;
      }
    },
    async readFile(absoluteGuestPath, options = {}) {
      try {
        if (!options || typeof options !== "object" || Array.isArray(options))
          fail("readFile options must be an object.");
        const { maxBytes = 65536 } = options;
        const guestPath = assertGuestPath(absoluteGuestPath, safeConfig.guestRoot, "guest path");
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > maxReadBytes)
          fail(`readFile maxBytes must be between 0 and ${maxReadBytes}.`);
        const result = await perform("readFile", { path: guestPath, maxBytes });
        return Buffer.from(result.data, "base64");
      } catch (error) {
        try {
          await dispose();
        } catch {
          throw new Error("The Hyper-V operation failed and VM cleanup was not confirmed.");
        }
        throw error;
      }
    },
    async start(options) {
      try {
        if (!options || typeof options !== "object" || Array.isArray(options))
          fail("start options must be an object.");
        const { command, args, cwd, env, input } = options;
        if (jobStarted) fail("A Hyper-V VM supports one job process.");
        if (typeof command !== "string") fail("command must be an absolute guest program path.");
        const guestCommand = absoluteWindowsPath(command, "command");
        const guestCwd = assertGuestPath(cwd, safeConfig.guestRoot, "cwd", true);
        if (
          !Array.isArray(args) ||
          args.some((value) => typeof value !== "string" || value.includes("\0"))
        )
          fail("args must be an array of strings without NUL characters.");
        if (!env || typeof env !== "object" || Array.isArray(env))
          fail("env must be a string map.");
        for (const [key, value] of Object.entries(env)) {
          if (!key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0"))
            fail("env must contain valid string keys and values.");
        }
        if (!(input instanceof Uint8Array)) fail("input must be a Uint8Array.");
        if (input.byteLength > maxInputBytes) fail("Job stdin exceeds the transfer limit.");
        jobStarted = true;
        const startResult = await perform("start", {
          command: guestCommand,
          args,
          cwd: guestCwd,
          env,
          input: Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("base64"),
        });
        jobRunning = true;
        const done = (async () => {
          try {
            while (true) {
              if (safeContext.signal?.aborted || disposed) throw abortError();
              const result = await protocol.request("poll", { jobId: startResult.jobId });
              if (result.running) {
                await delay(500, safeContext.signal);
                continue;
              }
              const outputDirectory = path.win32.join(safeContext.directory, vm.name, "output");
              const stdoutPath = path.win32.join(outputDirectory, "stdout.bin");
              const stderrPath = path.win32.join(outputDirectory, "stderr.bin");
              const [stdoutStats, stderrStats] = await Promise.all([
                stat(stdoutPath),
                stat(stderrPath),
              ]);
              if (stdoutStats.size > maxOutputBytes || stderrStats.size > maxOutputBytes)
                throw new Error("Hyper-V job output exceeded the limit.");
              const [stdout, stderr] = await Promise.all([
                readFile(stdoutPath),
                readFile(stderrPath),
              ]);
              await Promise.all([rm(stdoutPath, { force: true }), rm(stderrPath, { force: true })]);
              await protocol.request("complete", { jobId: startResult.jobId });
              jobRunning = false;
              return { code: result.code, stdout, stderr };
            }
          } catch (error) {
            jobRunning = false;
            try {
              await dispose();
            } catch {
              throw new Error("The Hyper-V job failed and VM cleanup was not confirmed.");
            }
            throw error;
          }
        })();
        return {
          done,
          get running() {
            return jobRunning;
          },
        };
      } catch (error) {
        try {
          await dispose();
        } catch {
          throw new Error("The Hyper-V job failed and VM cleanup was not confirmed.");
        }
        throw error;
      }
    },
    async dispose() {
      await dispose();
    },
  };

  if (safeContext.signal?.aborted) {
    await dispose();
    throw abortError();
  }
  return vm;
}

export async function recoverHypervVm(machine, context) {
  if (process.platform !== "win32") fail("The Hyper-V provider requires a Windows host.");
  if (!machine || typeof machine !== "object" || Array.isArray(machine))
    fail("machine is required.");
  if (!context || typeof context !== "object" || Array.isArray(context))
    fail("context is required.");
  const id = assertUuid(context.id);
  const directory = absoluteWindowsPath(context.directory, "context.directory");
  if (path.win32.basename(directory).toLowerCase() !== id)
    fail("context.directory must be named with context.id.");
  const recoveryContext = { id, directory };
  const safeMachine = await readRunMetadata(machine, recoveryContext);
  const child = startPowerShell();
  const protocol = await sendInitial(child, {
    op: "recover",
    machine: safeMachine,
    context: recoveryContext,
  });
  try {
    const message = await withTimeout(
      protocol.ready,
      recoveryTimeoutMs,
      "Hyper-V recovery timed out."
    );
    if (message.type !== "recovered") throw new Error("Hyper-V recovery was not confirmed.");
    await stopPowerShell(protocol, child);
  } catch (error) {
    child.kill();
    if (!(await waitForClose(protocol, 5000)))
      throw new Error("Hyper-V recovery failed and its host process did not exit.");
    throw error;
  }
}
