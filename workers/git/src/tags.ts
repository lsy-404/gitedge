import * as git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import {
  GitOidSchema,
  TAG_LIST_LIMIT,
  type CreateTagInput,
  type RepositoryTag,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { gitHttpClient } from "./http";
import { listArtifactRefs } from "./read";
import {
  GitWriteConflict,
  GitWriteInputError,
  ZERO_OID,
  author,
  checkout,
  revokeWriteToken,
} from "./write";

const TAG_PREFIX = "refs/tags/";
const HEAD_PREFIX = "refs/heads/";

export class GitTagExists extends Error {}

function naturalDescending(a: string, b: string): number {
  return b.localeCompare(a, "en", { numeric: true });
}

/** Lists tags newest-name first; one commit lookup per returned tag keeps the call bounded. */
export async function listRepositoryTags(
  repo: ArtifactsRepo,
  level: string | undefined,
  name?: string | null
): Promise<{ tags: RepositoryTag[]; truncated: boolean }> {
  const refs = (await listArtifactRefs(repo, level))
    .filter((ref) => ref.name.startsWith(TAG_PREFIX))
    .filter((ref) => !name || ref.name === TAG_PREFIX + name);
  refs.sort((a, b) => naturalDescending(a.name, b.name));
  const tags: RepositoryTag[] = [];
  for (const ref of refs.slice(0, TAG_LIST_LIMIT)) {
    const commitOid = ref.peeledOid ?? ref.oid;
    const commit = await repo.readCommit(commitOid);
    if (!commit) continue;
    tags.push({
      name: ref.name.slice(TAG_PREFIX.length),
      oid: ref.oid,
      commitOid,
      annotated: ref.peeledOid !== undefined,
      subject: commit.message.split("\n")[0] ?? "",
      timestamp: commit.committedAt,
    });
  }
  return { tags, truncated: refs.length > TAG_LIST_LIMIT };
}

/**
 * Creates a lightweight tag, or an annotated one when a message is given. The target is a
 * branch tip, or a commit contained in the source branch's history.
 */
export async function createRepositoryTag(
  repo: ArtifactsRepo,
  input: CreateTagInput,
  defaultBranch: string,
  user: { id: string; identifier: string },
  beforePush: () => Promise<void>,
  level?: string
): Promise<RepositoryTag> {
  const refs = await listArtifactRefs(repo, level);
  if (refs.some((ref) => ref.name === TAG_PREFIX + input.name))
    throw new GitTagExists("The tag already exists.");
  const targetIsCommit = GitOidSchema.safeParse(input.target).success;
  const branch = targetIsCommit ? (input.source ?? defaultBranch) : input.target;
  const tip = refs.find((ref) => ref.name === HEAD_PREFIX + branch);
  if (!tip) throw new GitWriteInputError("The branch does not exist.");
  const { fs, dir, http, info, token, logger } = await checkout(repo, branch, tip.oid, level);
  try {
    const commitOid = targetIsCommit ? input.target : tip.oid;
    try {
      await git.readCommit({ fs, dir, oid: commitOid });
    } catch {
      throw new GitWriteInputError("The commit is not part of the selected branch.");
    }
    const ref = TAG_PREFIX + input.name;
    let tagOid = commitOid;
    if (input.message) {
      const tagger = author(user.identifier, user.id);
      await git.annotatedTag({
        fs,
        dir,
        ref: input.name,
        object: commitOid,
        message: input.message + "\n",
        tagger,
      });
      tagOid = await git.resolveRef({ fs, dir, ref });
    } else await git.writeRef({ fs, dir, ref, value: commitOid });
    await beforePush();
    const pushed = await git.push({
      fs,
      dir,
      http,
      url: info.remote,
      ref,
      remoteRef: ref,
      force: false,
      headers: { Authorization: `Bearer ${token.plaintext}` },
      onPrePush: (refs) => refs.remoteRef.oid === ZERO_OID,
    });
    if (!pushed.ok) throw new GitTagExists("The tag already exists.");
    const commit = await repo.readCommit(commitOid);
    logger.info("git:tag-created", { tag: input.name, annotated: Boolean(input.message) });
    return {
      name: input.name,
      oid: tagOid,
      commitOid,
      annotated: Boolean(input.message),
      subject: commit?.message.split("\n")[0] ?? "",
      timestamp: commit?.committedAt ?? 0,
    };
  } catch (error) {
    if (
      error instanceof git.Errors.PushRejectedError ||
      error instanceof git.Errors.UserCanceledError
    )
      throw new GitTagExists("The tag already exists.");
    throw error;
  } finally {
    await revokeWriteToken(repo, token.id, logger);
  }
}

export async function deleteRepositoryTag(
  repo: ArtifactsRepo,
  name: string,
  expectedOid: string,
  beforePush: () => Promise<void>,
  level?: string
): Promise<void> {
  const info = await repo.info();
  const logger = createLogger(level, { service: "git-tags", repoId: info.name });
  const token = await repo.createToken("write", 60);
  const fs = createFsFromVolume(new Volume());
  const dir = "/repo";
  try {
    await git.init({ fs, dir, defaultBranch: info.defaultBranch });
    await beforePush();
    const ref = TAG_PREFIX + name;
    const pushed = await git.push({
      fs,
      dir,
      http: gitHttpClient(info.remote),
      url: info.remote,
      // A commit id satisfies local ref expansion; nothing is read locally for a deletion.
      ref: expectedOid,
      remoteRef: ref,
      delete: true,
      headers: { Authorization: `Bearer ${token.plaintext}` },
      onPrePush: (refs) => refs.remoteRef.oid === expectedOid,
    });
    if (!pushed.ok) throw new GitWriteConflict("The tag changed before deletion.");
    logger.info("git:tag-deleted", { tag: name });
  } catch (error) {
    if (
      error instanceof git.Errors.PushRejectedError ||
      error instanceof git.Errors.UserCanceledError
    )
      throw new GitWriteConflict("The tag changed before deletion.");
    throw error;
  } finally {
    await revokeWriteToken(repo, token.id, logger);
  }
}
