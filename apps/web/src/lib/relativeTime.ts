const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

/** Localized "3 days ago" style text for a Unix timestamp in seconds. */
export function relativeAge(timestampSeconds: number, nowMs: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const elapsed = Math.round(nowMs / 1000 - timestampSeconds);
  for (const [unit, size] of UNITS) {
    if (Math.abs(elapsed) >= size || unit === "second")
      return format.format(-Math.trunc(elapsed / size), unit);
  }
  return format.format(0, "second");
}
