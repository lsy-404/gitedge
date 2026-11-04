import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const requestLimit = 2 * 1024 * 1024;
const outputLimit = 64 * 1024;

function absolute(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0"))
    throw new Error("An absolute guest path is required.");
  return value;
}

async function request() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > requestLimit) throw new Error("Guest request exceeds its size limit.");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid guest request.");
  return value;
}

function decode(value) {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error("Invalid guest input encoding.");
  return Buffer.from(value, "base64");
}

function tail() {
  let bytes = Buffer.alloc(0);
  let truncated = false;
  return {
    append(chunk) {
      const next = Buffer.concat([bytes, chunk]);
      truncated ||= next.length > outputLimit;
      bytes = next.subarray(Math.max(0, next.length - outputLimit));
    },
    result() {
      if (!truncated) return bytes;
      const marker = Buffer.from("[earlier output truncated]\n");
      return Buffer.concat([marker, bytes.subarray(marker.length)]);
    },
  };
}

async function execute(value) {
  const command = absolute(value.command);
  const cwd = absolute(value.cwd);
  if (
    !Array.isArray(value.args) ||
    value.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
    throw new Error("Invalid guest arguments.");
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env))
    throw new Error("Invalid guest environment.");
  for (const [key, entry] of Object.entries(value.env)) {
    if (!key || /[=\0]/.test(key) || typeof entry !== "string" || entry.includes("\0"))
      throw new Error("Invalid guest environment.");
  }
  const input = decode(value.input ?? "");
  const stdout = tail();
  const stderr = tail();
  const child = spawn(command, value.args, {
    cwd,
    env: { ...process.env, ...value.env },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.append(chunk));
  child.stderr.on("data", (chunk) => stderr.append(chunk));
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") child.kill();
  });
  const finished = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("Could not start the guest command.")));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(input, () => input.fill(0));
  const result = await finished;
  process.stdout.write(stdout.result());
  process.stderr.write(stderr.result());
  process.exitCode = Number.isInteger(result.code) ? result.code : 1;
}

async function main() {
  const value = await request();
  if (value.op === "exec") return execute(value);
  const target = absolute(value.path);
  if (value.op === "mkdir") {
    await mkdir(target, { recursive: true, mode: 0o700 });
  } else if (value.op === "write") {
    const data = decode(value.data);
    await writeFile(target, data, { mode: 0o600 });
    data.fill(0);
  } else if (value.op === "read") {
    const maxBytes = value.maxBytes ?? outputLimit;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > outputLimit)
      throw new Error("Invalid guest read limit.");
    const file = await open(target, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes)
        throw new Error("Guest file exceeds its read limit.");
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      for (;;) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        length += bytesRead;
        if (length > maxBytes) throw new Error("Guest file exceeds its read limit.");
        if (bytesRead === 0) break;
      }
      process.stdout.write(
        JSON.stringify({ ok: true, data: buffer.subarray(0, length).toString("base64") })
      );
      return;
    } finally {
      await file.close();
    }
  } else {
    throw new Error("Unknown guest operation.");
  }
  process.stdout.write(JSON.stringify({ ok: true }));
}

main().catch((error) => {
  process.stderr.write(
    error?.code === "ENOENT" ? "Guest path does not exist.\n" : "Guest operation failed.\n"
  );
  process.exitCode = 1;
});
