import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accountId,
  findUnresolvedResourceIds,
  workerConfigs,
} from "../../scripts/deploy-stack.mjs";

describe("production deployment preflight", () => {
  it("has no unresolved resource IDs in production configs", () => {
    expect(findUnresolvedResourceIds(workerConfigs)).toEqual([]);
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

  it("requires every Worker to declare the same valid account", () => {
    expect(accountId(workerConfigs)).toMatch(/^[a-f0-9]{32}$/);

    const fixtureDir = mkdtempSync(join(tmpdir(), "gitedge-account-"));
    const first = join(fixtureDir, "first.jsonc");
    const second = join(fixtureDir, "second.jsonc");
    writeFileSync(first, `{"account_id":"${"a".repeat(32)}"}\n`);
    writeFileSync(second, `{"account_id":"${"b".repeat(32)}"}\n`);

    try {
      expect(() => accountId([first, second])).toThrow(/share one account_id/);
      writeFileSync(second, '{"account_id":"not-an-id"}\n');
      expect(() => accountId([first, second])).toThrow(/valid production account_id/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
