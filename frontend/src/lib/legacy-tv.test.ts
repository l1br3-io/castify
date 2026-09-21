// Legacy TV player (legacy-tv-player tasks 001+): the legacy page is a
// dependency-free ES5 script + static CSS under public/tv/ that pre-module
// browsers (Samsung Tizen TV, Chromium-38-era) evaluate directly. These tests
// load the real bytes the TV downloads — no bundler, no transforms — so what
// passes here is what ships.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderKey, ShareFolderDto, VideoSummaryDto } from "../api/types";

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
  window.onpopstate = null;
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

/**
 * jsdom's canPlayType answers "" for everything; real browsers answer
 * "probably"/"maybe". Stub the reply to control the legacy gate's branch.
 */
function stubCanPlay(reply: "probably" | "maybe" | ""): void {
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(reply);
}

/** A share item as the items endpoint returns it (flattened summary). */
function shareItem(
  overrides: Partial<VideoSummaryDto> & { folder_id?: string | null } = {},
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

/** A share folder as the items endpoint returns it (`ShareFolderDto`). */
function shareFolder(overrides: Partial<ShareFolderDto> = {}): ShareFolderDto {
  return { id: "f_1", parent_id: null, name: "Folder", position: 0, ...overrides };
}

// Canonical nested fixture for the nav-search effort: two root folders (payload
// order deliberately shuffled so tests prove `position` ordering), a subfolder,
// an empty folder, and one video per level.
const NAV_SEARCH_FOLDERS: ShareFolderDto[] = [
  shareFolder({ id: "f_s2", name: "Season 2", position: 1 }),
  shareFolder({ id: "f_s1", name: "Season 1", position: 0 }),
  shareFolder({ id: "f_day1", parent_id: "f_s1", name: "Day 1", position: 0 }),
  shareFolder({ id: "f_empty", name: "Empty", position: 2 }),
];

const NAV_SEARCH_ITEMS: Array<VideoSummaryDto & { folder_id: string | null }> = [
  shareItem({ id: "vid_root", name: "Trailer.mp4", folder_id: null }),
  shareItem({ id: "vid_s1", name: "Episode 1.mp4", folder_id: "f_s1" }),
  shareItem({ id: "vid_day1", name: "Episode 2.mp4", folder_id: "f_day1" }),
  shareItem({ id: "vid_s2", name: "Extras.mp4", folder_id: "f_s2" }),
];

describe("legacy tv skeleton (task 001)", () => {
  afterEach(resetLegacyDom);

  it("ships legacy.js and legacy.css under public/tv/", () => {
    expect(() => readFileSync(legacyJsPath), "public/tv/legacy.js").not.toThrow();
    expect(() => readFileSync(legacyCssPath), "public/tv/legacy.css").not.toThrow();
  });

  it("renders into #castify-legacy and hides #root", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    expect(container, "#castify-legacy container").not.toBeNull();
    expect(container?.textContent?.length ?? 0).toBeGreaterThan(0);
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
    const css = readFileSync(legacyCssPath, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Flatten at-rule preludes (@media (…) {) so the enclosing condition
      // isn't mistaken for a selector — the inner rules are checked as-is.
      .replace(/@[^{}]*\{/g, "{");
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
    stubCanPlay("probably");
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
    stubCanPlay("probably");
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

describe("legacy tv landing + unlock + notice (task 004)", () => {
  afterEach(resetLegacyDom);

  it("renders the share-links-only notice on non-share paths", () => {
    window.history.pushState({}, "", "/settings");
    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    expect(container?.textContent).toContain("Castify on this TV supports share links only.");
  });

  it("renders one anchor per video — thumbnail and name share the same link", async () => {
    window.history.pushState({}, "", "/share/tok_2");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_2", () => ({
        status: 200,
        body: { title: "Trip videos", item_count: 2, locked: false, status: "active" },
      }));
      fake.get("/api/share/tok_2/items", () => ({
        status: 200,
        body: {
          folders: [],
          items: [
            shareItem({ id: "vid_a", name: "Beach.mp4" }),
            shareItem({ id: "vid_b", name: "Mountains.mp4", duration_ms: 3661000 }),
          ],
        },
      }));
    });

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelectorAll("a.tv-item-link")).toHaveLength(2);
    });

    expect(container?.querySelector(".tv-title")?.textContent).toBe("Trip videos");

    const first = container?.querySelectorAll("a.tv-item-link")[0];
    const expectedHref = "/share/tok_2/watch/vid_a";
    expect(first?.getAttribute("href")).toBe(expectedHref);
    // Click parity: the thumbnail img lives inside the same anchor as the
    // name — one link, so both clicks navigate identically (FR-3.1).
    const thumb = first?.querySelector("img.tv-item-thumb");
    expect(thumb?.getAttribute("src")).toBe("/api/share/tok_2/videos/vid_a/thumbnail");
    expect(thumb?.closest("a")?.getAttribute("href")).toBe(expectedHref);
    expect(first?.querySelector(".tv-item-name")?.textContent).toBe("Beach.mp4");
    expect(first?.querySelector(".tv-item-name")?.closest("a")?.getAttribute("href")).toBe(expectedHref);

    const second = container?.querySelectorAll("a.tv-item-link")[1];
    expect(second?.getAttribute("href")).toBe("/share/tok_2/watch/vid_b");
    expect(second?.textContent).toContain("1:01:01");
  });

  it("renders the unlock form when the share is locked", async () => {
    window.history.pushState({}, "", "/share/tok_3");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_3", () => ({
        status: 200,
        body: { title: "Private videos", item_count: 1, locked: true, status: "active" },
      }));
      fake.get("/api/share/tok_3/items", () => ({ status: 401, body: { error: "locked" } }));
    });

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelector("input[type=password]")).not.toBeNull();
    });

    expect(container?.querySelector(".tv-title")?.textContent).toBe("Private videos");
    expect(container?.querySelector('label[for="tv-password"]')?.textContent).toBe("Password");
    expect(requestedUrls()).toContain("GET /api/share/tok_3");
  });

  it("wrong password shows an inline message and stays on the form", async () => {
    window.history.pushState({}, "", "/share/tok_4");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_4", () => ({
        status: 200,
        body: { title: "Private videos", item_count: 1, locked: true, status: "active" },
      }));
      fake.get("/api/share/tok_4/items", () => ({ status: 401, body: { error: "locked" } }));
      fake.post("/api/share/tok_4/unlock", () => ({ status: 401, body: { error: "wrong password" } }));
    });

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelector("input[type=password]")).not.toBeNull();
    });

    (document.getElementById("tv-password") as HTMLInputElement).value = "nope";
    fireEvent.submit(document.getElementById("tv-unlock-form") as HTMLFormElement);

    await waitFor(() => {
      expect(container?.textContent).toContain("Wrong password");
    });
    expect(container?.querySelector("input[type=password]")).not.toBeNull();

    const unlockRequest = FakeXMLHttpRequest.requests.find((r) => r.url === "/api/share/tok_4/unlock");
    expect(unlockRequest?.method).toBe("POST");
    expect(unlockRequest?.body).toBe(JSON.stringify({ password: "nope" }));
    expect(unlockRequest?.headers["Content-Type"]).toBe("application/json");
  });

  it("successful unlock refetches and renders the video list", async () => {
    window.history.pushState({}, "", "/share/tok_5");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_5", () => ({
        status: 200,
        body: { title: "Private videos", item_count: 1, locked: true, status: "active" },
      }));
      fake.get("/api/share/tok_5/items", () => {
        const unlocked = FakeXMLHttpRequest.requests.some((r) => r.url === "/api/share/tok_5/unlock");
        return unlocked
          ? { status: 200, body: { folders: [], items: [shareItem({ id: "vid_x", name: "Secret.mp4" })] } }
          : { status: 401, body: { error: "locked" } };
      });
      fake.post("/api/share/tok_5/unlock", () => ({ status: 204 }));
    });

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelector("input[type=password]")).not.toBeNull();
    });

    (document.getElementById("tv-password") as HTMLInputElement).value = "hunter2";
    fireEvent.submit(document.getElementById("tv-unlock-form") as HTMLFormElement);

    await waitFor(() => {
      expect(container?.querySelectorAll("a.tv-item-link")).toHaveLength(1);
    });
    expect(container?.querySelector("a.tv-item-link")?.getAttribute("href")).toBe("/share/tok_5/watch/vid_x");
  });

  it("rate limit (429) shows the wait message", async () => {
    window.history.pushState({}, "", "/share/tok_6");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_6", () => ({
        status: 200,
        body: { title: "Private videos", item_count: 1, locked: true, status: "active" },
      }));
      fake.get("/api/share/tok_6/items", () => ({ status: 401, body: { error: "locked" } }));
      fake.post("/api/share/tok_6/unlock", () => ({ status: 429, body: { error: "rate limited" } }));
    });

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelector("input[type=password]")).not.toBeNull();
    });

    (document.getElementById("tv-password") as HTMLInputElement).value = "a";
    fireEvent.submit(document.getElementById("tv-unlock-form") as HTMLFormElement);

    await waitFor(() => {
      expect(container?.textContent).toContain("Too many attempts");
    });
  });

  it.each([
    [404, "This share doesn't exist."],
    [410, "This share is no longer available."],
  ])("dead share (%s) renders terminal copy on the landing page", async (code, copy) => {
    window.history.pushState({}, "", "/share/tok_dead");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_dead", () => ({ status: code, body: { error: "dead" } }));
    });

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.textContent).toContain(copy);
    });
  });
});

