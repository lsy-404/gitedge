import { Buffer } from "node:buffer";
import { isActionWorkflowPath } from "../../../packages/contracts/src/actions";
import {
  editablePath,
  type RepositorySnapshot,
  type RepositorySnapshotFile,
} from "../../../packages/contracts/src/repository-controls";
import { GitResourceLimitError } from "./http";

const ACTION_SNAPSHOT_MAX_FILES = 2048;
const ACTION_SNAPSHOT_MAX_TREES = 2048;
const ACTION_SNAPSHOT_MAX_BYTES = 24 * 1024 * 1024;
const WORKFLOW_DIRECTORIES = new Set([
  ".github",
  ".github/workflows",
  ".gitedge",
  ".gitedge/workflows",
]);
export async function repositorySnapshot(
  repo: ArtifactsRepo,
  oid: string,
  workflowsOnly = false
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
    if (++trees > ACTION_SNAPSHOT_MAX_TREES || item.depth > 32)
      throw new GitResourceLimitError("Repository directory count exceeds the snapshot limit.");
    const entries = await repo.readTree(item.oid);
    if (!entries) throw new Error("Repository tree is unavailable.");
    for (const entry of entries) {
      const path = item.path ? `${item.path}/${entry.name}` : entry.name;
      if (
        workflowsOnly &&
        !(entry.type === "tree" ? WORKFLOW_DIRECTORIES.has(path) : isActionWorkflowPath(path))
      )
        continue;
      if (!editablePath(path))
        throw new GitResourceLimitError("Repository snapshot contains an unsupported path.");
      if (entry.type === "tree") {
        queue.push({ oid: entry.hash, path, depth: item.depth + 1 });
        continue;
      }
      if (entry.type !== "blob")
        throw new GitResourceLimitError("Actions snapshots support regular files only.");
      if (files.length >= ACTION_SNAPSHOT_MAX_FILES)
        throw new GitResourceLimitError("Actions snapshots allow at most 2,048 files.");
      const blob = await repo.readBlob(entry.hash);
      if (!blob) throw new Error("Repository blob is unavailable.");
      totalBytes += blob.size;
      if (totalBytes > ACTION_SNAPSHOT_MAX_BYTES)
        throw new GitResourceLimitError("Actions snapshot exceeds 24 MiB.");
      files.push({
        path,
        mode: entry.mode,
        contentBase64: Buffer.from(await blob.arrayBuffer()).toString("base64"),
      });
    }
  }
  return { oid, files, totalBytes };
}
