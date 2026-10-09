import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { createTarPacker } from "modern-tar";

export const ARCHIVE_MAX_FILES = 5000;
export const ARCHIVE_MAX_DIRECTORIES = 1000;
export const ARCHIVE_MAX_DEPTH = 64;
export const ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
export const ARCHIVE_MAX_FILE_BYTES = 32 * 1024 * 1024;

export type ArchiveFormat = "zip" | "tar.gz";
export interface ArchiveLimits {
  maxFiles: number;
  maxDirectories: number;
  maxBytes: number;
  maxFileBytes: number;
}
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxFiles: ARCHIVE_MAX_FILES,
  maxDirectories: ARCHIVE_MAX_DIRECTORIES,
  maxBytes: ARCHIVE_MAX_BYTES,
  maxFileBytes: ARCHIVE_MAX_FILE_BYTES,
};

/** An archive that cannot be produced completely; it is reported instead of emitting a partial file. */
export class ArchiveError extends Error {
  constructor(
    readonly code: "archive_too_large" | "archive_invalid",
    message: string
  ) {
    super(message);
  }
}

export type ArchiveStore = Pick<ArtifactsRepo, "readTree" | "readBlob">;
export interface ArchiveFile {
  path: string;
  oid: string;
  mode: "100644" | "100755" | "120000";
}
export interface ArchivePlan {
  directories: string[];
  files: ArchiveFile[];
}
export interface ArchiveOptions {
  root: string;
  mtime: Date;
  limits?: ArchiveLimits;
  /** Called once when streaming fails after the response has started. */
  onError?: (cause: unknown) => void;
}

const CHUNK_BYTES = 64 * 1024;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function safeName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    name.toLowerCase() !== ".git" &&
    !/[\\/\x00-\x1f\x7f]/.test(name)
  );
}
function memoryLimit(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && "code" in cause && cause.code === "MEMORY_LIMIT"
  );
}

/**
 * Walks the tree before any byte is streamed so structural limits fail with a normal HTTP error.
 * Submodule links are not part of an archive.
 */
export async function planArchive(
  store: ArchiveStore,
  treeHash: string,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS
): Promise<ArchivePlan> {
  const pending = [{ hash: treeHash, prefix: "", depth: 0 }];
  const directories: string[] = [];
  const files: ArchiveFile[] = [];
  let visited = 0;
  for (let next = pending.pop(); next; next = pending.pop()) {
    visited += 1;
    if (visited > limits.maxDirectories + 1)
      throw new ArchiveError(
        "archive_too_large",
        `The repository has more than ${limits.maxDirectories} directories and cannot be archived.`
      );
    if (next.depth > ARCHIVE_MAX_DEPTH)
      throw new ArchiveError(
        "archive_too_large",
        "The repository directories are nested too deeply."
      );
    const entries = await store.readTree(next.hash);
    if (!entries) throw new ArchiveError("archive_invalid", "A repository tree is unavailable.");
    for (const entry of entries) {
      if (!safeName(entry.name))
        throw new ArchiveError("archive_invalid", "The repository contains an unsafe path.");
      const path = next.prefix + entry.name;
      if (entry.type === "tree") {
        directories.push(path);
        pending.push({ hash: entry.hash, prefix: `${path}/`, depth: next.depth + 1 });
      } else if (entry.type === "gitlink") continue;
      else {
        if (files.length >= limits.maxFiles)
          throw new ArchiveError(
            "archive_too_large",
            `The repository has more than ${limits.maxFiles} files and cannot be archived.`
          );
        files.push({
          path,
          oid: entry.hash,
          mode: entry.type === "symlink" ? "120000" : entry.type === "exec" ? "100755" : "100644",
        });
      }
    }
  }
  directories.sort(compare);
  files.sort((a, b) => compare(a.path, b.path));
  return { directories, files };
}

