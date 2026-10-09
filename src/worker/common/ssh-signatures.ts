import { base64ToBytes, bytesToBase64, bytesToBase64Url } from "./encoding";

/**
 * SSH public keys and SSHSIG signatures (OpenSSH PROTOCOL.sshsig), verified with WebCrypto.
 * Supported keys: ssh-ed25519, ecdsa-sha2-nistp256 and ssh-rsa (2048-8192 bits, rsa-sha2-256/512).
 */
export class SshFormatError extends Error {}

export interface SshPublicKey {
  type: SshKeyType;
  /** `SHA256:` followed by unpadded base64, as printed by `ssh-keygen -l`. */
  fingerprint: string;
  /** `<type> <base64 blob>` without the comment. */
  publicKey: string;
}

export type SshSignatureCheck =
  | { status: "valid"; fingerprint: string }
  | { status: "invalid" | "unsupported"; fingerprint: string | null };

type SshKeyType = "ssh-ed25519" | "ecdsa-sha2-nistp256" | "ssh-rsa";

const MAGIC = new TextEncoder().encode("SSHSIG");
const ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_END = "-----END SSH SIGNATURE-----";
const MAX_SIGNATURE_BYTES = 8192;
const RSA_MIN_BITS = 2048;
const RSA_MAX_BITS = 8192;
const signatureHashes: Readonly<Record<string, "SHA-256" | "SHA-512">> = {
  sha256: "SHA-256",
  sha512: "SHA-512",
};

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  uint32(): number {
    if (this.offset + 4 > this.bytes.length) throw new SshFormatError("Truncated SSH data.");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4);
    this.offset += 4;
    return view.getUint32(0);
  }
  bytesField(): Uint8Array {
    const length = this.uint32();
    if (this.offset + length > this.bytes.length) throw new SshFormatError("Truncated SSH data.");
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  text(): string {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.bytesField());
  }
  raw(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) throw new SshFormatError("Truncated SSH data.");
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  end(): void {
    if (this.offset !== this.bytes.length) throw new SshFormatError("Unexpected trailing data.");
  }
}

function sshString(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Strips the sign byte of a positive SSH mpint and left-pads it to `size` bytes. */
function unsignedInteger(value: Uint8Array, size?: number): Uint8Array {
  if (value.length && value[0] & 0x80) throw new SshFormatError("Negative SSH integer.");
  let start = 0;
  while (start < value.length && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  if (size === undefined) return trimmed;
  if (trimmed.length > size) throw new SshFormatError("SSH integer is too large.");
  const out = new Uint8Array(size);
  out.set(trimmed, size - trimmed.length);
  return out;
}

function isKeyType(value: string): value is SshKeyType {
  return value === "ssh-ed25519" || value === "ecdsa-sha2-nistp256" || value === "ssh-rsa";
}

interface DecodedKey {
  type: SshKeyType;
  blob: Uint8Array;
  ed25519?: Uint8Array;
  point?: Uint8Array;
  rsa?: { n: Uint8Array; e: Uint8Array };
}

/** Decodes a public key blob; returns null for well-formed keys of unsupported types. */
function decodeKeyBlob(blob: Uint8Array): DecodedKey | null {
  const reader = new Reader(blob);
  const type = reader.text();
  if (!isKeyType(type)) return null;
  if (type === "ssh-ed25519") {
    const key = reader.bytesField();
    reader.end();
    if (key.length !== 32) throw new SshFormatError("Invalid Ed25519 key.");
    return { type, blob, ed25519: key };
  }
  if (type === "ecdsa-sha2-nistp256") {
    if (reader.text() !== "nistp256") throw new SshFormatError("Mismatched ECDSA curve.");
    const point = reader.bytesField();
    reader.end();
    if (point.length !== 65 || point[0] !== 4) throw new SshFormatError("Invalid ECDSA point.");
    return { type, blob, point };
  }
  const e = unsignedInteger(reader.bytesField());
  const n = unsignedInteger(reader.bytesField());
  reader.end();
  const bits = n.length * 8 - Math.clz32(n[0] ?? 0) + 24;
  if (bits < RSA_MIN_BITS || bits > RSA_MAX_BITS || !e.length)
    throw new SshFormatError("RSA keys must have 2048 to 8192 bits.");
  return { type, blob, rsa: { n, e } };
}

async function fingerprintOf(blob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", concat([blob])));
  return "SHA256:" + bytesToBase64(digest).replace(/=+$/, "");
}

/** Parses one OpenSSH public key line (`type base64 [comment]`). */
export async function parseSshPublicKey(text: string): Promise<SshPublicKey> {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== 1) throw new SshFormatError("Paste exactly one SSH public key.");
  const [type = "", encoded = ""] = lines[0].trim().split(/\s+/);
  let blob: Uint8Array;
  try {
    blob = base64ToBytes(encoded);
  } catch {
    throw new SshFormatError("Invalid SSH public key encoding.");
  }
  const key = decodeKeyBlob(blob);
  if (!key || key.type !== type) throw new SshFormatError("Unsupported SSH public key type.");
  return {
    type: key.type,
    fingerprint: await fingerprintOf(blob),
    publicKey: `${type} ${encoded}`,
  };
}

function unarmor(armored: string): Uint8Array {
  const text = armored.trim();
  if (!text.startsWith(ARMOR_BEGIN) || !text.endsWith(ARMOR_END) || text.length > 4 * 8192)
    throw new SshFormatError("Invalid SSH signature armor.");
  const body = text.slice(ARMOR_BEGIN.length, -ARMOR_END.length).replace(/\s+/g, "");
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(body);
  } catch {
    throw new SshFormatError("Invalid SSH signature encoding.");
  }
  if (bytes.length > MAX_SIGNATURE_BYTES) throw new SshFormatError("SSH signature is too large.");
  return bytes;
}

