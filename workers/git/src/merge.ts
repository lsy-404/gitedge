import * as git from "isomorphic-git";
import { createFsFromVolume, Volume } from "memfs";
import { z } from "zod";
import { GitBranchSchema, GitOidSchema } from "../../../packages/contracts/src/index";
import { gitHttpClient } from "./http";
import { resolveCommit } from "./read";

export const GitMergeInputSchema = z.object({
  baseRef: GitBranchSchema,
  headRef: GitBranchSchema,
  headSessionId: z.string().nullable().optional(),
  expectedBaseOid: GitOidSchema,
  expectedHeadOid: GitOidSchema,
  author: z.object({ name: z.string().min(1).max(100), email: z.string().min(1).max(200) }),
  message: z.string().min(1).max(50_000),
});
export type GitMergeInput = z.infer<typeof GitMergeInputSchema>;
export type GitMergeResult =
  | { ok: true; oid: string }
  | { ok: false; reason: "refs_changed" | "merge_conflict" | "already_merged" };

export async function mergeArtifacts(
  baseRepo: ArtifactsRepo,
  headRepo: ArtifactsRepo,
  input: GitMergeInput
): Promise<GitMergeResult> {
  const base = await resolveCommit(baseRepo, input.baseRef);
  const head = await resolveCommit(headRepo, input.headRef);
  if (base?.hash !== input.expectedBaseOid || head?.hash !== input.expectedHeadOid)
    return { ok: false, reason: "refs_changed" };
  const baseInfo = await baseRepo.info();
  const headInfo = await headRepo.info();
  const baseToken = await baseRepo.createToken("write", 60);
  const headToken = await headRepo.createToken("read", 60);
  const fs = createFsFromVolume(new Volume());
  const dir = "/repo";
  try {
    const http = gitHttpClient(baseInfo.remote);
    await git.clone({
      fs,
      http,
      dir,
      url: baseInfo.remote,
      ref: input.baseRef,
      singleBranch: true,
      noCheckout: true,
      noTags: true,
      headers: { Authorization: `Bearer ${baseToken.plaintext}` },
    });
    const localBase = await git.resolveRef({ fs, dir, ref: input.baseRef });
    if (localBase !== input.expectedBaseOid) return { ok: false, reason: "refs_changed" };
    await git.fetch({
      fs,
      http: gitHttpClient(headInfo.remote),
      dir,
      url: headInfo.remote,
      remote: "proposal",
      ref: input.headRef,
      singleBranch: true,
      tags: false,
      headers: { Authorization: `Bearer ${headToken.plaintext}` },
    });
    const localHead = await git.resolveRef({
      fs,
      dir,
      ref: `refs/remotes/proposal/${input.headRef}`,
    });
    if (localHead !== input.expectedHeadOid) return { ok: false, reason: "refs_changed" };
    let result: git.MergeResult;
    try {
      result = await git.merge({
        fs,
        dir,
        ours: input.baseRef,
        theirs: `refs/remotes/proposal/${input.headRef}`,
        abortOnConflict: true,
        message: input.message,
        author: input.author,
        committer: input.author,
      });
    } catch (error) {
      if (error instanceof git.Errors.MergeConflictError)
        return { ok: false, reason: "merge_conflict" };
      throw error;
    }
    if (!result.oid || result.alreadyMerged) return { ok: false, reason: "already_merged" };
    const latestHead = await resolveCommit(headRepo, input.headRef);
    if (latestHead?.hash !== input.expectedHeadOid) return { ok: false, reason: "refs_changed" };
    try {
      // The receive-pack server atomically compares the advertised old OID before updating the ref.
      const pushed = await git.push({
        fs,
        http,
        dir,
        url: baseInfo.remote,
        ref: input.baseRef,
        remoteRef: input.baseRef,
        force: false,
        headers: { Authorization: `Bearer ${baseToken.plaintext}` },
        onPrePush: (refs) => refs.remoteRef.oid === input.expectedBaseOid,
      });
      if (!pushed.ok) return { ok: false, reason: "refs_changed" };
    } catch (error) {
      if (
        error instanceof git.Errors.PushRejectedError ||
        error instanceof git.Errors.UserCanceledError
      )
        return { ok: false, reason: "refs_changed" };
      throw error;
    }
    return { ok: true, oid: result.oid };
  } finally {
    await Promise.allSettled([
      baseRepo.revokeToken(baseToken.id),
      headRepo.revokeToken(headToken.id),
    ]);
  }
}
