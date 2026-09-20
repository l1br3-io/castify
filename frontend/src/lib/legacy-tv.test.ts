// Legacy TV player (legacy-tv-player tasks 001+): the legacy page is a
// dependency-free ES5 script + static CSS under public/tv/ that pre-module
// browsers (Samsung Tizen TV, Chromium-38-era) evaluate directly. These tests
// load the real bytes the TV downloads — no bundler, no transforms — so what
// passes here is what ships.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderKey, VideoSummaryDto } from "../api/types";

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
  window.history.pushState({}, "", "/");
  vi.unstubAllGlobals();
}

// ── Fake XHR harness ────────────────────────────────────────────────────────
//
// The legacy script speaks XMLHttpRequest (fetch is Chrome 42+; the Tizen
// engine is older). This stub routes GETs/POSTs to canned responses and
// records every request for URL assertions. Responses fire on a macrotask
// (setTimeout 0) like a real network tick, so the script's async contract
// (handlers may attach after send) is exercised honestly.

type RecordedRequest = {
  method: string;
  url: string;
  body: string | null;
  headers: Record<string, string>;
};

type FakeReply = { status: number; body?: unknown };

type FakeRoute = {
  method: string;
  pattern: RegExp;
  respond: (request: RecordedRequest) => FakeReply;
};

class FakeXMLHttpRequest {
  static requests: RecordedRequest[] = [];
  static routes: FakeRoute[] = [];

  static get(url: string, respond: (request: RecordedRequest) => FakeReply): void {
    FakeXMLHttpRequest.routes.push({ method: "GET", pattern: new RegExp(`^${url}$`), respond });
  }

  static post(url: string, respond: (request: RecordedRequest) => FakeReply): void {
    FakeXMLHttpRequest.routes.push({ method: "POST", pattern: new RegExp(`^${url}$`), respond });
  }

  static reset(): void {
    FakeXMLHttpRequest.requests = [];
    FakeXMLHttpRequest.routes = [];
  }

  readyState = 0;
  status = 0;
  responseText = "";
  onreadystatechange: (() => void) | null = null;
  onload: (() => void) | null = null;
  private method = "";
  private url = "";
  private sentBody: string | null = null;
  private headers: Record<string, string> = {};

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  getResponseHeader(): string | null {
    return null;
  }

  send(body?: string): void {
    this.sentBody = body ?? null;
    const request: RecordedRequest = {
      method: this.method,
      url: this.url,
      body: this.sentBody,
      headers: this.headers,
    };
    FakeXMLHttpRequest.requests.push(request);
    const method = this.method;
    const url = this.url;
    setTimeout(() => {
      const route = FakeXMLHttpRequest.routes.find(
        (r) => r.method === method && r.pattern.test(url),
      );
      const reply = route ? route.respond(request) : { status: 404, body: { error: "no fake route" } };
      this.status = reply.status;
      this.responseText = reply.body === undefined ? "" : JSON.stringify(reply.body);
      this.readyState = 4;
      if (this.onreadystatechange) this.onreadystatechange();
      if (this.onload) this.onload();
    }, 0);
  }
}

function stubShareApi(setup: (fake: typeof FakeXMLHttpRequest) => void): void {
  FakeXMLHttpRequest.reset();
  setup(FakeXMLHttpRequest);
  vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
}

function requestedUrls(): string[] {
  return FakeXMLHttpRequest.requests.map((request) => `${request.method} ${request.url}`);
}

/** A share item as the items endpoint returns it (flattened summary). */
function shareItem(
  overrides: Partial<VideoSummaryDto> = {},
): VideoSummaryDto & { folder_id: string | null } {
  return {
    id: "vid_1",
    name: "Holiday.mp4",
    provider: "google_drive" as ProviderKey,
    size_bytes: 524288000,
    mime_type: "video/mp4",
    duration_ms: 754000,
    width: 1920,
    height: 1080,
    sources: [],
    created_at: "2026-01-01T00:00:00Z",
    path: null,
    is_favorite: false,
    my_rating: null,
    thumbnail_status: "pending",
    position_seconds: null,
    completed: false,
    folder_id: null,
    ...overrides,
  };
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

describe("legacy tv watch happy path (task 003)", () => {
  afterEach(resetLegacyDom);

  it("renders a <video> with stream src, poster, metadata, and native subtitle tracks", async () => {
    window.history.pushState({}, "", "/share/tok_1/watch/vid_1");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_1/items", () => ({
        status: 200,
        body: { folders: [], items: [shareItem()] },
      }));
      fake.get("/api/share/tok_1/videos/vid_1/stream-url", () => ({
        status: 200,
        body: { url: "https://cdn.example.com/v.mp4?sig=abc", strategy: "direct", expires_at: null },
      }));
      fake.get("/api/share/tok_1/videos/vid_1/subtitles", () => ({
        status: 200,
        body: [
          { id: "st_vtt", language: "en", filename: "a.en.vtt", format: "vtt", format_family: "text", embedded_track_id: null },
          { id: "st_ass", language: "ja", filename: "a.ja.ass", format: "ass", format_family: "text", embedded_track_id: null },
          { id: "st_pgs", language: "es", filename: "mkv.es.pgs", format: "pgs", format_family: "image", embedded_track_id: 2 },
        ],
      }));
    });

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    expect(container?.textContent).toContain("Loading");

    await waitFor(() => {
      expect(container?.querySelector("video")).not.toBeNull();
    });

    const video = container?.querySelector("video");
    expect(video?.getAttribute("src")).toBe("https://cdn.example.com/v.mp4?sig=abc");
    expect(video?.getAttribute("poster")).toBe("/api/share/tok_1/videos/vid_1/thumbnail");
    expect(video?.hasAttribute("controls")).toBe(true);

    expect(container?.textContent).toContain("Holiday.mp4");
    expect(container?.textContent).toContain("12:34");
    expect(container?.textContent).toContain("500.0 MB");

    const tracks = video?.querySelectorAll("track");
    expect(tracks).toHaveLength(1);
    expect(tracks?.[0].getAttribute("kind")).toBe("subtitles");
    expect(tracks?.[0].getAttribute("srclang")).toBe("en");
    expect(tracks?.[0].getAttribute("src")).toBe("/api/share/tok_1/videos/vid_1/subtitles/st_vtt");

    expect(requestedUrls()).toEqual([
      "GET /api/share/tok_1/items",
      "GET /api/share/tok_1/videos/vid_1/stream-url",
      "GET /api/share/tok_1/videos/vid_1/subtitles",
    ]);
  });

  it("plays proxy and cached strategies the same as direct", async () => {
    window.history.pushState({}, "", "/share/tok_9/watch/vid_9");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_9/items", () => ({
        status: 200,
        body: { folders: [], items: [shareItem({ id: "vid_9", name: "Cached.mp4" })] },
      }));
      fake.get("/api/share/tok_9/videos/vid_9/stream-url", () => ({
        status: 200,
        body: { url: "/api/share/tok_9/videos/vid_9/stream", strategy: "cached", expires_at: null },
      }));
      fake.get("/api/share/tok_9/videos/vid_9/subtitles", () => ({ status: 200, body: [] }));
    });

    loadLegacyScript();

    await waitFor(() => {
      expect(document.getElementById("castify-legacy")?.querySelector("video")).not.toBeNull();
    });
    expect(document.querySelector("#castify-legacy video")?.getAttribute("src")).toBe(
      "/api/share/tok_9/videos/vid_9/stream",
    );
  });
});
