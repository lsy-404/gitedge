import { describe, expect, it } from "vitest";
import { i18n } from "../../apps/web/src/i18n";

describe("locale message syntax", () => {
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
