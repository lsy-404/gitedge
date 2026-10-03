import { describe, expect, it } from "vitest";
import { i18n } from "../../apps/web/src/i18n";

const components = import.meta.glob<string>("../../apps/web/src/**/*.vue", {
  query: "?raw",
  import: "default",
  eager: true,
});
describe("locale message syntax", () => {
  it("defines every statically referenced Vue message in both languages", () => {
    const missing: string[] = [];
    for (const [file, source] of Object.entries(components)) {
      for (const [, key] of source.matchAll(/\bt\(\s*["'](\w+)["']/g)) {
        for (const locale of ["zh-CN", "en"] as const)
          if (!i18n.global.te(key, locale)) missing.push(`${file}: ${locale}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
  for (const locale of ["zh-CN", "en"] as const) {
    it(`compiles every ${locale} message and preserves literal agent handles`, () => {
      const messages = i18n.global.getLocaleMessage(locale);
      for (const [key, message] of Object.entries(messages)) {
        if (typeof message !== "string") continue;
        const parameters = Object.fromEntries(
          [...message.matchAll(/\{(\w+)\}/g)].map((match) => [match[1], "sample"])
        );
        expect(
          () => i18n.global.t(key, parameters, { locale, missingWarn: false, fallbackWarn: false }),
          `${locale}.${key}`
        ).not.toThrow();
      }
      expect(i18n.global.t("agentHandleHint", {}, { locale })).toContain("/@handle");
    });
  }
});
