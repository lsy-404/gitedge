#!/usr/bin/env node
import { experimental_readRawConfig } from "wrangler";
import { finished } from "node:stream/promises";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOperatorConfig,
  productionConfigPath,
  writeProductionConfigs,
} from "./operator-config.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDb = "gitedge";
const authConfig = productionConfigPath("auth");
const forgeConfig = productionConfigPath("forge");
const manifestName = "manifest.json";
const queryPageSize = 500;
const maximumRows = 50_000;
const maximumRefOutputBytes = 8 * 1024 * 1024;

function usage() {
  console.log(`GitEdge backup and isolated recovery rehearsal

Usage:
  pnpm run recovery -- backup --output <new-directory> --base-url <https://host>
  pnpm run recovery -- verify --backup <directory>
  pnpm run recovery -- rehearse --backup <directory> --destination-db <name> --destination-config <wrangler.jsonc> --destination-base-url <https://host> --destination-release-bucket <bucket> --destination-account-id <id> --destination-artifacts-namespace <namespace>

Backup uses Wrangler and CLOUDFLARE_API_TOKEN. It mints short-lived read-only Artifacts tokens in memory and revokes them after each mirror. Credentials never enter arguments, URLs, or the manifest. The rehearsal writes only to explicitly named destination resources and refuses the source database, source bucket, and source host.`);
}

function options(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    parsed[key.slice(2).replaceAll("-", "_")] = value;
    i += 1;
  }
  return parsed;
}

function required(opts, name) {
  const value = opts[name];
  if (!value) throw new Error(`Required option --${name.replaceAll("_", "-")}`);
  return value;
}

function configAt(path) {
  return experimental_readRawConfig({ config: path }).rawConfig;
}

async function containedPath(directory, path) {
  const base = await realpath(directory);
  const target = await realpath(resolve(directory, path));
  if (!target.startsWith(base + sep)) throw new Error(`Unsafe backup path: ${path}`);
  return target;
}

function safeUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(`${name} must be HTTPS without credentials, query, or fragment`);
  return url.origin;
}

function sanitize(value) {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^/\s:@]+:[^@\s/]+@/gi, "https://[redacted]@")
    .replace(/https?:\/\/[^\s?#]+[?#][^\s]*/gi, "[URL]");
}

function run(command, args, { cwd = root, stdoutFile, env = process.env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const out = stdoutFile ? createWriteStream(stdoutFile, { flags: "wx" }) : process.stdout;
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", stdoutFile ? "pipe" : "inherit", "pipe"],
      env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    if (stdoutFile) child.stdout.pipe(out);
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code === 0) {
        if (stdoutFile) {
          try {
            await finished(out);
          } catch (error) {
            reject(error);
            return;
          }
        }
        resolvePromise();
      } else reject(new Error(`${command} failed (${code}): ${sanitize(stderr)}`));
    });
  });
}