describe("legacy tv watch edge states (task 005)", () => {
  afterEach(resetLegacyDom);

  function stubWatchApi(token: string, options: {
    itemsStatus?: () => number;
    streamStatus?: () => number;
    streamBody?: () => unknown;
  } = {}): void {
    stubShareApi((fake) => {
      const itemsStatus = options.itemsStatus ?? (() => 200);
      const streamStatus = options.streamStatus ?? (() => 200);
      fake.get(`/api/share/${token}/items`, () => {
        const status = itemsStatus();
        return status === 200
          ? { status, body: { folders: [], items: [shareItem()] } }
          : { status, body: { error: "gate" } };
      });
      fake.get(`/api/share/${token}/videos/vid_1/stream-url`, () => {
        const status = streamStatus();
        return status === 200
          ? { status, body: options.streamBody?.() ?? { url: "https://cdn.example.com/v.mp4", strategy: "direct", expires_at: null } }
          : { status, body: { error: "stream" } };
      });
      fake.get(`/api/share/${token}/videos/vid_1/subtitles`, () => ({ status: 200, body: [] }));
    });
  }

  it("items 401 on a watch URL shows the unlock form, then plays in place after unlock", async () => {
    window.history.pushState({}, "", "/share/tok_w1/watch/vid_1");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_w1", () => ({
        status: 200,
        body: { title: "Locked share", item_count: 1, locked: true, status: "active" },
      }));
      fake.get("/api/share/tok_w1/items", () => {
        const unlocked = FakeXMLHttpRequest.requests.some((r) => r.url === "/api/share/tok_w1/unlock");
        return unlocked
          ? { status: 200, body: { folders: [], items: [shareItem()] } }
          : { status: 401, body: { error: "locked" } };
      });
      fake.get("/api/share/tok_w1/videos/vid_1/stream-url", () => ({
        status: 200,
        body: { url: "https://cdn.example.com/unlocked.mp4", strategy: "direct", expires_at: null },
      }));
      fake.get("/api/share/tok_w1/videos/vid_1/subtitles", () => ({ status: 200, body: [] }));
      fake.post("/api/share/tok_w1/unlock", () => ({ status: 204 }));
    });
    stubCanPlay("probably");

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelector("input[type=password]")).not.toBeNull();
    });
    expect(container?.querySelector(".tv-title")?.textContent).toBe("Locked share");

    (document.getElementById("tv-password") as HTMLInputElement).value = "pw";
    fireEvent.submit(document.getElementById("tv-unlock-form") as HTMLFormElement);

    await waitFor(() => {
      expect(container?.querySelector("video")).not.toBeNull();
    });
    expect(container?.querySelector("video")?.getAttribute("src")).toBe("https://cdn.example.com/unlocked.mp4");
    // In-place recovery: the watch flow re-ran, no landing list rendered.
    expect(container?.querySelectorAll("a.tv-item-link")).toHaveLength(0);
  });

  it.each([
    [404, "This share doesn't exist."],
    [410, "This share is no longer available."],
  ])("watch items %s renders the terminal copy", async (code, copy) => {
    window.history.pushState({}, "", "/share/tok_w2/watch/vid_1");
    stubWatchApi("tok_w2", { itemsStatus: () => code });

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.textContent).toContain(copy);
    });
    expect(container?.querySelector("video")).toBeNull();
  });

  it("missing member renders the not-in-share block with a back link", async () => {
    window.history.pushState({}, "", "/share/tok_w3/watch/vid_other");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_w3/items", () => ({
        status: 200,
        body: { folders: [], items: [shareItem()] },
      }));
    });
    stubCanPlay("probably");

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.textContent).toContain("This video isn't part of the share.");
    });
    const back = container?.querySelector("a.tv-back");
    expect(back?.getAttribute("href")).toBe("/share/tok_w3");
  });

  it("stream-url failure renders Couldn't-load with a working Retry", async () => {
    window.history.pushState({}, "", "/share/tok_w4/watch/vid_1");
    let failures = 0;
    stubShareApi((fake) => {
      fake.get("/api/share/tok_w4/items", () => ({
        status: 200,
        body: { folders: [], items: [shareItem()] },
      }));
      fake.get("/api/share/tok_w4/videos/vid_1/stream-url", () => {
        failures += 1;
        return failures < 2 ? { status: 500, body: { error: "boom" } } : { status: 200, body: { url: "https://cdn.example.com/ok.mp4", strategy: "direct", expires_at: null } };
      });
      fake.get("/api/share/tok_w4/videos/vid_1/subtitles", () => ({ status: 200, body: [] }));
    });
    stubCanPlay("probably");

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.textContent).toContain("Couldn't load this video");
    });

    fireEvent.click(document.getElementById("tv-retry") as HTMLElement);

    await waitFor(() => {
      expect(container?.querySelector("video")).not.toBeNull();
    });
    expect(container?.querySelector("video")?.getAttribute("src")).toBe("https://cdn.example.com/ok.mp4");
  });

  it("stream-url 404 renders the removed-from-share terminal", async () => {
    window.history.pushState({}, "", "/share/tok_w5/watch/vid_1");
    stubWatchApi("tok_w5", { streamStatus: () => 404 });
    stubCanPlay("probably");

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.textContent).toContain("This video is no longer available in this share");
    });
  });

  it("transcode strategy renders the dedicated unsupported card", async () => {
    window.history.pushState({}, "", "/share/tok_w6/watch/vid_1");
    stubWatchApi("tok_w6", {
      streamBody: () => ({ url: "/api/share/tok_w6/videos/vid_1/master.m3u8", strategy: "transcode", expires_at: null }),
    });

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.textContent).toContain("Transcoding isn't supported on this TV");
    });
    expect(container?.textContent).toContain("MP4 (H.264)");
    expect(container?.querySelector("video")).toBeNull();
  });

  it("canPlayType empty renders the can't-play card", async () => {
    window.history.pushState({}, "", "/share/tok_w7/watch/vid_1");
    stubWatchApi("tok_w7");
    stubCanPlay("");

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.textContent).toContain("This format can't be played in-browser");
    });
    expect(container?.querySelector("video")).toBeNull();
  });

  it("recovers once from a CDN-expiry video error, then gives up", async () => {
    window.history.pushState({}, "", "/share/tok_w8/watch/vid_1");
    let served = 0;
    stubShareApi((fake) => {
      fake.get("/api/share/tok_w8/items", () => ({
        status: 200,
        body: { folders: [], items: [shareItem()] },
      }));
      fake.get("/api/share/tok_w8/videos/vid_1/stream-url", () => {
        served += 1;
        return { status: 200, body: { url: "https://cdn.example.com/v-" + served + ".mp4", strategy: "direct", expires_at: null } };
      });
      fake.get("/api/share/tok_w8/videos/vid_1/subtitles", () => ({ status: 200, body: [] }));
    });
    stubCanPlay("probably");

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelector("video")).not.toBeNull();
    });

    const video = container?.querySelector("video") as HTMLVideoElement;
    video.currentTime = 42;
    fireEvent.error(video);

    await waitFor(() => {
      expect(video.getAttribute("src")).toBe("https://cdn.example.com/v-2.mp4");
    });
    expect(video.currentTime).toBe(42);
    expect(
      FakeXMLHttpRequest.requests.filter((r) => r.url === "/api/share/tok_w8/videos/vid_1/stream-url"),
    ).toHaveLength(2);

    fireEvent.error(video);

    await waitFor(() => {
      expect(container?.textContent).toContain("This format can't be played in-browser");
    });
    expect(
      FakeXMLHttpRequest.requests.filter((r) => r.url === "/api/share/tok_w8/videos/vid_1/stream-url"),
    ).toHaveLength(2);
  });

  it("subtitle fetch failure is non-fatal — the video still renders", async () => {
    window.history.pushState({}, "", "/share/tok_w9/watch/vid_1");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_w9/items", () => ({
        status: 200,
        body: { folders: [], items: [shareItem()] },
      }));
      fake.get("/api/share/tok_w9/videos/vid_1/stream-url", () => ({
        status: 200,
        body: { url: "https://cdn.example.com/v.mp4", strategy: "direct", expires_at: null },
      }));
      fake.get("/api/share/tok_w9/videos/vid_1/subtitles", () => ({ status: 500, body: { error: "boom" } }));
    });
    stubCanPlay("probably");

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelector("video")).not.toBeNull();
    });
    expect(container?.querySelector("video")?.getAttribute("src")).toBe("https://cdn.example.com/v.mp4");
    expect(container?.querySelectorAll("track")).toHaveLength(0);
  });
});

