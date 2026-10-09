/** Minimal SSHSIG signer for tests that need fresh proofs over dynamic challenges. */
const encoder = new TextEncoder();

function sshString(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export interface TestSshKey {
  publicKey: string;
  sign(message: string | Uint8Array, namespace: string): Promise<string>;
}

export async function generateSshKey(): Promise<TestSshKey> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("Expected an Ed25519 key pair.");
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const blob = concat(sshString("ssh-ed25519"), sshString(raw));
  return {
    publicKey: `ssh-ed25519 ${base64(blob)} test-key`,
    async sign(message, namespace) {
      const bytes = typeof message === "string" ? encoder.encode(message) : message;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", concat(bytes)));
      const magic = encoder.encode("SSHSIG");
      const signed = concat(
        magic,
        sshString(namespace),
        sshString(""),
        sshString("sha512"),
        sshString(digest)
      );
      const value = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, signed));
      const envelope = concat(
        magic,
        new Uint8Array([0, 0, 0, 1]),
        sshString(blob),
        sshString(namespace),
        sshString(""),
        sshString("sha512"),
        sshString(concat(sshString("ssh-ed25519"), sshString(value)))
      );
      const lines = base64(envelope).match(/.{1,70}/g) ?? [];
      return ["-----BEGIN SSH SIGNATURE-----", ...lines, "-----END SSH SIGNATURE-----", ""].join(
        "\n"
      );
    },
  };
}

/** Inserts a `gpgsig` header into an unsigned commit payload, as `git commit -S` does. */
export function signedCommitObject(payload: string, signature: string): Uint8Array {
  const split = payload.indexOf("\n\n");
  const header = "gpgsig " + signature.replace(/\n$/, "").split("\n").join("\n ") + "\n";
  return encoder.encode(payload.slice(0, split + 1) + header + payload.slice(split + 1));
}
