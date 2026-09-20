// Loader dispatch (legacy-tv-player task 002): the inline probe in
// index.html decides between the modern bundle and /tv/legacy.js. These
// tests evaluate the real inline script bytes from index.html in jsdom with
// controlled capability stubs — the same code the browser runs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const indexHtml = readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8");

/** The inline (src-less) scripts, in document order. */
function inlineScripts(): string[] {
  const scripts: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  for (const match of indexHtml.matchAll(re)) {
    scripts.push(match[1]);
  }
  return scripts;
}

/** The legacy dispatch block: the inline script that probes noModule. */
function loaderScript(): string {
  const loader = inlineScripts().find((code) => code.includes("noModule"));
  if (loader === undefined) throw new Error("legacy loader script not found in index.html");
  return loader;
}

function runLoader(): void {
  new Function(loaderScript())();
}

function appendedLegacyScripts(): HTMLScriptElement[] {
  return Array.from(document.head.querySelectorAll('script[src="/tv/legacy.js"]'));
}

function withNoModuleStub(present: boolean, run: () => void): void {
  const prototype = HTMLScriptElement.prototype as unknown as Record<string, unknown>;
  const hadNoModule = "noModule" in prototype;
  if (hadNoModule !== present) {
    if (present) prototype.noModule = true;
    else delete prototype.noModule;
  }
  try {
    run();
  } finally {
    if (hadNoModule !== present) {
      if (hadNoModule) prototype.noModule = true;
      else delete prototype.noModule;
    }
  }
}

function resetLoaderEnvironment(): void {
  for (const script of appendedLegacyScripts()) script.remove();
  window.history.pushState({}, "", "/");
}

afterEach(resetLoaderEnvironment);

describe("legacy loader dispatch (task 002)", () => {
  it("index.html carries the module entry unchanged", () => {
    expect(indexHtml).toContain('<script type="module" src="/src/main.tsx"></script>');
  });

  it("the loader probes modern syntax via new Function and honors ?legacy=1", () => {
    const loader = loaderScript();
    expect(loader).toContain('new Function("return ({}).a?.b")');
    expect(loader).toContain("legacy=1");
    expect(loader).toContain("/tv/legacy.js");
  });

  it("the loader block stays ES5 (no let/const/arrows)", () => {
    const loader = loaderScript();
    expect(/\blet\b/.test(loader)).toBe(false);
    expect(/\bconst\b/.test(loader)).toBe(false);
    expect(/=>/.test(loader)).toBe(false);
  });

  it("appends nothing on a modern browser", () => {
    withNoModuleStub(true, () => {
      runLoader();
      expect(appendedLegacyScripts()).toHaveLength(0);
    });
  });

  it("appends exactly one /tv/legacy.js script when noModule is missing", () => {
    withNoModuleStub(false, () => {
      runLoader();
      expect(appendedLegacyScripts()).toHaveLength(1);
    });
  });

  it("appends /tv/legacy.js when ?legacy=1 forces it on a modern browser", () => {
    withNoModuleStub(true, () => {
      window.history.pushState({}, "", "/?legacy=1");
      runLoader();
      expect(appendedLegacyScripts()).toHaveLength(1);
    });
  });
});
