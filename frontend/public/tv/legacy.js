/*
 * Castify legacy TV player.
 *
 * GOTCHA: this file must stay ES5 — no let/const, arrow functions, `?.`,
 * `??`, template literals, Promise, or fetch. The target browser is a
 * Samsung Smart TV (Tizen, Chromium-38-era); anything newer is a parse
 * error that blanks the page. The acorn ecmaVersion:5 gate in
 * src/lib/legacy-tv.test.ts enforces this.
 *
 * Dispatch: an inline probe in index.html appends this script on browsers
 * that cannot run the modern bundle (?legacy=1 forces it for dev/e2e).
 * The modern app's #root is hidden and all rendering happens inside the
 * #castify-legacy container, whose styles live in /tv/legacy.css.
 */
(function () {
  "use strict";

  if (window.__castifyLegacyLoaded) {
    return;
  }
  window.__castifyLegacyLoaded = true;

  function ensureStylesheet() {
    if (document.getElementById("castify-legacy-css")) {
      return;
    }
    var link = document.createElement("link");
    link.id = "castify-legacy-css";
    link.rel = "stylesheet";
    link.href = "/tv/legacy.css";
    document.head.appendChild(link);
  }

  function ensureContainer() {
    var root = document.getElementById("root");
    if (root) {
      root.style.display = "none";
    }
    var container = document.getElementById("castify-legacy");
    if (!container) {
      container = document.createElement("div");
      container.id = "castify-legacy";
      document.body.appendChild(container);
    }
    return container;
  }

  function render() {
    ensureStylesheet();
    var container = ensureContainer();
    /* Task 001 skeleton: route flows (watch, landing) replace this
     * placeholder in later tasks. */
    container.innerHTML = '<p class="tv-loading">Loading&#8230;</p>';
  }

  /* Re-entry point for tests and forced mode; the TV path auto-runs it. */
  window.__castifyLegacyInit = function () {
    render();
  };

  render();
})();
