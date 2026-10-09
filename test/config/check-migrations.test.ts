import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allowedGaps, checkMigrations } from "../../scripts/check-migrations.mjs";

function files(...numbers: number[]): string[] {
  return numbers.map((number) => `${String(number).padStart(4, "0")}_step.sql`);
}
const upTo = (last: number) => Array.from({ length: last }, (_, index) => index + 1);

describe("migration numbering check", () => {
  it("accepts the repository's migrations", () => {
    expect(checkMigrations(readdirSync("migrations"))).toEqual([]);
  });

  it("allows only the historical gap", () => {
    expect([...allowedGaps]).toEqual([17]);
    expect(checkMigrations(files(...upTo(16), 18), allowedGaps)).toEqual([]);
  });

  it("reports duplicate numbers", () => {
    expect(checkMigrations(["0001_a.sql", "0001_b.sql"], new Set())).toEqual([
      "duplicate migration number 0001: 0001_a.sql, 0001_b.sql",
    ]);
  });

  it("reports names that do not match the convention", () => {
    const problems = checkMigrations(
      ["0001_a.sql", "0002-b.sql", "003_c.sql", "0004_Upper.sql"],
      new Set()
    );
    expect(problems).toContain("0002-b.sql: name must match NNNN_snake_case.sql");
    expect(problems).toContain("003_c.sql: name must match NNNN_snake_case.sql");
    expect(problems).toContain("0004_Upper.sql: name must match NNNN_snake_case.sql");
  });

  it("reports new gaps but not the allowlisted one", () => {
    expect(checkMigrations(["0001_a.sql", "0003_b.sql"], new Set())).toEqual([
      "missing migration number 0002",
    ]);
    expect(checkMigrations(files(...upTo(16), 18, 20), new Set([17]))).toEqual([
      "missing migration number 0019",
    ]);
  });

  it("rejects reusing the reserved historical number", () => {
    expect(checkMigrations(files(...upTo(17)), new Set([17]))).toEqual([
      "0017_step.sql: number 0017 is a reserved historical gap",
    ]);
  });
});
