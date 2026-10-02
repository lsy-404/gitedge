import { z } from "zod";

export const SigningKeyChallengeInputSchema = z.object({
  title: z.string().trim().min(1).max(80),
  publicKey: z.string().min(100).max(32_768),
});
export const AddSigningKeyInputSchema = z.object({
  challengeId: z.string().uuid(),
  signature: z.string().min(50).max(16_384),
});
export interface SigningKey {
  id: string;
  title: string;
  fingerprint: string;
  keyIds: string[];
  publicKey: string;
  createdAt: number;
  revokedAt: number | null;
}
export interface SigningKeyChallenge {
  id: string;
  fingerprint: string;
  payload: string;
  expiresAt: number;
}
export interface CommitSignature {
  status: "unsigned" | "valid" | "invalid" | "unknown_key" | "revoked_key" | "unsupported";
  format: "openpgp" | "ssh" | "x509" | null;
  fingerprint: string | null;
  signer: { id: string; identifier: string } | null;
  verifiedAt: number;
}
