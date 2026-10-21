import { lstat, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CONTEXT_BYTES = 16 * 1024;

const UUID = z.uuid();
const CONTEXT_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    baseUrl: z.string().url(),
    ownerId: UUID,
    repositoryId: UUID,
    runnerId: UUID,
    runId: UUID,
    requestId: UUID,
    platform: z.enum(["windows", "macos", "ios"]),
    workflowOid: z.string().regex(/^[0-9a-f]{40}$/),
    profileRevision: z.string().regex(/^[0-9a-f]{40}$/),
    generation: z.number().int().positive(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    leaseToken: z.string().regex(/^[0-9a-f]{64}$/i),
    leaseExpiresAt: z.number().int().positive(),
    runnerToken: z.string().regex(/^ge_runner_[0-9a-f]{64}$/i),
    operatorApproved: z.literal(true),
    approvedBy: z.string().min(1).max(256),
    approvedAt: z.number().int().positive(),
  })
  .strict();

export class SigningContextError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function parseSigningContext(value, now = Date.now()) {
  const parsed = CONTEXT_SCHEMA.safeParse(value);
  if (!parsed.success) throw new SigningContextError("INVALID_CONTEXT");
  const url = new URL(parsed.data.baseUrl);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    throw new SigningContextError("INVALID_CONTEXT");
  if (url.search || url.hash || !url.pathname.replace(/\/$/, "").endsWith("/api/actions"))
    throw new SigningContextError("INVALID_CONTEXT");
  if (parsed.data.leaseExpiresAt <= now || parsed.data.approvedAt > now)
    throw new SigningContextError("INVALID_CONTEXT");
  return { ...parsed.data, baseUrl: url.href.replace(/\/$/, "") };
}

export async function readSigningContext(
  contextFile,
  { now = Date.now(), platform = process.platform } = {}
) {
  try {
    const info = await lstat(contextFile);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new SigningContextError("INVALID_CONTEXT_FILE");
    if (info.size < 1 || info.size > MAX_CONTEXT_BYTES)
      throw new SigningContextError("INVALID_CONTEXT_FILE");
    if (platform !== "win32") {
      if (info.mode & 0o077) throw new SigningContextError("INSECURE_CONTEXT_FILE");
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new SigningContextError("INSECURE_CONTEXT_FILE");
    } else {
      const aclScript = fileURLToPath(new URL("./check-context-acl.ps1", import.meta.url));
      await execFileAsync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          aclScript,
          "-Path",
          path.resolve(contextFile),
        ],
        { windowsHide: true }
      );
    }
    let value;
    try {
      value = JSON.parse(await readFile(contextFile, "utf8"));
    } catch {
      throw new SigningContextError("INVALID_CONTEXT_FILE");
    }
    return parseSigningContext(value, now);
  } catch (error) {
    if (error instanceof SigningContextError) throw error;
    throw new SigningContextError("INVALID_CONTEXT_FILE");
  }
}

export async function removeSigningContext(contextFile) {
  await rm(contextFile, { force: true });
}
