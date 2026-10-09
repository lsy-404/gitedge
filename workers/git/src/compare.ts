import { createTwoFilesPatch } from "diff";
import type { GitComparison, GitDiffFile } from "../../../packages/contracts/src/index";
import { commitResponse, resolveCommit } from "./read";
import { GitResourceLimitError } from "./http";

export interface FlatTreeEntry {
  oid: string;
  mode: string;
}
async function collectTree(
  repo: ArtifactsRepo,
  tree: string,
  prefix = "",
  entries = new Map<string, FlatTreeEntry>()
): Promise<Map<string, FlatTreeEntry>> {
  const children = await repo.readTree(tree);
  if (!children) throw new Error("Git tree was not found.");
  for (const child of children) {
    if (entries.size > 1000)
      throw new GitResourceLimitError("Comparison exceeds the file count limit.");
    const path = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.type === "tree") await collectTree(repo, child.hash, path, entries);
    else entries.set(path, { oid: child.hash, mode: child.mode });
  }
  return entries;
}
async function history(
  repo: ArtifactsRepo,
  oid: string
): Promise<Map<string, ArtifactsCommitMetadata>> {
  const result = new Map<string, ArtifactsCommitMetadata>();
  const pending = [oid];
  while (pending.length) {
    const current = pending.shift();
    if (!current || result.has(current)) continue;
    if (result.size >= 250)
      throw new GitResourceLimitError("Comparison exceeds the commit history limit.");
    const commit = await repo.readCommit(current);
    if (!commit) throw new Error("Commit history is incomplete.");
    result.set(current, commit);
    pending.push(...commit.parents);
  }
  return result;
}
async function blobText(repo: ArtifactsRepo, oid: string | null): Promise<string | null> {
  if (!oid) return "";
  const blob = await repo.readBlob(oid);
  if (!blob || blob.size > 256_000) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    return bytes.includes(0)
      ? null
      : new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}
/** Unified diff of one path; patch is null for binary or oversized content. */
export async function fileDiff(
  oldRepo: ArtifactsRepo,
  newRepo: ArtifactsRepo,
  path: string,
  oldEntry: FlatTreeEntry | undefined,
  newEntry: FlatTreeEntry | undefined
): Promise<{ patch: string | null; binary: boolean }> {
  const oldText = await blobText(oldRepo, oldEntry?.oid ?? null);
  const newText = await blobText(newRepo, newEntry?.oid ?? null);
  const patch =
    oldText === null || newText === null
      ? null
      : createTwoFilesPatch(
          oldEntry ? `a/${path}` : "/dev/null",
          newEntry ? `b/${path}` : "/dev/null",
          oldText,
          newText,
          "",
          "",
          { context: 3 }
        );
  return { patch, binary: oldText === null || newText === null };
}
export async function compareArtifacts(
  baseRepo: ArtifactsRepo,
  headRepo: ArtifactsRepo,
  baseRef: string,
  headRef: string
): Promise<GitComparison | null> {
  const base = await resolveCommit(baseRepo, baseRef);
  const head = await resolveCommit(headRepo, headRef);
  if (!base || !head) return null;
  const baseHistory = await history(baseRepo, base.hash);
  const headHistory = await history(headRepo, head.hash);
  const common = [...headHistory.values()].filter((commit) => baseHistory.has(commit.hash));
  // A common ancestor with a common descendant cannot be the merge base.
  const ancestors = new Set<string>();
  for (const commit of common) {
    const pending = [...commit.parents];
    while (pending.length) {
      const oid = pending.pop();
      if (!oid || ancestors.has(oid)) continue;
      ancestors.add(oid);
      const parent = headHistory.get(oid);
      if (parent) pending.push(...parent.parents);
    }
  }
  const bases = common.filter((commit) => !ancestors.has(commit.hash));
  if (bases.length > 1)
    throw new GitResourceLimitError("Multiple merge bases require a local Git merge.");
  const mergeBase = bases[0] ?? null;
  const diffBase = mergeBase ?? base;
  const oldEntries = await collectTree(baseRepo, diffBase.treeHash);
  const newEntries = await collectTree(headRepo, head.treeHash);
  const files: GitDiffFile[] = [];
  let patchBytes = 0;
  let truncated = false;
  for (const path of [...new Set([...oldEntries.keys(), ...newEntries.keys()])].sort()) {
    const oldEntry = oldEntries.get(path);
    const newEntry = newEntries.get(path);
    if (oldEntry?.oid === newEntry?.oid && oldEntry?.mode === newEntry?.mode) continue;
    if (files.length >= 200) {
      truncated = true;
      break;
    }
    // Once the patch budget is spent, list the remaining files without reading their blobs.
    const diff =
      patchBytes > 2_000_000
        ? { patch: null, binary: false }
        : await fileDiff(baseRepo, headRepo, path, oldEntry, newEntry);
    let patch = diff.patch;
    patchBytes += patch?.length ?? 0;
    if (patchBytes > 2_000_000) {
      patch = null;
      truncated = true;
    }
    files.push({
      path,
      type: !oldEntry ? "added" : !newEntry ? "deleted" : "modified",
      oldOid: oldEntry?.oid ?? null,
      newOid: newEntry?.oid ?? null,
      patch,
      binary: diff.binary,
    });
  }
  const commits = [...headHistory.values()]
    .filter((commit) => !baseHistory.has(commit.hash))
    .map(commitResponse);
  return {
    baseOid: base.hash,
    headOid: head.hash,
    mergeBaseOid: mergeBase?.hash ?? null,
    commits,
    files,
    truncated,
  };
}
