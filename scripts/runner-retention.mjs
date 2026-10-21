import { lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

export const RUN_RETENTION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const RUN_RETENTION_MAX_BYTES = 1024 * 1024 * 1024;

async function directorySize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await directorySize(file);
    else if (entry.isFile()) total += (await stat(file)).size;
  }
  return total;
}

async function listCandidates(root, predicate) {
  const info = await lstat(root).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return [];
  const canonicalRoot = await realpath(root);
  const candidates = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !(entry.isDirectory() || entry.isFile())) continue;
    if (!predicate(entry)) continue;
    const target = path.resolve(root, entry.name);
    const relative = path.relative(canonicalRoot, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const targetInfo = await lstat(target);
    if (targetInfo.isSymbolicLink() || !(targetInfo.isDirectory() || targetInfo.isFile())) continue;
    candidates.push({
      path: target,
      root: canonicalRoot,
      modifiedAt: targetInfo.mtimeMs,
      bytes: targetInfo.isDirectory() ? await directorySize(target) : targetInfo.size,
    });
  }
  return candidates;
}

export async function pruneRunArtifacts(roots, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? RUN_RETENTION_AGE_MS;
  const maxBytes = options.maxBytes ?? RUN_RETENTION_MAX_BYTES;
  const candidates = [];
  for (const { directory, match } of roots)
    candidates.push(...(await listCandidates(directory, match ?? (() => true))));

  const oldestFirst = candidates.sort((left, right) => left.modifiedAt - right.modifiedAt);
  let totalBytes = oldestFirst.reduce((total, item) => total + item.bytes, 0);
  for (const item of oldestFirst) {
    if (now - item.modifiedAt <= maxAgeMs && totalBytes <= maxBytes) continue;
    const resolvedRoot = item.root;
    const resolvedTarget = path.resolve(item.path);
    const relative = path.relative(resolvedRoot, resolvedTarget);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const targetInfo = await lstat(resolvedTarget).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!targetInfo || targetInfo.isSymbolicLink()) continue;
    await rm(resolvedTarget, { recursive: targetInfo.isDirectory(), force: true });
    totalBytes -= item.bytes;
  }
}

export function runArtifactRoots(state, profiles) {
  return [
    {
      directory: path.join(state, "runs"),
      match: (entry) => entry.isDirectory() && /^[a-zA-Z0-9._-]+-[a-f0-9-]{36}-/i.test(entry.name),
    },
    ...profiles.flatMap((profile) => [
      { directory: path.join(profile.directory, "runs"), match: (entry) => entry.isDirectory() },
      {
        directory: path.join(profile.directory, "logs"),
        match: (entry) => entry.isFile() && entry.name.endsWith(".log"),
      },
    ]),
    {
      directory: path.join(state, "..", "actions", "runs"),
      match: (entry) => entry.isDirectory() && entry.name.startsWith("run-"),
    },
  ];
}

export function actionRunRoots(state) {
  return [
    {
      directory: path.join(state, "runs"),
      match: (entry) => entry.isDirectory() && entry.name.startsWith("run-"),
    },
  ];
}
