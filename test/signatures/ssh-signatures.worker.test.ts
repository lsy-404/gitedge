import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import * as git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import { z } from "zod";
import auth from "../../workers/auth/src/index";
import forge from "../../workers/forge/src/index";
import gitWorker from "../../workers/git/src/index";
import { walkIntroducedCommits } from "../../workers/git/src/merge";
import { splitSignedObject, verifyObjectSignature } from "../../workers/git/src/signatures";
import { parseSshPublicKey } from "../../src/worker/common/ssh-signatures";
import { inspectSigningKey, verifyKeyProof } from "../../src/worker/common/signatures";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { unlimitedRateLimiter } from "../support/rate-limiter";
import { runSqlScript } from "../support/database";
import { FixtureArtifacts } from "../support/artifacts";
import { generateSshKey } from "../support/ssh-signer";
import rawFixtures from "../fixtures/ssh-signatures/fixtures.json";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const names = z.object({
  ed25519: z.string(),
  ecdsa: z.string(),
  rsa: z.string(),
  other: z.string(),
});
const fixtures = z
  .object({
    keys: names,
    fingerprints: names,
    proof: z.object({
      payload: z.string(),
      ed25519: z.string(),
      wrongNamespace: z.string(),
      ecdsaSha256: z.string(),
    }),
    commits: z.object({
      base: z.string(),
      ed25519: z.string(),
      ecdsa: z.string(),
      rsa: z.string(),
      other: z.string(),
      unsigned: z.string(),
      victim: z.string(),
    }),
    tags: z.object({ ed25519: z.string(), ecdsa: z.string(), unsigned: z.string() }),
    objects: z.array(
      z.object({
        oid: z.string(),
        type: z.enum(["blob", "tree", "commit", "tag"]),
        content: z.string(),
      })
    ),
  })
  .parse(rawFixtures);
const objects = new Map(
  fixtures.objects.map((object) => [
    object.oid,
    { type: object.type, bytes: Uint8Array.from(atob(object.content), (c) => c.charCodeAt(0)) },
  ])
);
function rawObject(oid: string): Uint8Array {
  const object = objects.get(oid);
  if (!object) throw new Error(`Missing fixture object ${oid}`);
  return object.bytes;
}
function tampered(oid: string, from: string, to: string): Uint8Array {
  const text = new TextDecoder().decode(rawObject(oid));
  expect(text).toContain(from);
  return new TextEncoder().encode(text.replace(from, to));
}

const artifacts = new FixtureArtifacts();
const authEnv = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  RATE_LIMITER: unlimitedRateLimiter,
  ALLOW_PUBLIC_SIGNUP: "true",
  DEFAULT_USER_GROUP: "free",
};
const ownerUser = { id: "", identifier: "ssh-owner", groupKey: "free" };
let cookie = "";
let ecdsaKeyId = "";

