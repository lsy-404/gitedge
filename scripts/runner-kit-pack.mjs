import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestDirectory = "packages/runner-kit";
const directories = ["scripts/signing", "scripts/runner-vm", "scripts/runner-colab"];
const topLevelScripts = /^(?:runner-.+|actions-runner\.mjs|secure-runner-context\.ps1)$/;
const contractFiles = [
  "packages/contracts/runner-scheduling.mjs",
  "packages/contracts/signing-native.mjs",
];
// Entry points the launcher, broker and jobs execute; everything they import must ship in the kit.
const closureRoots = [
  "scripts/runner-launcher.mjs",
  "scripts/runner-broker.mjs",
  "scripts/runner-broker-service.mjs",
  "scripts/runner-gpu-probe.mjs",
  "scripts/actions-runner.mjs",
  "scripts/runner-vm/guest.mjs",
  "scripts/signing/client.mjs",
];
const relativeImport =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\bexport\s+\*\s+from\s*)["'](\.{1,2}\/[^"']+)["']/g;
const bareImport =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*|\bimport\s+)["']((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)(?:\/[^"']*)?["']/g;
const builtins = new Set(builtinModules);

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

function assertImportClosure(root, included, dependencies) {
  const pending = [...closureRoots];
  const seen = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    if (!included.has(path)) throw new Error(`${path} is missing from the runner kit.`);
    if (!/\.(?:mjs|js)$/.test(path)) continue;
    const source = readFileSync(join(root, path), "utf8");
    for (const match of source.matchAll(relativeImport)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1]));
      if (!included.has(target))
        throw new Error(`${path} imports ${match[1]}, which is outside the runner kit.`);
      pending.push(target);
    }
    for (const match of source.matchAll(bareImport)) {
      const name = match[1];
      if (name.startsWith("node:") || builtins.has(name)) continue;
      if (!dependencies.has(name))
        throw new Error(`${path} imports ${name}, which ${manifestDirectory} does not declare.`);
    }
  }
}

function normalized(root, path) {
  const raw = readFileSync(join(root, path));
  // Normalize checkout line endings so every machine produces the same digest.
  return raw.includes(0)
    ? raw
    : Buffer.from(raw.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
}

export function packRunnerKit({ root = repositoryRoot } = {}) {
  const sources = new Map([
    ["package.json", `${manifestDirectory}/package.json`],
    ["pnpm-lock.yaml", `${manifestDirectory}/pnpm-lock.yaml`],
  ]);
  for (const directory of directories)
    for (const path of walk(root, directory)) sources.set(path, path);
  for (const entry of readdirSync(join(root, "scripts"), { withFileTypes: true }))
    if (entry.isFile() && topLevelScripts.test(entry.name))
      sources.set(`scripts/${entry.name}`, `scripts/${entry.name}`);
  for (const path of contractFiles) sources.set(path, path);
  const manifest = JSON.parse(readFileSync(join(root, manifestDirectory, "package.json"), "utf8"));
  assertImportClosure(
    root,
    new Set(sources.keys()),
    new Set(Object.keys(manifest.dependencies ?? {}))
  );
  const files = [...sources.keys()].sort().map((path) => {
    const bytes = normalized(root, sources.get(path));
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
    const kit = packRunnerKit();
    if (output) writeFileSync(output, kit.bytes);
    console.log(JSON.stringify({ digest: kit.digest, size: kit.size }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
