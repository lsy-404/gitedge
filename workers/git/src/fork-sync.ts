import * as git from "isomorphic-git";
import type { ForkSyncResult } from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { GitWriteInputError } from "./changes";
import { gitHttpClient } from "./http";
import { resolveCommit } from "./read";
import { checkout, GitWriteConflict, revokeWriteToken } from "./write";

const MAX_AHEAD_COMMITS = 250;

export type ForkSyncOutcome =
  | { kind: "synced"; result: ForkSyncResult; before: string }
  | { kind: "not_fast_forward" }
  | { kind: "missing_upstream" };

/** Whether `target` is reachable from `tip` within MAX_AHEAD_COMMITS commits, following every parent. */
async function reaches(repo: ArtifactsRepo, tip: string, target: string): Promise<boolean> {
  const seen = new Set<string>();
  const pending = [tip];
  while (pending.length > 0) {
    const oid = pending.shift();
    if (!oid || seen.has(oid)) continue;
    if (oid === target) return true;
    if (seen.size >= MAX_AHEAD_COMMITS) return false;
    seen.add(oid);
    const commit = await repo.readCommit(oid);
    if (commit) pending.push(...commit.parents);
  }
  return false;
}

/**
 * Fast-forwards a fork branch to the upstream branch of the same name. The push is non-force and
 * compares the fork's advertised tip, so a concurrent push to the fork fails instead of being lost.
 */
export async function syncForkBranch(
  fork: ArtifactsRepo,
  upstream: ArtifactsRepo,
  branch: string,
  beforePush: () => Promise<void>,
  level?: string
): Promise<ForkSyncOutcome> {
  const forkTip = await resolveCommit(fork, branch);
  if (!forkTip) throw new GitWriteInputError("The branch does not exist in the fork.");
  const upstreamTip = await resolveCommit(upstream, branch);
  if (!upstreamTip) return { kind: "missing_upstream" };
  if (forkTip.hash === upstreamTip.hash)
    return {
      kind: "synced",
      result: { status: "up_to_date", branch, oid: forkTip.hash },
      before: forkTip.hash,
    };
  if (!(await reaches(upstream, upstreamTip.hash, forkTip.hash)))
    return { kind: "not_fast_forward" };

  const state = await checkout(fork, branch, forkTip.hash, level);
  const { fs, dir, http, info, token, logger } = state;
  const upstreamInfo = await upstream.info();
  const upstreamToken = await upstream.createToken("read", 60);
  try {
    await git.addRemote({ fs, dir, remote: "upstream", url: upstreamInfo.remote });
    const fetched = await git.fetch({
      fs,
      http: gitHttpClient(upstreamInfo.remote),
      dir,
      url: upstreamInfo.remote,
      remote: "upstream",
      ref: branch,
      singleBranch: true,
      tags: false,
      headers: { Authorization: `Bearer ${upstreamToken.plaintext}` },
    });
    if (fetched.fetchHead !== upstreamTip.hash)
      throw new GitWriteConflict("The upstream branch changed. Retry the sync.");
    await git.writeRef({
      fs,
      dir,
      ref: `refs/heads/${branch}`,
      value: upstreamTip.hash,
      force: true,
    });
    await beforePush();
    const pushed = await git.push({
      fs,
      dir,
      http,
      url: info.remote,
      ref: branch,
      remoteRef: branch,
      force: false,
      headers: { Authorization: `Bearer ${token.plaintext}` },
      onPrePush: (refs) => refs.remoteRef.oid === forkTip.hash,
    });
    if (!pushed.ok) throw new GitWriteConflict("The fork branch changed during the sync.");
    createLogger(level, { service: "git-fork-sync", repoId: info.name }).info("git:fork-synced", {
      branch,
    });
    return {
      kind: "synced",
      result: { status: "fast_forwarded", branch, oid: upstreamTip.hash },
      before: forkTip.hash,
    };
  } catch (error) {
    if (
      error instanceof git.Errors.PushRejectedError ||
      error instanceof git.Errors.UserCanceledError
    )
      throw new GitWriteConflict("The fork branch changed during the sync.");
    throw error;
  } finally {
    await revokeWriteToken(fork, token.id, logger);
    await revokeWriteToken(upstream, upstreamToken.id, logger);
  }
}
