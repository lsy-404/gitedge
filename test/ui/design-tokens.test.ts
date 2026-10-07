import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "../../apps/web/src/styles", name), "utf8");
const mainCss = styles("main.css");
const motionCss = styles("motion.css");

type Scheme = "light" | "dark";

function token(name: string, scheme: Scheme): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(mainCss);
  if (!match) throw new Error(`Missing token --${name}`);
  const value = match[1].trim();
  const pair = /^light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)$/i.exec(value);
  if (pair) return scheme === "light" ? pair[1] : pair[2];
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  throw new Error(`--${name} is not a color: ${value}`);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string, scheme: Scheme): number {
  const [a, b] = [luminance(token(foreground, scheme)), luminance(token(background, scheme))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const text: Array<[string, string]> = [
  ["fg-default", "bg-canvas"],
  ["fg-default", "bg-selected"],
  ["fg-secondary", "bg-overlay"],
  ["fg-muted", "bg-canvas"],
  ["fg-muted", "bg-subtle"],
  ["fg-muted", "bg-overlay"],
  ["fg-muted", "bg-selected"],
  ["fg-default", "control-bg-hover"],
  ["fg-default", "control-bg-active"],
  ["fg-muted", "control-bg-hover"],
  ["fg-muted", "control-bg-active"],
  ["fg-secondary", "control-bg-active"],
  ["accent-fg", "control-bg-hover"],
  ["accent-fg", "control-bg-active"],
  ["fg-secondary", "bg-subtle"],
  ["fg-secondary", "bg-selected"],
  ["fg-muted", "bg-raised"],
  ["danger-fg", "bg-raised"],
  ["accent-fg", "bg-canvas"],
  ["accent-fg", "bg-subtle"],
  ["accent-fg", "accent-subtle"],
  ["fg-default", "accent-subtle"],
  ["danger-fg", "accent-subtle"],
  ["fg-on-accent", "accent-emphasis"],
  ["fg-on-accent", "accent-emphasis-hover"],
  ["fg-on-accent", "accent-emphasis-active"],
  ["fg-on-danger", "danger-emphasis"],
  ["fg-on-danger", "danger-emphasis-active"],
  ["danger-fg", "control-bg"],
  ["success-fg", "success-subtle"],
  ["warning-fg", "warning-subtle"],
  ["danger-fg", "danger-subtle"],
  ["info-fg", "info-subtle"],
  ["done-fg", "done-subtle"],
  ["fg-secondary", "control-bg-hover"],
  ["fg-secondary", "bg-subtle"],
  ["fg-secondary", "bg-selected"],
];
const graphics: Array<[string, string]> = [
  ["focus-ring", "bg-canvas"],
  ["focus-ring", "bg-subtle"],
  ["focus-ring", "bg-overlay"],
  ["focus-ring", "control-bg-hover"],
  ["focus-ring", "bg-selected"],
  ["focus-ring", "accent-subtle"],
  ["accent-strong", "bg-selected"],
  ["accent-strong", "bg-canvas"],
  ["border-strong", "bg-canvas"],
  ["border-strong", "bg-overlay"],
  ["border-strong", "control-bg"],
  ["accent-strong", "control-bg-hover"],
  ["accent-strong", "bg-selected"],
];

describe("design tokens", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`meets WCAG AA text contrast in ${scheme} mode`, () => {
      for (const [foreground, background] of text) {
        expect(
          contrast(foreground, background, scheme),
          `${foreground} on ${background}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`meets WCAG AA non-text contrast in ${scheme} mode`, () => {
      for (const [foreground, background] of graphics) {
        expect(
          contrast(foreground, background, scheme),
          `${foreground} on ${background}`
        ).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("keeps reduced motion in one place and page entry free of transforms", () => {
    expect(mainCss).not.toContain("prefers-reduced-motion");
    expect(motionCss.match(/prefers-reduced-motion/g)).toHaveLength(1);
    const pageIn = /@keyframes gitedge-page-in\s*\{[\s\S]*?\n\}/.exec(motionCss)?.[0] ?? "";
    expect(pageIn).toContain("opacity");
    expect(pageIn).not.toContain("transform");
  });
});