describe("legacy tv forced-mode link continuity (FR-1.4)", () => {
  afterEach(resetLegacyDom);

  it("preserves ?legacy=1 on item links when the page was forced", async () => {
    window.history.pushState({}, "", "/share/tok_fl?legacy=1");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_fl", () => ({
        status: 200,
        body: { title: "Forced", item_count: 1, locked: false, status: "active" },
      }));
      fake.get("/api/share/tok_fl/items", () => ({
        status: 200,
        body: { folders: [], items: [shareItem()] },
      }));
    });

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelectorAll("a.tv-item-link")).toHaveLength(1);
    });
    expect(container?.querySelector("a.tv-item-link")?.getAttribute("href")).toBe(
      "/share/tok_fl/watch/vid_1?legacy=1",
    );
  });

  it("keeps clean URLs when not forced (real TVs)", async () => {
    window.history.pushState({}, "", "/share/tok_clean");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_clean", () => ({
        status: 200,
        body: { title: "Clean", item_count: 1, locked: false, status: "active" },
      }));
      fake.get("/api/share/tok_clean/items", () => ({
        status: 200,
        body: { folders: [], items: [shareItem()] },
      }));
    });

    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelectorAll("a.tv-item-link")).toHaveLength(1);
    });
    expect(container?.querySelector("a.tv-item-link")?.getAttribute("href")).toBe(
      "/share/tok_clean/watch/vid_1",
    );
  });
});

describe("legacy tv folder browse (nav-search task 001)", () => {
  afterEach(resetLegacyDom);

  /** Landing at `path` against the canonical nested fixture (tok_fb). */
  function stubFolderedShare(path: string): void {
    window.history.pushState({}, "", path);
    stubShareApi((fake) => {
      fake.get("/api/share/tok_fb", () => ({
        status: 200,
        body: { title: "Trip videos", item_count: 4, locked: false, status: "active" },
      }));
      fake.get("/api/share/tok_fb/items", () => ({
        status: 200,
        body: { folders: NAV_SEARCH_FOLDERS, items: NAV_SEARCH_ITEMS },
      }));
    });
  }

  async function renderLanding(): Promise<HTMLElement> {
    loadLegacyScript();
    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelectorAll("a.tv-item-link, a.tv-folder-link").length).toBeGreaterThan(0);
    });
    return container as HTMLElement;
  }

  function folderNames(container: HTMLElement): string[] {
    return [...container.querySelectorAll(".tv-folder-name")].map((el) => el.textContent);
  }

  function videoNames(container: HTMLElement): string[] {
    return [...container.querySelectorAll(".tv-item-name")].map((el) => el.textContent);
  }

  it("renders folder rows before video rows, position order, with direct counts", async () => {
    stubFolderedShare("/share/tok_fb");
    const container = await renderLanding();

    // Folders precede videos at the level; payload order must not leak through.
    expect(folderNames(container)).toEqual(["Season 1", "Season 2", "Empty"]);
    const rows = [...container.querySelectorAll("ul.tv-items > li")];
    expect(rows[0].querySelector("a")).toHaveClass("tv-folder-link");
    expect(rows[3].querySelector("a")).toHaveClass("tv-item-link");

    // Direct counts, parts only when non-zero (modern sidebar's "N videos" style).
    const counts = [...container.querySelectorAll(".tv-folder-counts")].map((el) => el.textContent);
    expect(counts[0]).toBe("1 videos · 1 folders");
    expect(counts[1]).toBe("1 videos");
    expect(container.querySelectorAll(".tv-folder-counts")).toHaveLength(2); // Empty has none

    // Root level shows no breadcrumb trail.
    expect(container.querySelector(".tv-crumbs")).toBeNull();
  });

  it("folder click pushStates the folder param and re-renders from memory — zero XHRs", async () => {
    stubFolderedShare("/share/tok_fb");
    const container = await renderLanding();
    expect(requestedUrls()).toEqual(["GET /api/share/tok_fb", "GET /api/share/tok_fb/items"]);

    fireEvent.click(container.querySelectorAll("a.tv-folder-link")[0]); // Season 1

    expect(window.location.search).toBe("?folder=f_s1");
    expect(folderNames(container)).toEqual(["Day 1"]);
    expect(videoNames(container)).toContain("Episode 1.mp4");
    expect(requestedUrls()).toEqual(["GET /api/share/tok_fb", "GET /api/share/tok_fb/items"]);
  });

  it("breadcrumbs: title is the root link, ancestors link, current crumb is plain text", async () => {
    stubFolderedShare("/share/tok_fb");
    const container = await renderLanding();

    fireEvent.click(container.querySelectorAll("a.tv-folder-link")[0]); // Season 1
    fireEvent.click(container.querySelectorAll("a.tv-folder-link")[0]); // Day 1

    const crumbs = container.querySelector(".tv-crumbs");
    expect(crumbs).not.toBeNull();
    const links = [...crumbs!.querySelectorAll("a.tv-crumb")];
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toBe("Trip videos");
    expect(links[0].getAttribute("href")).toBe("/share/tok_fb");
    expect(links[1].textContent).toBe("Season 1");
    expect(links[1].getAttribute("href")).toBe("/share/tok_fb?folder=f_s1");
    expect(crumbs!.querySelector(".tv-crumb-current")?.textContent).toBe("Day 1");
    // The current level is never a link — it's where you are.
    expect([...crumbs!.querySelectorAll("a")].some((a) => a.textContent === "Day 1")).toBe(false);
  });

  it("crumb clicks navigate like folder clicks", async () => {
    stubFolderedShare("/share/tok_fb");
    const container = await renderLanding();

    fireEvent.click(container.querySelectorAll("a.tv-folder-link")[0]); // Season 1
    fireEvent.click(container.querySelectorAll("a.tv-folder-link")[0]); // Day 1
    const crumbs = container.querySelector(".tv-crumbs")!;
    fireEvent.click(crumbs.querySelectorAll("a.tv-crumb")[1]); // Season 1

    expect(window.location.search).toBe("?folder=f_s1");
    expect(videoNames(container)).toContain("Episode 1.mp4");

    fireEvent.click(container.querySelector(".tv-crumbs")!.querySelectorAll("a.tv-crumb")[0]); // root
    expect(window.location.search).toBe("");
    expect(folderNames(container)).toEqual(["Season 1", "Season 2", "Empty"]);
  });

  it("history.back() (the remote's Return) re-renders the previous level", async () => {
    stubFolderedShare("/share/tok_fb");
    const container = await renderLanding();

    fireEvent.click(container.querySelectorAll("a.tv-folder-link")[0]); // Season 1
    fireEvent.click(container.querySelectorAll("a.tv-folder-link")[0]); // Day 1
    expect(window.location.search).toBe("?folder=f_day1");

    window.history.back();
    await waitFor(() => {
      expect(container.querySelectorAll(".tv-item-name")[0]?.textContent ?? "").toContain("Episode 1.mp4");
    });
    expect(window.location.search).toBe("?folder=f_s1");

    window.history.back();
    await waitFor(() => {
      expect(folderNames(container)).toEqual(["Season 1", "Season 2", "Empty"]);
    });
    expect(window.location.search).toBe("");
  });

  it("cold-loads ?folder= at that level", async () => {
    stubFolderedShare("/share/tok_fb?folder=f_day1");
    const container = await renderLanding();

    expect(window.location.search).toBe("?folder=f_day1");
    expect(folderNames(container)).toEqual([]);
    expect(videoNames(container)).toEqual(["Episode 2.mp4"]);
    expect(container.querySelector(".tv-crumb-current")?.textContent).toBe("Day 1");
  });

  it("stale ?folder= (folder since deleted) falls back to root, not an error", async () => {
    stubFolderedShare("/share/tok_fb?folder=zzz");
    const container = await renderLanding();

    expect(folderNames(container)).toEqual(["Season 1", "Season 2", "Empty"]);
    expect(container.querySelector(".tv-crumbs")).toBeNull();
  });

  it("empty folder: message with crumbs still navigable", async () => {
    stubFolderedShare("/share/tok_fb");
    const container = await renderLanding();

    fireEvent.click(container.querySelectorAll("a.tv-folder-link")[2]); // Empty

    expect(container.textContent).toContain("Nothing in this folder.");
    const crumbs = container.querySelector(".tv-crumbs");
    expect(crumbs).not.toBeNull();
    fireEvent.click(crumbs!.querySelectorAll("a.tv-crumb")[0]); // root
    expect(folderNames(container)).toEqual(["Season 1", "Season 2", "Empty"]);
  });

  it("watch links from inside a folder carry the folder param", async () => {
    stubFolderedShare("/share/tok_fb?folder=f_day1");
    const container = await renderLanding();

    expect(container.querySelector("a.tv-item-link")?.getAttribute("href")).toBe(
      "/share/tok_fb/watch/vid_day1?folder=f_day1",
    );
  });

  it("watch links merge legacy=1 with the folder param when forced", async () => {
    stubFolderedShare("/share/tok_fb?legacy=1&folder=f_day1");
    const container = await renderLanding();

    expect(container.querySelector("a.tv-item-link")?.getAttribute("href")).toBe(
      "/share/tok_fb/watch/vid_day1?legacy=1&folder=f_day1",
    );
  });

  it("folder-free share renders the classic flat list — no crumbs, no folder rows", async () => {
    window.history.pushState({}, "", "/share/tok_flat");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_flat", () => ({
        status: 200,
        body: { title: "Flat", item_count: 2, locked: false, status: "active" },
      }));
      fake.get("/api/share/tok_flat/items", () => ({
        status: 200,
        body: {
          folders: [],
          items: [shareItem({ id: "v1", name: "A.mp4" }), shareItem({ id: "v2", name: "B.mp4" })],
        },
      }));
    });

    loadLegacyScript();
    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelectorAll("a.tv-item-link")).toHaveLength(2);
    });

    expect(container?.querySelector(".tv-crumbs")).toBeNull();
    expect(container?.querySelector("a.tv-folder-link")).toBeNull();
    expect(container?.querySelector("a.tv-item-link")?.getAttribute("href")).toBe("/share/tok_flat/watch/v1");
  });
});

