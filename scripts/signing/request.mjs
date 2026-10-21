import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  SIGNING_MAX_ARCHIVE_BYTES,
  SigningRequestSchema,
  SigningSubmissionSchema,
} from "../../packages/contracts/src/signing.ts";

export function signingRequestClient({ origin, repositoryId, token, fetcher = fetch }) {
  const base = new URL(origin);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error("Use the HTTPS Gateway origin.");
  if (!/^[0-9a-f-]{36}$/.test(repositoryId) || !token || /[\r\n]/.test(token))
    throw new Error("A Runner repository ID and scoped credential are required.");
  const endpoint = (suffix) => {
    const url = new URL(`/api/actions/signing/requests${suffix}`, base);
    url.searchParams.set("repositoryId", repositoryId);
    return url;
  };
  const headers = () => ({ Authorization: `Bearer ${token}` });
  async function json(url, init) {
    const response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Signing request failed (HTTP ${response.status}).`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Signing returned no response.");
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 65_536) {
          await reader.cancel();
          throw new Error("Signing response exceeds its limit.");
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value.data;
  }
  function requestId(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid signing request ID.");
    return id;
  }
  return {
    async submit(raw, idempotencyKey) {
      const input = SigningSubmissionSchema.parse(raw);
      if (!/^[A-Za-z0-9_.-]{16,128}$/.test(idempotencyKey))
        throw new Error("Invalid idempotency key.");
      const result = await json(endpoint(""), {
        method: "POST",
        headers: {
          ...headers(),
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(input),
      });
      return SigningRequestSchema.parse(result.request);
    },
    async status(id) {
      return SigningRequestSchema.parse(
        await json(endpoint(`/${requestId(id)}`), { headers: headers() })
      );
    },
    async download(request, output) {
      const state = SigningRequestSchema.parse(request);
      if (
        state.state !== "succeeded" ||
        !state.outputDigest ||
        !state.outputSize ||
        state.outputSize > SIGNING_MAX_ARCHIVE_BYTES
      )
        throw new Error("Signing output is not ready.");
      const response = await fetcher(endpoint(`/${requestId(state.id)}/download`), {
        headers: headers(),
        redirect: "error",
        signal: AbortSignal.timeout(30 * 60_000),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Signing download failed (HTTP ${response.status}).`);
      }
      if (
        response.headers.get("X-Signing-Digest") !== state.outputDigest ||
        response.headers.get("Content-Length") !== String(state.outputSize)
      ) {
        await response.body.cancel();
        throw new Error("Signing output metadata does not match the request.");
      }
      const target = path.resolve(output);
      const temporary = `${target}.${crypto.randomUUID()}.partial`;
      const hash = createHash("sha256");
      let bytes = 0;
      const verifier = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > state.outputSize)
            return callback(new Error("Signing output exceeds its declared size."));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(response.body),
          verifier,
          createWriteStream(temporary, { flags: "wx", mode: 0o600 })
        );
        if (bytes !== state.outputSize || `sha256:${hash.digest("hex")}` !== state.outputDigest)
          throw new Error("Signing output digest does not match the request.");
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      return target;
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      origin: { type: "string" },
      repository: { type: "string" },
      input: { type: "string" },
      request: { type: "string" },
      output: { type: "string" },
      "idempotency-key": { type: "string" },
      "timeout-minutes": { type: "string", default: "60" },
    },
  });
  const client = signingRequestClient({
    origin: values.origin,
    repositoryId: values.repository,
    token: process.env.GITEDGE_SIGNING_TOKEN,
  });
  const command = positionals[0];
  let state;
  if (command === "submit") {
    const info = await stat(values.input);
    if (!info.isFile() || info.size > 65_536) throw new Error("Signing input exceeds its limit.");
    const input = await readFile(values.input);
    if (input.length > 65_536) throw new Error("Signing input exceeds its limit.");
    state = await client.submit(JSON.parse(input.toString("utf8")), values["idempotency-key"]);
  } else if (["status", "download", "wait"].includes(command)) {
    state = await client.status(values.request);
    if (command === "wait") {
      const minutes = Number(values["timeout-minutes"]);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 360)
        throw new Error("Invalid wait timeout.");
      const deadline = Date.now() + minutes * 60_000;
      while (!["succeeded", "failed", "cancelled"].includes(state.state)) {
        if (Date.now() >= deadline) throw new Error("Signing wait timed out.");
        await delay(10_000);
        state = await client.status(values.request);
      }
      if (state.state !== "succeeded") throw new Error(`Signing ended with state ${state.state}.`);
    }
    if ((command === "download" || command === "wait") && values.output)
      await client.download(state, values.output);
    else if (command === "download") throw new Error("An output path is required.");
  } else throw new Error("Use submit, status, wait or download.");
  process.stdout.write(`${JSON.stringify(state)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Signing client failed."}\n`);
    process.exitCode = 1;
  });
}
