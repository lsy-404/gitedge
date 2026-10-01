import * as git from "isomorphic-git";
import { createLogger } from "../../../src/worker/common/logger";
import type {
  GitCommit,
  GitFile,
  GitGraph,
  GitRef,
  GitTree,
  GitTreeEntry,
} from "../../../packages/contracts/src/index";
import { gitHttpClient } from "./http";
import type { AgentSession } from "../../../packages/contracts/src/index";

export function commitResponse(commit: ArtifactsCommitMetadata): GitCommit {
  return {
    oid: commit.hash,
    tree: commit.treeHash,
    parents: commit.parents,
    message: commit.message,
    author: { ...commit.author, timestamp: commit.authoredAt },
  };
}
export async function listArtifactRefs(repo: ArtifactsRepo, level?: string): Promise<GitRef[]> {
  const info = await repo.info();
  const token = await repo.createToken("read", 60);
  const logger = createLogger(level, { service: "git-read", repoId: info.name });
  try {
    const refs = await git.listServerRefs({
      http: gitHttpClient(info.remote, 1_000_000),
      url: info.remote,
      headers: { Authorization: `Bearer ${token.plaintext}` },
      protocolVersion: 2,
      peelTags: true,
    });
    logger.debug("artifacts:refs-read", { count: refs.length });
    return refs.map((ref) => ({ name: ref.ref, oid: ref.oid }));
  } finally {
    try {
      await repo.revokeToken(token.id);
    } catch {
      logger.warn("artifacts:read-token-revoke-failed", {});
    }
  }
}
export async function resolveCommit(
  repo: ArtifactsRepo,
  ref: string
): Promise<ArtifactsCommitMetadata | null> {
  const commits = await repo.log({ ref, limit: 1 });
  return commits[0] ?? null;
}
export async function readArtifactTree(
  repo: ArtifactsRepo,
  ref: string,
  path: string
): Promise<GitTree | null> {
  const commit = await resolveCommit(repo, ref);
  if (!commit) return { ref, oid: null, path, entries: [] };
  let oid = commit.treeHash;
  for (const segment of path.split("/").filter(Boolean)) {
    const entries = await repo.readTree(oid);
    const entry = entries?.find((item) => item.name === segment && item.type === "tree");
    if (!entry) return null;
    oid = entry.hash;
  }
  const entries = await repo.readTree(oid);
  if (!entries) return null;
  const mapped: GitTreeEntry[] = entries.map((entry) => ({
    name: entry.name,
    path: path ? `${path}/${entry.name}` : entry.name,
    oid: entry.hash,
    mode: entry.mode,
    type: entry.type === "tree" ? "tree" : entry.type === "gitlink" ? "commit" : "blob",
  }));
  mapped.sort(
    (a, b) =>
      (a.type === "tree" ? 0 : 1) - (b.type === "tree" ? 0 : 1) || a.name.localeCompare(b.name)
  );
  return { ref, oid, path, entries: mapped };
}
export async function readArtifactFile(
  repo: ArtifactsRepo,
  ref: string,
  path: string
): Promise<GitFile | null> {
  const slash = path.lastIndexOf("/");
  const parentPath = slash === -1 ? "" : path.slice(0, slash);
  const parent = await readArtifactTree(repo, ref, parentPath);
  const entry = parent?.entries.find((item) => item.path === path && item.type === "blob");
  if (!entry) return null;
  const blob = await repo.readFile({ ref, path });
  if (!blob) return null;
  if (blob.size > 2 * 1024 * 1024)
    return { path, oid: entry.oid, size: blob.size, binary: true, content: null };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let content: string | null = null;
  try {
    if (!bytes.includes(0))
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {}
  return { path, oid: entry.oid, size: blob.size, binary: content === null, content };
}
export async function artifactGraph(
  repo: ArtifactsRepo,
  refs: GitRef[],
  sessions: AgentSession[],
  limit: number
): Promise<GitGraph> {
  const pending = [
    ...new Set(
      refs
        .filter((ref) => ref.name === "HEAD" || ref.name.startsWith("refs/heads/"))
        .map((ref) => ref.oid)
    ),
  ];
  const seen = new Set<string>();
  const commits: GitCommit[] = [];
  while (pending.length && commits.length < limit) {
    const oid = pending.shift();
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    const commit = await repo.readCommit(oid);
    if (!commit) continue;
    commits.push(commitResponse(commit));
    pending.push(...commit.parents.filter((parent) => !seen.has(parent)));
  }
  return {
    commits: orderCommits(commits),
    refs,
    sessions,
    truncated: pending.some((oid) => !seen.has(oid)),
  };
}
export function orderCommits(commits: GitCommit[]): GitCommit[] {
  // Emit children before their parents even when commit timestamps are skewed.
  const byOid = new Map(commits.map((commit) => [commit.oid, commit]));
  const children = new Map<string, number>();
  for (const commit of commits)
    for (const parent of commit.parents)
      if (byOid.has(parent)) children.set(parent, (children.get(parent) ?? 0) + 1);
  const ready = commits.filter((commit) => !children.get(commit.oid));
  const sorted: GitCommit[] = [];
  while (ready.length) {
    ready.sort((a, b) => b.author.timestamp - a.author.timestamp || a.oid.localeCompare(b.oid));
    const commit = ready.shift();
    if (!commit) break;
    sorted.push(commit);
    for (const parent of commit.parents) {
      const next = (children.get(parent) ?? 0) - 1;
      children.set(parent, next);
      const info = byOid.get(parent);
      if (next === 0 && info) ready.push(info);
    }
  }
  return sorted;
}