describe("legacy tv search (nav-search task 002)", () => {
  afterEach(resetLegacyDom);

  /** Landing at `path` against the canonical nested fixture (tok_fb). */
  function stubNestedShare(path: string): void {
    window.history.pushState({}, "", path);
    stubShareApi((fake) => {
      fake.get("/api/share/tok_fb", () => ({
        status: 200,
        body: { title: "Trip videos", item_count: 4, locked: false, status: "active" },
      }));
      fake.get("/api/share/tok_fb/items", () => ({
        status: 200,
        body: { folders: NAV_SEARCH_FOLDERS, items: NAV_SEARCH_ITEMS },
      }));
    });
  }

  async function renderLanding(): Promise<HTMLElement> {
    loadLegacyScript();
    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelectorAll("a.tv-item-link, a.tv-folder-link").length).toBeGreaterThan(0);
    });
    return container as HTMLElement;
  }

  function searchInput(container: HTMLElement): HTMLInputElement {
    return container.querySelector("#tv-search") as HTMLInputElement;
  }

  async function type(container: HTMLElement, query: string): Promise<void> {
    const input = searchInput(container);
    input.value = query;
    fireEvent.input(input);
    // The debounced callback rewrites the URL and re-renders in the same
    // tick — settle on the URL so the helper never resolves against a
    // stale render (a results count from the previous query, say).
    await waitFor(() => {
      const search = window.location.search;
      const settled = query === ""
        ? !search.includes("q=")
        : search.includes("q=" + encodeURIComponent(query));
      expect(settled).toBe(true);
    });
  }

  function resultPaths(container: HTMLElement): string[] {
    return [...container.querySelectorAll(".tv-item-path")].map((el) => el.textContent);
  }

  it("renders the header band — title + search field in one row, no autofocus", async () => {
    stubNestedShare("/share/tok_fb");
    const container = await renderLanding();

    const band = container.querySelector(".tv-header-band");
    expect(band).not.toBeNull();
    expect(band?.querySelector(".tv-title")?.textContent).toBe("Trip videos");
    const input = searchInput(container);
    expect(input.getAttribute("type")).toBe("search");
    expect(input.getAttribute("placeholder")).toBe("Search videos");
    // No autofocus: some TVs pop the on-screen keyboard on focus — rude on load.
    expect(document.activeElement).not.toBe(input);
  });

  it("typing filters the whole share after the debounce — not synchronously, zero XHRs", async () => {
    stubNestedShare("/share/tok_fb");
    const container = await renderLanding();
    expect(requestedUrls()).toEqual(["GET /api/share/tok_fb", "GET /api/share/tok_fb/items"]);

    const input = searchInput(container);
    input.value = "episode";
    fireEvent.input(input);
    // Debounced: the same tick must not have re-rendered or touched the URL.
    expect(container.querySelector(".tv-results-count")).toBeNull();
    expect(window.location.search).toBe("");

    await waitFor(() => {
      expect(container.querySelector(".tv-results-count")?.textContent).toBe("2 results");
    });
    expect(window.location.search).toBe("?q=episode");
    // Search mode hides browse chrome and flattens results across folders.
    expect(container.querySelector(".tv-crumbs")).toBeNull();
    expect(container.querySelector("a.tv-folder-link")).toBeNull();
    expect(requestedUrls()).toEqual(["GET /api/share/tok_fb", "GET /api/share/tok_fb/items"]);
  });

  it("labels each result with its folder path, root omitted", async () => {
    stubNestedShare("/share/tok_fb");
    const container = await renderLanding();

    await type(container, "episode");

    const names = [...container.querySelectorAll(".tv-item-name")].map((el) => el.textContent);
    expect(names).toEqual(["Episode 1.mp4", "Episode 2.mp4"]);
    expect(resultPaths(container)).toEqual(["Season 1", "Season 1 › Day 1"]);

    await type(container, "trailer");
    expect(container.querySelectorAll(".tv-item-name")).toHaveLength(1);
    // Root-level hits carry no path label — there is no folder to name.
    expect(resultPaths(container)).toEqual([]);
  });

  it("folder-name matches surface as folder rows; clicking one clears q and enters it", async () => {
    stubNestedShare("/share/tok_fb");
    const container = await renderLanding();

    await type(container, "season");

    expect(container.querySelector(".tv-results-count")?.textContent).toBe("2 results");
    const folderRows = [...container.querySelectorAll("a.tv-folder-link")];
    expect(folderRows).toHaveLength(2);
    expect(folderRows[0].querySelector(".tv-folder-name")?.textContent).toBe("Season 1");
    expect(folderRows[1].querySelector(".tv-folder-name")?.textContent).toBe("Season 2");

    fireEvent.click(folderRows[0]);

    expect(window.location.search).toBe("?folder=f_s1");
    expect(container.querySelector(".tv-results-count")).toBeNull();
    expect(container.querySelectorAll(".tv-item-name")).toHaveLength(1); // Episode 1
    expect(container.querySelector(".tv-crumb-current")?.textContent).toBe("Season 1");
  });

  it("writes ?q= via replaceState — back never steps through keystrokes", async () => {
    stubNestedShare("/share/tok_fb");
    const container = await renderLanding();

    await type(container, "epi");
    expect(window.location.search).toBe("?q=epi");

    await type(container, "episode");
    expect(window.location.search).toBe("?q=episode");

    // replaceState never pushed an entry: back lands on whatever preceded
    // the landing (the harness's reset entry, "/") — NOT on the mid-search
    // "?q=epi" a push-per-keystroke implementation would have produced.
    window.history.back();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(window.location.search).toBe("");
  });

  it("clearing the input restores the previous folder view, folder param intact", async () => {
    stubNestedShare("/share/tok_fb?folder=f_s1");
    const container = await renderLanding();

    await type(container, "episode");
    expect(window.location.search).toBe("?folder=f_s1&q=episode");

    const input = searchInput(container);
    input.value = "";
    fireEvent.input(input);
    await waitFor(() => {
      expect(container.querySelector(".tv-results-count")).toBeNull();
    });

    expect(window.location.search).toBe("?folder=f_s1");
    expect([...container.querySelectorAll(".tv-folder-name")].map((el) => el.textContent)).toEqual(["Day 1"]);
    expect(container.querySelector(".tv-crumb-current")?.textContent).toBe("Season 1");
  });

  it("zero results shows No-videos-match with a working clear-search button", async () => {
    stubNestedShare("/share/tok_fb");
    const container = await renderLanding();

    await type(container, "zzz");

    expect(container.textContent).toContain("No videos match.");
    const clear = container.querySelector("#tv-clear-search");
    expect(clear).not.toBeNull();

    fireEvent.click(clear as HTMLElement);

    await waitFor(() => {
      expect([...container.querySelectorAll(".tv-folder-name")].map((el) => el.textContent)).toEqual([
        "Season 1",
        "Season 2",
        "Empty",
      ]);
    });
    expect(window.location.search).toBe("");
    expect(searchInput(container).value).toBe("");
  });

  it("keeps the input focused across the debounced re-render (keyboard stays open)", async () => {
    stubNestedShare("/share/tok_fb");
    const container = await renderLanding();

    const input = searchInput(container);
    input.focus();
    input.value = "episode";
    fireEvent.input(input);

    await waitFor(() => {
      expect(container.querySelector(".tv-results-count")).not.toBeNull();
    });
    expect(document.activeElement).toBe(searchInput(container));

    // Cold load with ?q= must NOT autofocus — same on-screen-keyboard rule.
    stubNestedShare("/share/tok_fb?q=episode");
    document.getElementById("castify-legacy")?.remove();
    delete (window as LegacyWindow).__castifyLegacyLoaded;
    delete (window as LegacyWindow).__castifyLegacyInit;
    loadLegacyScript();
    const cold = document.getElementById("castify-legacy") as HTMLElement;
    await waitFor(() => {
      expect(cold.querySelector(".tv-results-count")).not.toBeNull();
    });
    expect(document.activeElement).not.toBe(cold.querySelector("#tv-search"));
  });

  it("escapes the query — markup in the box is data, not tags", async () => {
    stubNestedShare("/share/tok_fb");
    const container = await renderLanding();

    await type(container, "<b>x");

    expect(container.querySelector(".tv-results-count")?.textContent).toBe("0 results");
    expect(container.textContent).toContain("No videos match.");
    expect(container.querySelector("b")).toBeNull();
    expect(searchInput(container).value).toBe("<b>x");
  });

  it("folder navigation cancels a pending debounce", async () => {
    stubNestedShare("/share/tok_fb");
    const container = await renderLanding();

    const input = searchInput(container);
    input.value = "epi";
    fireEvent.input(input);
    fireEvent.click(container.querySelectorAll("a.tv-folder-link")[0]); // Season 1

    expect(window.location.search).toBe("?folder=f_s1");
    // If the pending timer survived the click it would re-append q later —
    // sleep past the debounce window and prove it stays gone.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(window.location.search).toBe("?folder=f_s1");
    expect(container.querySelector(".tv-results-count")).toBeNull();
  });

  it("searches a folder-free share and works after unlock in one page life", async () => {
    window.history.pushState({}, "", "/share/tok_un");
    stubShareApi((fake) => {
      fake.get("/api/share/tok_un", () => ({
        status: 200,
        body: { title: "Private", item_count: 1, locked: true, status: "active" },
      }));
      fake.get("/api/share/tok_un/items", () => {
        const unlocked = FakeXMLHttpRequest.requests.some((r) => r.url === "/api/share/tok_un/unlock");
        return unlocked
          ? { status: 200, body: { folders: [], items: [shareItem({ id: "vid_x", name: "Secret.mp4" })] } }
          : { status: 401, body: { error: "locked" } };
      });
      fake.post("/api/share/tok_un/unlock", () => ({ status: 204 }));
    });

    loadLegacyScript();
    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelector("input[type=password]")).not.toBeNull();
    });

    (document.getElementById("tv-password") as HTMLInputElement).value = "hunter2";
    fireEvent.submit(document.getElementById("tv-unlock-form") as HTMLFormElement);
    await waitFor(() => {
      expect(container?.querySelectorAll("a.tv-item-link")).toHaveLength(1);
    });

    await type(container as HTMLElement, "secret");

    expect(container?.querySelector(".tv-results-count")?.textContent).toBe("1 result");
    expect(container?.querySelector(".tv-item-name")?.textContent).toBe("Secret.mp4");
    expect(resultPaths(container as HTMLElement)).toEqual([]);
    expect(requestedUrls()).toEqual([
      "GET /api/share/tok_un",
      "GET /api/share/tok_un/items",
      "POST /api/share/tok_un/unlock",
      // Unlock re-runs the landing flow: resolve + items again, in place.
      "GET /api/share/tok_un",
      "GET /api/share/tok_un/items",
    ]);
  });
});

