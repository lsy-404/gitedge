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

function cloudflareEnvironment() {
  const authConfig = JSON.parse(readFileSync("workers/auth/wrangler.jsonc", "utf8"));
  if (!/^[a-f0-9]{32}$/.test(authConfig.account_id ?? "")) {
    throw new Error("Auth Worker must declare a valid production account_id.");
  }

  return { ...process.env, CLOUDFLARE_ACCOUNT_ID: authConfig.account_id };
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

  for (const service of ["limits", "auth", "actions", "git", "forge", "deploy", "gateway"]) {
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
