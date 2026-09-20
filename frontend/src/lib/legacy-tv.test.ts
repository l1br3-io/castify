// Legacy TV player (legacy-tv-player tasks 001+): the legacy page is a
// dependency-free ES5 script + static CSS under public/tv/ that pre-module
// browsers (Samsung Tizen TV, Chromium-38-era) evaluate directly. These tests
// load the real bytes the TV downloads — no bundler, no transforms — so what
// passes here is what ships.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const legacyJsPath = resolve(import.meta.dirname, "../../public/tv/legacy.js");
const legacyCssPath = resolve(import.meta.dirname, "../../public/tv/legacy.css");

type LegacyWindow = Window & {
  __castifyLegacyLoaded?: boolean;
  __castifyLegacyInit?: () => void;
};

/** Evaluate the shipped legacy.js bytes in the jsdom global scope. */
function loadLegacyScript(): void {
  const code = readFileSync(legacyJsPath, "utf8");
  // The TV runs these bytes as-is; the test must too.
  new Function(code)();
}

/** The script mutates global state (window flags, DOM); reset between tests. */
function resetLegacyDom(): void {
  document.getElementById("castify-legacy")?.remove();
  document.getElementById("castify-legacy-css")?.remove();
  const legacyWindow = window as LegacyWindow;
  delete legacyWindow.__castifyLegacyLoaded;
  delete legacyWindow.__castifyLegacyInit;
  const root = document.getElementById("root");
  if (root) root.style.display = "";
}

describe("legacy tv skeleton (task 001)", () => {
  afterEach(resetLegacyDom);

  it("ships legacy.js and legacy.css under public/tv/", () => {
    expect(() => readFileSync(legacyJsPath), "public/tv/legacy.js").not.toThrow();
    expect(() => readFileSync(legacyCssPath), "public/tv/legacy.css").not.toThrow();
  });

  it("renders the placeholder into #castify-legacy and hides #root", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    expect(container, "#castify-legacy container").not.toBeNull();
    expect(container?.textContent).toContain("Loading");
    expect(root.style.display, "#root hidden in forced mode").toBe("none");
  });

  it("exposes window.__castifyLegacyInit for tests and forced mode", () => {
    loadLegacyScript();

    expect(typeof (window as LegacyWindow).__castifyLegacyInit).toBe("function");
  });

  it("is idempotent — evaluating the script twice renders one container", () => {
    loadLegacyScript();
    expect(() => loadLegacyScript()).not.toThrow();
    expect(document.querySelectorAll("#castify-legacy")).toHaveLength(1);
  });

  it("appends the /tv/legacy.css stylesheet exactly once", () => {
    loadLegacyScript();
    loadLegacyScript();

    const links = document.querySelectorAll('link[rel="stylesheet"][href="/tv/legacy.css"]');
    expect(links).toHaveLength(1);
  });

  it("scopes every legacy.css selector under #castify-legacy", () => {
    const css = readFileSync(legacyCssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = css
      .split("}")
      .map((rule) => rule.split("{")[0].trim())
      .filter((selector) => selector.length > 0);

    expect(selectors.length, "at least one rule").toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(
        selector.startsWith("#castify-legacy"),
        `unscoped selector: ${selector}`,
      ).toBe(true);
    }
  });
});
