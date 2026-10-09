import { base64ToBytes, bytesToBase64 } from "./encoding";

export interface SealedText {
  ciphertext: string;
  iv: string;
}

/** Imports a base64 32-byte AES-GCM key; returns null when the value is missing or malformed. */
export async function importSealingKey(value: string | undefined): Promise<CryptoKey | null> {
  if (!value) return null;
  try {
    const bytes = base64ToBytes(value);
    if (bytes.length !== 32) return null;
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
}

export async function sealText(key: CryptoKey, text: string): Promise<SealedText> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(text)
  );
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

export async function openText(key: CryptoKey, sealed: SealedText): Promise<string> {
  const bytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(sealed.iv) },
    key,
    base64ToBytes(sealed.ciphertext)
  );
  return new TextDecoder().decode(bytes);
}