async function authRequest(path: string, method = "GET", body?: unknown) {
  return auth.fetch(
    new Request(`https://auth.test${path}`, {
      method,
      headers: { Cookie: cookie, Origin: "https://auth.test", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    authEnv
  );
}
async function registerUser(identifier: string): Promise<{ id: string; cookie: string }> {
  const response = await auth.fetch(
    new Request("https://auth.test/register", {
      method: "POST",
      headers: { Origin: "https://auth.test", "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password: "fixture-password-for-ssh-signatures" }),
    }),
    authEnv
  );
  expect(response.status).toBe(201);
  const row = await env.DB.prepare("SELECT id FROM users WHERE identifier = ?")
    .bind(identifier)
    .first<{ id: string }>();
  return {
    id: row?.id ?? "",
    cookie:
      response.headers
        .getSetCookie()
        .find((entry) => entry.startsWith("gitedge_session="))
        ?.split(";")[0] ?? "",
  };
}
async function insertKey(userId: string, name: "ed25519" | "ecdsa" | "rsa"): Promise<string> {
  const key = await inspectSigningKey(fixtures.keys[name]);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO auth_signing_keys (id,user_id,title,format,fingerprint,key_ids_json,public_key,created_at) VALUES (?,?,?,?,?,'[]',?,1)"
  )
    .bind(id, userId, name, key.format, key.fingerprint, key.publicKey)
    .run();
  return id;
}
async function verifyEmail(userId: string, email: string) {
  await env.DB.prepare(
    "INSERT INTO auth_emails (user_id,email,verified_at,created_at) VALUES (?,?,1,1)"
  )
    .bind(userId, email)
    .run();
}
const verifyCommit = (raw: Uint8Array) => verifyObjectSignature(env.DB, "commit", raw);
const verifyTag = (raw: Uint8Array) => verifyObjectSignature(env.DB, "tag", raw);

beforeAll(async () => {
  for (const name of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[name]);
  const owner = await registerUser("ssh-owner");
  ownerUser.id = owner.id;
  cookie = owner.cookie;
  const victim = await registerUser("ssh-victim");
  await insertKey(owner.id, "ed25519");
  ecdsaKeyId = await insertKey(owner.id, "ecdsa");
  await insertKey(owner.id, "rsa");
  await verifyEmail(owner.id, "signer@example.test");
  await verifyEmail(victim.id, "victim@example.test");
});

describe("SSH public keys", () => {
  it("computes the same SHA256 fingerprints as ssh-keygen and drops comments", async () => {
    for (const name of ["ed25519", "ecdsa", "rsa", "other"] as const) {
      const key = await parseSshPublicKey(fixtures.keys[name]);
      expect(key.fingerprint).toBe(fixtures.fingerprints[name]);
      expect(key.publicKey).toBe(fixtures.keys[name].split(" ").slice(0, 2).join(" "));
    }
  });

  it("rejects unsupported, mislabeled, multiple and private keys", async () => {
    const [, ed25519Blob] = fixtures.keys.ed25519.split(" ");
    for (const text of [
      "ssh-dss AAAAB3NzaC1kc3MAAAA= dsa",
      `ssh-rsa ${ed25519Blob}`,
      `${fixtures.keys.ed25519}\n${fixtures.keys.ecdsa}`,
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
      "ssh-ed25519 not-base64!",
    ])
      await expect(inspectSigningKey(text)).rejects.toThrow();
  });
});

describe("SSHSIG ownership proofs from ssh-keygen", () => {
  it("accepts the gitedge namespace and rejects other namespaces, keys and payloads", async () => {
    const ed25519 = await inspectSigningKey(fixtures.keys.ed25519);
    const ecdsa = await inspectSigningKey(fixtures.keys.ecdsa);
    const { payload } = fixtures.proof;
    expect(await verifyKeyProof(ed25519, fixtures.proof.ed25519, payload)).toBe(true);
    expect(await verifyKeyProof(ecdsa, fixtures.proof.ecdsaSha256, payload)).toBe(true);
    expect(await verifyKeyProof(ed25519, fixtures.proof.wrongNamespace, payload)).toBe(false);
    expect(await verifyKeyProof(ecdsa, fixtures.proof.ed25519, payload)).toBe(false);
    expect(await verifyKeyProof(ed25519, fixtures.proof.ed25519, payload + "x")).toBe(false);
    expect(await verifyKeyProof(ed25519, "-----BEGIN SSH SIGNATURE-----\n", payload)).toBe(false);
  });
});

describe("SSH signing key registration", () => {
  const challengeSchema = z.object({
    data: z.object({
      id: z.string(),
      payload: z.string(),
      fingerprint: z.string(),
      format: z.string(),
    }),
  });
  it("binds the challenge to the key, the gitedge namespace and one use", async () => {
    const key = await generateSshKey();
    const created = await authRequest("/signing-keys/challenges", "POST", {
      title: "Laptop",
      publicKey: key.publicKey,
    });
    expect(created.status).toBe(201);
    const challenge = challengeSchema.parse(await created.json()).data;
    expect(challenge.format).toBe("ssh");
    expect(challenge.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const wrongNamespace = await authRequest("/signing-keys", "POST", {
      challengeId: challenge.id,
      signature: await key.sign(challenge.payload, "git"),
    });
    expect(wrongNamespace.status).toBe(400);
    const otherKey = await generateSshKey();
    const wrongKey = await authRequest("/signing-keys", "POST", {
      challengeId: challenge.id,
      signature: await otherKey.sign(challenge.payload, "gitedge"),
    });
    expect(wrongKey.status).toBe(400);
    const proof = await key.sign(challenge.payload, "gitedge");
    const registered = await authRequest("/signing-keys", "POST", {
      challengeId: challenge.id,
      signature: proof,
    });
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({
      data: { format: "ssh", fingerprint: challenge.fingerprint, keyIds: [] },
    });
    expect(
      (await authRequest("/signing-keys", "POST", { challengeId: challenge.id, signature: proof }))
        .status
    ).toBe(409);
    const listed = await authRequest("/signing-keys");
    expect(await listed.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ format: "ssh", fingerprint: challenge.fingerprint }),
      ]),
    });
  });

  it("refuses keys it cannot verify", async () => {
    const response = await authRequest("/signing-keys/challenges", "POST", {
      title: "DSA",
      publicKey: "ssh-dss AAAAB3NzaC1kc3MAAACBAP1/U4EddRIpUt9KnC7s5Of2EbdSPO9EAMMeP4C2USZpRV1A",
    });
    expect(response.status).toBe(400);
  });
});