async function wrangler(args, outputFile, accountId = configAt(authConfig).account_id) {
  await run("pnpm", ["exec", "wrangler", ...args], {
    stdoutFile: outputFile,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function addFile(manifest, backupDir, path, kind, metadata = {}) {
  const info = await stat(path);
  manifest.files.push({
    path: relative(backupDir, path).split(sep).join("/"),
    bytes: info.size,
    sha256: await sha256(path),
    kind,
    ...metadata,
  });
}

async function queryPage(config, sql, database = sourceDb) {
  const args = [
    "d1",
    "execute",
    database,
    "--remote",
    "--json",
    "--command",
    sql,
    "--config",
    config,
  ];
  const child = spawn("pnpm", ["exec", "wrangler", ...args], {
    cwd: root,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: configAt(config).account_id },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", resolvePromise);
  });
  if (code !== 0)
    throw new Error(`Wrangler D1 query failed (${code}): ${sanitize(stderr.slice(-4000))}`);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Wrangler D1 JSON response could not be parsed");
  }
  const resultSets = Array.isArray(parsed) ? parsed : [parsed];
  return resultSets.flatMap((result) => result?.results ?? result?.result?.results ?? []);
}

async function queryAll(config, sql, database = sourceDb) {
  const rows = [];
  for (let offset = 0; ; offset += queryPageSize) {
    const page = await queryPage(
      config,
      `${sql} LIMIT ${queryPageSize} OFFSET ${offset}`,
      database
    );
    rows.push(...page);
    if (rows.length > maximumRows)
      throw new Error(`D1 inventory exceeds ${maximumRows} rows; refusing an incomplete backup`);
    if (page.length < queryPageSize) return rows;
  }
}

async function snapshotRows() {
  const repos = await queryAll(
    authConfig,
    "SELECT r.id, n.slug AS namespace, r.slug, r.artifact_name, r.default_branch, r.updated_at FROM repositories r JOIN namespaces n ON n.id = r.namespace_id WHERE r.artifact_name IS NOT NULL ORDER BY r.id"
  );
  const sessions = await queryAll(
    authConfig,
    "SELECT s.id, s.repository_id, s.workspace_name, s.remote, s.status, s.expires_at FROM auth_agent_sessions s JOIN repositories r ON r.id = s.repository_id WHERE r.artifact_name IS NOT NULL ORDER BY s.id"
  );
  const assets = await queryAll(
    authConfig,
    "SELECT id, repository_id, size, repository_id || '/' || id AS object_key, 'release-asset' AS kind FROM forge_release_assets UNION ALL SELECT run_id || ':' || name AS id, repository_id, size, object_key, 'action-artifact' AS kind FROM actions_run_artifacts UNION ALL SELECT cache_key AS id, repository_id, size, object_key, 'action-cache' AS kind FROM actions_cache_entries ORDER BY kind, id"
  );
  return { repositories: repos, sessions, assets };
}

function remoteUrl(value, label) {
  safeUrl(value, label);
  return value;
}

async function artifactInfo(accountId, namespace, repo) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/artifacts/namespaces/${encodeURIComponent(namespace)}`;
  const response = await fetch(`${base}/repos/${encodeURIComponent(repo)}`, {
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success || !payload.result?.remote)
    throw new Error(`Artifacts repository lookup failed (${response.status})`);
  return {
    remote: remoteUrl(payload.result.remote, "Artifacts remote"),
    defaultBranch: payload.result.default_branch,
  };
}

async function artifactToken(accountId, namespace, repo, scope) {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) throw new Error("Set CLOUDFLARE_API_TOKEN with Artifacts read/edit permission");
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/artifacts/namespaces/${encodeURIComponent(namespace)}`;
  const response = await fetch(`${base}/tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ repo, scope, ttl: 600 }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success || !payload.result?.plaintext || !payload.result?.id)
    throw new Error(`Artifacts ${scope} token request failed with HTTP ${response.status}`);
  return { token: payload.result.plaintext, id: payload.result.id, base };
}

async function revokeArtifactToken(token) {
  const response = await fetch(`${token.base}/tokens/${encodeURIComponent(token.id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
  });
  if (!response.ok)
    throw new Error(`Artifacts temporary token revoke failed with HTTP ${response.status}`);
}

async function cloneArtifact(remote, dir, accountId, namespace, repo) {
  const token = await artifactToken(accountId, namespace, repo, "read");
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.token}`,
  };
  delete env.CLOUDFLARE_API_TOKEN;
  try {
    await run("git", ["clone", "--mirror", remote, dir], { env });
    await run("git", ["-C", dir, "fsck", "--full"]);
  } finally {
    delete env.GIT_CONFIG_VALUE_0;
    await revokeArtifactToken(token);
  }
}

async function backup(opts) {
  const output = resolve(required(opts, "output"));
  const sourceHost = safeUrl(required(opts, "base_url"), "--base-url");
  if (!process.env.CLOUDFLARE_ACCOUNT_ID)
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID for the configured Cloudflare account");
  if (!process.env.CLOUDFLARE_API_TOKEN)
    throw new Error("Set CLOUDFLARE_API_TOKEN with Artifacts token creation/read access");
  const sourceConfig = configAt(authConfig);
  const configuredAccountId = sourceConfig.account_id;
  if (configuredAccountId !== process.env.CLOUDFLARE_ACCOUNT_ID)
    throw new Error("CLOUDFLARE_ACCOUNT_ID does not match the source Wrangler config");
  await mkdir(output, { recursive: false, mode: 0o700 });
  const backupDir = output;
  const startedAt = new Date().toISOString();
  const before = await snapshotRows();
  const manifest = {
    format: "gitedge-backup-v1",
    source: {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      artifactsNamespace: sourceConfig.artifacts.find((binding) => binding.binding === "ARTIFACTS")
        .namespace,
      database: sourceDb,
      releaseBucket: "gitedge-release-assets",
      baseUrl: sourceHost,
    },
    d1TimeTravelBookmark: null,
    startedAt,
    completedAt: null,
    consistency: {
      atomic: false,
      changedDuringBackup: false,
      incomplete: [],
      repositoryMapping: [],
    },
    files: [],
  };

  const initialSources = new Map();
  for (const item of [
    ...before.repositories.map((repo) => ({ id: repo.id, name: repo.artifact_name })),
    ...before.sessions.map((session) => ({ id: session.id, name: session.workspace_name })),
  ]) {
    try {
      if (!item.name) throw new Error("Repository has no Artifacts mapping");
      const info = await artifactInfo(
        manifest.source.accountId,
        manifest.source.artifactsNamespace,
        item.name
      );
      const refs = await readArtifactRefs(
        info.remote,
        manifest.source.accountId,
        manifest.source.artifactsNamespace,
        item.name
      );
      initialSources.set(item.id, { ...info, refs });
    } catch (error) {
      manifest.consistency.incomplete.push({
        kind: "initial-ref-inventory",
        id: item.id,
        reason: sanitize(error.message).slice(0, 500),
      });
    }
  }
  const sqlPath = join(backupDir, "database.sql");
  await wrangler([
    "d1",
    "export",
    sourceDb,
    "--remote",
    "--config",
    authConfig,
    "--output",
    sqlPath,
    "--skip-confirmation",
  ]);
  await chmod(sqlPath, 0o600);
  if ((await stat(sqlPath)).size === 0) throw new Error("D1 export is empty");
  await addFile(manifest, backupDir, sqlPath, "d1-sql");
  const ttPath = join(backupDir, "time-travel.json");
  await wrangler(["d1", "time-travel", "info", sourceDb, "--json", "--config", authConfig], ttPath);
  await addFile(manifest, backupDir, ttPath, "d1-time-travel");
  manifest.d1TimeTravelBookmark = JSON.parse(await readFile(ttPath, "utf8"));
  const artifactMirrors = [];

  for (const repo of before.repositories) {
    const dir = join(backupDir, "git", "repositories", repo.id + ".git");
    await mkdir(dirname(dir), { recursive: true });
    const source = initialSources.get(repo.id)?.remote;
    try {
      if (!repo.artifact_name || !source)
        throw new Error("Repository metadata or initial refs are unavailable");
      await cloneArtifact(
        source,
        dir,
        manifest.source.accountId,
        manifest.source.artifactsNamespace,
        repo.artifact_name
      );
      const refs = await gitRefs(dir);
      manifest.consistency.repositoryMapping.push({
        repositoryId: repo.id,
        namespace: repo.namespace,
        slug: repo.slug,
        artifactName: repo.artifact_name,
        defaultBranch: repo.default_branch,
        mirror: relative(backupDir, dir).split(sep).join("/"),
        refs,
      });
      artifactMirrors.push({ id: repo.id, remote: source, repo: repo.artifact_name, refs });
    } catch (error) {
      manifest.consistency.incomplete.push({
        kind: "repository",
        id: repo.id,
        reason: sanitize(String(error.message)).slice(0, 500),
      });
    }
  }

  for (const session of before.sessions) {
    const dir = join(backupDir, "git", "sessions", session.id + ".git");
    await mkdir(dirname(dir), { recursive: true });
    try {
      const remote = initialSources.get(session.id)?.remote;
      if (!remote) throw new Error("Session fork metadata or initial refs are unavailable");
      await cloneArtifact(
        remote,
        dir,
        manifest.source.accountId,
        manifest.source.artifactsNamespace,
        session.workspace_name
      );
      const refs = await gitRefs(dir);
      manifest.consistency.repositoryMapping.push({
        sessionId: session.id,
        repositoryId: session.repository_id,
        workspaceName: session.workspace_name,
        defaultBranch: await gitDefaultBranch(dir),
        mirror: relative(backupDir, dir).split(sep).join("/"),
        refs,
      });
      artifactMirrors.push({ id: session.id, remote, repo: session.workspace_name, refs });
    } catch (error) {
      manifest.consistency.incomplete.push({
        kind: "agent-session-fork",
        id: session.id,
        reason: sanitize(String(error.message)).slice(0, 500),
      });
    }
  }

  for (const asset of before.assets) {
    const path = join(backupDir, "r2-objects", digest(asset.object_key));
    await mkdir(dirname(path), { recursive: true });
    try {
      await wrangler([
        "r2",
        "object",
        "get",
        `gitedge-release-assets/${asset.object_key}`,
        "--remote",
        "--file",
        path,
        "--config",
        forgeConfig,
      ]);
      const info = await stat(path);
      if (info.size !== asset.size)
        throw new Error(`expected ${asset.size} bytes, received ${info.size}`);
      await addFile(manifest, backupDir, path, asset.kind, {
        objectKey: asset.object_key,
        repositoryId: asset.repository_id,
        assetId: asset.id,
      });
    } catch (error) {
      manifest.consistency.incomplete.push({
        kind: asset.kind,
        id: asset.id,
        repositoryId: asset.repository_id,
        reason: sanitize(String(error.message)).slice(0, 500),
      });
    }
  }

  manifest.consistency.changedRefs = [];
  for (const mirror of artifactMirrors) {
    try {
      const refs = await readArtifactRefs(
        mirror.remote,
        manifest.source.accountId,
        manifest.source.artifactsNamespace,
        mirror.repo
      );
      if (
        JSON.stringify(refs) !== JSON.stringify(mirror.refs) ||
        JSON.stringify(initialSources.get(mirror.id)?.refs) !== JSON.stringify(mirror.refs)
      )
        manifest.consistency.changedRefs.push({
          id: mirror.id,
          refsAtCopy: mirror.refs,
          refsAtCheck: refs,
        });
    } catch (error) {
      manifest.consistency.incomplete.push({
        kind: "artifact-ref-recheck",
        id: mirror.id,
        reason: sanitize(String(error.message)).slice(0, 500),
      });
    }
  }
  const after = await snapshotRows();
  manifest.consistency.changedDuringBackup =
    JSON.stringify(before) !== JSON.stringify(after) || manifest.consistency.changedRefs.length > 0;
  manifest.consistency.snapshotFingerprintBefore = digest(JSON.stringify(before));
  manifest.consistency.snapshotFingerprintAfter = digest(JSON.stringify(after));
  manifest.completedAt = new Date().toISOString();
  await writeFile(join(backupDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(`Backup manifest: ${join(backupDir, manifestName)}`);
  console.log(
    `Files: ${manifest.files.length}; incomplete components: ${manifest.consistency.incomplete.length}; source changed during backup: ${manifest.consistency.changedDuringBackup}`
  );
  if (manifest.consistency.incomplete.length || manifest.consistency.changedDuringBackup)
    process.exitCode = 2;
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readArtifactRefs(remote, accountId, namespace, repo) {
  const token = await artifactToken(accountId, namespace, repo, "read");
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.token}`,
  };
  delete env.CLOUDFLARE_API_TOKEN;
  try {
    return await gitRemoteRefs(remote, env);
  } finally {
    delete env.GIT_CONFIG_VALUE_0;
    await revokeArtifactToken(token);
  }
}

