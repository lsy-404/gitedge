import type { GitCodeSearch } from "../../../packages/contracts/src/forge";
import { resolveCommit } from "./read";
import { TreeReader, WalkBudgetError } from "./tree-walk";

export const CODE_SEARCH_LIMITS = {
  trees: 500,
  files: 100,
  matches: 100,
  bytes: 2_000_000,
  fileBytes: 1_000_000,
};

interface SearchTree {
  prefix: string;
  entries: ArtifactsTreeEntry[];
  index: number;
}

function searchCursor(value: string | null): {
  path: string | null;
  line: number | null;
  mode: "line" | "skip-file" | "tree" | "start";
} | null {
  if (value === null) return { path: null, line: null, mode: "start" };
  if (!value.startsWith("v1:")) return null;
  const parts = value.slice(3).split(":");
  if (parts.length !== 2) return null;
  let path: string;
  try {
    path = decodeURIComponent(parts[0] ?? "");
  } catch {
    return null;
  }
  if (
    !path ||
    path.length > 2000 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    return null;
  if (parts[1] === "skip-file") return { path, line: null, mode: "skip-file" };
  if (parts[1] === "tree") return { path, line: null, mode: "tree" };
  const line = Number(parts[1]);
  return Number.isSafeInteger(line) && line >= 0 ? { path, line, mode: "line" } : null;
}

export function isCodeSearchCursor(value: string): boolean {
  return searchCursor(value) !== null;
}

function cursorFor(path: string, line: number | "skip-file" | "tree"): string {
  return `v1:${encodeURIComponent(path)}:${line}`;
}

function pathOrder(left: ArtifactsTreeEntry, right: ArtifactsTreeEntry): number {
  const leftName = `${left.name}${left.type === "tree" ? "/" : ""}`;
  const rightName = `${right.name}${right.type === "tree" ? "/" : ""}`;
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
}

export async function searchCode(
  repo: ArtifactsRepo,
  owner: string,
  repository: string,
  oid: string,
  query: string,
  path: string,
  rawCursor: string | null
): Promise<GitCodeSearch | null> {
  const commit = await resolveCommit(repo, oid);
  if (!commit || commit.hash !== oid) return null;
  const cursor = searchCursor(rawCursor);
  if (!cursor) return null;
  const reader = new TreeReader(repo, CODE_SEARCH_LIMITS.trees);
  const matches: GitCodeSearch["matches"] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let inspected = 0;
  let bytes = 0;
  let nextCursor: string | null = null;
  let treeWalkTruncated = false;
  let lastProcessedPath: string | null = null;
  let pendingTreePath: string | null = null;
  let startTreeOid = commit.treeHash;
  let startPrefix = "";
  let singleFile: string | null = null;

  if (path) {
    const selected = await reader.entryAt(commit.treeHash, path);
    if (!selected) return { oid, matches, inspected, truncated: false, nextCursor: null };
    if (selected.type === "tree") {
      startTreeOid = selected.oid;
      startPrefix = path;
    } else if (selected.type === "blob" || selected.type === "exec") singleFile = path;
    else return { oid, matches, inspected, truncated: false, nextCursor: null };
  }

  const inspectFile = async (filePath: string, startLine: number): Promise<void> => {
    if (inspected >= CODE_SEARCH_LIMITS.files) {
      nextCursor = cursorFor(filePath, 0);
      return;
    }
    const file = await repo.readFile({ ref: oid, path: filePath });
    if (!file) return;
    if (file.size > CODE_SEARCH_LIMITS.fileBytes || bytes + file.size > CODE_SEARCH_LIMITS.bytes) {
      nextCursor = cursorFor(filePath, "skip-file");
      return;
    }
    inspected += 1;
    lastProcessedPath = filePath;
    bytes += file.size;
    const content = new Uint8Array(await file.arrayBuffer());
    if (content.includes(0)) return;
    let text: string;
    try {
      text = decoder.decode(content);
    } catch {
      return;
    }
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (index < startLine) continue;
      if (!line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      const lineNumber = index + 1;
      matches.push({
        path: filePath,
        line: lineNumber,
        text: line.slice(0, 500),
        permalink: `/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/blob/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${oid}#L${lineNumber}`,
      });
      if (matches.length >= CODE_SEARCH_LIMITS.matches) {
        nextCursor = cursorFor(filePath, index + 1);
        return;
      }
    }
  };

  if (singleFile) {
    const startLine = cursor.path === singleFile ? (cursor.line ?? 0) : 0;
    if (
      !cursor.path ||
      singleFile > cursor.path ||
      (singleFile === cursor.path && cursor.mode === "line")
    )
      await inspectFile(singleFile, startLine);
  } else {
    try {
      const firstEntries = (await reader.read(startTreeOid)) ?? [];
      firstEntries.sort(pathOrder);
      const stack: SearchTree[] = [{ prefix: startPrefix, entries: firstEntries, index: 0 }];
      while (stack.length > 0 && nextCursor === null) {
        const frame = stack.at(-1);
        if (!frame) break;
        const entry = frame.entries[frame.index];
        if (!entry) {
          stack.pop();
          continue;
        }
        frame.index += 1;
        if (
          entry.name === "." ||
          entry.name === ".." ||
          entry.name.includes("/") ||
          entry.name.includes("\\") ||
          entry.name.includes("\0")
        ) {
          treeWalkTruncated = true;
          continue;
        }
        const entryPath = frame.prefix ? `${frame.prefix}/${entry.name}` : entry.name;
        if (entryPath.length > 2000) {
          treeWalkTruncated = true;
          continue;
        }
        if (entry.type === "tree") {
          const treePrefix = `${entryPath}/`;
          if (cursor.path && !cursor.path.startsWith(treePrefix) && treePrefix <= cursor.path)
            continue;
          pendingTreePath = entryPath;
          const entries = (await reader.read(entry.hash)) ?? [];
          pendingTreePath = null;
          entries.sort(pathOrder);
          stack.push({ prefix: entryPath, entries, index: 0 });
          continue;
        }
        if (entry.type === "gitlink") continue;
        const afterCursor =
          !cursor.path ||
          entryPath > cursor.path ||
          (entryPath === cursor.path && cursor.mode === "line");
        if (!afterCursor) continue;
        const startLine = entryPath === cursor.path ? (cursor.line ?? 0) : 0;
        await inspectFile(entryPath, startLine);
        if (inspected >= CODE_SEARCH_LIMITS.files && nextCursor === null) {
          const next = frame.entries[frame.index];
          if (next)
            nextCursor = cursorFor(`${frame.prefix ? `${frame.prefix}/` : ""}${next.name}`, 0);
        }
      }
    } catch (cause) {
      if (!(cause instanceof WalkBudgetError)) throw cause;
      treeWalkTruncated = true;
      nextCursor = lastProcessedPath
        ? cursorFor(lastProcessedPath, "skip-file")
        : pendingTreePath
          ? cursorFor(pendingTreePath, "tree")
          : null;
    }
  }

  return {
    oid,
    matches,
    inspected,
    truncated: nextCursor !== null || treeWalkTruncated,
    nextCursor,
  };
}