describe("SSH commit and tag signatures from git", () => {
  it("verifies ed25519, ecdsa and rsa commits and attributes them to the key owner", async () => {
    for (const name of ["ed25519", "ecdsa", "rsa"] as const) {
      const result = await verifyCommit(rawObject(fixtures.commits[name]));
      expect(result).toMatchObject({
        status: "valid",
        format: "ssh",
        fingerprint: fixtures.fingerprints[name],
        signer: { id: ownerUser.id, identifier: "ssh-owner" },
      });
    }
  });

  it("strips only the gpgsig header from the signed payload", () => {
    const signed = splitSignedObject("commit", rawObject(fixtures.commits.ed25519));
    const payload = new TextDecoder().decode(signed.payload);
    expect(payload).not.toContain("gpgsig");
    expect(payload).toMatch(/^tree [0-9a-f]{40}\nparent [0-9a-f]{40}\n/);
    expect(payload.endsWith("\n\nSigned with ed25519\n")).toBe(true);
    expect(signed.signature).toMatch(
      /^-----BEGIN SSH SIGNATURE-----\n[\s\S]+\n-----END SSH SIGNATURE-----\n$/
    );
    expect(signed.email).toBe("signer@example.test");
  });

  it("rejects tampered content, unknown keys and impersonated committers", async () => {
    expect(
      await verifyCommit(
        tampered(fixtures.commits.ed25519, "Signed with ed25519", "Signed with ed25520")
      )
    ).toMatchObject({ status: "invalid", format: "ssh" });
    expect(
      await verifyCommit(tampered(fixtures.commits.ecdsa, "1790000000 +0000", "1790000001 +0000"))
    ).toMatchObject({ status: "invalid" });
    expect(await verifyCommit(rawObject(fixtures.commits.other))).toMatchObject({
      status: "unknown_key",
      fingerprint: fixtures.fingerprints.other,
      signer: null,
    });
    expect(await verifyCommit(rawObject(fixtures.commits.unsigned))).toMatchObject({
      status: "unsigned",
      format: null,
    });
    expect(await verifyCommit(rawObject(fixtures.commits.victim))).toMatchObject({
      status: "email_mismatch",
      signer: { identifier: "ssh-owner" },
    });
  });

  it("verifies annotated tag signatures with the same rules", async () => {
    expect(await verifyTag(rawObject(fixtures.tags.ed25519))).toMatchObject({
      status: "valid",
      format: "ssh",
      fingerprint: fixtures.fingerprints.ed25519,
    });
    expect(await verifyTag(rawObject(fixtures.tags.ecdsa))).toMatchObject({ status: "valid" });
    expect(await verifyTag(rawObject(fixtures.tags.unsigned))).toMatchObject({
      status: "unsigned",
    });
    expect(
      await verifyTag(tampered(fixtures.tags.ed25519, "Release v1.0.0", "Release v1.0.1"))
    ).toMatchObject({ status: "invalid" });
    const signed = splitSignedObject("tag", rawObject(fixtures.tags.ed25519));
    expect(new TextDecoder().decode(signed.payload).endsWith("\n\nRelease v1.0.0\n")).toBe(true);
  });
});