describe("legacy tv link continuity (nav-search task 003)", () => {
  afterEach(resetLegacyDom);

  function stubNestedShareAt(path: string): void {
    window.history.pushState({}, "", path);
    stubShareApi((fake) => {
      fake.get("/api/share/tok_fb", () => ({
        status: 200,
        body: { title: "Trip videos", item_count: 4, locked: false, status: "active" },
      }));
      fake.get("/api/share/tok_fb/items", () => ({
        status: 200,
        body: { folders: NAV_SEARCH_FOLDERS, items: NAV_SEARCH_ITEMS },
      }));
    });
  }

  function stubWatchAt(path: string): void {
    window.history.pushState({}, "", path);
    stubShareApi((fake) => {
      fake.get("/api/share/tok_fb/items", () => ({
        status: 200,
        body: { folders: NAV_SEARCH_FOLDERS, items: NAV_SEARCH_ITEMS },
      }));
      fake.get("/api/share/tok_fb/videos/vid_s1/stream-url", () => ({
        status: 200,
        body: { url: "https://cdn.example.com/s1.mp4", strategy: "direct", expires_at: null },
      }));
      fake.get("/api/share/tok_fb/videos/vid_s1/subtitles", () => ({ status: 200, body: [] }));
    });
  }

  async function renderLanding(): Promise<HTMLElement> {
    loadLegacyScript();
    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelectorAll("a.tv-item-link, a.tv-folder-link").length).toBeGreaterThan(0);
    });
    return container as HTMLElement;
  }

  async function typeQuery(container: HTMLElement, query: string): Promise<void> {
    const input = container.querySelector("#tv-search") as HTMLInputElement;
    input.value = query;
    fireEvent.input(input);
    await waitFor(() => {
      const search = window.location.search;
      const settled = query === ""
        ? !search.includes("q=")
        : search.includes("q=" + encodeURIComponent(query));
      expect(settled).toBe(true);
    });
  }

  it("every browse link shape merges params instead of clobbering", async () => {
    stubNestedShareAt("/share/tok_fb?legacy=1&folder=f_s1");
    const container = await renderLanding();

    // Watch row
    expect(container.querySelector("a.tv-item-link")?.getAttribute("href")).toBe(
      "/share/tok_fb/watch/vid_s1?legacy=1&folder=f_s1",
    );
    // Crumbs: root is a link; Season 1 is the current crumb (plain text).
    const crumbs = container.querySelectorAll("a.tv-crumb");
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].getAttribute("href")).toBe("/share/tok_fb?legacy=1");
    expect(container.querySelector(".tv-crumb-current")?.textContent).toBe("Season 1");
    // Subfolder row (Day 1)
    expect(container.querySelector("a.tv-folder-link")?.getAttribute("href")).toBe(
      "/share/tok_fb?legacy=1&folder=f_day1",
    );
  });

  it("stale ?folder= in forced mode renders root and rebuilds clean links", async () => {
    stubNestedShareAt("/share/tok_fb?legacy=1&folder=ghost");
    const container = await renderLanding();

    expect(container.querySelectorAll("a.tv-folder-link")).toHaveLength(3);
    expect(container.querySelector("a.tv-folder-link")?.getAttribute("href")).toBe(
      "/share/tok_fb?legacy=1&folder=f_s1",
    );
  });

  it("search-mode watch links carry legacy, folder, and q", async () => {
    stubNestedShareAt("/share/tok_fb?legacy=1&folder=f_s1");
    const container = await renderLanding();

    await typeQuery(container, "episode");

    expect(container.querySelector("a.tv-item-link")?.getAttribute("href")).toBe(
      "/share/tok_fb/watch/vid_s1?legacy=1&folder=f_s1&q=episode",
    );
  });

  it("watch page back link returns to the exact browse state — or clean root", async () => {
    stubWatchAt("/share/tok_fb/watch/vid_s1?legacy=1&folder=f_s1");
    stubCanPlay("probably");
    loadLegacyScript();
    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelector("video")).not.toBeNull();
    });
    expect(container?.querySelector("a.tv-back")?.getAttribute("href")).toBe(
      "/share/tok_fb?legacy=1&folder=f_s1",
    );

    // No params in, no params out — and no stray "?" on the clean URL.
    stubWatchAt("/share/tok_fb/watch/vid_s1");
    document.getElementById("castify-legacy")?.remove();
    delete (window as LegacyWindow).__castifyLegacyLoaded;
    delete (window as LegacyWindow).__castifyLegacyInit;
    loadLegacyScript();
    const fresh = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(fresh?.querySelector("video")).not.toBeNull();
    });
    expect(fresh?.querySelector("a.tv-back")?.getAttribute("href")).toBe("/share/tok_fb");
  });

  it("watch back link carries the search state too", async () => {
    stubWatchAt("/share/tok_fb/watch/vid_s1?legacy=1&folder=f_s1&q=episode");
    stubCanPlay("probably");
    loadLegacyScript();
    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelector("video")).not.toBeNull();
    });
    expect(container?.querySelector("a.tv-back")?.getAttribute("href")).toBe(
      "/share/tok_fb?legacy=1&folder=f_s1&q=episode",
    );
  });

  it("isn't-part-of-the-share back link preserves folder + query", async () => {
    stubWatchAt("/share/tok_fb/watch/vid_ghost?legacy=1&folder=f_s1&q=ep");
    loadLegacyScript();
    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.textContent).toContain("This video isn't part of the share.");
    });
    expect(container?.querySelector("a.tv-back")?.getAttribute("href")).toBe(
      "/share/tok_fb?legacy=1&folder=f_s1&q=ep",
    );
  });

  it("cold load with folder + q renders search over that context; clear lands in the folder", async () => {
    stubNestedShareAt("/share/tok_fb?legacy=1&folder=f_s1&q=zzz");
    loadLegacyScript();
    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelector(".tv-results-count")).not.toBeNull();
    });

    expect(container?.textContent).toContain("No videos match.");
    expect(container?.querySelector(".tv-crumbs")).toBeNull();

    fireEvent.click(container?.querySelector("#tv-clear-search") as HTMLElement);

    await waitFor(() => {
      expect(container?.querySelector(".tv-crumb-current")?.textContent).toBe("Season 1");
    });
    expect(window.location.search).toBe("?legacy=1&folder=f_s1");
  });
});

