import { base64UrlToBytes, bytesToBase64Url } from "../../src/worker/common/encoding";

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function cborBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = bytes.length < 24 ? [0x40 + bytes.length] : [0x58, bytes.length];
  return concat(Uint8Array.from(header), bytes);
}

function cborText(text: string): Uint8Array<ArrayBuffer> {
  return concat(Uint8Array.from([0x60 + text.length]), new TextEncoder().encode(text));
}

function derInteger(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const body = bytes.slice(start);
  const padded = body[0] & 0x80 ? concat(Uint8Array.of(0), body) : body;
  return concat(Uint8Array.of(0x02, padded.length), padded);
}

function derSignature(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = concat(derInteger(raw.slice(0, 32)), derInteger(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** A software authenticator that produces "none"-attestation registrations and ES256 assertions. */
export class SoftwareAuthenticator {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(32));
  counter = 0;
  private constructor(
    private readonly keys: CryptoKeyPair,
    private readonly origin: string,
    private readonly rpId: string
  ) {}

  static async create(origin: string): Promise<SoftwareAuthenticator> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    return new SoftwareAuthenticator(keys, origin, new URL(origin).hostname);
  }

  get id(): string {
    return bytesToBase64Url(this.credentialId);
  }

  private async authData(flags: number, attested: boolean): Promise<Uint8Array<ArrayBuffer>> {
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, this.counter);
    const header = concat(
      await sha256(new TextEncoder().encode(this.rpId)),
      Uint8Array.of(flags),
      counter
    );
    if (!attested) return header;
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
    const cose = concat(
      Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21),
      cborBytes(base64UrlToBytes(jwk.x ?? "")),
      Uint8Array.of(0x22),
      cborBytes(base64UrlToBytes(jwk.y ?? ""))
    );
    return concat(
      header,
      new Uint8Array(16),
      Uint8Array.of(0, this.credentialId.length),
      this.credentialId,
      cose
    );
  }

  private clientData(type: string, challenge: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin: this.origin }));
  }

  async register(challenge: string) {
    this.counter = 0;
    const authData = await this.authData(0x45, true);
    const attestationObject = concat(
      Uint8Array.of(0xa3),
      cborText("fmt"),
      cborText("none"),
      cborText("attStmt"),
      Uint8Array.of(0xa0),
      cborText("authData"),
      cborBytes(authData)
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: bytesToBase64Url(this.clientData("webauthn.create", challenge)),
        attestationObject: bytesToBase64Url(attestationObject),
        transports: ["internal" as const],
      },
    };
  }

  async assert(challenge: string, options: { userVerified?: boolean } = {}) {
    this.counter += 1;
    const authData = await this.authData(options.userVerified === false ? 0x01 : 0x05, false);
    const clientData = this.clientData("webauthn.get", challenge);
    const signed = concat(authData, await sha256(clientData));
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed)
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: bytesToBase64Url(clientData),
        authenticatorData: bytesToBase64Url(authData),
        signature: bytesToBase64Url(derSignature(signature)),
      },
    };
  }
}