async function gitRefs(dir) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", dir, "for-each-ref", "--format=%(refname) %(objectname)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > maximumRefOutputBytes) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(stdout.trim().split("\n").filter(Boolean))
        : reject(
            new Error(code === null ? "Git mirror ref inventory exceeded 8 MiB" : sanitize(stderr))
          )
    );
  });
}

async function gitDefaultBranch(dir) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", dir, "symbolic-ref", "HEAD"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`Git mirror has no symbolic HEAD: ${sanitize(stderr)}`));
      else resolvePromise(stdout.trim().replace(/^refs\/heads\//, ""));
    });
  });
}

async function verify(opts) {
  const backupDir = resolve(required(opts, "backup"));
  const manifest = JSON.parse(await readFile(join(backupDir, manifestName), "utf8"));
  if (manifest.format !== "gitedge-backup-v1")
    throw new Error("Unsupported backup manifest format");
  const problems = [];
  for (const file of manifest.files) {
    const path = await containedPath(backupDir, file.path);
    try {
      const info = await stat(path);
      if (info.size !== file.bytes || (await sha256(path)) !== file.sha256)
        problems.push(file.path);
      if (file.kind === "git-mirror") await run("git", ["-C", path, "fsck", "--full"]);
    } catch {
      problems.push(file.path);
    }
  }
  for (const item of manifest.consistency.repositoryMapping) {
    const path = await containedPath(backupDir, item.mirror);
    try {
      await run("git", ["-C", path, "fsck", "--full"]);
      if (JSON.stringify(await gitRefs(path)) !== JSON.stringify(item.refs))
        problems.push(item.mirror + " refs");
    } catch {
      problems.push(item.mirror + " git integrity");
    }
  }
  console.log(
    `Verified ${manifest.files.length} files; source snapshot ${manifest.startedAt} to ${manifest.completedAt}.`
  );
  if (problems.length) throw new Error(`Integrity failures: ${problems.join(", ")}`);
  if (manifest.consistency.incomplete.length || manifest.consistency.changedDuringBackup)
    throw new Error("Backup is intact but incomplete or inconsistent; see manifest.consistency");
}

