import { Buffer } from "node:buffer";
import type {
  RepositorySnapshot,
  RepositorySnapshotFile,
} from "../../../packages/contracts/src/repository-controls";
import { GitResourceLimitError } from "./http";
import { editablePath } from "../../../packages/contracts/src/repository-controls";
export async function repositorySnapshot(
  repo: ArtifactsRepo,
  oid: string
): Promise<RepositorySnapshot> {
  const commit = await repo.readCommit(oid);
  if (!commit) throw new Error("Commit was not found.");
  const files: RepositorySnapshotFile[] = [],
    queue = [{ oid: commit.treeHash, path: "", depth: 0 }];
  let totalBytes = 0,
    trees = 0;
  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    if (++trees > 128 || item.depth > 24)
      throw new GitResourceLimitError("Repository directory count exceeds the snapshot limit.");
    const entries = await repo.readTree(item.oid);
    if (!entries) throw new Error("Repository tree is unavailable.");
    for (const entry of entries) {
      const path = item.path ? `${item.path}/${entry.name}` : entry.name;
      if (!editablePath(path))
        throw new GitResourceLimitError("Repository snapshot contains an unsupported path.");
      if (entry.type === "tree") {
        queue.push({ oid: entry.hash, path, depth: item.depth + 1 });
        continue;
      }
      if (entry.type !== "blob")
        throw new GitResourceLimitError("Actions snapshots support regular files only.");
      if (files.length >= 128)
        throw new GitResourceLimitError("Actions snapshots allow at most 128 files.");
      const blob = await repo.readBlob(entry.hash);
      if (!blob) throw new Error("Repository blob is unavailable.");
      totalBytes += blob.size;
      if (totalBytes > 4 * 1024 * 1024)
        throw new GitResourceLimitError("Actions snapshot exceeds 4 MiB.");
      files.push({
        path,
        mode: entry.mode,
        contentBase64: Buffer.from(await blob.arrayBuffer()).toString("base64"),
      });
    }
  }
  return { oid, files, totalBytes };
}
