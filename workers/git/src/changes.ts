import * as git from "isomorphic-git";

export class GitWriteInputError extends Error {}

export type RepositoryChange =
  | { op: "put"; path: string; content: Uint8Array; textEdit?: boolean }
  | { op: "delete"; path: string }
  | { op: "move"; from: string; to: string };

type ObjectStore = { fs: git.CallbackFsClient | git.PromiseFsClient; dir: string };

const MAX_EDITABLE_TEXT_BYTES = 1_000_000;

async function readEntries(store: ObjectStore, oid: string | null): Promise<git.TreeEntry[]> {
  return oid ? (await git.readTree({ ...store, oid })).tree : [];
}
async function lookup(
  store: ObjectStore,
  rootOid: string | null,
  parts: string[]
): Promise<git.TreeEntry | null> {
  let oid = rootOid;
  for (const [index, name] of parts.entries()) {
    const entry = (await readEntries(store, oid)).find((item) => item.path === name);
    if (!entry) return null;
    if (index === parts.length - 1) return entry;
    if (entry.type !== "tree") return null;
    oid = entry.oid;
  }
  return null;
}
/** Rewrites one path; returns the new tree oid, or null when the tree ends up empty. */
async function replace(
  store: ObjectStore,
  oid: string | null,
  parts: string[],
  next: (existing: git.TreeEntry | undefined) => Omit<git.TreeEntry, "path"> | null
): Promise<string | null> {
  const entries = await readEntries(store, oid);
  const [name, ...rest] = parts,
    existing = entries.find((entry) => entry.path === name);
  let replacement: git.TreeEntry | null;
  if (rest.length) {
    if (existing && existing.type !== "tree")
      throw new GitWriteInputError("A parent path is not a directory.");
    const child = await replace(store, existing?.oid ?? null, rest, next);
    replacement = child ? { path: name, mode: "040000", type: "tree", oid: child } : null;
  } else {
    const made = next(existing);
    replacement = made ? { path: name, ...made } : null;
  }
  const remaining = entries.filter((entry) => entry.path !== name);
  if (replacement) remaining.push(replacement);
  return remaining.length ? git.writeTree({ ...store, tree: remaining }) : null;
}
async function assertEditableText(store: ObjectStore, oid: string): Promise<void> {
  const original = await git.readBlob({ ...store, oid });
  if (original.blob.byteLength > MAX_EDITABLE_TEXT_BYTES || original.blob.includes(0))
    throw new GitWriteInputError("Only text files under 1 MB can be edited.");
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(original.blob);
  } catch {
    throw new GitWriteInputError("Only UTF-8 text files can be edited.");
  }
}

/** Applies path-disjoint changes to a tree and returns the new root tree oid. */
export async function applyRepositoryChanges(
  store: ObjectStore,
  rootOid: string | null,
  changes: readonly RepositoryChange[]
): Promise<string> {
  let root = rootOid;
  for (const change of changes) {
    if (change.op === "put") {
      const parts = change.path.split("/");
      const existing = await lookup(store, root, parts);
      if (existing && (existing.type !== "blob" || existing.mode === "120000"))
        throw new GitWriteInputError("Only regular files can be replaced.");
      if (existing && change.textEdit) await assertEditableText(store, existing.oid);
      const blob = await git.writeBlob({ ...store, blob: change.content });
      root = await replace(store, root, parts, (current) => ({
        mode: current?.mode === "100755" ? "100755" : "100644",
        type: "blob",
        oid: blob,
      }));
    } else if (change.op === "delete") {
      const parts = change.path.split("/");
      if (!(await lookup(store, root, parts)))
        throw new GitWriteInputError("The path does not exist.");
      root = await replace(store, root, parts, () => null);
    } else {
      const source = await lookup(store, root, change.from.split("/"));
      if (!source) throw new GitWriteInputError("The path does not exist.");
      if (await lookup(store, root, change.to.split("/")))
        throw new GitWriteInputError("The destination already exists.");
      const { mode, type, oid } = source;
      root = await replace(store, root, change.to.split("/"), () => ({ mode, type, oid }));
      root = await replace(store, root, change.from.split("/"), () => null);
    }
  }
  return root ?? (await git.writeTree({ ...store, tree: [] }));
}
