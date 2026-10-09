import { describe, expect, it } from "vitest";
import { i18n } from "../../apps/web/src/i18n";
import { taskDocumentKinds, taskStatuses } from "../../apps/web/src/lib/tasks";

const locales = ["zh-CN", "en"] as const;

const sources = import.meta.glob<string>("../../apps/web/src/**/*.{vue,ts}", {
  query: "?raw",
  import: "default",
  eager: true,
});
const components = Object.fromEntries(
  Object.entries(sources).filter(([file]) => file.endsWith(".vue"))
);
const nonMessageSources = Object.entries(sources).filter(
  ([file]) => !/\/src\/i18n(\.ts|\/)/.test(file)
);

/** Message keys built at runtime: prefix to the values appended to it. */
const dynamicKeys: Record<string, readonly string[]> = {
  quotaResource_: ["repositories", "storage"],
  actionsStatus_: ["queued", "running", "completed"],
  "deployWizard.state.": ["pending", "running", "done", "failed"],
  actionsConclusion_: ["success", "failure", "cancelled"],
  taskStatus_: taskStatuses,
  docKind_: taskDocumentKinds,
  docEmpty_: taskDocumentKinds,
  taskCommitSource_: ["manual", "pull_request_merge"],
  review: ["approved", "changes_requested", "commented"],
  category: ["general", "ideas", "q-and-a", "announcements"],
  mergeError_: [
    "changes_requested",
    "approvals_required",
    "checks_incomplete",
    "checks_required",
    "required_checks_missing",
    "protected_branch",
    "repository_readonly",
    "merge_method_disabled",
  ],
  "deployWizard.steps.": ["provision", "migrate", "deploy"],
};

function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") return { [prefix]: value };
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      Object.entries(flatten(child, prefix ? `${prefix}.${key}` : key))
    )
  );
}

function parameters(message: string): string[] {
  return [...new Set([...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
}

const flat = Object.fromEntries(
  locales.map((locale) => [locale, flatten(i18n.global.getLocaleMessage(locale))])
);

describe("locale message syntax", () => {
  it("defines every statically referenced Vue message in both languages", () => {
    const missing: string[] = [];
    for (const [file, source] of Object.entries(components)) {
      for (const [, key] of source.matchAll(/\bt\(\s*["']([\w.]+)["']/g)) {
        for (const locale of locales)
          if (!i18n.global.te(key, locale)) missing.push(`${file}: ${locale}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("defines every dynamically built key for each listed value", () => {
    const missing: string[] = [];
    for (const [prefix, values] of Object.entries(dynamicKeys))
      for (const value of values)
        for (const locale of locales)
          if (!i18n.global.te(`${prefix}${value}`, locale))
            missing.push(`${locale}.${prefix}${value}`);
    expect(missing).toEqual([]);
  });

  it("lists the prefix of every template-literal key used in the sources", () => {
    const unlisted: string[] = [];
    for (const [file, source] of nonMessageSources)
      for (const [, prefix] of source.matchAll(/\bt\(\s*`([^`$]*)\$\{/g))
        if (!(prefix in dynamicKeys)) unlisted.push(`${file}: ${prefix}`);
    expect(unlisted).toEqual([]);
  });

  it("keeps the same keys and placeholders in both locales", () => {
    expect(Object.keys(flat["zh-CN"]).sort()).toEqual(Object.keys(flat.en).sort());
    const mismatched = Object.keys(flat.en).filter(
      (key) =>
        JSON.stringify(parameters(flat["zh-CN"][key] ?? "")) !==
        JSON.stringify(parameters(flat.en[key]))
    );
    expect(mismatched).toEqual([]);
  });

  it("has no message that is never referenced", () => {
    const corpus = nonMessageSources.map(([, source]) => source).join("\n");
    const generated = new Set(
      Object.entries(dynamicKeys).flatMap(([prefix, values]) =>
        values.map((value) => `${prefix}${value}`)
      )
    );
    const unused = Object.keys(flat.en).filter((key) => {
      if (generated.has(key)) return false;
      return !new RegExp(`["'\`]${key.replaceAll(".", "\\.")}["'\`]`).test(corpus);
    });
    expect(unused).toEqual([]);
  });

  for (const locale of locales) {
    it(`compiles every ${locale} message and preserves literal agent handles`, () => {
      for (const [key, message] of Object.entries(flat[locale])) {
        const values = Object.fromEntries(parameters(message).map((name) => [name, "sample"]));
        expect(
          () => i18n.global.t(key, values, { locale, missingWarn: false, fallbackWarn: false }),
          `${locale}.${key}`
        ).not.toThrow();
      }
      expect(i18n.global.t("agentHandleHint", {}, { locale })).toContain("/@handle");
    });
  }
});
