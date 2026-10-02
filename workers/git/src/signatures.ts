import * as git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import { readSignature } from "openpgp";
import type { CommitSignature } from "../../../packages/contracts/src/signatures";
import { verifyDetachedSignature } from "../../../src/worker/common/signatures";
import { createLogger } from "../../../src/worker/common/logger";
import { gitHttpClient } from "./http";

interface RegisteredKey {
  id: string;
  fingerprint: string;
  publicKey: string;
  revokedAt: number | null;
  userId: string;
  identifier: string;
}
export async function verifyCommitSignature(
  db: D1Database,
  payload: string,
  signature: string | undefined
): Promise<CommitSignature> {
  const result: CommitSignature = {
    status: "unsigned",
    format: null,
    fingerprint: null,
    signer: null,
    verifiedAt: Date.now(),
  };
  if (!signature) return result;
  if (signature.includes("BEGIN SSH SIGNATURE"))
    return { ...result, status: "unsupported", format: "ssh" };
  if (!signature.includes("BEGIN PGP SIGNATURE"))
    return { ...result, status: "unsupported", format: "x509" };
  result.format = "openpgp";
  let keyIds: string[];
  try {
    keyIds = (await readSignature({ armoredSignature: signature }))
      .getSigningKeyIDs()
      .map((id) => id.toHex().toLowerCase());
  } catch {
    return { ...result, status: "invalid" };
  }
  if (keyIds.length !== 1) return { ...result, status: "invalid" };
  const rows = await db
    .prepare(
      "SELECT k.id,k.fingerprint,k.public_key AS publicKey,k.revoked_at AS revokedAt,k.user_id AS userId,u.identifier FROM auth_signing_key_ids i JOIN auth_signing_keys k ON k.id = i.signing_key_id JOIN users u ON u.id = k.user_id WHERE i.key_id = ? LIMIT 6"
    )
    .bind(keyIds[0])
    .all<RegisteredKey>();
  if (!rows.results.length) return { ...result, status: "unknown_key" };
  if (rows.results.length > 5) return { ...result, status: "invalid" };
  for (const key of rows.results) {
    if (await verifyDetachedSignature(key.publicKey, signature, payload))
      return {
        ...result,
        status: key.revokedAt === null ? "valid" : "revoked_key",
        fingerprint: key.fingerprint,
        signer: { id: key.userId, identifier: key.identifier },
      };
  }
  return { ...result, status: "invalid" };
}

export async function readCommitSignature(
  repo: ArtifactsRepo,
  db: D1Database,
  oid: string,
  level?: string
): Promise<CommitSignature> {
  const info = await repo.info();
  const token = await repo.createToken("read", 60);
  const fs = createFsFromVolume(new Volume());
  const logger = createLogger(level, { service: "git-signature", repoId: info.id });
  try {
    await git.init({ fs, dir: "/signature", defaultBranch: "main" });
    await git.addRemote({ fs, dir: "/signature", remote: "origin", url: info.remote });
    await git.fetch({
      fs,
      dir: "/signature",
      http: gitHttpClient(info.remote, 12 * 1024 * 1024),
      url: info.remote,
      ref: oid,
      depth: 1,
      singleBranch: true,
      tags: false,
      headers: { Authorization: `Bearer ${token.plaintext}` },
    });
    const { commit, payload } = await git.readCommit({ fs, dir: "/signature", oid });
    const result = await verifyCommitSignature(db, payload, commit.gpgsig);
    logger.info("signature:verified", { oid, status: result.status });
    return result;
  } finally {
    try {
      await repo.revokeToken(token.id);
    } catch {
      logger.warn("signature:read-token-revoke-failed", { oid });
    }
  }
}
