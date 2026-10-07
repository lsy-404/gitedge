import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const workerConfigs = [
  "workers/limits/wrangler.jsonc",
  "workers/auth/wrangler.jsonc",
  "workers/forge/wrangler.jsonc",
  "workers/git/wrangler.jsonc",
  "workers/deploy/wrangler.jsonc",
  "workers/actions/wrangler.jsonc",
  "workers/gateway/wrangler.jsonc",
];

const unresolvedIdPattern = /REPLACE_WITH_[A-Z0-9_]+/;

const bootstrapServices = ["git", "forge", "actions"];

export function accountId(configPaths = workerConfigs) {
  const accounts = configPaths.map((configPath) => ({
    configPath,
    accountId: JSON.parse(readFileSync(configPath, "utf8")).account_id,
  }));
  const invalid = accounts.filter((entry) => !/^[a-f0-9]{32}$/.test(entry.accountId ?? ""));
  if (invalid.length > 0) {
    throw new Error(
      `Every Worker must declare a valid production account_id: ${invalid
        .map((entry) => `${entry.configPath} (${entry.accountId})`)
        .join(", ")}`
    );
  }
  if (new Set(accounts.map((entry) => entry.accountId)).size !== 1) {
    throw new Error(
      `Workers must share one account_id: ${accounts
        .map((entry) => `${entry.configPath}=${entry.accountId}`)
        .join(", ")}`
    );
  }
  return accounts[0].accountId;
}

function cloudflareEnvironment() {
  return { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId() };
}

export function findUnresolvedResourceIds(configPaths = workerConfigs) {
  const findings = [];

  for (const configPath of configPaths) {
    const lines = readFileSync(configPath, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (unresolvedIdPattern.test(line)) findings.push({ configPath, line: index + 1 });
    });
  }

  return findings;
}

function assertProductionResourceIds() {
  const findings = findUnresolvedResourceIds();
  if (findings.length === 0) return true;

  console.error("Production deployment stopped: replace the configured D1/KV resource IDs first.");
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

function workerExists(service) {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "deployments", "list", "--config", `workers/${service}/wrangler.jsonc`],
    { encoding: "utf8", env: cloudflareEnvironment() }
  );
  if (result.status === 0) return true;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (/10007|does not exist|not found/i.test(output)) return false;
  throw new Error(`Cannot determine whether ${service} is deployed:\n${output}`);
}

// Git, Forge and Actions bind each other, so a fresh account needs placeholders before the real deploys.
function bootstrapCyclicWorkers() {
  for (const service of bootstrapServices) {
    if (workerExists(service)) continue;
    const configPath = `workers/${service}/wrangler.jsonc`;
    const config = JSON.parse(readFileSync(configPath, "utf8"));
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

export function deployStack({ dryRun = false } = {}) {
  if (!assertProductionResourceIds()) return false;
  if (!run("pnpm", ["--dir", "apps/web", "run", "build"])) return false;

  if (!dryRun) {
    if (
      !run(
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
          "workers/auth/wrangler.jsonc",
        ],
        { cloudflare: true }
      )
    ) {
      return false;
    }
  }

  if (!dryRun && !bootstrapCyclicWorkers()) return false;

  for (const service of ["limits", "auth", "forge", "git", "actions", "deploy", "gateway"]) {
    const args = ["exec", "wrangler", "deploy", "--config", `workers/${service}/wrangler.jsonc`];
    if (dryRun) args.push("--dry-run");
    if (!run("pnpm", args, { cloudflare: true })) return false;
  }

  return true;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (!deployStack({ dryRun: process.argv.includes("--dry-run") })) {
    process.exitCode ??= 2;
  }
}
