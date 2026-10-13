import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findUnresolvedResourceIds } from "../../scripts/deploy-stack.mjs";
import {
  dryRunOperatorConfig,
  renderWorkerConfig,
  services,
  sourceConfigPath,
} from "../../scripts/operator-config.mjs";

describe("production deployment preflight", () => {
  it("resolves every placeholder once operator values are applied", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "gitedge-deploy-"));
    try {
      const rendered = services.map((service) => {
        const path = join(fixtureDir, `${service}.jsonc`);
        writeFileSync(
          path,
          JSON.stringify(renderWorkerConfig(service, dryRunOperatorConfig()), null, 2)
        );
        return path;
      });
      expect(findUnresolvedResourceIds(rendered)).toEqual([]);
      expect(findUnresolvedResourceIds(services.map(sourceConfigPath)).length).toBeGreaterThan(0);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("finds an unresolved ID without returning its value", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "gitedge-deploy-"));
    const configPath = join(fixtureDir, "wrangler.jsonc");
    writeFileSync(configPath, '{"database_id":"REPLACE_WITH_DATABASE_ID"}\n');

    try {
      const findings = findUnresolvedResourceIds([configPath]);
      expect(findings).toEqual([{ configPath, line: 1 }]);
      expect(JSON.stringify(findings)).not.toContain("REPLACE_WITH_");
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("applies the account, domain and SSO providers to the rendered Workers", () => {
    const operator = {
      ...dryRunOperatorConfig(),
      accountId: "a".repeat(32),
      ssoProviders: [{ id: "corp" }],
    };
    expect(renderWorkerConfig("gateway", operator).account_id).toBe("a".repeat(32));
    expect(renderWorkerConfig("gateway", operator).routes[0].pattern).toBe(operator.domain);
    expect(renderWorkerConfig("auth", operator).vars.SSO_PROVIDERS_JSON).toBe('[{"id":"corp"}]');
  });
});
