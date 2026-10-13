import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const operatorFile = resolve(root, "gitedge.config.json");
export const services = ["limits", "auth", "forge", "git", "actions", "deploy", "mcp", "gateway"];

const hostname = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const varsSchema = z.record(z.string(), z.string());

const OperatorSchema = z
  .object({
    accountId: z
      .string()
      .regex(/^[a-f0-9]{32}$/, "must be your 32-character Cloudflare account ID"),
    databaseId: z
      .string()
      .regex(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, "must be the D1 database UUID"),
    domain: z
      .string()
      .regex(hostname, "must be your Gateway hostname")
      .refine(
        (value) => !/(^|\.)example\.(com|org|net)$/.test(value),
        "must not be an example domain"
      ),
    ssoProviders: z.array(z.record(z.string(), z.unknown())).default([]),
    vars: z.partialRecord(z.enum(services), varsSchema).default({}),
  })
  .strict();

// Valid-looking values used only for offline dry-run builds when no operator file exists.
const dryRunOperator = {
  accountId: "0".repeat(32),
  databaseId: "00000000-0000-0000-0000-000000000000",
  domain: "gitedge.example.com",
  ssoProviders: [],
  vars: {},
};

export function sourceConfigPath(service) {
  return resolve(root, `workers/${service}/wrangler.jsonc`);
}

export function productionConfigPath(service) {
  return resolve(root, `workers/${service}/wrangler.production.jsonc`);
}

export function loadOperatorConfig({ optional = false } = {}) {
  if (!existsSync(operatorFile)) {
    if (optional) return null;
    throw new Error(
      `Missing operator file ${operatorFile}. Copy gitedge.config.example.json to gitedge.config.json and replace every value.`
    );
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(operatorFile, "utf8"));
  } catch (error) {
    throw new Error(`${operatorFile} is not valid JSON: ${error.message}`);
  }
  const parsed = OperatorSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `${operatorFile} still has placeholder or invalid values (replace every REPLACE_WITH_* value):\n${problems}`
    );
  }
  return parsed.data;
}

export function renderWorkerConfig(service, operator) {
  const config = JSON.parse(readFileSync(sourceConfigPath(service), "utf8"));
  config.account_id = operator.accountId;
  for (const database of config.d1_databases ?? []) database.database_id = operator.databaseId;
  if (service === "gateway") {
    for (const route of config.routes ?? [])
      if (route.custom_domain) route.pattern = operator.domain;
  }
  const vars = { ...config.vars, ...operator.vars[service] };
  if (service === "auth") vars.SSO_PROVIDERS_JSON = JSON.stringify(operator.ssoProviders);
  if (Object.keys(vars).length > 0) config.vars = vars;
  return config;
}

export function writeProductionConfigs(operator) {
  const paths = {};
  for (const service of services) {
    paths[service] = productionConfigPath(service);
    writeFileSync(
      paths[service],
      `${JSON.stringify(renderWorkerConfig(service, operator), null, 2)}\n`
    );
  }
  return paths;
}

export function dryRunOperatorConfig() {
  return dryRunOperator;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "account-id") {
    const operator = loadOperatorConfig({ optional: true });
    if (operator) console.log(operator.accountId);
  }
}
