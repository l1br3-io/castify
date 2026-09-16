// Task 001 (app-redesign): design tokens are load-bearing. This suite parses
// index.css directly — the same file the browser consumes — and recomputes
// WCAG 2.2 contrast ratios from the raw oklch/hex values, so a token edit
// that quietly drops below AA fails here instead of in an audit.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "index.css"), "utf8");

/** Extract a `{ ... }` block (brace-depth aware) starting at the line that
 * begins with `selector`. Returns the block's inner text. */
function extractBlock(selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    i += 1;
  }
  return css.slice(open + 1, i - 1);
}

function tokenMap(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

const theme = tokenMap(extractBlock("@theme"));
const dark = tokenMap(extractBlock(':root,\n:root[data-theme="dark"]'));
const light = tokenMap(extractBlock(':root[data-theme="light"]'));
const systemLight = tokenMap(extractBlock(':root:not([data-theme="dark"])'));

type Rgb = { r: number; g: number; b: number; alpha: number };

function parseColor(value: string): Rgb {
  const hex = value.match(/^#([\da-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return {
      r: ((n >> 16) & 255) / 255,
      g: ((n >> 8) & 255) / 255,
      b: (n & 255) / 255,
      alpha: 1,
    };
  }
  const m = value.match(
    /oklch\(([\d.]+)% ([\d.]+) ([\d.]+)(?: \/ ([\d.]+)%)?\)/,
  );
  if (!m) throw new Error(`unparseable color: ${value}`);
  const [L, C, H] = [+m[1] / 100, +m[2], +m[3]];
  const alpha = m[4] === undefined ? 1 : +m[4] / 100;
  const rad = (H * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const mm = m_ ** 3;
  const s = s_ ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  const encode = (c: number) => {
    const clamped = Math.min(1, Math.max(0, c));
    return clamped <= 0.0031308
      ? clamped * 12.92
      : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  return { r: encode(linear[0]), g: encode(linear[1]), b: encode(linear[2]), alpha };
}

/** WCAG relative luminance; translucent colors composite over `bg`
 * (gamma space, matching CSS alpha compositing). */
function luminance(fg: Rgb, bg: Rgb = { r: 0, g: 0, b: 0, alpha: 1 }): number {
  const r = fg.r * fg.alpha + bg.r * (1 - fg.alpha);
  const g = fg.g * fg.alpha + bg.g * (1 - fg.alpha);
  const b = fg.b * fg.alpha + bg.b * (1 - fg.alpha);
  const lin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["--color-castify-canvas", "--color-castify-surface", "--color-castify-surface-raised"] as const;
const SEMANTIC = ["success", "warning", "danger", "info"] as const;
const THEMES = { dark, light } as const;
const WHITE_FRAME = { r: 1, g: 1, b: 1, alpha: 1 };

describe("semantic + structural design tokens", () => {
  it("declares every semantic token and subtle variant in @theme and both theme blocks", () => {
    for (const block of [theme, dark, light, systemLight]) {
      for (const name of SEMANTIC) {
        expect(block[`--color-${name}`], `${name} missing from a block`).toBeTruthy();
        expect(block[`--color-${name}-subtle`], `${name}-subtle missing from a block`).toBeTruthy();
      }
      expect(block["--color-focus"], "focus missing from a block").toBeTruthy();
    }
  });

  it.each(Object.entries(THEMES))(
    "keeps semantic tokens at AA text contrast (4.5:1) on every surface — %s",
    (themeName, block) => {
      for (const name of SEMANTIC) {
        const fg = parseColor(block[`--color-${name}`]);
        for (const surface of SURFACES) {
          const ratio = contrast(fg, parseColor(block[surface]));
          expect(
            ratio,
            `${themeName} ${name} on ${surface}: ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );

  it.each(Object.entries(THEMES))(
    "keeps the focus ring at UI-component contrast (3:1) on every surface — %s",
    (themeName, block) => {
      const fg = parseColor(block["--color-focus"]);
      for (const surface of SURFACES) {
        const ratio = contrast(fg, parseColor(block[surface]));
        expect(
          ratio,
          `${themeName} focus on ${surface}: ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it("declares player scrim/overlay tokens whose white text survives a fully bright frame", () => {
    for (const token of [
      "--color-player-scrim-bottom",
      "--color-player-overlay-surface",
      "--color-caption-bg",
    ]) {
      expect(theme[token], `${token} missing from @theme`).toBeTruthy();
      // composite the translucent layer over a pure-white frame (worst case),
      // then check white text against the result
      const l = luminance(parseColor(theme[token]), WHITE_FRAME);
      const composed = (1 + 0.05) / (l + 0.05);
      expect(
        composed,
        `white on ${token} over bright frame: ${composed.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(theme["--color-player-scrim-top"]).toBeTruthy();
    expect(theme["--color-player-overlay-text"]).toBeTruthy();
    expect(theme["--color-caption-text"]).toBeTruthy();
    expect(theme["--caption-size-floor"]).toBeTruthy();
  });

  it("declares elevation layers ordered menu < dialog < toast", () => {
    const z = {
      menu: Number.parseInt(theme["--z-menu"] ?? "", 10),
      dialog: Number.parseInt(theme["--z-dialog"] ?? "", 10),
      toast: Number.parseInt(theme["--z-toast"] ?? "", 10),
    };
    expect(Number.isNaN(z.menu)).toBe(false);
    expect(Number.isNaN(z.dialog)).toBe(false);
    expect(Number.isNaN(z.toast)).toBe(false);
    expect(z.menu).toBeLessThan(z.dialog);
    expect(z.dialog).toBeLessThan(z.toast);
  });

  it("declares provider brand tokens with a small-area usage restriction", () => {
    for (const provider of ["google", "dropbox", "onedrive"]) {
      expect(
        theme[`--color-brand-${provider}`],
        `brand ${provider} missing from @theme`,
      ).toBeTruthy();
    }
    const brandCommentIndex = css.indexOf("--color-brand-google");
    const restriction = /badge|sign-in|small[- ]area/i;
    const context = css.slice(Math.max(0, brandCommentIndex - 700), brandCommentIndex);
    expect(restriction.test(context), "brand usage restriction comment").toBe(true);
  });

  it("documents computed contrast ratios in a comment table", () => {
    expect(/contrast/i.test(css)).toBe(true);
    // The table must cite ratios (e.g. "9.25:1") near the semantic tokens.
    const semanticIndex = css.indexOf("--color-success");
    const table = css.slice(Math.max(0, semanticIndex - 1200), semanticIndex);
    expect(/\d+\.\d+\s*:\s*1/.test(table), "ratio table near semantic tokens").toBe(true);
  });
});
