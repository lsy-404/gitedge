import type { GitCommitDetail, GitDiffFile } from "../../../packages/contracts/src/index";
import { fileDiff, type FlatTreeEntry } from "./compare";
import { commitResponse } from "./read";
import { TreeReader, WalkBudgetError } from "./tree-walk";

export const COMMIT_DIFF_LIMITS = { files: 200, treeReads: 200, patchBytes: 2_000_000 };

interface LeafChange {
  path: string;
  before?: FlatTreeEntry;
  after?: FlatTreeEntry;
}

/** Collects changed leaves between two trees, skipping subtrees whose object ids match. */
async function collectChanges(
  reader: TreeReader,
  before: string | null,
  after: string | null,
  prefix: string,
  changes: LeafChange[],
  maxFiles: number
): Promise<boolean> {
  const beforeEntries = before ? ((await reader.read(before)) ?? []) : [];
  const afterEntries = after ? ((await reader.read(after)) ?? []) : [];
  const leftByName = new Map(beforeEntries.map((entry) => [entry.name, entry]));
  const rightByName = new Map(afterEntries.map((entry) => [entry.name, entry]));
  for (const name of [...new Set([...leftByName.keys(), ...rightByName.keys()])].sort()) {
    const left = leftByName.get(name);
    const right = rightByName.get(name);
    if (left?.hash === right?.hash && left?.mode === right?.mode) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    const leftTree = left?.type === "tree" ? left.hash : null;
    const rightTree = right?.type === "tree" ? right.hash : null;
    if (leftTree || rightTree) {
      if (!(await collectChanges(reader, leftTree, rightTree, path, changes, maxFiles)))
        return false;
    }
    const leftLeaf = left && left.type !== "tree" ? left : undefined;
    const rightLeaf = right && right.type !== "tree" ? right : undefined;
    if (!leftLeaf && !rightLeaf) continue;
    if (changes.length >= maxFiles) return false;
    changes.push({
      path,
      before: leftLeaf && { oid: leftLeaf.hash, mode: leftLeaf.mode },
      after: rightLeaf && { oid: rightLeaf.hash, mode: rightLeaf.mode },
    });
  }
  return true;
}

/** Commit metadata with its diff against the first parent (or the empty tree for a root). */
export async function commitDetail(
  repo: ArtifactsRepo,
  oid: string,
  limits = COMMIT_DIFF_LIMITS
): Promise<GitCommitDetail | null> {
  const commit = await repo.readCommit(oid);
  if (!commit) return null;
  const parentOid = commit.parents[0];
  const parent = parentOid ? await repo.readCommit(parentOid) : null;
  const reader = new TreeReader(repo, limits.treeReads);
  const changes: LeafChange[] = [];
  let complete: boolean;
  try {
    complete = await collectChanges(
      reader,
      parent?.treeHash ?? null,
      commit.treeHash,
      "",
      changes,
      limits.files
    );
  } catch (cause) {
    if (!(cause instanceof WalkBudgetError)) throw cause;
    complete = false;
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files: GitDiffFile[] = [];
  let patchBytes = 0;
  let truncated = !complete;
  for (const change of changes) {
    const diff = await fileDiff(repo, repo, change.path, change.before, change.after);
    let patch = diff.patch;
    patchBytes += patch?.length ?? 0;
    if (patchBytes > limits.patchBytes) {
      patch = null;
      truncated = true;
    }
    files.push({
      path: change.path,
      type: !change.before ? "added" : !change.after ? "deleted" : "modified",
      oldOid: change.before?.oid ?? null,
      newOid: change.after?.oid ?? null,
      patch,
      binary: diff.binary,
    });
  }
  return { commit: commitResponse(commit), files, truncated };
}
