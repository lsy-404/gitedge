import assert from "node:assert/strict";
import { createServer } from "node:http";
import { builtinModules, createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = path.join(root, "work");
await mkdir(work, { recursive: true });
const scratch = await mkdtemp(path.join(work, "auth-http-"));
const port = Number(process.env.GITEDGE_TEST_PORT ?? 8877);
assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, "Invalid test port");
let miniflare;
let server;

async function migrate(db, sql) {
  let statement = "";
  let trigger = false;
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (!statement && (!trimmed || trimmed.startsWith("--") || /^PRAGMA\b/i.test(trimmed)))
      continue;
    if (/^CREATE TRIGGER\b/i.test(trimmed)) trigger = true;
    statement += `${line}\n`;
    if ((trigger && /^END;?$/i.test(trimmed)) || (!trigger && trimmed.endsWith(";"))) {
      await db.prepare(statement).run();
      statement = "";
      trigger = false;
    }
  }
  if (statement.trim()) await db.prepare(statement).run();
}

try {
  const bundle = path.join(scratch, "worker.mjs");
  const buildOptions = {
    entryPoints: [path.join(root, "test/support/auth-http-worker.mjs")],
    outfile: bundle,
    bundle: true,
    platform: "browser",
    plugins: [
      {
        name: "node-builtins",
        setup(builder) {
          builder.onResolve({ filter: /^[a-z][a-z0-9_/-]*$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined
          );
        },
      },
    ],
    format: "esm",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*", "cloudflare:*"],
    logLevel: "silent",
  };
  const preview = await build({ ...buildOptions, write: false });
  const requires = [
    ...new Set(
      Array.from(
        preview.outputFiles[0].text.matchAll(/__require\("(node:[^"\n]+)"\)/g),
        (match) => match[1]
      )
    ),
  ];
  const imports = requires
    .map((name, i) => `import * as builtin${i} from ${JSON.stringify(name)};`)
    .join("\n");
  const entries = requires.map((name, i) => `${JSON.stringify(name)}: builtin${i}`).join(",");
  await build({
    ...buildOptions,
    banner: { js: `${imports}\nconst require = (name) => ({${entries}})[name];` },
  });
  miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: bundle,
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      d1Persist: false,
      bindings: {
        ALLOW_PUBLIC_SIGNUP: "true",
        DEFAULT_USER_GROUP: "free",
        SSO_PROVIDERS_JSON: "[]",
      },
    })
  );
  const db = await miniflare.getD1Database("DB");
  const migrations = path.join(root, "migrations");
  for (const name of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort()) {
    await migrate(db, await readFile(path.join(migrations, name), "utf8"));
  }
  server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const host = incoming.headers.host;
      if (
        host !== `127.0.0.1:${server.address().port}` &&
        host !== `localhost:${server.address().port}`
      ) {
        outgoing.writeHead(400).end();
        return;
      }
      const url = `http://${host}${incoming.url}`;
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const body = Buffer.concat(chunks);
      const result = await miniflare.dispatchFetch(url, {
        method: incoming.method,
        headers,
        ...(body.length ? { body } : {}),
      });
      const responseHeaders = Object.fromEntries(result.headers);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) responseHeaders["set-cookie"] = cookies;
      outgoing.writeHead(result.status, responseHeaders);
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      outgoing.writeHead(500).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(`Auth test host ready at http://127.0.0.1:${server.address().port}`);
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (miniflare) await miniflare.dispose();
  await rm(scratch, { recursive: true, force: true });
}
