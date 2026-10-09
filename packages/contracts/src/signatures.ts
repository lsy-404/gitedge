import { z } from "zod";

/** `ssh-keygen -Y sign -n` namespace for key ownership proofs; Git signatures use `git`. */
export const SSH_KEY_PROOF_NAMESPACE = "gitedge";

export type SigningKeyFormat = "openpgp" | "ssh";

export const SigningKeyChallengeInputSchema = z.object({
  title: z.string().trim().min(1).max(80),
  publicKey: z.string().trim().min(64).max(32_768),
});
export const AddSigningKeyInputSchema = z.object({
  challengeId: z.string().uuid(),
  signature: z.string().min(50).max(16_384),
});
export interface SigningKey {
  id: string;
  title: string;
  format: SigningKeyFormat;
  /** Lowercase hex for OpenPGP; `SHA256:<base64>` for SSH. */
  fingerprint: string;
  /** OpenPGP key and subkey IDs; empty for SSH keys. */
  keyIds: string[];
  publicKey: string;
  createdAt: number;
  revokedAt: number | null;
}
export interface SigningKeyChallenge {
  id: string;
  format: SigningKeyFormat;
  fingerprint: string;
  payload: string;
  expiresAt: number;
}
/** Verification result for a commit or annotated tag signature. */
export interface GitSignature {
  /**
   * `valid` means a registered, unrevoked key made the signature. `email_mismatch` means the
   * signature is cryptographically valid but the committer or tagger email is verified by a
   * different account than the key owner.
   */
  status:
    | "unsigned"
    | "valid"
    | "invalid"
    | "unknown_key"
    | "revoked_key"
    | "email_mismatch"
    | "unsupported";
  format: "openpgp" | "ssh" | "x509" | null;
  fingerprint: string | null;
  signer: { id: string; identifier: string } | null;
  verifiedAt: number;
}
