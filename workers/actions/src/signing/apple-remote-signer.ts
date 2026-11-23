import { DurableObject } from "cloudflare:workers";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { decodeFirst } from "cborg";
import forge from "node-forge";
import { z } from "zod";
import type {
  SigningMachineContext,
  SigningProfile,
} from "../../../../packages/contracts/src/signing";
import { sha256Hex } from "../../../../packages/contracts/src/index";
import { dataResponse, errorResponse } from "../../../../src/worker/common/http";
import { readJsonLimited } from "../../../../src/worker/common/readText";
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
} from "../../../../src/worker/common/encoding";
import {
  loadRemoteSigningKey,
  recordRemoteOperation,
  remoteSign,
  type RemoteHash,
  type RemoteSigningKey,
} from "./remote-keys";
import type { SigningEnv } from "./types";

// Wire protocol of apple-codesign's remote signing relay (`rcodesign sign --remote-*`).
const RELAY_APIS = ["hello", "create-session", "join-session", "send-message", "goodbye"];
const SOCKET_ROUTE = /^\/runner\/signing\/apple-remote\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{43})$/;
const SIGNING_STAGES: Record<string, string[]> = {
  macos: ["sign", "dmg_sign"],
  ios: ["ios_sign"],
};
const MAX_SIGN_BYTES = 1024 * 1024;
const LEASE_CHECK_MS = 30_000;
const SESSION_MS = 60 * 60_000;

// Signature algorithm of the leaf certificate, which rcodesign uses to verify each remote signature.
const SIGNATURE_ALGORITHMS: Record<string, { family: "rsa" | "ec"; hash: RemoteHash }> = {
  "1.2.840.113549.1.1.5": { family: "rsa", hash: "SHA-1" },
  "1.2.840.113549.1.1.11": { family: "rsa", hash: "SHA-256" },
  "1.2.840.113549.1.1.12": { family: "rsa", hash: "SHA-384" },
  "1.2.840.113549.1.1.13": { family: "rsa", hash: "SHA-512" },
  "1.2.840.10045.4.3.2": { family: "ec", hash: "SHA-256" },
  "1.2.840.10045.4.3.3": { family: "ec", hash: "SHA-384" },
};
const SIGNATURE_OIDS: Record<string, string> = {
  "rsa:SHA-1": "1.2.840.113549.1.1.5",
  "rsa:SHA-256": "1.2.840.113549.1.1.11",
  "rsa:SHA-384": "1.2.840.113549.1.1.12",
  "rsa:SHA-512": "1.2.840.113549.1.1.13",
  "ec:SHA-256": "1.2.840.10045.4.3.2",
  "ec:SHA-384": "1.2.840.10045.4.3.3",
};

const clientMessage = z.object({
  request_id: z.string().max(128).optional(),
  api: z.string().max(32),
  payload: z.record(z.string(), z.unknown()).nullish(),
});
const peerMessage = z.object({
  type: z.string().max(64),
  payload: z.record(z.string(), z.unknown()).nullish(),
});

class RelayError extends Error {}

interface Session {
  context: SigningMachineContext;
  profile: SigningProfile;
  leaseHash: string;
  url: string;
  tokenHash: string;
  rsa: CryptoKeyPair;
  spki: Uint8Array;
  expiresAt: number;
  socket?: WebSocket;
  relaySessionId?: string;
  peer?: { seal: Uint8Array; open: Uint8Array; sealed: number; opened: number };
  signer?: { key: RemoteSigningKey; hash: RemoteHash; algorithmOid: Uint8Array };
  queue: Promise<void>;
}

function nonce(counter: number): Uint8Array {
  const value = new Uint8Array(12);
  new DataView(value.buffer).setUint32(0, counter, true);
  return value;
}

function oidDer(oid: string): Uint8Array {
  const der = forge.asn1.toDer(
    forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.OID,
      false,
      forge.asn1.oidToDer(oid).getBytes()
    )
  );
  return Uint8Array.from(der.getBytes(), (character) => character.charCodeAt(0));
}

function certificateSignatureOid(der: Uint8Array): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const certificate = forge.asn1.fromDer(binary);
  const algorithm = (certificate.value as forge.asn1.Asn1[])[1];
  const oid = (algorithm?.value as forge.asn1.Asn1[] | undefined)?.[0];
  if (!oid || oid.type !== forge.asn1.Type.OID) throw new RelayError("certificate_invalid");
  return forge.asn1.derToOid(oid.value as string);
}

