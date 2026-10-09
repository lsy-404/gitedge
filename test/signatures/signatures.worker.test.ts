import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createMessage, generateKey, readPrivateKey, sign } from "openpgp";
import { z } from "zod";
import { unlimitedRateLimiter } from "../support/rate-limiter";
import { runSqlScript } from "../support/database";
import { FixtureArtifacts } from "../support/artifacts";
import auth from "../../workers/auth/src/index";
import { verifyObjectSignature } from "../../workers/git/src/signatures";
import { signedCommitObject } from "../support/ssh-signer";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const authEnv = {
  DB: env.DB,
  ARTIFACTS: new FixtureArtifacts(),
  RATE_LIMITER: unlimitedRateLimiter,
  ALLOW_PUBLIC_SIGNUP: "true",
  DEFAULT_USER_GROUP: "free",
};
const challengeSchema = z.object({
  data: z.object({ id: z.string(), payload: z.string(), fingerprint: z.string() }),
});
const keySchema = z.object({
  data: z.object({ id: z.string(), fingerprint: z.string(), publicKey: z.string() }),
});
let publicKey = "",
  privateKey = "",
  cookie = "",
  otherCookie = "",
  keyId = "";
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  sessionCookie = cookie,
  origin = "https://auth.test"
) {
  return auth.fetch(
    new Request(`https://auth.test${path}`, {
      method,
      headers: { Cookie: sessionCookie, Origin: origin, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    authEnv
  );
}
async function signatureFor(payload: string) {
  return sign({
    message: await createMessage({ binary: new TextEncoder().encode(payload) }),
    signingKeys: await readPrivateKey({ armoredKey: privateKey }),
    detached: true,
    format: "armored",
  });
}
beforeAll(async () => {
  for (const name of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[name]);
  const generated = await generateKey({
    type: "ecc",
    curve: "ed25519Legacy",
    userIDs: [{ name: "Signer", email: "signer@gitedge.invalid" }],
    format: "armored",
  });
  publicKey = generated.publicKey;
  privateKey = generated.privateKey;
  for (const name of ["signature-owner", "other-owner"]) {
    const r = await request("/register", "POST", {
      identifier: name,
      password: "fixture-password-for-signatures",
    });
    expect(r.status).toBe(201);
    const value =
      r.headers
        .getSetCookie()
        .find((entry) => entry.startsWith("gitedge_session="))
        ?.split(";")[0] ?? "";
    if (name === "signature-owner") cookie = value;
    else otherCookie = value;
  }
});
describe("Signing key ownership and commit signatures", () => {
  it("requires a human same-origin session and refuses private keys", async () => {
    expect((await request("/signing-keys", "GET", undefined, "")).status).toBe(401);
    expect(
      (
        await request(
          "/signing-keys/challenges",
          "POST",
          { title: "Signer", publicKey },
          cookie,
          "https://other.test"
        )
      ).status
    ).toBe(403);
    expect(
      (
        await request("/signing-keys/challenges", "POST", {
          title: "Signer",
          publicKey: privateKey,
        })
      ).status
    ).toBe(400);
  });
  it("binds the proof to the account and exact one-time challenge", async () => {
    const response = await request("/signing-keys/challenges", "POST", {
      title: "Signer",
      publicKey,
    });
    expect(response.status).toBe(201);
    const challenge = challengeSchema.parse(await response.json()).data;
    const proof = await signatureFor(challenge.payload);
    expect(
      (
        await request(
          "/signing-keys",
          "POST",
          { challengeId: challenge.id, signature: proof },
          otherCookie
        )
      ).status
    ).toBe(409);
    const created = await request("/signing-keys", "POST", {
      challengeId: challenge.id,
      signature: proof,
    });
    expect(created.status).toBe(201);
    const key = keySchema.parse(await created.json()).data;
    keyId = key.id;
    expect(key.publicKey).not.toContain("PRIVATE");
    expect(key.fingerprint).toBe(challenge.fingerprint);
    expect(
      (await request("/signing-keys", "POST", { challengeId: challenge.id, signature: proof }))
        .status
    ).toBe(409);
  });
  it("verifies exact payloads and attributes only proven keys", async () => {
    const payload =
      "tree 0000000000000000000000000000000000000000\nauthor Signer <signer@gitedge.invalid> 1 +0000\n\nSigned content\n";
    const signature = await signatureFor(payload);
    const verify = (object: Uint8Array) => verifyObjectSignature(env.DB, "commit", object);
    const result = await verify(signedCommitObject(payload, signature));
    expect(result).toMatchObject({ status: "valid", format: "openpgp" });
    expect(result.signer?.identifier).toBe("signature-owner");
    expect((await verify(signedCommitObject(payload + "changed", signature))).status).toBe(
      "invalid"
    );
    expect((await verify(new TextEncoder().encode(payload))).status).toBe("unsigned");
    expect(
      (await verify(signedCommitObject(payload, "-----BEGIN SSH SIGNATURE-----\n"))).status
    ).toBe("invalid");
  });
  it("revokes owned keys without granting another user control", async () => {
    expect((await request("/signing-keys/" + keyId, "DELETE", undefined, otherCookie)).status).toBe(
      404
    );
    expect((await request("/signing-keys/" + keyId, "DELETE")).status).toBe(200);
    const payload = "tree 0000000000000000000000000000000000000000\n\nRevoked\n";
    expect(
      (
        await verifyObjectSignature(
          env.DB,
          "commit",
          signedCommitObject(payload, await signatureFor(payload))
        )
      ).status
    ).toBe("revoked_key");
  });
});
