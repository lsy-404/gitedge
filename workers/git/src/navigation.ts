import type { GitFileList, GitPathHistory } from "../../../packages/contracts/src/index";
import { GitResourceLimitError } from "./http";
import { commitResponse, resolveCommit } from "./read";
import { FirstParentWalk, samePathEntry, TreeReader, WalkBudgetError } from "./tree-walk";

export const FILE_LIST_LIMITS = { paths: 20_000, trees: 500, concurrency: 8 };
export const PATH_HISTORY_LIMITS = { inspect: 200, results: 30, treeReads: 400 };

interface PendingTree {
  oid: string;
  prefix: string;
}

/** Lists blob paths of a commit breadth-first, stopping at the path or directory budget. */
export async function listFiles(
  repo: ArtifactsRepo,
  ref: string,
  limits = FILE_LIST_LIMITS
): Promise<GitFileList | null> {
  const commit = await resolveCommit(repo, ref);
  if (!commit) return null;
  const reader = new TreeReader(repo, limits.trees);
  const paths: string[] = [];
  let level: PendingTree[] = [{ oid: commit.treeHash, prefix: "" }];
  let truncated = false;
  while (level.length > 0 && !truncated) {
    const next: PendingTree[] = [];
    for (let start = 0; start < level.length && !truncated; start += limits.concurrency) {
      const batch = level.slice(start, start + limits.concurrency);
      let listings: (ArtifactsTreeEntry[] | null)[];
      try {
        listings = await Promise.all(batch.map((item) => reader.read(item.oid)));
      } catch (cause) {
        if (!(cause instanceof WalkBudgetError)) throw cause;
        truncated = true;
        break;
      }
      for (const [index, entries] of listings.entries()) {
        const prefix = batch[index]?.prefix ?? "";
        for (const entry of entries ?? []) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.type === "tree") next.push({ oid: entry.hash, prefix: path });
          else if (entry.type !== "gitlink") paths.push(path);
        }
      }
      if (paths.length >= limits.paths) truncated = true;
    }
    level = next;
  }
  if (paths.length > limits.paths) paths.length = limits.paths;
  paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { oid: commit.hash, paths, truncated };
}

/**
 * Commits on the first-parent chain from `start` that changed `path`. The walk is bounded by
 * commits inspected, matches returned and tree reads; `nextCursor` resumes where it stopped.
 */
export async function pathHistory(
  repo: ArtifactsRepo,
  start: string,
  path: string,
  limits = PATH_HISTORY_LIMITS
): Promise<GitPathHistory> {
  const walk = new FirstParentWalk(repo, start);
  const reader = new TreeReader(repo, limits.treeReads);
  const commits: GitPathHistory["commits"] = [];
  let inspected = 0;
  let nextCursor: string | null = null;
  let current = await walk.take();
  try {
    let currentEntry = current ? await reader.entryAt(current.treeHash, path) : null;
    while (current) {
      if (inspected >= limits.inspect || commits.length >= limits.results) {
        nextCursor = current.hash;
        break;
      }
      const parent = await walk.take();
      const parentEntry = parent ? await reader.entryAt(parent.treeHash, path) : null;
      inspected += 1;
      if (!samePathEntry(currentEntry, parentEntry)) commits.push(commitResponse(current));
      current = parent;
      currentEntry = parentEntry;
    }
  } catch (cause) {
    if (!(cause instanceof WalkBudgetError) || !current) throw cause;
    if (inspected === 0) throw new GitResourceLimitError("Path exceeds the history walk budget.");
    nextCursor = current.hash;
  }
  return { commits, inspected, truncated: nextCursor !== null, nextCursor };
}