class ByteBudget {
  private used = 0;
  constructor(private readonly limits: ArchiveLimits) {}
  async read(store: ArchiveStore, file: ArchiveFile): Promise<Uint8Array> {
    let blob: Blob | null;
    try {
      blob = await store.readBlob(file.oid);
    } catch (cause) {
      if (!memoryLimit(cause)) throw cause;
      throw new ArchiveError("archive_too_large", `${file.path} is too large to archive.`);
    }
    if (!blob) throw new ArchiveError("archive_invalid", `${file.path} is unavailable.`);
    if (blob.size > this.limits.maxFileBytes)
      throw new ArchiveError("archive_too_large", `${file.path} is too large to archive.`);
    this.used += blob.size;
    if (this.used > this.limits.maxBytes)
      throw new ArchiveError(
        "archive_too_large",
        "The repository exceeds the archive size limit; clone it with Git instead."
      );
    return new Uint8Array(await blob.arrayBuffer());
  }
}

function zipArchive(store: ArchiveStore, plan: ArchivePlan, options: ArchiveOptions) {
  const budget = new ByteBudget(options.limits ?? DEFAULT_ARCHIVE_LIMITS);
  const output: Uint8Array[] = [];
  let failure: unknown = null;
  const zip = new Zip((error, chunk) => {
    if (error) failure = error;
    else output.push(chunk);
  });
  const names = [
    ...plan.directories.map((path) => ({ directory: true as const, path })),
    ...plan.files.map((file) => ({ directory: false as const, file })),
  ];
  let index = 0;
  let finished = false;
  async function addNext(): Promise<void> {
    const item = names[index++];
    if (!item) {
      zip.end();
      finished = true;
      return;
    }
    if (item.directory) {
      const entry = new ZipPassThrough(`${options.root}/${item.path}/`);
      entry.mtime = options.mtime;
      entry.os = 3;
      entry.attrs = (0o40755 << 16) >>> 0;
      zip.add(entry);
      entry.push(new Uint8Array(0), true);
      return;
    }
    const bytes = await budget.read(store, item.file);
    const name = `${options.root}/${item.file.path}`;
    const entry =
      item.file.mode === "120000" ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
    entry.mtime = options.mtime;
    entry.os = 3;
    entry.attrs = (parseInt(item.file.mode, 8) << 16) >>> 0;
    zip.add(entry);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES)
      entry.push(
        bytes.subarray(offset, offset + CHUNK_BYTES),
        offset + CHUNK_BYTES >= bytes.length
      );
    if (bytes.length === 0) entry.push(bytes, true);
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await addNext();
        if (failure) throw failure;
      } catch (cause) {
        options.onError?.(cause);
        throw cause;
      }
      for (const chunk of output.splice(0)) if (chunk.length) controller.enqueue(chunk);
      if (finished) controller.close();
    },
  });
}

function tarGzArchive(store: ArchiveStore, plan: ArchivePlan, options: ArchiveOptions) {
  const budget = new ByteBudget(options.limits ?? DEFAULT_ARCHIVE_LIMITS);
  const { readable, controller } = createTarPacker();
  const { root, mtime } = options;
  async function produce(): Promise<void> {
    for (const path of plan.directories)
      await controller
        .add({ name: `${root}/${path}/`, type: "directory", size: 0, mode: 0o755, mtime })
        .close();
    for (const file of plan.files) {
      const bytes = await budget.read(store, file);
      const name = `${root}/${file.path}`;
      if (file.mode === "120000") {
        await controller
          .add({
            name,
            type: "symlink",
            size: 0,
            mode: 0o777,
            mtime,
            linkname: new TextDecoder().decode(bytes),
          })
          .close();
        continue;
      }
      const writer = controller
        .add({
          name,
          type: "file",
          size: bytes.length,
          mode: parseInt(file.mode, 8) & 0o777,
          mtime,
        })
        .getWriter();
      if (bytes.length) await writer.write(bytes);
      await writer.close();
    }
    controller.finalize();
  }
  produce().catch((cause: unknown) => {
    options.onError?.(cause);
    controller.error(cause);
  });
  return readable.pipeThrough(new CompressionStream("gzip"));
}

/**
 * Streams the archive. A limit hit after streaming began errors the stream, so clients receive a
 * failed transfer instead of a truncated but well-formed file.
 */
export function archiveStream(
  store: ArchiveStore,
  plan: ArchivePlan,
  format: ArchiveFormat,
  options: ArchiveOptions
): ReadableStream<Uint8Array> {
  return format === "zip" ? zipArchive(store, plan, options) : tarGzArchive(store, plan, options);
}

export function archiveContentType(format: ArchiveFormat): string {
  return format === "zip" ? "application/zip" : "application/gzip";
}