describe("legacy tv explicit back control", () => {
  afterEach(resetLegacyDom);

  /** Landing at `path` against the canonical nested fixture (tok_fb). */
  function stubNestedShareAt(path: string): void {
    window.history.pushState({}, "", path);
    stubShareApi((fake) => {
      fake.get("/api/share/tok_fb", () => ({
        status: 200,
        body: { title: "Trip videos", item_count: 4, locked: false, status: "active" },
      }));
      fake.get("/api/share/tok_fb/items", () => ({
        status: 200,
        body: { folders: NAV_SEARCH_FOLDERS, items: NAV_SEARCH_ITEMS },
      }));
    });
  }

  async function renderLanding(): Promise<HTMLElement> {
    loadLegacyScript();
    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelectorAll("a.tv-item-link, a.tv-folder-link").length).toBeGreaterThan(0);
    });
    return container as HTMLElement;
  }

  it("root browse hides the control — there is nowhere back to go", async () => {
    stubNestedShareAt("/share/tok_fb");
    const container = await renderLanding();

    expect(container.querySelector("a.tv-back-nav")).toBeNull();
  });

  it("inside folders: back names the parent explicitly; each click climbs one level, zero XHRs", async () => {
    stubNestedShareAt("/share/tok_fb");
    const container = await renderLanding();
    expect(requestedUrls()).toEqual(["GET /api/share/tok_fb", "GET /api/share/tok_fb/items"]);

    fireEvent.click(container.querySelectorAll("a.tv-folder-link")[0]); // Season 1
    fireEvent.click(container.querySelectorAll("a.tv-folder-link")[0]); // Day 1

    const back = container.querySelector("a.tv-back-nav") as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/share/tok_fb?folder=f_s1");

    fireEvent.click(back);
    expect(window.location.search).toBe("?folder=f_s1");
    expect(container.querySelector(".tv-crumb-current")?.textContent).toBe("Season 1");

    fireEvent.click(container.querySelector("a.tv-back-nav") as HTMLElement);
    expect(window.location.search).toBe("");
    expect([...container.querySelectorAll(".tv-folder-name")].map((el) => el.textContent)).toEqual([
      "Season 1",
      "Season 2",
      "Empty",
    ]);
    expect(container.querySelector("a.tv-back-nav")).toBeNull();
    expect(requestedUrls()).toEqual(["GET /api/share/tok_fb", "GET /api/share/tok_fb/items"]);
  });

  it("deep-linked ?folder= still has a way up — the target is explicit, not history-relative", async () => {
    stubNestedShareAt("/share/tok_fb?folder=f_day1");
    const container = await renderLanding();

    const back = container.querySelector("a.tv-back-nav");
    expect(back?.getAttribute("href")).toBe("/share/tok_fb?folder=f_s1");

    fireEvent.click(back as HTMLElement);
    expect(window.location.search).toBe("?folder=f_s1");
    expect(container.querySelector(".tv-crumb-current")?.textContent).toBe("Season 1");
  });

  it("search mode: back exits to the folder view — q dropped via replaceState, input cleared", async () => {
    stubNestedShareAt("/share/tok_fb?folder=f_s1");
    const container = await renderLanding();

    const input = container.querySelector("#tv-search") as HTMLInputElement;
    input.value = "episode";
    fireEvent.input(input);
    await waitFor(() => {
      expect(window.location.search).toBe("?folder=f_s1&q=episode");
    });

    const back = container.querySelector("a.tv-back-nav");
    expect(back?.getAttribute("href")).toBe("/share/tok_fb?folder=f_s1");

    fireEvent.click(back as HTMLElement);

    expect(window.location.search).toBe("?folder=f_s1");
    expect(container.querySelector(".tv-results-count")).toBeNull();
    expect((container.querySelector("#tv-search") as HTMLInputElement).value).toBe("");
    expect(container.querySelector(".tv-crumb-current")?.textContent).toBe("Season 1");

    // replaceState never pushed an entry: back lands on what preceded
    // the landing (the harness's reset entry, "/") — never back into
    // the recipient's own query.
    window.history.back();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });

  it("forced mode: the back control preserves legacy=1", async () => {
    stubNestedShareAt("/share/tok_fb?legacy=1&folder=f_day1");
    const container = await renderLanding();

    expect(container.querySelector("a.tv-back-nav")?.getAttribute("href")).toBe(
      "/share/tok_fb?legacy=1&folder=f_s1",
    );
  });
});

