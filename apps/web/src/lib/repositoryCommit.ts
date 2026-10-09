import {
  CommitRepositoryChangesSchema,
  REPOSITORY_COMMIT_LIMITS,
  editablePath,
  type CommitRepositoryChangesInput,
} from "../../../../packages/contracts/src/repository-controls";

export type StagedChange =
  | { op: "put"; path: string; content: Blob }
  | { op: "delete"; path: string }
  | { op: "move"; from: string; to: string };

export interface CommitBase {
  branch: string;
  newBranch?: string;
  expectedOid: string | null;
  message: string;
}

export interface CommitPayload {
  manifest: CommitRepositoryChangesInput;
  files: Map<string, Blob>;
}

/** Builds the manifest and file parts for the multipart commit endpoint; null when invalid. */
export function commitPayload(
  base: CommitBase,
  changes: readonly StagedChange[]
): CommitPayload | null {
  const files = new Map<string, Blob>();
  const wire = changes.map((change) => {
    if (change.op !== "put") return change;
    const part = `f${files.size}`;
    files.set(part, change.content);
    return { op: "put" as const, path: change.path, part };
  });
  const manifest = CommitRepositoryChangesSchema.safeParse({ ...base, changes: wire });
  return manifest.success ? { manifest: manifest.data, files } : null;
}

export interface StagedUpload {
  path: string;
  file: File;
}
export type UploadRejection = "path" | "fileSize" | "totalSize" | "count";
export interface RejectedUpload {
  path: string;
  reason: UploadRejection;
}

/** Adds files to the staged list (later paths replace earlier ones) while enforcing commit limits. */
export function stageUploads(
  current: readonly StagedUpload[],
  incoming: readonly StagedUpload[]
): { staged: StagedUpload[]; rejected: RejectedUpload[] } {
  const staged = new Map(current.map((item) => [item.path, item]));
  const rejected: RejectedUpload[] = [];
  let total = current.reduce((sum, item) => sum + item.file.size, 0);
  for (const item of incoming) {
    const replaced = staged.get(item.path)?.file.size ?? 0;
    const reason: UploadRejection | null = !editablePath(item.path)
      ? "path"
      : item.file.size > REPOSITORY_COMMIT_LIMITS.fileBytes
        ? "fileSize"
        : total - replaced + item.file.size > REPOSITORY_COMMIT_LIMITS.totalBytes
          ? "totalSize"
          : !staged.has(item.path) && staged.size >= REPOSITORY_COMMIT_LIMITS.changes
            ? "count"
            : null;
    if (reason) {
      rejected.push({ path: item.path, reason });
      continue;
    }
    total += item.file.size - replaced;
    staged.set(item.path, item);
  }
  return { staged: [...staged.values()], rejected };
}

function joinPath(directory: string, relative: string): string {
  return directory ? `${directory}/${relative}` : relative;
}

/** Maps picker results; directory pickers expose the folder structure through webkitRelativePath. */
export function uploadsFromFiles(files: Iterable<File>, directory: string): StagedUpload[] {
  return [...files].map((file) => ({
    path: joinPath(directory, file.webkitRelativePath || file.name),
    file,
  }));
}

const MAX_DROPPED_ENTRIES = 1000;

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}
async function readDirectory(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: FileSystemEntry[] = [];
  while (entries.length < MAX_DROPPED_ENTRIES) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    );
    if (!batch.length) break;
    entries.push(...batch);
  }
  return entries;
}

/** Collects dropped files and folders; `truncated` reports that the entry cap was reached. */
export async function uploadsFromDrop(
  transfer: DataTransfer,
  directory: string
): Promise<{ uploads: StagedUpload[]; truncated: boolean }> {
  const roots = [...transfer.items]
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null))
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  if (!roots.length)
    return { uploads: uploadsFromFiles(transfer.files, directory), truncated: false };
  const uploads: StagedUpload[] = [];
  let truncated = false;
  async function visit(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (uploads.length >= MAX_DROPPED_ENTRIES) {
      truncated = true;
      return;
    }
    const path = joinPath(prefix, entry.name);
    if (entry.isFile)
      uploads.push({ path, file: await readEntryFile(entry as FileSystemFileEntry) });
    else {
      const children = await readDirectory(entry as FileSystemDirectoryEntry);
      if (children.length >= MAX_DROPPED_ENTRIES) truncated = true;
      for (const child of children) await visit(child, path);
    }
  }
  for (const root of roots) await visit(root, directory);
  return { uploads, truncated };
}
