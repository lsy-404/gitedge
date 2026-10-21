import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

const aliases = new Set([
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
]);
const schedules = z
  .array(z.object({ cron: z.string().trim().min(1).max(128) }).strict())
  .min(1)
  .max(5);

export function nextCronTime(expression: string, after: number): number {
  const fields = expression.trim().split(/\s+/);
  if (
    fields.length !== 5 ||
    !/^[\dA-Za-z*,/\s-]+$/.test(expression) ||
    (expression.match(/[A-Za-z]+/g) ?? []).some((alias) => !aliases.has(alias.toUpperCase()))
  )
    throw new Error("Cron must use five POSIX fields in UTC.");
  return CronExpressionParser.parse(expression, {
    currentDate: after,
    tz: "UTC",
    hashSeed: expression,
  })
    .next()
    .getTime();
}

export function parseCronSchedules(value: unknown): string[] {
  const parsed = schedules.parse(value);
  const expressions = [...new Set(parsed.map((item) => item.cron))];
  for (const expression of expressions) nextCronTime(expression, Date.UTC(2026, 0, 1));
  return expressions;
}

export function nextScheduleTime(expressions: readonly string[], after: number): number {
  return Math.min(...expressions.map((expression) => nextCronTime(expression, after)));
}
