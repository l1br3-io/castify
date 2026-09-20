// Legacy TV gates (legacy-tv-player task 006): the legacy artifacts' core
// contract is what they DON'T contain. These gates parse the shipped bytes
// and fail CI the moment modern syntax or CSS creeps in.
//
// GOTCHA — why acorn instead of the alternatives:
//   * Node's own parser accepts ES2022 — it cannot fail on modern syntax,
//     so it can't be a gate.
//   * esbuild with `target: es5` transforms what it can instead of
//     rejecting; a gate must fail, not rewrite.
// acorn at `ecmaVersion: 5` is strict about let/const/arrows/template
// literals/`?.`/`??` — exactly the contract (spec FR-6.1/6.2).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "acorn";

const legacyJs = readFileSync(resolve(import.meta.dirname, "../../public/tv/legacy.js"), "utf8");
const legacyCss = readFileSync(resolve(import.meta.dirname, "../../public/tv/legacy.css"), "utf8");

const BANNED_CSS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /var\(/i, label: "var( — CSS custom properties (Chromium 49+)" },
  { pattern: /oklch\(/i, label: "oklch( — unsupported color function" },
  { pattern: /color-mix\(/i, label: "color-mix( — unsupported color function" },
  { pattern: /@layer\b/i, label: "@layer — unsupported at-rule" },
  { pattern: /@property\b/i, label: "@property — unsupported at-rule" },
];

describe("legacy tv guardrails (task 006)", () => {
  it("legacy.js parses as ES5 (acorn ecmaVersion: 5)", () => {
    expect(() => parse(legacyJs, { ecmaVersion: 5 })).not.toThrow();
  });

  it("legacy.css contains none of the banned modern constructs", () => {
    // Comments are stripped first — the header documents the ban itself.
    const rules = legacyCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const lines = rules.split("\n");
    for (const { pattern, label } of BANNED_CSS) {
      for (const [index, line] of lines.entries()) {
        expect(
          pattern.test(line),
          `line ${index + 1}: ${label} — ${line.trim()}`,
        ).toBe(false);
      }
    }
  });
});