async function rehearse(opts) {
  const backupDir = resolve(required(opts, "backup"));
  const destinationDb = required(opts, "destination_db");
  const destinationConfig = resolve(required(opts, "destination_config"));
  const destinationHost = safeUrl(required(opts, "destination_base_url"), "--destination-base-url");
  const destinationBucket = required(opts, "destination_release_bucket");
  const destinationAccount = required(opts, "destination_account_id");
  const destinationNamespace = required(opts, "destination_artifacts_namespace");
  const manifest = JSON.parse(await readFile(join(backupDir, manifestName), "utf8"));
  if (destinationDb.toLowerCase() === sourceDb.toLowerCase())
    throw new Error("Refusing to restore into source database gitedge");
  const targetConfig = configAt(destinationConfig);
  const sourceConfig = configAt(authConfig);
  const sourceDbId = sourceConfig.d1_databases.find(
    (binding) => binding.database_name === sourceDb
  )?.database_id;
  const destinationDbId = targetConfig.d1_databases?.find(
    (binding) => binding.database_name === destinationDb
  )?.database_id;
  if (!destinationDbId || destinationDbId === sourceDbId)
    throw new Error("Destination config must bind a distinct named D1 database");
  if (targetConfig.account_id !== destinationAccount)
    throw new Error("Destination account must match its config");
  if (sourceConfig.account_id !== manifest.source.accountId)
    throw new Error("Source backup account differs from the source config");
  if (destinationHost === manifest.source.baseUrl)
    throw new Error("Refusing to push to source host");
  if (destinationBucket === manifest.source.releaseBucket || destinationBucket.includes("/"))
    throw new Error("Choose a distinct destination bucket name");
  if (
    destinationNamespace === manifest.source.artifactsNamespace ||
    !targetConfig.artifacts?.some((binding) => binding.namespace === destinationNamespace)
  )
    throw new Error("Destination config must bind a distinct Artifacts namespace");
  if (manifest.consistency.incomplete.length || manifest.consistency.changedDuringBackup)
    throw new Error(
      "Refusing rehearsal from an incomplete or changed snapshot; repair or take a clean backup first"
    );
  await verify({ backup: backupDir });
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) throw new Error("Set CLOUDFLARE_API_TOKEN with Artifacts edit permission");
  const destinationApiBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(destinationAccount)}/artifacts/namespaces/${encodeURIComponent(destinationNamespace)}`;
  const inventoryResponse = await fetch(`${destinationApiBase}/repos?limit=1`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const inventory = await inventoryResponse.json();
  if (!inventoryResponse.ok || !inventory.success || !Array.isArray(inventory.result))
    throw new Error(
      `Could not inspect destination Artifacts namespace (${inventoryResponse.status})`
    );
  if (inventory.result.length) throw new Error("Destination Artifacts namespace must be empty");
  const existingTables = await queryPage(
    destinationConfig,
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE '_cf_%' ORDER BY name LIMIT 1",
    destinationDb
  );
  if (existingTables.length) throw new Error("Destination D1 database must be empty");
  const sql = manifest.files.find((file) => file.kind === "d1-sql");
  if (!sql) throw new Error("Backup has no D1 export");
  await wrangler(
    [
      "d1",
      "execute",
      destinationDb,
      "--remote",
      "--config",
      destinationConfig,
      "--file",
      resolve(backupDir, sql.path),
    ],
    undefined,
    destinationAccount
  );
  const destinationSessionRemotes = [];
  for (const item of manifest.consistency.repositoryMapping) {
    const repoName = item.artifactName ?? item.workspaceName;
    const base = destinationApiBase;
    const response = await fetch(`${base}/repos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName, default_branch: item.defaultBranch }),
    });
    const created = await response.json();
    if (!response.ok || !created.success || !created.result?.remote || !created.result?.token)
      throw new Error(
        `Could not create fresh destination Artifacts repo ${repoName}; use an empty namespace (HTTP ${response.status})`
      );
    if (item.sessionId)
      destinationSessionRemotes.push({
        id: item.sessionId,
        remote: (() => {
          const parent = manifest.consistency.repositoryMapping.find(
            (entry) => !entry.sessionId && entry.repositoryId === item.repositoryId
          );
          if (!parent) throw new Error("The session parent is missing from the backup");
          const gatewayRemote = new URL(`/${parent.namespace}/${parent.slug}.git`, destinationHost);
          gatewayRemote.username = item.sessionId;
          return gatewayRemote.toString();
        })(),
      });
    const env = { ...process.env };
    delete env.CLOUDFLARE_API_TOKEN;
    try {
      const writeToken = await artifactToken(
        destinationAccount,
        destinationNamespace,
        repoName,
        "write"
      );
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.extraHeader";
      env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${writeToken.token}`;
      try {
        await run("git", ["push", "--mirror", created.result.remote], {
          cwd: resolve(backupDir, item.mirror),
          env,
        });
        const refs = await gitRemoteRefs(created.result.remote, env);
        if (JSON.stringify(refs) !== JSON.stringify(item.refs))
          throw new Error(`Destination refs differ for ${repoName}`);
      } finally {
        delete env.GIT_CONFIG_VALUE_0;
        await revokeArtifactToken(writeToken);
      }
    } finally {
      const tokensResponse = await fetch(
        `${base}/repos/${encodeURIComponent(repoName)}/tokens?state=active&per_page=100&page=1`,
        { headers: { Authorization: `Bearer ${apiToken}` } }
      );
      const tokensPayload = await tokensResponse.json();
      if (!tokensResponse.ok || !tokensPayload.success)
        throw new Error(
          `Could not enumerate destination repo tokens for revocation (${tokensResponse.status})`
        );
      for (const token of tokensPayload.result ?? []) {
        const revoked = await fetch(`${base}/tokens/${encodeURIComponent(token.id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        if (!revoked.ok)
          throw new Error(`Could not revoke destination repo token (${revoked.status})`);
      }
    }
  }
  for (let offset = 0; offset < destinationSessionRemotes.length; offset += 100) {
    const statements = destinationSessionRemotes
      .slice(offset, offset + 100)
      .map(
        ({ id, remote }) =>
          `UPDATE auth_agent_sessions SET remote=${sqlString(remote)} WHERE id=${sqlString(id)}`
      );
    await wrangler(
      [
        "d1",
        "execute",
        destinationDb,
        "--remote",
        "--config",
        destinationConfig,
        "--command",
        statements.join(";"),
      ],
      undefined,
      destinationAccount
    );
  }
  for (const file of manifest.files.filter((entry) =>
    ["release-asset", "action-artifact", "action-cache"].includes(entry.kind)
  )) {
    await wrangler(
      [
        "r2",
        "object",
        "put",
        `${destinationBucket}/${file.objectKey}`,
        "--remote",
        "--file",
        resolve(backupDir, file.path),
        "--config",
        destinationConfig,
      ],
      undefined,
      destinationAccount
    );
    const verificationPath = join(tmpdir(), `gitedge-asset-${digest(file.objectKey)}`);
    try {
      await wrangler(
        [
          "r2",
          "object",
          "get",
          `${destinationBucket}/${file.objectKey}`,
          "--remote",
          "--file",
          verificationPath,
          "--config",
          destinationConfig,
        ],
        undefined,
        destinationAccount
      );
      if ((await sha256(verificationPath)) !== file.sha256)
        throw new Error(`Destination release asset hash differs for ${file.assetId}`);
    } finally {
      await rm(verificationPath, { force: true });
    }
  }
  const restoredRepositories = await queryAll(
    destinationConfig,
    "SELECT id, artifact_name FROM repositories WHERE artifact_name IS NOT NULL ORDER BY id",
    destinationDb
  );
  const restoredSessions = await queryAll(
    destinationConfig,
    "SELECT id, workspace_name, remote FROM auth_agent_sessions ORDER BY id",
    destinationDb
  );
  for (const item of manifest.consistency.repositoryMapping) {
    const valid = !item.sessionId
      ? restoredRepositories.some(
          (row) => row.id === item.repositoryId && row.artifact_name === (item.artifactName ?? null)
        )
      : restoredSessions.some(
          (row) => row.id === item.sessionId && row.workspace_name === item.workspaceName
        );
    if (!valid)
      throw new Error(
        `Restored D1 mapping is missing or mismatched for ${item.repositoryId ?? item.sessionId}`
      );
  }
  for (const mapping of destinationSessionRemotes) {
    if (!restoredSessions.some((row) => row.id === mapping.id && row.remote === mapping.remote))
      throw new Error(`Restored agent-session remote is mismatched for ${mapping.id}`);
  }
  console.log(
    `D1, Git refs, and release asset rehearsal writes completed for destination ${destinationDb} at ${destinationHost}; perform the mapping and application checks in docs/operations.md.`
  );
}

async function gitRemoteRefs(remote, env) {
  const output = await new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["ls-remote", "--refs", remote], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > maximumRefOutputBytes) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(stdout)
        : reject(
            new Error(
              code === null
                ? "Remote ref inventory exceeded 8 MiB"
                : `git ls-remote failed (${code}): ${sanitize(stderr)}`
            )
          )
    );
  });
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [oid, ref] = line.split("\t");
      return `${ref} ${oid}`;
    })
    .sort();
}

try {
  const cliArgs = process.argv.slice(2);
  if (cliArgs[0] === "--") cliArgs.shift();
  const [command, ...args] = cliArgs;
  if (!command || command === "help" || command === "--help") usage();
  else if (command === "backup") {
    writeProductionConfigs(loadOperatorConfig());
    await backup(options(args));
  } else if (command === "verify") await verify(options(args));
  else if (command === "rehearse") {
    writeProductionConfigs(loadOperatorConfig());
    await rehearse(options(args));
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
