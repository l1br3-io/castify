import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom doesn't implement scrollIntoView — T8's "View All" handler calls it
// to smooth-scroll to the grid section. Mock it as a no-op.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom doesn't implement the Fullscreen API. M3 T8's fullscreen toggle calls
// `requestFullscreen()` on the player container and reads `document.fullscreenElement`.
// Mock the request/exit methods as no-ops returning a resolved promise (matching the
// real API's `Promise<void>`). Tests that need to verify the toggle dispatch
// `fullscreenchange` manually (jsdom won't fire it from the no-op).
if (!Element.prototype.requestFullscreen) {
  Element.prototype.requestFullscreen = () => Promise.resolve();
}
if (!Document.prototype.exitFullscreen) {
  Document.prototype.exitFullscreen = () => Promise.resolve();
}

// jsdom 25 doesn't ship PointerEvent. M3 T8's seek drag uses pointer events
// (pointerdown/move/up); Testing Library's fireEvent falls back to a plain
// Event (no clientX) without this, breaking coordinate-based dispatch.
// Polyfill a minimal MouseEvent subclass so clientX/clientY survive.
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  (
    globalThis as unknown as { PointerEvent: typeof PointerEventPolyfill }
  ).PointerEvent = PointerEventPolyfill;
}

afterEach(() => {
  cleanup();
});
