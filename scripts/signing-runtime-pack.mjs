import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = "scripts/signing";
const extraFiles = ["packages/contracts/signing-native.mjs"];
// request.mjs is the submit client used by source workflows; the runner never executes it.
const closureRoots = ["scripts/signing/client.mjs", ...extraFiles];
const importPattern =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\bexport\s+\*\s+from\s*)["'](\.{1,2}\/[^"']+)["']/g;

function walk(root, directory) {
  const found = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(root, path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function assertImportClosure(root, included) {
  const pending = [...closureRoots];
  const seen = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    if (!/\.(?:mjs|js)$/.test(path)) continue;
    const source = readFileSync(join(root, path), "utf8");
    for (const match of source.matchAll(importPattern)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1]));
      if (!included.has(target))
        throw new Error(
          `${path} imports ${match[1]}, which is outside the signing runtime bundle.`
        );
      pending.push(target);
    }
  }
}

export function packSigningRuntime({ root = repositoryRoot } = {}) {
  const paths = [
    ...new Set([
      ...walk(root, runtimeDirectory),
      ...extraFiles.filter((p) => existsSync(join(root, p))),
    ]),
  ].sort();
  if (paths.length === 0 || extraFiles.some((path) => !paths.includes(path)))
    throw new Error("The signing runtime sources are missing.");
  assertImportClosure(root, new Set(paths));
  const files = paths.map((path) => {
    const raw = readFileSync(join(root, path));
    // Normalize checkout line endings so every machine produces the same digest.
    const bytes = raw.includes(0)
      ? raw
      : Buffer.from(raw.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
    return {
      path,
      mode: bytes.subarray(0, 2).toString("latin1") === "#!" ? 0o755 : 0o644,
      data: bytes.toString("base64"),
    };
  });
  const bytes = gzipSync(Buffer.from(JSON.stringify({ format: 1, files })), { level: 9 });
  bytes[9] = 3; // zlib stamps the host OS into the header; pin it so the digest is platform independent
  const hex = createHash("sha256").update(bytes).digest("hex");
  return { bytes, hex, digest: `sha256:${hex}`, size: bytes.length };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const output = process.argv[2];
    const bundle = packSigningRuntime();
    if (output) writeFileSync(output, bundle.bytes);
    console.log(JSON.stringify({ digest: bundle.digest, size: bundle.size }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
