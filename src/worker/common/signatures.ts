import { createMessage, readKey, readSignature, verify } from "openpgp";

export async function verifyDetachedSignature(
  publicKey: string,
  signature: string,
  payload: string
): Promise<boolean> {
  try {
    const key = await readKey({ armoredKey: publicKey });
    if (key.isPrivate()) return false;
    const result = await verify({
      message: await createMessage({ binary: new TextEncoder().encode(payload) }),
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

export async function inspectSigningKey(armoredKey: string) {
  const key = await readKey({ armoredKey });
  if (key.isPrivate()) throw new Error("Upload only a public key.");
  await key.verifyPrimaryKey();
  await key.getSigningKey();
  const keyIds = key.getKeyIDs().map((id) => id.toHex().toLowerCase());
  if (keyIds.length > 20) throw new Error("Signing keys may contain at most 20 subkeys.");
  return {
    fingerprint: key.getFingerprint().toLowerCase(),
    publicKey: key.armor(),
    keyIds,
  };
}