describe("legacy tv classical canvas (classical task 001)", () => {
  afterEach(resetLegacyDom);

  const fontsDir = resolve(import.meta.dirname, "../../public/tv/fonts");

  // The app's own typeface (user pivot 2026-09-21): Spline Sans Variable,
  // not the standalone's Cormorant/Lora.
  const FONT_FILES: Array<[family: string, file: string]> = [
    ["Spline Sans Variable", "spline-sans-latin.woff2"],
  ];

  it("ships the app's Spline Sans variable latin font — real file with wOF2 magic", () => {
    for (const [, file] of FONT_FILES) {
      const bytes = readFileSync(resolve(fontsDir, file));
      expect(bytes.length, `${file} size`).toBeGreaterThan(50000);
      expect(bytes.subarray(0, 4).toString("latin1"), `${file} magic`).toBe("wOF2");
    }
  });

  it("declares Spline Sans Variable at 400 and 600 against the shipped file", () => {
    const css = readFileSync(legacyCssPath, "utf8");
    for (const [family, file] of FONT_FILES) {
      for (const weight of ["400", "600"]) {
        const face = new RegExp(
          `@font-face\\s*\\{[^}]*font-family:\\s*["']${family}["'][^}]*` +
            `font-weight:\\s*${weight}[^}]*url\\("/tv/fonts/${file}"\\)[^}]*\\}`,
        );
        expect(css, `${family} ${weight} @font-face → ${file}`).toMatch(face);
      }
    }
    // No reference font files may linger (comments may note the pivot).
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/Cormorant|Lora/);
  });

  it("mounts the 1920x1080 stage scaffold and renders into the #tv-content column", () => {
    window.history.pushState({}, "", "/settings");
    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    const frame = container?.querySelector(".tv-frame");
    const stage = container?.querySelector(".tv-stage");
    const content = container?.querySelector(".tv-content");
    expect(frame).not.toBeNull();
    expect(stage).not.toBeNull();
    // The content column is the test-facing render root the flows write into.
    expect(content?.id).toBe("tv-content");
    expect(content?.textContent).toContain("Castify on this TV supports share links only.");
    // The share-links notice lives INSIDE the stage, not beside it.
    expect(stage?.contains(content ?? null)).toBe(true);
    expect(frame?.contains(stage ?? null)).toBe(true);
  });

  it("guards the scale to 1 when clientWidth is 0 (jsdom has no layout)", () => {
    window.history.pushState({}, "", "/settings");
    loadLegacyScript();

    const container = document.getElementById("castify-legacy");
    const stage = container?.querySelector(".tv-stage") as HTMLElement;
    const frame = container?.querySelector(".tv-frame") as HTMLElement;
    expect(stage.style.transform).toBe("scale(1)");
    expect(frame.style.height).toBe("1080px");
  });

  it("recomputes the scale on window resize — no ResizeObserver", () => {
    window.history.pushState({}, "", "/settings");
    loadLegacyScript();

    const container = document.getElementById("castify-legacy") as HTMLElement;
    Object.defineProperty(container, "clientWidth", { value: 960, configurable: true });
    window.dispatchEvent(new Event("resize"));

    const stage = container.querySelector(".tv-stage") as HTMLElement;
    const frame = container.querySelector(".tv-frame") as HTMLElement;
    expect(stage.style.transform).toBe("scale(0.5)");
    expect(frame.style.height).toBe("540px");
  });
});

