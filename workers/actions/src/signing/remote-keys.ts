import forge from "node-forge";
import type {
  SigningMachineContext,
  SigningPlatform,
  SigningProfile,
} from "../../../../packages/contracts/src/signing";
import { bytesToBase64 } from "../../../../src/worker/common/encoding";
import { storedCredentialRow } from "./services";
import type { SigningEnv } from "./types";

export type RemoteKeyType = "rsa" | "ec-p256" | "ec-p384";
export type RemoteHash = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

export interface RemoteSigningKey {
  /** Non-extractable signing key; for RSA it is bound to SHA-256, see `keys`. */
  key: CryptoKey;
  /** RSA keys are hash-bound in WebCrypto, so one import per supported hash. */
  keys: Readonly<Record<RemoteHash, CryptoKey>>;
  /** DER certificates, leaf first. */
  chain: Uint8Array[];
  keyType: RemoteKeyType;
}

export const REMOTE_OPERATION_CAP = 4096;
const hashes: readonly RemoteHash[] = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"];
const cache = new Map<string, Promise<RemoteSigningKey | null>>();
const MAX_CACHE = 16;

const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const CURVES: Record<string, { keyType: RemoteKeyType; namedCurve: string }> = {
  "1.2.840.10045.3.1.7": { keyType: "ec-p256", namedCurve: "P-256" },
  "1.3.132.0.34": { keyType: "ec-p384", namedCurve: "P-384" },
};

const toBytes = (binary: string) => Uint8Array.from(binary, (c) => c.charCodeAt(0));
const toBinary = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
};
const standard = <T extends Uint8Array>(bytes: T) => new Uint8Array(bytes);

interface PkcsBag {
  key?: forge.pki.rsa.PrivateKey | null;
  asn1?: forge.asn1.Asn1;
  cert?: forge.pki.Certificate;
  attributes?: { localKeyId?: string[]; friendlyName?: string[] };
}

function bagsOf(p12: forge.pkcs12.Pkcs12Pfx, ...types: string[]): PkcsBag[] {
  return types.flatMap((type) => (p12.getBags({ bagType: type })[type] as PkcsBag[]) ?? []);
}

function parsePkcs12(base64: string, passwords: string[], alias?: string) {
  const der = atob(base64);
  let p12: forge.pkcs12.Pkcs12Pfx | null = null;
  for (const password of passwords) {
    try {
      p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), password);
      break;
    } catch {
      p12 = null;
    }
  }
  if (!p12) throw new Error("signing_credentials_invalid");
  const keyBags = bagsOf(p12, forge.pki.oids.pkcs8ShroudedKeyBag, forge.pki.oids.keyBag);
  const certBags = bagsOf(p12, forge.pki.oids.certBag).filter((bag) => bag.cert || bag.asn1);
  const keyBag =
    (alias
      ? keyBags.find(
          (bag) => bag.attributes?.friendlyName?.[0]?.toLowerCase() === alias.toLowerCase()
        )
      : undefined) ?? (keyBags.length === 1 ? keyBags[0] : undefined);
  if (!keyBag) throw new Error("signing_credentials_invalid");

  let pkcs8: Uint8Array;
  if (keyBag.key) {
    pkcs8 = toBytes(
      forge.asn1
        .toDer(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keyBag.key)))
        .getBytes()
    );
  } else if (keyBag.asn1) {
    pkcs8 = toBytes(forge.asn1.toDer(keyBag.asn1).getBytes());
  } else throw new Error("signing_credentials_invalid");

  const keyId = keyBag.attributes?.localKeyId?.[0];
  // forge only models RSA certificates, so names are read from the ASN.1 of every certificate.
  const certs = certBags.map((bag) => {
    const asn1 = bag.cert ? forge.pki.certificateToAsn1(bag.cert) : bag.asn1!;
    const tbs = (asn1.value as forge.asn1.Asn1[])[0]!;
    const fields = tbs.value as forge.asn1.Asn1[];
    const offset = fields[0]!.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
    const name = (index: number) => forge.asn1.toDer(fields[offset + index]!).getBytes();
    return {
      der: forge.asn1.toDer(asn1).getBytes(),
      issuer: name(2),
      subject: name(4),
      localKeyId: bag.attributes?.localKeyId?.[0],
    };
  });
  let leaf = certs.find((cert) => keyId && cert.localKeyId === keyId);
  if (!leaf) {
    // Without a local key id the leaf is the only certificate that issues no other certificate.
    const candidates = certs.filter(
      (cert) => !certs.some((other) => other !== cert && other.issuer === cert.subject)
    );
    leaf = candidates.length === 1 ? candidates[0] : undefined;
  }
  if (!leaf) throw new Error("signing_credentials_invalid");
  const chain = [leaf];
  for (;;) {
    const tail = chain[chain.length - 1]!;
    if (tail.issuer === tail.subject) break;
    const issuer = certs.find((cert) => !chain.includes(cert) && cert.subject === tail.issuer);
    if (!issuer) break;
    chain.push(issuer);
  }
  return { pkcs8, chain: chain.map((cert) => toBytes(cert.der)) };
}

