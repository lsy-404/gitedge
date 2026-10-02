import { createDarkTheme, createLightTheme, type BrandVariants } from "@fluentui/tokens";
import { setTheme, type Theme } from "@fluentui/web-components/theme/set-theme.js";
import { hexToHsl, hslToHex } from "./color";

export type ColorScheme = "light" | "dark";

/** Cloudflare orange. It is the brand ramp's key 90 and the primary button fill in both schemes. */
export const BRAND_SEED = "#f6821f";

/** Dark ink for text on orange fills; white on this orange is only 2.6:1. */
const ON_BRAND_INK = "#1a0e04";

const FONT_SANS =
  '"Hanken Grotesk", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif';
const FONT_MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace';

/**
 * Brand ramp lightness (HSL percent) for keys 10 (darkest) to 160 (lightest), at the seed's hue
 * and saturation. Key 90 is the seed itself (about 54%).
 *
 * Fluent maps ramp keys to roles differently per scheme, which is what makes dark mode
 * lighter without a second ramp:
 *  - light: link 70 (36%, 5.0:1 on white), indicators/focus/strokes 80 (45%, 3.4:1 on white)
 *  - dark: link 100 (62%), foreground 110 (69%), indicators/strokes 100-110; all above 7:1 on
 *    the dark surfaces
 * Primary button fills are pinned to the seed (key 90) with hover 100 and pressed 80 in both
 * schemes, because every one of those steps keeps at least 4.5:1 against the dark ink text.
 */
const RAMP_LIGHTNESS = {
  10: 7,
  20: 11,
  30: 15,
  40: 20,
  50: 26,
  60: 31,
  70: 36,
  80: 45,
  100: 62,
  110: 69,
  120: 75,
  130: 81,
  140: 87,
  150: 92,
  160: 96,
} satisfies Record<Exclude<keyof BrandVariants, 90>, number>;

export function createBrandRamp(seed: string): BrandVariants {
  const { h, s } = hexToHsl(seed);
  const at = (key: keyof BrandVariants): string =>
    key === 90 ? seed : hslToHex({ h, s, l: RAMP_LIGHTNESS[key] });
  return {
    10: at(10),
    20: at(20),
    30: at(30),
    40: at(40),
    50: at(50),
    60: at(60),
    70: at(70),
    80: at(80),
    90: at(90),
    100: at(100),
    110: at(110),
    120: at(120),
    130: at(130),
    140: at(140),
    150: at(150),
    160: at(160),
  };
}

/** Dark is the default look; light only when the system explicitly asks for it. */
export function resolveColorScheme(prefersLight: boolean): ColorScheme {
  return prefersLight ? "light" : "dark";
}

/** Flat token map that `setTheme` accepts, with the app's orange and typography applied. */
export function createAppTheme(scheme: ColorScheme, seed: string = BRAND_SEED): Theme {
  const brand = createBrandRamp(seed);
  const base = scheme === "light" ? createLightTheme(brand) : createDarkTheme(brand);
  const focusRing = scheme === "light" ? brand[80] : brand[110];
  return {
    ...Object.fromEntries(Object.entries(base)),
    fontFamilyBase: FONT_SANS,
    fontFamilyMonospace: FONT_MONO,
    colorNeutralForegroundOnBrand: ON_BRAND_INK,
    colorBrandBackground: brand[90],
    colorBrandBackgroundHover: brand[100],
    colorBrandBackgroundPressed: brand[80],
    colorBrandBackgroundSelected: brand[80],
    colorStrokeFocus2: focusRing,
  };
}

function setMetaThemeColor(color: string): void {
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
}

function applyColorScheme(scheme: ColorScheme): void {
  const theme = createAppTheme(scheme);
  setTheme(theme);
  document.documentElement.style.colorScheme = scheme;
  document.documentElement.dataset.colorScheme = scheme;
  setMetaThemeColor(String(theme.colorNeutralBackground1));
}

/** Applies the theme now and keeps it in sync with the system setting. Returns a cleanup. */
export function installColorScheme(): () => void {
  const light = window.matchMedia("(prefers-color-scheme: light)");
  const sync = () => applyColorScheme(resolveColorScheme(light.matches));
  sync();
  light.addEventListener("change", sync);
  return () => light.removeEventListener("change", sync);
}
