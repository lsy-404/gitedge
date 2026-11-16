import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { githubSourceIdentity, signingRequestClient } from "../scripts/signing/request.mjs";

const repositoryId = "a9daf3ca-68c5-46eb-bc75-fd8250e9cd6c";
const request = {
  id: "38b2a946-dc04-4cbb-83e9-40de3f20207e",
  repositoryId,
  ownerId: "owner",
  profile: "application",
  profileRevision: "a".repeat(40),
  platform: "windows",
  stage: "windows_sign",
  runId: "02124cea-581c-454e-a2d9-9c457c520671",
  state: "succeeded",
  sourceDigest: `sha256:${"b".repeat(64)}`,
  sourceSize: 12,
  outputDigest: null,
  outputSize: null,
  createdAt: 1,
  expiresAt: Date.now() + 86_400_000,
  completedAt: 2,
};

describe("signing submission client", () => {
  it("submits only canonical source metadata with a repository scope and idempotency key", async () => {
    let calls = 0;
    const client = signingRequestClient({
      origin: "https://forge.example.com",
      repositoryId,
      token: "scoped-secret",
      sourceIdentity: async () => "signed.source.identity",
      fetcher: async (url, options) => {
        calls++;
        expect(url.searchParams.get("repositoryId")).toBe(repositoryId);
        expect(options.headers.Authorization).toBe("Bearer scoped-secret");
        expect(options.headers["Idempotency-Key"]).toBe("repeatable-request-001");
        expect(options.headers["X-Run-Identity"]).toBe("signed.source.identity");
        return Response.json({ data: { request } });
      },
    });
    const input = {
      profile: "application",
      platform: "windows",
      sourceRepositoryId: "123",
      sourceCommitOid: "a".repeat(40),
      sourceRunId: "456",
      sourceDigest: request.sourceDigest,
      sourceSize: 12,
      version: "1.0.0",
    };
    await expect(
      client.submit({ ...input, labels: ["signing"] }, "repeatable-request-001")
    ).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(client.submit(input, "repeatable-request-001")).resolves.toMatchObject({
      id: request.id,
    });
  });

  it("does not send credentials through an HTTP origin", () => {
    expect(() =>
      signingRequestClient({ origin: "http://forge.example.com", repositoryId, token: "secret" })
    ).toThrow("HTTPS");
  });

  it("requests source identity for the exact Gateway audience", async () => {
    const value = await githubSourceIdentity(
      "https://forge.example.com",
      {
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://run-actions-1.actions.githubusercontent.com/token?api-version=2",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-secret",
      },
      async (url, options) => {
        expect(url.searchParams.get("audience")).toBe("https://forge.example.com");
        expect(options.headers.Authorization).toBe("Bearer runtime-secret");
        expect(options.redirect).toBe("error");
        return Response.json({ value: "signed.source.identity" });
      }
    );
    expect(value).toBe("signed.source.identity");
  });

  it("rejects an untrusted identity endpoint before sending the runtime token", async () => {
    let called = false;
    await expect(
      githubSourceIdentity(
        "https://forge.example.com",
        {
          ACTIONS_ID_TOKEN_REQUEST_URL:
            "https://actions.githubusercontent.com.attacker.example/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-secret",
        },
        async () => {
          called = true;
          return Response.json({ value: "signed.source.identity" });
        }
      )
    ).rejects.toThrow("endpoint");
    expect(called).toBe(false);
  });

  it("fails closed when identity configuration or its bounded response is invalid", async () => {
    await expect(
      githubSourceIdentity("https://forge.example.com", {
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret",
      })
    ).rejects.toThrow("incomplete");
    await expect(
      githubSourceIdentity(
        "https://forge.example.com",
        {
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret",
        },
        async () => new Response("x".repeat(65_537))
      )
    ).rejects.toThrow("invalid");
  });

  it.each([true, false])(
    "validates the downloaded archive before publishing it (digest matches: %s)",
    async (valid) => {
      const directory = await mkdtemp(path.join(tmpdir(), "signing-client-"));
      const bytes = Buffer.from("signed-archive");
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const state = { ...request, outputDigest: digest, outputSize: bytes.length };
      const client = signingRequestClient({
        origin: "https://forge.example.com",
        repositoryId,
        token: "secret",
        fetcher: async () =>
          new Response(valid ? bytes : Buffer.alloc(bytes.length), {
            headers: { "X-Signing-Digest": digest, "Content-Length": String(bytes.length) },
          }),
      });
      const target = path.join(directory, "output.zip");
      try {
        if (valid) {
          await expect(client.download(state, target)).resolves.toBe(target);
          expect(await readFile(target)).toEqual(bytes);
        } else {
          await expect(client.download(state, target)).rejects.toThrow("digest");
          expect(await readdir(directory)).toEqual([]);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