function bytesField(value: unknown, length?: number): Uint8Array<ArrayBuffer> {
  // minicbor encodes `Vec<u8>` struct fields as arrays of integers rather than byte strings.
  const bytes =
    value instanceof Uint8Array
      ? new Uint8Array(value)
      : Array.isArray(value) &&
          value.every((item) => Number.isInteger(item) && item >= 0 && item < 256)
        ? Uint8Array.from(value as number[])
        : null;
  if (!bytes || (length !== undefined && bytes.length !== length))
    throw new RelayError("session_join_invalid");
  return bytes;
}

function pem(label: string, der: Uint8Array): string {
  const body = bytesToBase64(der).replace(/.{1,64}/g, "$&\n");
  return `-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export class AppleRemoteSigner extends DurableObject<SigningEnv> {
  private session: Session | null = null;

  async open(input: {
    context: SigningMachineContext;
    profile: SigningProfile;
    leaseHash: string;
    socketUrl: string;
  }): Promise<{ url: string; publicKeyPem: string }> {
    this.close(1000, "replaced");
    const rsa = (await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      false,
      ["encrypt", "decrypt"]
    )) as CryptoKeyPair;
    const spki = new Uint8Array(
      (await crypto.subtle.exportKey("spki", rsa.publicKey)) as ArrayBuffer
    );
    const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const url = `${input.socketUrl}/${token}`;
    this.session = {
      context: input.context,
      profile: input.profile,
      leaseHash: input.leaseHash,
      url,
      tokenHash: await sha256Hex(token),
      rsa,
      spki,
      expiresAt: Date.now() + SESSION_MS,
      queue: Promise.resolve(),
    };
    await this.ctx.storage.setAlarm(Date.now() + LEASE_CHECK_MS);
    return { url, publicKeyPem: pem("PUBLIC KEY", spki) };
  }

  override async fetch(request: Request): Promise<Response> {
    const match = SOCKET_ROUTE.exec(new URL(request.url).pathname);
    const session = this.session;
    if (
      !match ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      !session ||
      session.socket ||
      session.context.runId !== match[1] ||
      (await sha256Hex(match[2]!)) !== session.tokenHash ||
      !(await this.leaseActive(session))
    )
      return new Response(null, { status: 403 });
    session.tokenHash = "";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    session.socket = server;
    server.addEventListener("message", (event) => {
      session.queue = session.queue
        .then(() => this.relay(session, event.data))
        .catch((error) => {
          this.send(session, {
            type: "error",
            payload: {
              code: error instanceof RelayError ? error.message : "signer_failed",
              message: "The remote signing session failed.",
            },
          });
          this.close(1011, "signing failed", session);
        });
    });
    server.addEventListener("close", () => this.close(1000, "closed", session));
    server.addEventListener("error", () => this.close(1011, "socket error", session));
    return new Response(null, { status: 101, webSocket: client });
  }

  async join(sessionJoinString: string): Promise<void> {
    const session = this.session;
    if (!session?.socket || !session.relaySessionId || session.peer)
      throw new RelayError("session_not_ready");
    if (!(await this.leaseActive(session))) throw new RelayError("lease_inactive");
    let decoded: unknown;
    try {
      [decoded] = decodeFirst(base64UrlToBytes(sessionJoinString.trim()));
    } catch {
      throw new RelayError("session_join_invalid");
    }
    if (
      !Array.isArray(decoded) ||
      decoded[0] !== "publickey0" ||
      !Array.isArray(decoded[1]) ||
      decoded[1].length !== 3
    )
      throw new RelayError("session_join_invalid");
    const [wrappedKey, publicKey, messageCiphertext] = (decoded[1] as unknown[]).map((value) =>
      bytesField(value)
    ) as [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>];
    if (!sameBytes(publicKey, session.spki)) throw new RelayError("session_join_foreign");
    let message: unknown;
    try {
      const aesKey = await crypto.subtle.importKey(
        "raw",
        await crypto.subtle.decrypt({ name: "RSA-OAEP" }, session.rsa.privateKey, wrappedKey),
        "AES-GCM",
        false,
        ["decrypt"]
      );
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(12).fill(0x42) },
        aesKey,
        messageCiphertext
      );
      [message] = decodeFirst(new Uint8Array(plaintext));
    } catch {
      throw new RelayError("session_join_invalid");
    }
    if (!Array.isArray(message) || message.length !== 4)
      throw new RelayError("session_join_invalid");
    const [serverUrl, relaySessionId, challengeValue, agreementValue] = message as unknown[];
    if (serverUrl !== session.url || relaySessionId !== session.relaySessionId)
      throw new RelayError("session_join_foreign");
    const challenge = bytesField(challengeValue, 32);
    const peerPublic = bytesField(agreementValue, 32);

    session.signer = await this.loadSigner(session);
    const agreement = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const ownPublic = new Uint8Array(
      (await crypto.subtle.exportKey("raw", agreement.publicKey)) as ArrayBuffer
    );
    const shared = await crypto.subtle.deriveBits(
      {
        name: "X25519",
        public: await crypto.subtle.importKey("raw", peerPublic, { name: "X25519" }, false, []),
      },
      agreement.privateKey,
      256
    );
    const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const expand = async (role: "A" | "B") => {
      const label = new TextEncoder().encode(`${role}:${relaySessionId}:`);
      const info = new Uint8Array(label.length + challenge.length);
      info.set(label);
      info.set(challenge, label.length);
      return new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info },
          hkdf,
          256
        )
      );
    };
    // The joining peer is role B: it seals with the B key and opens with the A key.
    session.peer = { seal: await expand("B"), open: await expand("A"), sealed: 0, opened: 0 };
    this.send(session, { type: "session-joined", payload: { context: bytesToBase64(ownPublic) } });
  }

  override async alarm(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (Date.now() >= session.expiresAt || !(await this.leaseActive(session))) {
      this.close(1008, "lease ended", session);
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + LEASE_CHECK_MS);
  }

  private async loadSigner(session: Session): Promise<NonNullable<Session["signer"]>> {
    const key = await loadRemoteSigningKey(this.env, session.context, session.profile);
    if (!key?.chain[0]) throw new RelayError("signing_key_unavailable");
    const algorithm = SIGNATURE_ALGORITHMS[certificateSignatureOid(key.chain[0])];
    const family = key.keyType === "rsa" ? "rsa" : "ec";
    // rcodesign checks each signature assuming every EC certificate key is P-384, so P-256 never verifies.
    if (!algorithm || algorithm.family !== family || key.keyType === "ec-p256")
      throw new RelayError("signing_key_unsupported");
    return {
      key,
      hash: algorithm.hash,
      algorithmOid: oidDer(SIGNATURE_OIDS[`${family}:${algorithm.hash}`]!),
    };
  }

  private async relay(session: Session, data: string | ArrayBuffer): Promise<void> {
    if (this.session !== session || typeof data !== "string" || data.length > 4 * MAX_SIGN_BYTES)
      throw new RelayError("message_invalid");
    let parsed;
    try {
      parsed = clientMessage.parse(JSON.parse(data));
    } catch {
      throw new RelayError("message_invalid");
    }
    const requestId = parsed.request_id;
    const payload = parsed.payload ?? {};
    if (parsed.api === "hello") {
      this.send(session, {
        request_id: requestId,
        type: "greeting",
        payload: { apis: RELAY_APIS, motd: null },
      });
      return;
    }
    if (parsed.api === "create-session") {
      const id = z.uuid().safeParse(payload.session_id);
      if (session.relaySessionId || !id.success) throw new RelayError("session_invalid");
      session.relaySessionId = id.data;
      this.send(session, { request_id: requestId, type: "session-created" });
      return;
    }
    if (parsed.api === "goodbye") {
      this.send(session, {
        request_id: requestId,
        type: "session-closed",
        payload: { reason: null },
      });
      this.close(1000, "goodbye", session);
      return;
    }
    if (
      parsed.api !== "send-message" ||
      !session.peer ||
      payload.session_id !== session.relaySessionId ||
      typeof payload.message !== "string"
    )
      throw new RelayError("message_invalid");
    const peer = session.peer;
    let message;
    try {
      const plaintext = chacha20poly1305(peer.open, nonce(peer.opened)).decrypt(
        base64ToBytes(payload.message)
      );
      peer.opened += 1;
      message = peerMessage.parse(JSON.parse(new TextDecoder().decode(plaintext)));
    } catch {
      throw new RelayError("message_invalid");
    }
    const reply = await this.answer(session, message);
    this.send(session, { request_id: requestId, type: "message-sent" });
    const ciphertext = chacha20poly1305(peer.seal, nonce(peer.sealed)).encrypt(
      new TextEncoder().encode(JSON.stringify(reply))
    );
    peer.sealed += 1;
    this.send(session, { type: "peer-message", payload: { message: bytesToBase64(ciphertext) } });
  }

  private async answer(
    session: Session,
    message: z.infer<typeof peerMessage>
  ): Promise<{ type: string; payload?: unknown }> {
    const signer = session.signer!;
    if (message.type === "ping" || message.type === "pong") return { type: message.type };
    if (message.type === "request-signing-certificate") {
      const [leaf, ...chain] = signer.key.chain;
      return {
        type: "signing-certificate",
        payload: {
          certificates: [
            { certificate: bytesToBase64(leaf!), chain: chain.map((cert) => bytesToBase64(cert)) },
          ],
        },
      };
    }
    if (message.type === "sign-request" && typeof message.payload?.message === "string") {
      const data = base64ToBytes(message.payload.message);
      if (data.length > MAX_SIGN_BYTES) throw new RelayError("message_invalid");
      if (!(await this.leaseActive(session))) throw new RelayError("lease_inactive");
      await recordRemoteOperation(this.env, session.context, "apple-sign");
      const signature = await remoteSign(signer.key, data, signer.hash, "der");
      return {
        type: "signature",
        payload: {
          message: message.payload.message,
          signature: bytesToBase64(signature),
          algorithm_oid: bytesToBase64(signer.algorithmOid),
        },
      };
    }
    throw new RelayError("message_invalid");
  }

  private send(session: Session, message: Record<string, unknown>): void {
    try {
      session.socket?.send(JSON.stringify(message));
    } catch {
      this.close(1011, "socket error", session);
    }
  }

  private close(code: number, reason: string, session = this.session): void {
    if (!session || this.session !== session) return;
    this.session = null;
    try {
      session.socket?.close(code, reason);
    } catch {
      // The socket is already closed.
    }
  }

  private async leaseActive(session: Session): Promise<boolean> {
    const now = Date.now();
    if (now >= session.expiresAt) return false;
    const row = await this.env.DB.prepare(
      `SELECT 1 AS active FROM actions_runner_runs WHERE run_id=? AND runner_id=? AND lease_hash=?
         AND status='running' AND cancel_requested=0 AND lease_expires_at>? AND started_at+timeout_minutes*60000>?`
    )
      .bind(session.context.runId, session.context.runnerId, session.leaseHash, now, now)
      .first<{ active: number }>();
    return Boolean(row);
  }
}

/** Serves `apple-remote` (open a relay session) and `apple-remote/join` for an authorized lease. */
export async function handleAppleRemote(
  request: Request,
  env: SigningEnv,
  context: SigningMachineContext,
  profile: SigningProfile,
  action: string | undefined
): Promise<Response> {
  if (request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Remote signing requires POST.");
  if (!SIGNING_STAGES[profile.platform]?.includes(context.stage))
    return errorResponse(403, "forbidden", "Remote signing is not enabled for this stage.");
  const signer = env.APPLE_REMOTE_SIGNERS.get(env.APPLE_REMOTE_SIGNERS.idFromName(context.runId));
  try {
    if (action === undefined) {
      const origin = new URL(request.url);
      const scheme = origin.protocol === "https:" ? "wss:" : "ws:";
      return dataResponse(
        await signer.open({
          context,
          profile,
          leaseHash: await sha256Hex(request.headers.get("X-Runner-Lease-Token") ?? ""),
          socketUrl: `${scheme}//${origin.host}/api/actions/runner/signing/apple-remote/${context.runId}`,
        })
      );
    }
    if (action === "join") {
      const body = z
        .object({ sessionJoinString: z.string().regex(/^[A-Za-z0-9_-]{16,8192}={0,2}$/) })
        .strict()
        .safeParse(await readJsonLimited(request, 16_384));
      if (!body.success)
        return errorResponse(400, "bad_request", "Session join string is invalid.");
      await signer.join(body.data.sessionJoinString);
      return dataResponse({ joined: true });
    }
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : "";
    if (code)
      return errorResponse(
        409,
        `apple_remote_${code}`.slice(0, 64),
        "Remote signing session failed."
      );
    throw error;
  }
  return errorResponse(404, "not_found", "Signing runner endpoint was not found.");
}

/** Accepts rcodesign's relay connection; the one-time token in the path is checked by the session. */
export async function handleAppleRemoteSocket(
  request: Request,
  env: Pick<SigningEnv, "APPLE_REMOTE_SIGNERS">
): Promise<Response> {
  const match = SOCKET_ROUTE.exec(new URL(request.url).pathname);
  if (!match || request.method !== "GET")
    return errorResponse(404, "not_found", "Remote signing session was not found.");
  return env.APPLE_REMOTE_SIGNERS.get(env.APPLE_REMOTE_SIGNERS.idFromName(match[1]!)).fetch(
    request
  );
}

export const APPLE_REMOTE_SOCKET_ROUTE = SOCKET_ROUTE;
