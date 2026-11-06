import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer, Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { DOMParser } from "@xmldom/xmldom";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";

const service = "/twirp/github.actions.results.api.v1.CacheService/";
const issuer = "https://token.actions.githubusercontent.com";
const scopeSchema = z
  .array(
    z.object({ Scope: z.string().min(1).max(256), Permission: z.number().int().min(0).max(3) })
  )
  .min(1)
  .max(16);
const keySchema = z.object({
  key: z.string().min(1).max(512),
  version: z.string().min(1).max(128),
});
const lookupSchema = keySchema.extend({
  restore_keys: z.array(z.string().min(1).max(512)).max(32).default([]),
});
const finalizeSchema = keySchema.extend({
  size_bytes: z
    .string()
    .regex(/^\d{1,16}$/)
    .transform(Number)
    .refine(Number.isSafeInteger),
});
const blobId = /^[0-9a-f-]{36}$/;

function json(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function body(request, maximum = 65_536) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximum) throw new Error("Request body exceeds its limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function drain(request) {
  for await (const chunk of request) void chunk;
}

function agents(proxy, bypass = []) {
  const inherited = proxy
    ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: "127.0.0.1,localhost,::1" }
    : process.env;
  const noProxy = [
    ...new Set([...(inherited.NO_PROXY ?? inherited.no_proxy ?? "").split(","), ...bypass]),
  ].join(",");
  const proxyEnv = { ...inherited, NO_PROXY: noProxy, no_proxy: noProxy };
  return {
    http: new HttpAgent({ keepAlive: true, proxyEnv }),
    https: new HttpsAgent({ keepAlive: true, proxyEnv }),
  };
}

function outbound(url, options, pool) {
  return url.protocol === "https:"
    ? httpsRequest(url, { ...options, agent: pool.https })
    : httpRequest(url, { ...options, agent: pool.http });
}

function headersForProxy(headers) {
  const connectionHeaders = String(headers.connection ?? "")
    .toLowerCase()
    .split(",")
    .map((name) => name.trim());
  const excluded = new Set([
    "host",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...connectionHeaders,
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase()))
  );
}

async function relay(request, response, url, pool) {
  const abort = () => upstream.destroy();
  const upstream = outbound(
    url,
    { method: request.method, headers: headersForProxy(request.headers), timeout: 120_000 },
    pool
  );
  response.once("close", abort);
  upstream.once("timeout", () => upstream.destroy(new Error("Upstream request timed out.")));
  const incoming = once(upstream, "response");
  const upload = pipeline(request, upstream);
  try {
    const [reply] = await incoming;
    response.writeHead(reply.statusCode, headersForProxy(reply.headers));
    await Promise.all([upload, pipeline(reply, response)]);
  } finally {
    response.removeListener("close", abort);
    upstream.destroy();
    await upload.catch(() => {});
  }
}

function blockList(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("XML declarations are not allowed.");
  const errors = [];
  const document = new DOMParser({
    errorHandler: {
      warning: (value) => errors.push(value),
      error: (value) => errors.push(value),
      fatalError: (value) => errors.push(value),
    },
  }).parseFromString(source, "application/xml");
  const root = document.documentElement;
  if (errors.length || root?.nodeName !== "BlockList") throw new Error("Invalid block list.");
  const blocks = [];
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3 && !child.textContent.trim()) continue;
    if (
      child.nodeType !== 1 ||
      !["Latest", "Uncommitted", "Committed"].includes(child.nodeName) ||
      child.childNodes.length !== 1 ||
      child.firstChild.nodeType !== 3
    )
      throw new Error("Invalid block list element.");
    const id = child.textContent;
    if (!id || id.length > 128) throw new Error("Invalid block identifier.");
    blocks.push(id);
    if (blocks.length > 50_000) throw new Error("Too many cache blocks.");
  }
  return blocks;
}