describe("Signed-commit branch rule", () => {
  async function repository() {
    const fs = createFsFromVolume(new Volume());
    const dir = "/repo";
    await git.init({ fs, dir, defaultBranch: "main" });
    for (const [oid, object] of objects) {
      const written = await git.writeObject({
        fs,
        dir,
        type: object.type,
        object: object.bytes,
        format: "content",
      });
      expect(written).toBe(oid);
    }
    return { fs, dir };
  }
  const rule = async (raw: Uint8Array) => (await verifyCommit(raw)).status === "valid";

  it("admits merges whose introduced commits all carry verified SSH signatures", async () => {
    const { fs, dir } = await repository();
    const walked = await walkIntroducedCommits(
      fs,
      dir,
      fixtures.commits.rsa,
      fixtures.commits.base,
      rule
    );
    expect(walked).toMatchObject({ ok: true });
    if (walked.ok) expect(walked.commits).toHaveLength(3);
    for (const head of [fixtures.commits.other, fixtures.commits.unsigned, fixtures.commits.victim])
      expect(await walkIntroducedCommits(fs, dir, head, fixtures.commits.base, rule)).toEqual({
        ok: false,
        reason: "unsigned_commits",
      });
  });

  it("stops admitting commits once their key is revoked", async () => {
    const { fs, dir } = await repository();
    await env.DB.prepare("UPDATE auth_signing_keys SET revoked_at = 2 WHERE id = ?")
      .bind(ecdsaKeyId)
      .run();
    expect(await verifyCommit(rawObject(fixtures.commits.ecdsa))).toMatchObject({
      status: "revoked_key",
    });
    expect(
      await walkIntroducedCommits(fs, dir, fixtures.commits.rsa, fixtures.commits.base, rule)
    ).toEqual({ ok: false, reason: "unsigned_commits" });
  });

  it("refuses direct pushes to branches that require signed commits", async () => {
    const forgeCall = (path: string, body: unknown) => {
      const headers = trustedHeaders(ownerUser);
      headers.set("Content-Type", "application/json");
      return forge.fetch(
        new Request("https://forge.test" + path, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
        { DB: env.DB, ARTIFACTS: artifacts }
      );
    };
    const created = await forgeCall("/repositories", {
      owner: "ssh-owner",
      slug: "signed",
      visibility: "private",
    });
    expect(created.status).toBe(201);
    const repositoryId = z
      .object({ data: z.object({ id: z.string() }) })
      .parse(await created.json()).data.id;
    expect(
      (
        await forgeCall(`/repositories/${repositoryId}/branch-rules`, {
          pattern: "main",
          requireSignedCommits: true,
        })
      ).status
    ).toBe(201);
    const headers = trustedHeaders(ownerUser);
    headers.set("X-GitEdge-Git-Grant", JSON.stringify({ repositoryId, permission: "write" }));
    const command = `${"0".repeat(40)} ${fixtures.commits.ed25519} refs/heads/main\0report-status\n`;
    const body =
      (new TextEncoder().encode(command).length + 4).toString(16).padStart(4, "0") +
      command +
      "0000PACK";
    const pushed = await gitWorker.fetch(
      new Request("https://forge.test/ssh-owner/signed.git/git-receive-pack", {
        method: "POST",
        headers,
        body,
      }),
      { DB: env.DB, ARTIFACTS: artifacts }
    );
    expect(pushed.status).toBe(403);
    expect(await pushed.json()).toMatchObject({ error: { code: "protected_branch" } });
  });
});