async function verifyWithKey(
  key: DecodedKey,
  algorithm: string,
  signature: Uint8Array,
  data: Uint8Array<ArrayBuffer>
): Promise<boolean> {
  if (key.ed25519) {
    if (algorithm !== "ssh-ed25519" || signature.length !== 64) return false;
    const imported = await crypto.subtle.importKey(
      "raw",
      concat([key.ed25519]),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify({ name: "Ed25519" }, imported, concat([signature]), data);
  }
  if (key.point) {
    if (algorithm !== "ecdsa-sha2-nistp256") return false;
    const parts = new Reader(signature);
    const r = unsignedInteger(parts.bytesField(), 32);
    const s = unsignedInteger(parts.bytesField(), 32);
    parts.end();
    const imported = await crypto.subtle.importKey(
      "raw",
      concat([key.point]),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, imported, concat([r, s]), data);
  }
  if (key.rsa) {
    const hash =
      algorithm === "rsa-sha2-256" ? "SHA-256" : algorithm === "rsa-sha2-512" ? "SHA-512" : null;
    if (!hash) return false;
    const imported = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: bytesToBase64Url(key.rsa.n), e: bytesToBase64Url(key.rsa.e), ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash },
      false,
      ["verify"]
    );
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", imported, concat([signature]), data);
  }
  return false;
}

/**
 * Verifies an armored SSHSIG signature over `message` within `namespace` using the public key
 * embedded in the signature. Callers decide whether that key, identified by its fingerprint, is
 * trusted.
 */
export async function verifySshSignature(
  armored: string,
  message: Uint8Array,
  namespace: string
): Promise<SshSignatureCheck> {
  let fingerprint: string | null = null;
  try {
    const reader = new Reader(unarmor(armored));
    const magic = reader.raw(MAGIC.length);
    if (!magic.every((byte, index) => byte === MAGIC[index]) || reader.uint32() !== 1)
      return { status: "invalid", fingerprint };
    const keyBlob = reader.bytesField();
    const signedNamespace = reader.text();
    const reserved = reader.bytesField();
    const hashName = reader.text();
    const signatureBlob = reader.bytesField();
    reader.end();
    const key = decodeKeyBlob(keyBlob);
    if (!key) return { status: "unsupported", fingerprint };
    fingerprint = await fingerprintOf(keyBlob);
    const hash = signatureHashes[hashName];
    if (!hash || signedNamespace !== namespace) return { status: "invalid", fingerprint };
    const signature = new Reader(signatureBlob);
    const algorithm = signature.text();
    const value = signature.bytesField();
    signature.end();
    const digest = new Uint8Array(await crypto.subtle.digest(hash, concat([message])));
    const data = concat([
      MAGIC,
      sshString(signedNamespace),
      sshString(reserved),
      sshString(hashName),
      sshString(digest),
    ]);
    return (await verifyWithKey(key, algorithm, value, data))
      ? { status: "valid", fingerprint }
      : { status: "invalid", fingerprint };
  } catch {
    return { status: "invalid", fingerprint };
  }
}
