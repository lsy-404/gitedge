import * as git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import { readSignature } from "openpgp";
import type { GitSignature } from "../../../packages/contracts/src/signatures";
import { verifyDetachedSignature } from "../../../src/worker/common/signatures";
import { verifySshSignature } from "../../../src/worker/common/ssh-signatures";
import { createLogger } from "../../../src/worker/common/logger";
import { gitHttpClient } from "./http";

export type SignedObjectKind = "commit" | "tag";

interface RegisteredKey {
  id: string;
  fingerprint: string;
  publicKey: string;
  revokedAt: number | null;
  userId: string;
  identifier: string;
}

export interface SignedGitObject {
  /** The exact bytes Git signs: the object without its signature. */
  payload: Uint8Array;
  signature: string | null;
  /** Committer email for commits, tagger email for tags. */
  email: string | null;
}

const NEWLINE = 0x0a;
const SIGNATURE_HEADERS = ["gpgsig ", "gpgsig-sha256 "];
const SIGNATURE_MARKERS = [
  "-----BEGIN PGP SIGNATURE-----",
  "-----BEGIN PGP MESSAGE-----",
  "-----BEGIN SIGNED MESSAGE-----",
  "-----BEGIN SSH SIGNATURE-----",
];

function lines(raw: Uint8Array): Uint8Array[] {
  const result: Uint8Array[] = [];
  let start = 0;
  while (start < raw.length) {
    const end = raw.indexOf(NEWLINE, start);
    const next = end === -1 ? raw.length : end + 1;
    result.push(raw.subarray(start, next));
    start = next;
  }
  return result;
}

function startsWith(line: Uint8Array, prefix: string): boolean {
  if (line.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1)
    if (line[index] !== prefix.charCodeAt(index)) return false;
  return true;
}

