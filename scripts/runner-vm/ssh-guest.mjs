import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const maximumOutput = 64 * 1024;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function createSshGuest(config, context, dispose) {
  const knownHosts = path.join(context.directory, "known_hosts");
  const alias = `ge-${context.id}`;
  await writeFile(knownHosts, `${alias} ${config.sshHostKey}\n`, { flag: "wx", mode: 0o600 });
  const ssh = path.win32.join(process.env.SystemRoot, "System32", "OpenSSH", "ssh.exe");
  const options = [
    "-T",
    "-F",
    "NUL",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    `HostKeyAlias=${alias}`,
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-i",
    config.sshKeyPath,
    `${config.sshUser}@${config.guestNetwork.address}`,
  ];
  let child;
  const execute = (request) => {
    if (context.signal?.aborted) throw context.signal.reason;
    const command = `sudo -n -- ${quote(config.guestNode)} ${quote(config.sshAgentPath)}`;
    child = spawn(ssh, [...options, command], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const running = child;
    const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    for (const stream of ["stdout", "stderr"])
      running[stream].on("data", (chunk) => {
        output[stream] = Buffer.concat([output[stream], chunk]).subarray(-maximumOutput);
      });
    const abort = () => running.kill();
    context.signal?.addEventListener("abort", abort, { once: true });
    running.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") running.kill();
    });
    const done = new Promise((resolve, reject) => {
      running.once("error", reject);
      running.once("close", (code, signal) => {
        context.signal?.removeEventListener("abort", abort);
        resolve({ code: code ?? 1, signal, ...output });
      });
    });
    const payload = Buffer.from(JSON.stringify(request));
    if (payload.length > 2 * 1024 * 1024) {
      running.kill();
      throw new Error("Guest request exceeds its limit.");
    }
    running.stdin.end(payload, () => payload.fill(0));
    return { done };
  };
  const deadline = Date.now() + 180_000;
  while (true) {
    const probe = execute({
      op: "exec",
      command: "/usr/bin/true",
      args: [],
      cwd: config.guestRoot,
      env: {},
      input: "",
    });
    const result = await probe.done;
    if (result.code === 0) break;
    if (Date.now() >= deadline)
      throw new Error(`Linux guest readiness failed: ${result.stderr.toString("utf8")}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  let started = false;
  return {
    name: alias,
    guestRoot: config.guestRoot,
    async start({ command, args, cwd, env, input }) {
      if (started) throw new Error("Each disposable VM accepts one job.");
      started = true;
      return execute({
        op: "exec",
        command,
        args,
        cwd,
        env,
        input: Buffer.from(input).toString("base64"),
      });
    },
    async dispose() {
      child?.kill();
      await dispose();
    },
  };
}
