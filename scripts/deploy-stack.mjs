import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  dryRunOperatorConfig,
  loadOperatorConfig,
  writeProductionConfigs,
} from "./operator-config.mjs";

const unresolvedIdPattern = /REPLACE_WITH_[A-Z0-9_]+/;

const bootstrapServices = ["git", "forge", "actions", "gateway"];

const deployOrder = ["limits", "auth", "forge", "actions", "git", "deploy", "mcp", "gateway"];

let activeAccountId;

function cloudflareEnvironment() {
  return { ...process.env, CLOUDFLARE_ACCOUNT_ID: activeAccountId };
}

export function findUnresolvedResourceIds(configPaths) {
  const findings = [];

  for (const configPath of configPaths) {
    const lines = readFileSync(configPath, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (unresolvedIdPattern.test(line)) findings.push({ configPath, line: index + 1 });
    });
  }

  return findings;
}

function assertResolvedConfigs(configs) {
  const findings = findUnresolvedResourceIds(Object.values(configs));
  if (findings.length === 0) return true;

  console.error("Production deployment stopped: replace the unresolved IDs first.");
  for (const finding of findings) {
    console.error(`- ${finding.configPath}:${finding.line}: unresolved resource ID`);
  }
  return false;
}

function run(command, args, { cloudflare = false } = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: cloudflare ? cloudflareEnvironment() : process.env,
  });
  if (result.error) {
    console.error(`Command failed to start: ${command}`);
    process.exitCode = 1;
    return false;
  }
  if (result.status !== 0) {
    console.error(`Command failed with status ${result.status ?? "unknown"}: ${command}`);
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

function readConfig(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function workerExists(configPath, service) {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "deployments", "list", "--config", configPath],
    { encoding: "utf8", env: cloudflareEnvironment() }
  );
  if (result.status === 0) return true;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (/10007|does not exist|not found/i.test(output)) return false;
  throw new Error(`Cannot determine whether ${service} is deployed:\n${output}`);
}

// Git, Forge and Actions bind each other and MCP binds the Gateway that binds it, so a fresh account
// needs placeholders before the real deploys.
function bootstrapCyclicWorkers(configs) {
  for (const service of bootstrapServices) {
    if (workerExists(configs[service], service)) continue;
    const config = readConfig(configs[service]);
    console.log(`Creating placeholder Worker ${config.name}`);
    if (
      !run(
        "pnpm",
        [
          "exec",
          "wrangler",
          "deploy",
          "--config",
          "scripts/bootstrap-stub.wrangler.jsonc",
          "--name",
          config.name,
          "--compatibility-date",
          config.compatibility_date,
        ],
        { cloudflare: true }
      )
    ) {
      return false;
    }
  }
  return true;
}

// Wrangler requires R2 buckets to exist before deploying their bindings.
function ensureAssetBuckets(configs) {
  for (const [service, binding] of [
    ["forge", "RELEASE_ASSETS"],
    ["actions", "SIGNING_ARTIFACTS"],
  ]) {
    const config = readConfig(configs[service]);
    const bucket = config.r2_buckets?.find((entry) => entry.binding === binding);
    if (!bucket) throw new Error(`${service} must bind ${binding}.`);
    const info = spawnSync(
      "pnpm",
      ["exec", "wrangler", "r2", "bucket", "info", bucket.bucket_name],
      {
        encoding: "utf8",
        env: cloudflareEnvironment(),
      }
    );
    if (info.status === 0) continue;
    console.log(`Creating R2 bucket ${bucket.bucket_name}`);
    if (
      !run("pnpm", ["exec", "wrangler", "r2", "bucket", "create", bucket.bucket_name], {
        cloudflare: true,
      })
    )
      return false;
  }
  return true;
}

function ensureGithubSyncQueue(configs) {
  const config = readConfig(configs.forge);
  const queue = config.queues?.producers?.find(
    (entry) => entry.binding === "GITHUB_SYNC_QUEUE"
  )?.queue;
  if (!queue) throw new Error("Forge must bind GITHUB_SYNC_QUEUE.");
  const info = spawnSync("pnpm", ["exec", "wrangler", "queues", "info", queue], {
    encoding: "utf8",
    env: cloudflareEnvironment(),
  });
  if (info.status === 0) return true;
  const output = `${info.stdout ?? ""}${info.stderr ?? ""}`;
  if (!/does not exist|not found|10024/i.test(output))
    throw new Error("Cannot inspect the GitHub synchronization queue.");
  return run("pnpm", ["exec", "wrangler", "queues", "create", queue], { cloudflare: true });
}

function migrateRemote(configs) {
  return run(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "gitedge",
      "--remote",
      "--config",
      configs.auth,
    ],
    { cloudflare: true }
  );
}

// Dry runs fall back to inert sample values so the stack builds without an operator file.
function prepareConfigs({ dryRun }) {
  const operator = loadOperatorConfig({ optional: dryRun }) ?? dryRunOperatorConfig();
  activeAccountId = operator.accountId;
  const configs = writeProductionConfigs(operator);
  return assertResolvedConfigs(configs) ? configs : null;
}

export function migrateStack() {
  const configs = prepareConfigs({ dryRun: false });
  return configs !== null && migrateRemote(configs);
}

export function renderStack() {
  return prepareConfigs({ dryRun: false }) !== null;
}

export function deployStack({ dryRun = false } = {}) {
  const configs = prepareConfigs({ dryRun });
  if (!configs) return false;
  if (!run("pnpm", ["--dir", "apps/web", "run", "build"])) return false;

  if (!dryRun) {
    if (!migrateRemote(configs)) return false;
    if (!ensureAssetBuckets(configs)) return false;
    if (!ensureGithubSyncQueue(configs)) return false;
    if (!bootstrapCyclicWorkers(configs)) return false;
  }

  for (const service of deployOrder) {
    const args = ["exec", "wrangler", "deploy", "--config", configs[service]];
    if (dryRun) args.push("--dry-run");
    if (!run("pnpm", args, { cloudflare: true })) return false;
  }

  return true;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const flags = process.argv.slice(2);
    const ok = flags.includes("--migrate")
      ? migrateStack()
      : flags.includes("--render")
        ? renderStack()
        : deployStack({ dryRun: flags.includes("--dry-run") });
    if (!ok) process.exitCode ??= 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
