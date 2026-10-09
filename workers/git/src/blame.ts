import { diffArrays } from "diff";
import { splitLines, type GitBlame } from "../../../packages/contracts/src/index";
import { resolveCommit } from "./read";
import { FirstParentWalk, TreeReader, WalkBudgetError, type PathEntry } from "./tree-walk";

export const BLAME_LIMITS = {
  fileBytes: 512 * 1024,
  commits: 500,
  treeReads: 500,
  blobReads: 150,
  /** Bytes of earlier file versions decoded per request. */
  blobBytes: 8 * 1024 * 1024,
  editLength: 4000,
  /** Line-comparison budget across all diffs; Myers costs about (old + new lines) * edits. */
  diffWork: 20_000_000,
};

export type BlameResult =
  | { status: "ok"; blame: GitBlame }
  | { status: "not_found" }
  | { status: "unsupported"; reason: "binary" | "too_large" };

type BlobLines =
  { lines: string[]; byteLength: number } | { unsupported: "binary" | "too_large" } | null;

async function readLines(repo: ArtifactsRepo, oid: string, maxBytes: number): Promise<BlobLines> {
  const blob = await repo.readBlob(oid);
  if (!blob) return null;
  if (blob.size > maxBytes) return { unsupported: "too_large" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.includes(0)) return { unsupported: "binary" };
  try {
    return {
      lines: splitLines(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)),
      byteLength: bytes.byteLength,
    };
  } catch {
    return { unsupported: "binary" };
  }
}

function isRegularFile(entry: PathEntry | null): entry is PathEntry {
  return entry !== null && (entry.type === "blob" || entry.type === "exec");
}

/**
 * Maps each line of `next` to the matching line index of `previous`, or -1 when it is new, and
 * reports the number of edited lines.
 */
function lineMapping(
  previous: string[],
  next: string[],
  maxEditLength: number
): { mapping: Int32Array; edits: number } | null {
  const parts = diffArrays(previous, next, { maxEditLength });
  if (!parts) return null;
  const mapping = new Int32Array(next.length).fill(-1);
  let oldIndex = 0;
  let newIndex = 0;
  let edits = 0;
  for (const part of parts) {
    const count = part.value.length;
    if (part.added) {
      newIndex += count;
      edits += count;
    } else if (part.removed) {
      oldIndex += count;
      edits += count;
    } else {
      for (let offset = 0; offset < count; offset++) mapping[newIndex + offset] = oldIndex + offset;
      oldIndex += count;
      newIndex += count;
    }
  }
  return { mapping, edits };
}

/**
 * First-parent line attribution. Lines that cannot be traced within the budget are reported with
 * a null commit and `partial`, never attributed to a guess.
 */
export async function blameFile(
  repo: ArtifactsRepo,
  ref: string,
  path: string,
  limits = BLAME_LIMITS
): Promise<BlameResult> {
  const head = await resolveCommit(repo, ref);
  if (!head) return { status: "not_found" };
  const reader = new TreeReader(repo, limits.treeReads);
  const headEntry = await reader.entryAt(head.treeHash, path);
  if (!isRegularFile(headEntry)) return { status: "not_found" };
  const headLines = await readLines(repo, headEntry.oid, limits.fileBytes);
  if (!headLines) return { status: "not_found" };
  if ("unsupported" in headLines) return { status: "unsupported", reason: headLines.unsupported };

  const attribution: (string | null)[] = headLines.lines.map(() => null);
  const commits = new Map<string, ArtifactsCommitMetadata>();
  // Unattributed lines: index in the final file and index in the version being walked.
  let pending = headLines.lines.map((_, line) => ({ line, current: line }));
  const assign = (commit: ArtifactsCommitMetadata, lines: typeof pending) => {
    if (lines.length === 0) return;
    commits.set(commit.hash, commit);
    for (const item of lines) attribution[item.line] = commit.hash;
  };

  const walk = new FirstParentWalk(repo, head.hash);
  let current = await walk.take();
  let currentEntry: PathEntry = headEntry;
  let currentLines = headLines.lines;
  let inspected = 0;
  let blobReads = 0;
  let blobBytes = 0;
  let diffWork = limits.diffWork;
  try {
    while (current && pending.length > 0) {
      const parent = await walk.take();
      inspected += 1;
      const parentEntry = parent ? await reader.entryAt(parent.treeHash, path) : null;
      if (!parent || !isRegularFile(parentEntry)) {
        assign(current, pending);
        pending = [];
        break;
      }
      if (parentEntry.oid !== currentEntry.oid) {
        if (blobReads >= limits.blobReads) break;
        blobReads += 1;
        const remainingBytes = limits.blobBytes - blobBytes;
        const parentLines = await readLines(
          repo,
          parentEntry.oid,
          Math.min(limits.fileBytes, remainingBytes)
        );
        if (!parentLines || "unsupported" in parentLines) break;
        blobBytes += parentLines.byteLength;
        const span = Math.max(1, parentLines.lines.length + currentLines.length);
        const maxEditLength = Math.min(limits.editLength, Math.floor(diffWork / span));
        if (maxEditLength < 1) break;
        const diff = lineMapping(parentLines.lines, currentLines, maxEditLength);
        if (!diff) break;
        diffWork -= span * Math.max(1, diff.edits);
        const { mapping } = diff;
        const introduced: typeof pending = [];
        const carried: typeof pending = [];
        for (const item of pending) {
          const mapped = mapping[item.current] ?? -1;
          if (mapped < 0) introduced.push(item);
          else carried.push({ line: item.line, current: mapped });
        }
        assign(current, introduced);
        pending = carried;
        currentLines = parentLines.lines;
        currentEntry = parentEntry;
      }
      current = parent;
      if (inspected >= limits.commits) break;
    }
  } catch (cause) {
    if (!(cause instanceof WalkBudgetError)) throw cause;
  }

  const hunks: GitBlame["hunks"] = [];
  for (const [index, oid] of attribution.entries()) {
    const last = hunks.at(-1);
    if (last && last.commitOid === oid) last.lineCount += 1;
    else hunks.push({ startLine: index + 1, lineCount: 1, commitOid: oid });
  }
  return {
    status: "ok",
    blame: {
      oid: head.hash,
      path,
      blobOid: headEntry.oid,
      lineCount: attribution.length,
      hunks,
      commits: [...commits.values()].map((commit) => ({
        oid: commit.hash,
        summary: commit.message.split("\n")[0] ?? "",
        author: { name: commit.author.name, timestamp: commit.authoredAt },
      })),
      inspected,
      partial: attribution.includes(null),
    },
  };
}
