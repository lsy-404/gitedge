import { createDarkTheme, createLightTheme, type BrandVariants } from "@fluentui/tokens";
import { setTheme, type Theme } from "@fluentui/web-components/theme/set-theme.js";
import { hexToHsl, hslToHex } from "./color";

export type ColorScheme = "light" | "dark";

export const BRAND_SEED = "#f6821f";

// Dark text maintains contrast on the orange button fill.
const ON_BRAND_INK = "#1a0e04";

const FONT_SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
const FONT_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

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

// Follow an explicit light preference; otherwise use dark mode.
export function resolveColorScheme(prefersLight: boolean): ColorScheme {
  return prefersLight ? "light" : "dark";
}

export function createAppTheme(scheme: ColorScheme, seed: string = BRAND_SEED): Theme {
  const brand = createBrandRamp(seed);
  const base = scheme === "light" ? createLightTheme(brand) : createDarkTheme(brand);
  const focusRing = scheme === "light" ? brand[80] : brand[110];
  return {
    ...Object.fromEntries(Object.entries(base)),
    colorNeutralBackground1: scheme === "light" ? "#ffffff" : "#0d1117",
    colorNeutralBackground2: scheme === "light" ? "#f6f8fa" : "#151b23",
    colorNeutralBackground3: scheme === "light" ? "#f6f8fa" : "#151b23",
    colorNeutralBackground1Hover: scheme === "light" ? "#f3f4f6" : "#212830",
    colorNeutralForeground1: scheme === "light" ? "#1f2328" : "#f0f6fc",
    colorNeutralForeground2: scheme === "light" ? "#59636e" : "#b1bac4",
    colorNeutralForeground3: scheme === "light" ? "#59636e" : "#9198a1",
    colorNeutralStroke1: scheme === "light" ? "#d1d9e0" : "#3d444d",
    colorNeutralStroke2: scheme === "light" ? "#d1d9e0" : "#3d444d",
    colorBrandForegroundLink: scheme === "light" ? "#0969da" : "#79c0ff",
    colorBrandForegroundLinkHover: scheme === "light" ? "#0550ae" : "#a5d6ff",
    borderRadiusMedium: "6px",
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

export function installColorScheme(): () => void {
  const light = window.matchMedia("(prefers-color-scheme: light)");
  const sync = () => applyColorScheme(resolveColorScheme(light.matches));
  sync();
  light.addEventListener("change", sync);
  return () => light.removeEventListener("change", sync);
}
