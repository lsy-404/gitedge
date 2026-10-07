import * as git from "isomorphic-git";
import { createFsFromVolume, Volume } from "memfs";
import { z } from "zod";
import { GitBranchSchema, GitOidSchema } from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { gitHttpClient } from "./http";
import { resolveCommit } from "./read";

export const GitMergeInputSchema = z.object({
  pullRequestId: z.string().optional(),
  leaseAt: z.number().optional(),
  method: z.enum(["merge", "squash", "rebase"]).default("merge"),
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
  | {
      ok: false;
      reason:
        | "refs_changed"
        | "merge_conflict"
        | "already_merged"
        | "nonlinear_history"
        | "unsigned_commits"
        | "commit_limit";
    };

export interface GitMergePolicy {
  requireLinearHistory: boolean;
  requireSignedCommits: boolean;
  verifySignature(payload: string, signature: string | undefined): Promise<boolean>;
  beforePush(oid: string): Promise<void>;
}
export async function mergeArtifacts(
  baseRepo: ArtifactsRepo,
  headRepo: ArtifactsRepo,
  input: GitMergeInput,
  policy: GitMergePolicy,
  level?: string
): Promise<GitMergeResult> {
  const base = await resolveCommit(baseRepo, input.baseRef);
  const head = await resolveCommit(headRepo, input.headRef);
  if (head?.hash !== input.expectedHeadOid) return { ok: false, reason: "refs_changed" };
  if (base?.hash !== input.expectedBaseOid) return { ok: false, reason: "refs_changed" };
  const baseInfo = await baseRepo.info();
  const headInfo = await headRepo.info();
  const baseToken = await baseRepo.createToken("write", 300);
  const headToken = await headRepo.createToken("read", 300);
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
    await git.addRemote({ fs, dir, remote: "proposal", url: headInfo.remote });
    const fetched = await git.fetch({
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
    const localHead = fetched.fetchHead;
    if (localHead !== input.expectedHeadOid) return { ok: false, reason: "refs_changed" };
    let mergedOid: string;
    try {
      const bases = await git.findMergeBase({ fs, dir, oids: [input.expectedBaseOid, localHead] });
      if (bases.length !== 1) return { ok: false, reason: "merge_conflict" };
      const mergeBase = bases[0];
      const commits: git.ReadCommitResult[] = [];
      let cursor = localHead;
      if (input.method === "rebase" || policy.requireSignedCommits) {
        while (cursor !== mergeBase) {
          if (commits.length >= 100) return { ok: false, reason: "commit_limit" };
          const commit = await git.readCommit({ fs, dir, oid: cursor });
          if (commit.commit.parent.length !== 1) return { ok: false, reason: "nonlinear_history" };
          if (
            policy.requireSignedCommits &&
            !(await policy.verifySignature(commit.payload, commit.commit.gpgsig))
          )
            return { ok: false, reason: "unsigned_commits" };
          commits.push(commit);
          cursor = commit.commit.parent[0];
        }
      }
      if (
        policy.requireSignedCommits &&
        (input.method !== "merge" || mergeBase !== input.expectedBaseOid)
      )
        return { ok: false, reason: "unsigned_commits" };
      if (input.method === "rebase") {
        mergedOid = input.expectedBaseOid;
        for (const commit of commits.reverse()) {
          mergedOid = await git.cherryPick({
            fs,
            dir,
            oid: commit.oid,
            committer: input.author,
            noUpdateBranch: true,
            abortOnConflict: true,
          });
          await git.writeRef({
            fs,
            dir,
            ref: `refs/heads/${input.baseRef}`,
            value: mergedOid,
            force: true,
          });
        }
      } else {
        const result = await git.merge({
          fs,
          dir,
          ours: input.baseRef,
          theirs: localHead,
          abortOnConflict: true,
          noUpdateBranch: true,
          fastForwardOnly:
            policy.requireSignedCommits ||
            (input.method === "merge" && policy.requireLinearHistory),
          message: input.message,
          author: input.author,
          committer: input.author,
        });
        if (!result.oid) return { ok: false, reason: "already_merged" };
        if (result.alreadyMerged) return { ok: true, oid: result.oid };
        mergedOid = result.oid;
        if (input.method === "squash") {
          const resultCommit = await git.readCommit({ fs, dir, oid: mergedOid });
          mergedOid = await git.commit({
            fs,
            dir,
            tree: resultCommit.commit.tree,
            parent: [input.expectedBaseOid],
            message: input.message,
            author: input.author,
            committer: input.author,
            noUpdateBranch: true,
          });
        }
        await git.writeRef({
          fs,
          dir,
          ref: `refs/heads/${input.baseRef}`,
          value: mergedOid,
          force: true,
        });
      }
    } catch (error) {
      if (error instanceof git.Errors.MergeConflictError)
        return { ok: false, reason: "merge_conflict" };
      if (error instanceof git.Errors.FastForwardError)
        return { ok: false, reason: "nonlinear_history" };
      throw error;
    }
    const latestHead = await resolveCommit(headRepo, input.headRef);
    if (latestHead?.hash !== input.expectedHeadOid) return { ok: false, reason: "refs_changed" };
    await policy.beforePush(mergedOid);
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
    return { ok: true, oid: mergedOid };
  } finally {
    const logger = createLogger(level, { service: "git-merge", repoId: baseInfo.name });
    const revoked = await Promise.allSettled([
      baseRepo.revokeToken(baseToken.id),
      headRepo.revokeToken(headToken.id),
    ]);
    for (const [index, result] of revoked.entries())
      if (result.status === "rejected")
        logger.warn("artifacts:merge-token-revoke-failed", { side: index === 0 ? "base" : "head" });
  }
}
