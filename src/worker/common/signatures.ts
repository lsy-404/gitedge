import { createMessage, readKey, readSignature, verify } from "openpgp";
import {
  SSH_KEY_PROOF_NAMESPACE,
  type SigningKeyFormat,
} from "../../../packages/contracts/src/signatures";
import { parseSshPublicKey, verifySshSignature } from "./ssh-signatures";

export interface InspectedSigningKey {
  format: SigningKeyFormat;
  fingerprint: string;
  publicKey: string;
  keyIds: string[];
}

export async function verifyDetachedSignature(
  publicKey: string,
  signature: string,
  payload: Uint8Array
): Promise<boolean> {
  try {
    const key = await readKey({ armoredKey: publicKey });
    if (key.isPrivate()) return false;
    const result = await verify({
      message: await createMessage({ binary: payload }),
      signature: await readSignature({ armoredSignature: signature }),
      verificationKeys: key,
    });
    if (result.signatures.length !== 1) return false;
    await result.signatures[0].verified;
    return true;
  } catch {
    return false;
  }
}

/** Accepts an armored OpenPGP public key or one OpenSSH public key line. */
export async function inspectSigningKey(text: string): Promise<InspectedSigningKey> {
  if (!text.trim().startsWith("-----BEGIN PGP")) {
    const key = await parseSshPublicKey(text);
    return { format: "ssh", fingerprint: key.fingerprint, publicKey: key.publicKey, keyIds: [] };
  }
  const key = await readKey({ armoredKey: text });
  if (key.isPrivate()) throw new Error("Upload only a public key.");
  await key.verifyPrimaryKey();
  await key.getSigningKey();
  const keyIds = key.getKeyIDs().map((id) => id.toHex().toLowerCase());
  if (keyIds.length > 20) throw new Error("Signing keys may contain at most 20 subkeys.");
  return {
    format: "openpgp",
    fingerprint: key.getFingerprint().toLowerCase(),
    publicKey: key.armor(),
    keyIds,
  };
}

/** Checks a detached proof over `payload` made with the private half of `key`. */
export async function verifyKeyProof(
  key: InspectedSigningKey,
  signature: string,
  payload: string
): Promise<boolean> {
  const bytes = new TextEncoder().encode(payload);
  if (key.format === "openpgp") return verifyDetachedSignature(key.publicKey, signature, bytes);
  const result = await verifySshSignature(signature, bytes, SSH_KEY_PROOF_NAMESPACE);
  return result.status === "valid" && result.fingerprint === key.fingerprint;
}