function joined(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const decoder = new TextDecoder();

function identityEmail(line: Uint8Array, header: string): string | null {
  const match = /<([^<>]*)>[^<>]*$/.exec(decoder.decode(line.subarray(header.length)));
  return match ? match[1].trim() || null : null;
}

/** Separates the signature from a raw commit or tag object the way Git does before verifying. */
export function splitSignedObject(kind: SignedObjectKind, raw: Uint8Array): SignedGitObject {
  const all = lines(raw);
  const headerEnd = all.findIndex((line) => line.length === 1 && line[0] === NEWLINE);
  const headers = headerEnd === -1 ? all : all.slice(0, headerEnd);
  const identity = kind === "commit" ? "committer " : "tagger ";
  const identityLine = headers.find((line) => startsWith(line, identity));
  const email = identityLine ? identityEmail(identityLine, identity) : null;
  if (kind === "tag") {
    let start = -1;
    for (let index = headerEnd + 1; headerEnd !== -1 && index < all.length; index += 1)
      if (SIGNATURE_MARKERS.some((marker) => startsWith(all[index], marker))) start = index;
    if (start === -1) return { payload: raw, signature: null, email };
    return {
      payload: joined(all.slice(0, start)),
      signature: decoder.decode(joined(all.slice(start))),
      email,
    };
  }
  const payload: Uint8Array[] = [];
  const signature: string[] = [];
  let inSignature = false;
  let collecting = false;
  for (const [index, line] of all.entries()) {
    if (headerEnd === -1 || index < headerEnd) {
      if (inSignature && line[0] === 0x20) {
        if (collecting) signature.push(decoder.decode(line.subarray(1)));
        continue;
      }
      const header = SIGNATURE_HEADERS.find((name) => startsWith(line, name));
      inSignature = header !== undefined;
      collecting = header === SIGNATURE_HEADERS[0];
      if (header) {
        if (collecting) signature.push(decoder.decode(line.subarray(header.length)));
        continue;
      }
    }
    payload.push(line);
  }
  return {
    payload: joined(payload),
    signature: signature.length ? signature.join("") : null,
    email,
  };
}

async function attribute(
  db: D1Database,
  result: GitSignature,
  key: RegisteredKey,
  email: string | null
): Promise<GitSignature> {
  const attributed: GitSignature = {
    ...result,
    fingerprint: key.fingerprint,
    signer: { id: key.userId, identifier: key.identifier },
  };
  if (key.revokedAt !== null) return { ...attributed, status: "revoked_key" };
  const owner = email
    ? await db
        .prepare(
          "SELECT user_id AS userId FROM auth_emails WHERE email = ? AND verified_at IS NOT NULL LIMIT 1"
        )
        .bind(email)
        .first<{ userId: string }>()
    : null;
  return {
    ...attributed,
    status: owner && owner.userId !== key.userId ? "email_mismatch" : "valid",
  };
}

async function verifySsh(
  db: D1Database,
  result: GitSignature,
  signed: SignedGitObject & { signature: string }
): Promise<GitSignature> {
  const check = await verifySshSignature(signed.signature, signed.payload, "git");
  if (check.status !== "valid")
    return { ...result, status: check.status, fingerprint: check.fingerprint };
  const key = await db
    .prepare(
      "SELECT k.id,k.fingerprint,k.public_key AS publicKey,k.revoked_at AS revokedAt,k.user_id AS userId,u.identifier FROM auth_signing_keys k JOIN users u ON u.id = k.user_id WHERE k.fingerprint = ? AND k.format = 'ssh'"
    )
    .bind(check.fingerprint)
    .first<RegisteredKey>();
  if (!key) return { ...result, status: "unknown_key", fingerprint: check.fingerprint };
  return attribute(db, result, key, signed.email);
}

async function verifyOpenPgp(
  db: D1Database,
  result: GitSignature,
  signed: SignedGitObject & { signature: string }
): Promise<GitSignature> {
  let keyIds: string[];
  try {
    keyIds = (await readSignature({ armoredSignature: signed.signature }))
      .getSigningKeyIDs()
      .map((id) => id.toHex().toLowerCase());
  } catch {
    return { ...result, status: "invalid" };
  }
  if (keyIds.length !== 1) return { ...result, status: "invalid" };
  const rows = await db
    .prepare(
      "SELECT k.id,k.fingerprint,k.public_key AS publicKey,k.revoked_at AS revokedAt,k.user_id AS userId,u.identifier FROM auth_signing_key_ids i JOIN auth_signing_keys k ON k.id = i.signing_key_id JOIN users u ON u.id = k.user_id WHERE i.key_id = ? AND k.format = 'openpgp' LIMIT 6"
    )
    .bind(keyIds[0])
    .all<RegisteredKey>();
  if (!rows.results.length) return { ...result, status: "unknown_key" };
  if (rows.results.length > 5) return { ...result, status: "invalid" };
  for (const key of rows.results)
    if (await verifyDetachedSignature(key.publicKey, signed.signature, signed.payload))
      return attribute(db, result, key, signed.email);
  return { ...result, status: "invalid" };
}

/** Verifies the signature embedded in a raw commit or annotated tag object. */
export async function verifyObjectSignature(
  db: D1Database,
  kind: SignedObjectKind,
  raw: Uint8Array
): Promise<GitSignature> {
  const result: GitSignature = {
    status: "unsigned",
    format: null,
    fingerprint: null,
    signer: null,
    verifiedAt: Date.now(),
  };
  const signed = splitSignedObject(kind, raw);
  const signature = signed.signature;
  if (signature === null) return result;
  if (signature.trimStart().startsWith("-----BEGIN SSH SIGNATURE-----"))
    return verifySsh(db, { ...result, format: "ssh" }, { ...signed, signature });
  if (signature.trimStart().startsWith("-----BEGIN PGP SIGNATURE-----"))
    return verifyOpenPgp(db, { ...result, format: "openpgp" }, { ...signed, signature });
  return { ...result, status: "unsupported", format: "x509" };
}

/** Fetches one commit or tag object (depth 1, size-capped) and verifies its signature. */
export async function readObjectSignature(
  repo: ArtifactsRepo,
  db: D1Database,
  kind: SignedObjectKind,
  oid: string,
  level?: string
): Promise<GitSignature> {
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
    const object = await git.readObject({ fs, dir: "/signature", oid, format: "content" });
    if (object.type !== kind || !(object.object instanceof Uint8Array))
      throw new Error(`Object ${oid} is not a ${kind}.`);
    const result = await verifyObjectSignature(db, kind, object.object);
    logger.info("signature:verified", { kind, oid, status: result.status, format: result.format });
    return result;
  } finally {
    try {
      await repo.revokeToken(token.id);
    } catch {
      logger.warn("signature:read-token-revoke-failed", { oid });
    }
  }
}