async function serveBlob(request, response, url, session, store) {
  const id = url.pathname.split("/").at(-1);
  if (!blobId.test(id)) throw new Error("Invalid cache object identifier.");
  if (session.discarded.has(id)) store = undefined;
  if (request.method === "PUT" && session.uploadIds.has(id)) {
    const length = Number(request.headers["content-length"]);
    if (!Number.isSafeInteger(length) || length < 0 || length > 64 * 1024 * 1024)
      throw new Error("Cache blocks require a bounded content length.");
    if (url.searchParams.get("comp") === "blocklist") {
      const blocks = blockList((await body(request, 4 * 1024 * 1024)).toString("utf8"));
      if (store) await store.commit(id, blocks);
    } else if (url.searchParams.get("comp") === "block") {
      const block = url.searchParams.get("blockid");
      if (!block || block.length > 128) throw new Error("Invalid cache block identifier.");
      if (store) await store.putBlock(id, block, request, length);
      else await drain(request);
    } else if (!url.searchParams.has("comp")) {
      if (store) {
        await store.putBlock(id, "single", request, length);
        await store.commit(id, ["single"]);
      } else await drain(request);
    } else throw new Error("Unsupported cache upload operation.");
    response.writeHead(201, {
      ETag: `"${id}"`,
      "x-ms-request-id": id,
      "x-ms-blob-type": "BlockBlob",
    });
    response.end();
    return;
  }
  if (["GET", "HEAD"].includes(request.method) && session.downloads.has(id) && store) {
    const entry = session.downloads.get(id);
    let start = 0,
      end = entry.bytes - 1;
    const range = request.headers.range ?? request.headers["x-ms-range"];
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        response.writeHead(416);
        response.end();
        return;
      }
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= entry.bytes
      ) {
        response.writeHead(416, { "Content-Range": `bytes */${entry.bytes}` });
        response.end();
        return;
      }
      end = Math.min(end, entry.bytes - 1);
    }
    const opened = await store.read(id, { start, end });
    response.writeHead(range ? 206 : 200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": Math.max(0, end - start + 1),
      "Accept-Ranges": "bytes",
      "x-ms-blob-type": "BlockBlob",
      ETag: `"${id}"`,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${entry.bytes}` } : {}),
    });
    if (request.method === "HEAD") {
      opened.stream.destroy();
      response.end();
    } else await pipeline(opened.stream, response);
    return;
  }
  response.writeHead(404);
  response.end();
}

async function cacheRequest(request, response, url, session, store, authorize) {
  if (url.pathname.startsWith("/blobs/")) return serveBlob(request, response, url, session, store);
  if (request.method !== "POST" || !url.pathname.startsWith(service)) {
    response.writeHead(404);
    response.end();
    return;
  }
  if (!request.headers["content-type"]?.startsWith("application/json"))
    return json(
      response,
      { code: "invalid_argument", msg: "The cache endpoint requires JSON requests." },
      415
    );
  const method = url.pathname.slice(service.length);
  const payload = JSON.parse((await body(request)).toString("utf8"));
  const scopes = store ? await authorize(request, session) : [{ Scope: "discard", Permission: 3 }];
  if (method === "GetCacheEntryDownloadURL") {
    const input = lookupSchema.parse(payload);
    const entry = store
      ? await store.lookup({
          runner: session.runner,
          repository: session.repository,
          scopes: scopes
            .filter((scope) => scope.Permission & 1)
            .sort((a, b) => b.Permission - a.Permission)
            .map((scope) => scope.Scope),
          key: input.key,
          version: input.version,
          restoreKeys: input.restore_keys,
        })
      : null;
    if (!entry) return json(response, { ok: false });
    if (session.downloads.size >= 1024)
      session.downloads.delete(session.downloads.keys().next().value);
    session.downloads.set(entry.id, entry);
    return json(response, {
      ok: true,
      matched_key: entry.key,
      signed_download_url: `${session.url}blobs/${entry.id}`,
    });
  }
  const scope = scopes.find((value) => value.Permission & 2)?.Scope;
  if (!scope)
    return json(response, { code: "permission_denied", msg: "No writable cache scope." }, 403);
  if (method === "CreateCacheEntry") {
    const input = keySchema.parse(payload);
    if (session.uploadIds.size >= 128) throw new Error("Too many cache uploads in one job.");
    const identity = JSON.stringify([scope, input.key, input.version]);
    if (session.uploads.has(identity))
      return json(response, { code: "already_exists", msg: "Cache upload already exists." }, 409);
    let entry;
    try {
      entry = store
        ? await store.create({
            runner: session.runner,
            repository: session.repository,
            scope,
            ...input,
            expiresAt: session.expiresAt,
          })
        : { id: randomUUID() };
    } catch (error) {
      if (/already exists/i.test(error.message))
        return json(response, { code: "already_exists", msg: "Cache entry already exists." }, 409);
      if (error.message !== "Cache metadata capacity is full.") throw error;
      entry = { id: randomUUID() };
      session.discarded.add(entry.id);
    }
    session.uploads.set(identity, entry.id);
    session.uploadIds.add(entry.id);
    return json(response, { ok: true, signed_upload_url: `${session.url}blobs/${entry.id}` });
  }
  if (method === "FinalizeCacheEntryUpload") {
    const input = finalizeSchema.parse(payload);
    const id = session.uploads.get(JSON.stringify([scope, input.key, input.version]));
    if (!id) return json(response, { code: "not_found", msg: "Cache upload not found." }, 404);
    if (store && !session.finalized.has(id) && !session.discarded.has(id))
      await store.finalize(id, input.size_bytes);
    session.finalized.add(id);
    return json(response, {
      ok: true,
      entry_id: String(
        parseInt(createHash("sha256").update(id).digest("hex").slice(0, 12), 16) + 1
      ),
    });
  }
  return json(response, { code: "bad_route", msg: "Unknown cache method." }, 404);
}

function sessionState(values) {
  return {
    ...values,
    uploads: new Map(),
    uploadIds: new Set(),
    downloads: new Map(),
    discarded: new Set(),
    finalized: new Set(),
    requests: new Set(),
    operations: new Set(),
  };
}

class CacheAuthenticationError extends Error {}

function handlerError(response, error) {
  if (response.headersSent) return response.destroy();
  if (error instanceof CacheAuthenticationError)
    return json(response, { code: "unauthenticated", msg: "Invalid cache runtime identity." }, 401);
  const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
  json(
    response,
    {
      code: invalid ? "invalid_argument" : "internal",
      msg: invalid ? "Invalid cache request." : "Cache request could not complete.",
    },
    invalid ? 400 : 500
  );
  if (!invalid)
    console.error(
      JSON.stringify({ event: "runner-cache-request-failed", error: error.code ?? error.name })
    );
}

export async function createRunnerCacheServer({ store, address, port, proxy }) {
  const sessions = new Map();
  const pool = agents(proxy);
  const keySet = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`), {
    [customFetch]: async (url, options) => {
      const request = outbound(
        new URL(url),
        { method: "GET", signal: options.signal, headers: options.headers },
        pool
      );
      const incoming = once(request, "response");
      request.end();
      const [reply] = await incoming;
      return new Response(await body(reply, 256 * 1024), {
        status: reply.statusCode,
        headers: headersForProxy(reply.headers),
      });
    },
  });
  const authorize = async (request, session) => {
    if (session.kind === "gitedge") return [{ Scope: session.ref, Permission: 3 }];
    try {
      const token = /^Bearer ([^\s]{1,32768})$/i.exec(request.headers.authorization ?? "")?.[1];
      if (!token) throw new CacheAuthenticationError();
      const { payload } = await jwtVerify(token, keySet, {
        issuer,
        requiredClaims: ["exp", "iss", "repository_id", "ac"],
        algorithms: ["RS256", "ES256"],
      });
      if (String(payload.repository_id) !== String(session.githubRepositoryId))
        throw new CacheAuthenticationError();
      return scopeSchema.parse(JSON.parse(z.string().max(16_384).parse(payload.ac)));
    } catch {
      throw new CacheAuthenticationError();
    }
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, "http://cache.local");
      const match = /^\/sessions\/([0-9a-f]{64})(\/.*)$/.exec(url.pathname);
      const session = match && sessions.get(match[1]);
      const source = request.socket.remoteAddress?.replace(/^::ffff:/, "");
      if (!session || session.expiresAt <= Date.now() || source !== session.address) {
        response.writeHead(403);
        response.end();
        request.resume();
        return;
      }
      url.pathname = match[2];
      session.requests.add(request);
      const operation = cacheRequest(request, response, url, session, store, authorize);
      session.operations.add(operation);
      try {
        await operation;
      } finally {
        session.requests.delete(request);
        session.operations.delete(operation);
      }
    })().catch((error) => handlerError(response, error));
  });
  server.requestTimeout = 5 * 60_000;
  server.headersTimeout = 15_000;
  server.listen(port, address);
  await once(server, "listening");
  const closeSession = async (token, session) => {
    sessions.delete(token);
    for (const request of session.requests) request.destroy();
    await Promise.allSettled([...session.operations]);
    for (const id of session.uploadIds) await store.discard(id);
  };
  return {
    createSession(values) {
      const token = randomBytes(32).toString("hex");
      const url = `http://${address}:${server.address().port}/sessions/${token}/`;
      const session = sessionState({ ...values, url });
      sessions.set(token, session);
      return {
        url,
        close: () => closeSession(token, session),
      };
    },
    async close() {
      server.closeAllConnections();
      for (const [token, session] of sessions) await closeSession(token, session);
      await new Promise((resolve) => server.close(resolve));
      pool.http.destroy();
      pool.https.destroy();
    },
  };
}

export async function createRunnerCacheProxy({
  endpoint,
  upstream = "https://results-receiver.actions.githubusercontent.com/",
} = {}) {
  const pool = agents(undefined, endpoint ? [new URL(endpoint).hostname] : []);
  const session = sessionState({ url: "" });
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, "http://cache.local");
      if (url.pathname.startsWith(service) || url.pathname.startsWith("/blobs/")) {
        if (endpoint)
          return relay(
            request,
            response,
            new URL(url.pathname.slice(1) + url.search, endpoint),
            pool
          );
        return cacheRequest(request, response, url, session, undefined);
      }
      if (!url.pathname.startsWith("/twirp/")) {
        response.writeHead(404);
        response.end();
        request.resume();
        return;
      }
      return relay(request, response, new URL(url.pathname.slice(1) + url.search, upstream), pool);
    })().catch((error) => handlerError(response, error));
  });
  server.requestTimeout = 5 * 60_000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  session.url = `http://127.0.0.1:${server.address().port}/`;
  return {
    url: session.url,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      pool.http.destroy();
      pool.https.destroy();
    },
  };
}
