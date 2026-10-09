import * as git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import type { CommitRepositoryChangesResult } from "../../../packages/contracts/src/repository-controls";
import { applyRepositoryChanges, GitWriteInputError, type RepositoryChange } from "./changes";
import { createLogger, type Logger } from "../../../src/worker/common/logger";
import { gitHttpClient } from "./http";
import { resolveCommit } from "./read";

export class GitWriteConflict extends Error {}
const ZERO_OID = "0".repeat(40);
function author(name: string, id: string): git.CommitObject["author"] {
  return {
    name,
    email: `${id}@users.gitedge.invalid`,
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: 0,
  };
}
async function revokeWriteToken(repo: ArtifactsRepo, tokenId: string, logger: Logger) {
  try {
    await repo.revokeToken(tokenId);
  } catch {
    logger.warn("artifacts:write-token-revoke-failed", {});
  }
}
async function checkout(
  repo: ArtifactsRepo,
  branch: string,
  expectedOid: string | null,
  level: string | undefined
) {
  const current = await resolveCommit(repo, branch);
  if ((current?.hash ?? null) !== expectedOid)
    throw new GitWriteConflict("The branch changed. Reload before committing.");
  const info = await repo.info();
  const logger = createLogger(level, { service: "git-write", repoId: info.name });
  if (!current && info.lastPushAt !== null)
    throw new GitWriteInputError("The source branch does not exist.");
  const token = await repo.createToken("write", 60);
  const fs = createFsFromVolume(new Volume()),
    dir = "/repo",
    http = gitHttpClient(info.remote);
  try {
    if (current)
      await git.clone({
        fs,
        dir,
        http,
        url: info.remote,
        ref: branch,
        singleBranch: true,
        noCheckout: true,
        noTags: true,
        headers: { Authorization: `Bearer ${token.plaintext}` },
      });
    else {
      await git.init({ fs, dir, defaultBranch: branch });
      await git.addRemote({ fs, dir, remote: "origin", url: info.remote });
    }
    if (current && (await git.resolveRef({ fs, dir, ref: branch })) !== expectedOid)
      throw new GitWriteConflict("The branch changed. Reload before committing.");
    return { fs, dir, http, info, token, current, logger };
  } catch (error) {
    await revokeWriteToken(repo, token.id, logger);
    throw error;
  }
}
export interface RepositoryCommitInput {
  branch: string;
  newBranch?: string;
  expectedOid: string | null;
  message: string;
  changes: RepositoryChange[];
}
export async function commitRepositoryChanges(
  repo: ArtifactsRepo,
  input: RepositoryCommitInput,
  user: { id: string; identifier: string },
  beforePush: () => Promise<void>,
  level?: string
): Promise<CommitRepositoryChangesResult> {
  const target = input.newBranch ?? input.branch;
  if (input.newBranch && (await resolveCommit(repo, target)))
    throw new GitWriteConflict("The new branch already exists.");
  const state = await checkout(repo, input.branch, input.expectedOid, level);
  const { fs, dir, http, info, token, current, logger } = state;
  try {
    const tree = await applyRepositoryChanges(
      { fs, dir },
      current?.treeHash ?? null,
      input.changes
    );
    if (current?.treeHash === tree)
      throw new GitWriteInputError("The commit does not change any file.");
    const identity = author(user.identifier, user.id);
    const oid = await git.writeCommit({
      fs,
      dir,
      commit: {
        tree,
        parent: input.expectedOid ? [input.expectedOid] : [],
        author: identity,
        committer: identity,
        message: input.message + "\n",
      },
    });
    await git.writeRef({ fs, dir, ref: `refs/heads/${target}`, value: oid, force: true });
    const expected = input.newBranch ? ZERO_OID : (input.expectedOid ?? ZERO_OID);
    await beforePush();
    const pushed = await git.push({
      fs,
      dir,
      http,
      url: info.remote,
      ref: target,
      remoteRef: target,
      force: false,
      headers: { Authorization: `Bearer ${token.plaintext}` },
      onPrePush: (refs) => refs.remoteRef.oid === expected,
    });
    if (!pushed.ok)
      throw new GitWriteConflict("The branch changed before the commit could be saved.");
    return { oid, branch: target };
  } catch (error) {
    if (
      error instanceof git.Errors.PushRejectedError ||
      error instanceof git.Errors.UserCanceledError
    )
      throw new GitWriteConflict("The branch changed before the commit could be saved.");
    throw error;
  } finally {
    await revokeWriteToken(repo, token.id, logger);
  }
}
export async function createRepositoryBranch(
  repo: ArtifactsRepo,
  name: string,
  source: string,
  expectedOid: string,
  beforePush: () => Promise<void>,
  level?: string
): Promise<{ name: string; oid: string }> {
  if (await resolveCommit(repo, name)) throw new GitWriteConflict("The branch already exists.");
  const { fs, dir, http, info, token, logger } = await checkout(repo, source, expectedOid, level);
  try {
    await git.writeRef({ fs, dir, ref: `refs/heads/${name}`, value: expectedOid });
    await beforePush();
    const pushed = await git.push({
      fs,
      dir,
      http,
      url: info.remote,
      ref: name,
      remoteRef: name,
      force: false,
      headers: { Authorization: `Bearer ${token.plaintext}` },
      onPrePush: (refs) => refs.remoteRef.oid === ZERO_OID,
    });
    if (!pushed.ok) throw new GitWriteConflict("The branch already exists.");
    return { name, oid: expectedOid };
  } catch (error) {
    if (
      error instanceof git.Errors.PushRejectedError ||
      error instanceof git.Errors.UserCanceledError
    )
      throw new GitWriteConflict("The branch already exists.");
    throw error;
  } finally {
    await revokeWriteToken(repo, token.id, logger);
  }
}
export async function deleteRepositoryBranch(
  repo: ArtifactsRepo,
  name: string,
  expectedOid: string,
  beforePush: () => Promise<void>,
  level?: string
): Promise<void> {
  const { fs, dir, http, info, token, logger } = await checkout(repo, name, expectedOid, level);
  try {
    if (name === info.defaultBranch)
      throw new GitWriteInputError("The native default branch cannot be deleted.");
    await beforePush();
    const pushed = await git.push({
      fs,
      dir,
      http,
      url: info.remote,
      ref: name,
      remoteRef: name,
      delete: true,
      headers: { Authorization: `Bearer ${token.plaintext}` },
      onPrePush: (refs) => refs.remoteRef.oid === expectedOid,
    });
    if (!pushed.ok) throw new GitWriteConflict("The branch changed before deletion.");
  } catch (error) {
    if (
      error instanceof git.Errors.PushRejectedError ||
      error instanceof git.Errors.UserCanceledError
    )
      throw new GitWriteConflict("The branch changed before deletion.");
    throw error;
  } finally {
    await revokeWriteToken(repo, token.id, logger);
  }
}