function keyAlgorithm(pkcs8: Uint8Array): { keyType: RemoteKeyType; namedCurve?: string } {
  const info = forge.asn1.fromDer(forge.util.createBuffer(toBinary(pkcs8)));
  const algorithm = (info.value as forge.asn1.Asn1[])[1];
  const parts = (algorithm?.value ?? []) as forge.asn1.Asn1[];
  const oid = parts[0] ? forge.asn1.derToOid(parts[0].value as string) : "";
  if (oid === forge.pki.oids.rsaEncryption) return { keyType: "rsa" };
  if (oid === OID_EC_PUBLIC_KEY && parts[1]) {
    const curve = CURVES[forge.asn1.derToOid(parts[1].value as string)];
    if (curve) return curve;
  }
  throw new Error("signing_key_unsupported");
}

async function importKeys(
  pkcs8: Uint8Array,
  algorithm: ReturnType<typeof keyAlgorithm>
): Promise<Record<RemoteHash, CryptoKey>> {
  const entries = await Promise.all(
    hashes.map(async (hash) => {
      const params =
        algorithm.keyType === "rsa"
          ? { name: "RSASSA-PKCS1-v1_5", hash }
          : { name: "ECDSA", namedCurve: algorithm.namedCurve! };
      return [
        hash,
        await crypto.subtle.importKey("pkcs8", standard(pkcs8), params, false, ["sign"]),
      ] as const;
    })
  );
  return Object.fromEntries(entries) as Record<RemoteHash, CryptoKey>;
}

function credentialsFor(
  platform: SigningPlatform,
  credentials: Record<string, unknown>
): { p12: string; passwords: string[]; alias?: string } | null {
  if (platform === "android")
    return {
      p12: String(credentials.keystore_p12),
      passwords: [String(credentials.store_password), String(credentials.key_password)],
      alias: String(credentials.key_alias),
    };
  if (platform === "ios" || platform === "macos")
    return {
      p12: String(credentials.certificate_p12),
      passwords: [String(credentials.certificate_password)],
    };
  return null;
}

/** Decrypts the profile's stored credentials and imports their private key as non-extractable. */
export async function loadRemoteSigningKey(
  env: SigningEnv,
  context: SigningMachineContext,
  profile: SigningProfile
): Promise<RemoteSigningKey | null> {
  if (profile.platform === "windows") return null;
  const row = await storedCredentialRow(
    env,
    context.ownerId,
    context.repositoryId,
    profile.revision,
    profile.platform
  );
  if (!row) return null;
  const id = `${context.ownerId}/${context.repositoryId}/${profile.revision}/${profile.platform}/${row.updatedAt}`;
  let loaded = cache.get(id);
  if (!loaded) {
    loaded = (async () => {
      const source = credentialsFor(profile.platform, await row.credentials());
      if (!source) return null;
      const { pkcs8, chain } = parsePkcs12(source.p12, source.passwords, source.alias);
      const algorithm = keyAlgorithm(pkcs8);
      const keys = await importKeys(pkcs8, algorithm);
      return { key: keys["SHA-256"], keys, chain, keyType: algorithm.keyType };
    })();
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
    cache.set(id, loaded);
    loaded.catch(() => cache.delete(id));
  }
  return loaded;
}

function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const body = bytes.subarray(start);
    return body[0]! & 0x80 ? Uint8Array.of(0, ...body) : body;
  };
  const length = (n: number) => (n < 0x80 ? [n] : [0x81, n]);
  const r = integer(raw.subarray(0, half));
  const s = integer(raw.subarray(half));
  const inner = [0x02, ...length(r.length), ...r, 0x02, ...length(s.length), ...s];
  return Uint8Array.of(0x30, ...length(inner.length), ...inner);
}

/** Signs raw data; ECDSA output is JCA DER when `format` is "der" and raw r||s when "raw". */
export async function remoteSign(
  key: RemoteSigningKey,
  data: Uint8Array,
  hash: RemoteHash,
  format: "der" | "raw" = "der"
): Promise<Uint8Array> {
  const signingKey = key.keys[hash];
  if (!signingKey) throw new Error("signing_hash_unsupported");
  if (key.keyType === "rsa")
    return new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, standard(data))
    );
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash }, signingKey, standard(data))
  );
  return format === "der" ? ecdsaRawToDer(raw) : raw;
}

/** Counts one remote operation for the run and throws once its kind exceeds the per-run cap. */
export async function recordRemoteOperation(
  env: Pick<SigningEnv, "DB">,
  context: SigningMachineContext,
  kind: string
): Promise<void> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `INSERT INTO actions_signing_remote_operations(run_id,kind,count,first_at,last_at)
     VALUES(?,?,1,?,?)
     ON CONFLICT(run_id,kind) DO UPDATE SET count=count+1,last_at=excluded.last_at
     WHERE count<?`
  )
    .bind(context.runId, kind, now, now, REMOTE_OPERATION_CAP)
    .run();
  if (result.meta.changes !== 1) throw new Error("signing_operation_cap_exceeded");
}

export const chainToBase64 = (chain: Uint8Array[]) => chain.map((cert) => bytesToBase64(cert));