describe("legacy tv classical browse surfaces (classical task 002)", () => {
  afterEach(resetLegacyDom);

  /** Flat single-folder share at `path` (tok_cb): two videos, one folder. */
  function stubBrowseShare(path: string): void {
    window.history.pushState({}, "", path);
    stubShareApi((fake) => {
      fake.get("/api/share/tok_cb", () => ({
        status: 200,
        body: { title: "Classical browse", item_count: 2, locked: false, status: "active" },
      }));
      fake.get("/api/share/tok_cb/items", () => ({
        status: 200,
        body: {
          folders: [shareFolder({ id: "f_cb", name: "Picks" })],
          items: [shareItem({ id: "vid_cb", name: "Beach.mp4" })],
        },
      }));
    });
  }

  async function renderLanding(): Promise<HTMLElement> {
    loadLegacyScript();
    const container = document.getElementById("castify-legacy");
    await waitFor(() => {
      expect(container?.querySelectorAll("a.tv-item-link, a.tv-folder-link").length).toBeGreaterThan(0);
    });
    return container as HTMLElement;
  }

  it("wraps the search input in .tv-search-wrap with the inline magnifier SVG", async () => {
    stubBrowseShare("/share/tok_cb");
    const container = await renderLanding();

    const wrap = container.querySelector(".tv-search-wrap");
    expect(wrap).not.toBeNull();
    const input = wrap?.querySelector("#tv-search");
    expect(input?.getAttribute("type")).toBe("search");
    expect(input?.getAttribute("placeholder")).toBe("Search videos");
    expect(wrap?.querySelector("svg")).not.toBeNull();
  });

  it("folder rows carry the accent folder SVG before the name, full-width li", async () => {
    stubBrowseShare("/share/tok_cb");
    const container = await renderLanding();

    const link = container.querySelector("a.tv-folder-link") as HTMLElement;
    const svg = link.querySelector("svg");
    const name = link.querySelector(".tv-folder-name");
    expect(svg).not.toBeNull();
    expect(name).not.toBeNull();
    // The icon is drawn before the name, inside the same anchor.
    expect(svg!.compareDocumentPosition(name as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Full-width row marker: folders stack, cards flow in the wrapped row.
    expect(link.closest("li")?.classList.contains("tv-item-folder")).toBe(true);
  });

  it("video rows render the card + plate structure with the Video tag", async () => {
    stubBrowseShare("/share/tok_cb");
    const container = await renderLanding();

    const link = container.querySelector("a.tv-item-link") as HTMLElement;
    const card = link.querySelector(".tv-card");
    expect(card).not.toBeNull();

    const plate = card?.querySelector(".tv-plate");
    expect(plate).not.toBeNull();
    // Play icon under the real thumbnail: svg first, img covers it when loaded.
    expect(plate?.querySelector("svg")).not.toBeNull();
    const thumb = plate?.querySelector("img.tv-item-thumb");
    expect(thumb?.getAttribute("src")).toBe("/api/share/tok_cb/videos/vid_cb/thumbnail");

    const body = card?.querySelector(".tv-card-body");
    expect(body?.querySelector(".tv-item-name")?.textContent).toBe("Beach.mp4");
    expect(body?.querySelector(".tv-tag")?.textContent).toBe("Video");
    expect(body?.querySelector(".tv-item-meta")?.textContent).toContain("12:34");
    // One anchor per video still holds: plate and name share the link.
    expect(thumb?.closest("a")?.getAttribute("href")).toBe("/share/tok_cb/watch/vid_cb");
    expect(body?.querySelector(".tv-item-name")?.closest("a")?.getAttribute("href")).toBe(
      "/share/tok_cb/watch/vid_cb",
    );
  });

  it("renders the hairline divider below the band/crumbs block", async () => {
    stubBrowseShare("/share/tok_cb");
    const container = await renderLanding();

    expect(container.querySelector(".tv-hr")).not.toBeNull();
  });

  it("focusing the search lights the wrap via a tv-search-focus class (no :has on Ch38)", async () => {
    stubBrowseShare("/share/tok_cb");
    const container = await renderLanding();

    const input = container.querySelector("#tv-search") as HTMLInputElement;
    const wrap = container.querySelector(".tv-search-wrap") as HTMLElement;
    expect(wrap.classList.contains("tv-search-focus")).toBe(false);

    input.focus();
    expect(wrap.classList.contains("tv-search-focus")).toBe(true);

    input.blur();
    expect(wrap.classList.contains("tv-search-focus")).toBe(false);
  });

  it("a failed thumbnail degrades to stripes + play icon, never a broken glyph", async () => {
    stubBrowseShare("/share/tok_cb");
    const container = await renderLanding();

    const thumb = container.querySelector("img.tv-item-thumb") as HTMLImageElement;
    expect(thumb.style.display).toBe("");

    // The thumbnail request can 404 (pending generation) or decode-fail —
    // the img must get out of the plate's way either way.
    fireEvent.error(thumb);

    expect(thumb.style.display).toBe("none");
  });

  it("classical CSS: plate grade, focus treatment on hover AND focus, no :focus-visible", () => {
    const css = readFileSync(legacyCssPath, "utf8");

    // Plate: stripes + surface border + divider outline + the -webkit- grade.
    expect(css).toMatch(/repeating-linear-gradient\(135deg,\s*#eae7e7\s+0\s+12px,\s*#d7d3d3\s+12px\s+24px\)/);
    expect(css).toMatch(/#castify-legacy \.tv-plate\s*\{[^}]*-webkit-filter:\s*sepia\(0\.22\)\s*saturate\(0\.82\)\s*contrast\(1\.05\)/);
    expect(css).toMatch(/#castify-legacy \.tv-plate\s*\{[^}]*border:\s*6px solid #eae9e9/);
    expect(css).toMatch(/#castify-legacy \.tv-plate\s*\{[^}]*outline:\s*1px solid rgba\(32, 31, 29, 0\.16\)/);

    // tv-focus treatment: accent border + inset accent band + 30% accent
    // ring, on :hover and :focus alike (:focus-visible is Chromium 86+).
    // The inset band (not a scale lift) keeps the edge readable under the
    // stage's downscale, where a scaled 2px border antialiases away.
    const treatment =
      /[^}]*border-color:\s*#b68235[^}]*inset 0 0 0 2px #b68235[^}]*rgba\(182, 130, 53, 0\.3\)/;
    expect(css).toMatch(new RegExp(`#castify-legacy [^{]*:hover[^{]*\\{${treatment.source}`));
    expect(css).toMatch(new RegExp(`#castify-legacy [^{]*:focus[^{]*\\{${treatment.source}`));

    // Cards: padding opens a gap between the bronze edge and the plate
    // (the plate rides flush against the border otherwise and swallows it).
    // [^{]* rides over the grouped co-selector to the rule's brace.
    const cardPad = /[^{]*\{[^}]*padding:\s*6px/;
    expect(css).toMatch(new RegExp(`#castify-legacy \\.tv-item-link:hover \\.tv-card${cardPad.source}`));
    expect(css).toMatch(new RegExp(`#castify-legacy \\.tv-item-link:focus \\.tv-card${cardPad.source}`));
    // Comments may document the ban; the rules themselves may not use it.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/:focus-visible/);
  });
});

describe("legacy tv classical states (classical task 003)", () => {
  const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

  function classicalCss(): string {
    return stripComments(readFileSync(legacyCssPath, "utf8"));
  }

  it("messages render as centered bordered cards inside a flexed content column", () => {
    const css = classicalCss();
    expect(css).toMatch(/#castify-legacy \.tv-content\s*\{[^}]*display:\s*-webkit-flex/);
    expect(css).toMatch(/#castify-legacy \.tv-content\s*\{[^}]*-webkit-flex-direction:\s*column/);
    expect(css).toMatch(/#castify-legacy \.tv-message\s*\{[^}]*max-width:\s*720px/);
    expect(css).toMatch(/#castify-legacy \.tv-message\s*\{[^}]*border:\s*2px solid rgba\(32, 31, 29, 0\.16\)/);
    expect(css).toMatch(/#castify-legacy \.tv-message\s*\{[^}]*border-radius:\s*7px/);
    expect(css).toMatch(/#castify-legacy \.tv-message\s*\{[^}]*margin:\s*auto/);
    // App family title, muted body.
    expect(css).toMatch(/#castify-legacy \.tv-message-title\s*\{[^}]*font-size:\s*34px/);
    expect(css).toMatch(/#castify-legacy \.tv-message-title\s*\{[^}]*font-weight:\s*600/);
    expect(css).toMatch(/#castify-legacy \.tv-message-body\s*\{[^}]*color:\s*rgba\(32, 31, 29, 0\.55\)/);
    expect(css).toMatch(/#castify-legacy \.tv-message-body\s*\{[^}]*font-size:\s*20px/);
  });

  it("buttons take the outline .btn-primary manner with washes, disabled, focus", () => {
    const css = classicalCss();
    expect(css).toMatch(/#castify-legacy \.tv-button\s*\{[^}]*background:\s*transparent/);
    expect(css).toMatch(/#castify-legacy \.tv-button\s*\{[^}]*border:\s*1px solid #b68235/);
    expect(css).toMatch(/#castify-legacy \.tv-button\s*\{[^}]*color:\s*#b68235/);
    expect(css).toMatch(/#castify-legacy \.tv-button:hover\s*\{[^}]*background:\s*rgba\(182, 130, 53, 0\.12\)/);
    expect(css).toMatch(/#castify-legacy \.tv-button:active\s*\{[^}]*background:\s*rgba\(182, 130, 53, 0\.22\)/);
    expect(css).toMatch(/#castify-legacy \.tv-button\[disabled\]\s*\{[^}]*opacity:\s*0\.45/);
    expect(css).toMatch(/#castify-legacy \.tv-button:focus\s*\{[^}]*outline:\s*2px solid #b68235/);
  });

  it("unlock form and error take the classical treatment (accent-700 error)", () => {
    const css = classicalCss();
    expect(css).toMatch(/#castify-legacy \.tv-input\s*\{[^}]*background:\s*transparent/);
    expect(css).toMatch(/#castify-legacy \.tv-input\s*\{[^}]*caret-color:\s*#b68235/);
    expect(css).toMatch(/#castify-legacy \.tv-input:focus\s*\{[^}]*border-color:\s*#b68235/);
    // Serious bronze for the inline unlock error — no new palette entry.
    expect(css).toMatch(/#castify-legacy \.tv-unlock-error\s*\{[^}]*color:\s*#7d5411/);
  });

  it("search chrome is styled: count label, path lines, back link in the ml-back voice", () => {
    const css = classicalCss();
    expect(css).toMatch(/#castify-legacy \.tv-results-count\s*\{[^}]*color:\s*rgba\(32, 31, 29, 0\.55\)/);
    expect(css).toMatch(/#castify-legacy \.tv-item-path\s*\{[^}]*color:\s*rgba\(32, 31, 29, 0\.55\)/);
    expect(css).toMatch(/#castify-legacy \.tv-back\s*\{[^}]*color:\s*#7d5411/);
  });
});

describe("legacy tv classical watch page (classical task 004)", () => {
  it("watch takes the classical skin: full measure, 40px serif title, framed video", () => {
    const css = readFileSync(legacyCssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/#castify-legacy \.tv-watch\s*\{[^}]*width:\s*100%/);
    expect(css).not.toMatch(/#castify-legacy \.tv-watch\s*\{[^}]*max-width/);
    expect(css).toMatch(/#castify-legacy \.tv-watch \.tv-title\s*\{[^}]*font-size:\s*40px/);
    expect(css).toMatch(/#castify-legacy \.tv-video\s*\{[^}]*border:\s*1px solid rgba\(32, 31, 29, 0\.16\)/);
    expect(css).toMatch(/#castify-legacy \.tv-video\s*\{[^}]*border-radius:\s*7px/);
    // The old dark-theme amber/blue values must be gone for good.
    expect(css).not.toMatch(/#f0a93a|#9096a5|#171b24/);
  });
});
