import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const migrationsDirectory = "migrations";
const filenamePattern = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

// Numbers that were skipped historically and must never be reused or reported again.
export const allowedGaps = new Set([17]);

export function checkMigrations(files, gaps = allowedGaps) {
  const problems = [];
  const numbers = new Map();

  for (const file of files) {
    const match = filenamePattern.exec(file);
    if (!match) {
      problems.push(`${file}: name must match NNNN_snake_case.sql`);
      continue;
    }
    const number = Number(match[1]);
    numbers.set(number, [...(numbers.get(number) ?? []), file]);
  }

  for (const [number, names] of numbers) {
    if (names.length > 1)
      problems.push(
        `duplicate migration number ${String(number).padStart(4, "0")}: ${names.join(", ")}`
      );
    if (gaps.has(number))
      problems.push(
        `${names[0]}: number ${String(number).padStart(4, "0")} is a reserved historical gap`
      );
  }

  const highest = Math.max(0, ...numbers.keys());
  for (let number = 1; number <= highest; number += 1) {
    if (!numbers.has(number) && !gaps.has(number))
      problems.push(`missing migration number ${String(number).padStart(4, "0")}`);
  }
  return problems;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const problems = checkMigrations(readdirSync(migrationsDirectory));
  if (problems.length > 0) {
    console.error("Migration check failed:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("Migrations are consistent.");
  }
}
