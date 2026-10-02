import { describe, expect, it } from "vitest";
import { contrastRatio, hexToHsl, hslToHex } from "../../apps/web/src/ui/color";
import {
  BRAND_SEED,
  createAppTheme,
  createBrandRamp,
  resolveColorScheme,
  type ColorScheme,
} from "../../apps/web/src/ui/theme";

const rampKeys = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160] as const;

function token(scheme: ColorScheme, name: string): string {
  const value = createAppTheme(scheme)[name];
  if (typeof value !== "string") throw new Error(`Theme token ${name} is not a color`);
  return value;
}

describe("brand ramp", () => {
  it("converts colors between hex and HSL without drifting", () => {
    expect(hslToHex(hexToHsl("#f6821f"))).toBe("#f6821f");
    expect(hslToHex({ h: 0, s: 0, l: 100 })).toBe("#ffffff");
    expect(hslToHex({ h: 0, s: 100, l: 50 })).toBe("#ff0000");
    expect(() => hexToHsl("orange")).toThrow();
  });

  it("covers keys 10 to 160, passes through the seed at 90 and darkens monotonically downward", () => {
    const ramp = createBrandRamp(BRAND_SEED);
    expect(Object.keys(ramp).map(Number)).toEqual([...rampKeys]);
    expect(ramp[90]).toBe(BRAND_SEED);
    const lightness = rampKeys.map((key) => hexToHsl(ramp[key]).l);
    expect([...lightness].sort((a, b) => a - b)).toEqual(lightness);
  });

  it("keeps every step in the seed's orange hue", () => {
    const ramp = createBrandRamp(BRAND_SEED);
    const seedHue = hexToHsl(BRAND_SEED).h;
    for (const key of rampKeys) expect(Math.abs(hexToHsl(ramp[key]).h - seedHue)).toBeLessThan(3);
  });
});

describe("color scheme", () => {
  it("is dark unless the system asks for light", () => {
    expect(resolveColorScheme(false)).toBe("dark");
    expect(resolveColorScheme(true)).toBe("light");
  });

  it.each<ColorScheme>(["light", "dark"])("keeps %s text and indicators at WCAG AA", (scheme) => {
    const background = token(scheme, "colorNeutralBackground1");
    const canvas = token(scheme, "colorNeutralBackground2");
    const onBrand = token(scheme, "colorNeutralForegroundOnBrand");
    for (const name of [
      "colorBrandBackground",
      "colorBrandBackgroundHover",
      "colorBrandBackgroundPressed",
      "colorBrandBackgroundSelected",
    ]) {
      expect(contrastRatio(onBrand, token(scheme, name)), name).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of [background, canvas]) {
      expect(
        contrastRatio(token(scheme, "colorBrandForegroundLink"), surface)
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(
      contrastRatio(token(scheme, "colorCompoundBrandStroke"), background)
    ).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(token(scheme, "colorStrokeFocus2"), background)).toBeGreaterThanOrEqual(3);
  });

  it("keeps dark-mode links lighter than light-mode links", () => {
    const light = hexToHsl(token("light", "colorBrandForegroundLink")).l;
    const dark = hexToHsl(token("dark", "colorBrandForegroundLink")).l;
    expect(dark).toBeGreaterThan(light);
  });

  it("applies system UI and code font stacks", () => {
    const theme = createAppTheme("dark");
    expect(String(theme.fontFamilyBase)).toContain("-apple-system");
    expect(String(theme.fontFamilyMonospace)).toContain("ui-monospace");
    expect(theme.spacingVerticalM).toBeDefined();
  });
});
