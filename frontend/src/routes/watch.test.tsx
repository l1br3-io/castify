import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, act, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { WatchPage } from "./watch";
import { setCsrfToken } from "../api/client";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";
import type { VideoDetailDto } from "../api/types";

// Mock the IndexedDB layer — the hook reads resume position from here now,
// not from the server's `position_seconds` field.
vi.mock("../lib/player-db", () => ({
  getProgress: vi.fn().mockResolvedValue(null),
  saveProgressEntry: vi.fn().mockResolvedValue(undefined),
  clearProgress: vi.fn().mockResolvedValue(undefined),
  getGlobalPrefs: vi.fn().mockResolvedValue(null),
  getSubtitlePref: vi.fn().mockResolvedValue(null),
  saveGlobalPrefs: vi.fn().mockResolvedValue(undefined),
  saveSubtitlePref: vi.fn().mockResolvedValue(undefined),
}));

// Mock the share-link IndexedDB store (task 012) — jsdom has no IndexedDB.
vi.mock("../lib/share-links-db", () => ({
  saveShareLink: vi.fn().mockResolvedValue(undefined),
}));

// Mock jassub (M8 Task 004) — the dynamic import inside useLibassSubtitles
// resolves to this spy-able constructor so tests can assert on the ASS
// render lifecycle without loading the real ~500 KB WASM chunk. `vi.hoisted`
// lifts the spies above the hoisted mock factory.
const libassMock = vi.hoisted(() => ({
  ctor: vi.fn(),
  destroy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("jassub", () => ({
  default: class MockJassub {
    ready: Promise<void>;
    constructor(opts: unknown) {
      libassMock.ctor(opts);
      this.ready = Promise.resolve();
    }
    destroy() {
      return libassMock.destroy();
    }
  },
}));

// Mock hls.js (M8 Task 010) — the dynamic import inside useHlsStream
// resolves to this spy-able class so transcode-strategy tests can assert on
// the master URL (including the `?burn_subtitles=` param) without loading
// the real hls.js bundle or needing MediaSource in jsdom.
const hlsMock = vi.hoisted(() => ({
  ctor: vi.fn(),
  destroy: vi.fn(),
  loadSource: vi.fn(),
  attachMedia: vi.fn(),
  on: vi.fn(),
  isSupported: vi.fn(() => true),
}));
vi.mock("hls.js", () => ({
  default: class MockHls {
    static Events = {
      MANIFEST_PARSED: "hlsManifestParsed",
      LEVEL_SWITCHED: "hlsLevelSwitched",
      ERROR: "hlsError",
    };
    static ErrorTypes = {
      MEDIA_ERROR: "mediaError",
      NETWORK_ERROR: "networkError",
    };
    static isSupported() {
      return hlsMock.isSupported();
    }
    constructor(opts: unknown) {
      hlsMock.ctor(opts);
    }
    loadSource(url: string) {
      hlsMock.loadSource(url);
    }
    attachMedia(video: HTMLVideoElement) {
      hlsMock.attachMedia(video);
    }
    on(event: string, cb: (...args: unknown[]) => void) {
      hlsMock.on(event);
      // Auto-fire MANIFEST_PARSED so useHlsStream flips isReady=true and
      // the loading overlay doesn't block interaction with the player UI.
      if (event === "hlsManifestParsed") {
        cb({}, { levels: [] });
      }
    }
    destroy() {
      hlsMock.destroy();
    }
  },
}));

import { getProgress, clearProgress } from "../lib/player-db";
import { saveShareLink } from "../lib/share-links-db";

const mockGetProgress = vi.mocked(getProgress);
const mockClearProgress = vi.mocked(clearProgress);
const mockSaveShareLink = vi.mocked(saveShareLink);

const VIDEO_DETAIL: VideoDetailDto = {
  id: "v1",
  name: "cat.mp4",
  provider: "google_drive",
  size_bytes: 5_242_880,
  mime_type: "video/mp4",
  duration_ms: 120_000,
  width: 1920,
  height: 1080,
  sources: [
    { connection_id: "c1", provider: "google_drive", provider_file_id: "gd-1" },
  ],
  created_at: "2026-01-01T00:00:00Z",
  path: "/Movies/cat.mp4",
  is_favorite: false,
  my_rating: null,
  thumbnail_status: "cached",
  position_seconds: null,
  duration_seconds: null,
  completed: false,
  subtitle_tracks: [],
};

function watchFetch(detail: VideoDetailDto = VIDEO_DETAIL) {
  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/videos/${detail.id}`) return jsonResponse(detail);
    if (url === `/api/videos/${detail.id}/thumbnail`)
      return new Response("fake-image", { status: 200 });
    if (url === `/api/videos/${detail.id}/stream-url`) {
      return jsonResponse({
        url: `https://cdn.example.com/${detail.id}.mp4`,
        strategy: "direct",
        expires_at: "2026-01-01T01:00:00Z",
      });
    }
    return jsonError(404, "unmocked");
  };
}

function renderWatchPage(
  videoId = "v1",
  fetchImpl?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
) {
  return renderWithProviders(
    <Routes>
      <Route path="/watch/:id" element={<WatchPage />} />
    </Routes>,
    {
      initialEntries: [`/watch/${videoId}`],
      fetchImplementation: fetchImpl ?? watchFetch(),
    },
  );
}

// jsdom's canPlayType returns "" (no media implementation). Tests that need
// a "playable" result mock it.
function mockCanPlayType(value: "maybe" | "probably" | "") {
  vi.spyOn(HTMLVideoElement.prototype, "canPlayType").mockReturnValue(value);
}

describe("WatchPage", () => {
  beforeEach(() => {
    mockGetProgress.mockResolvedValue(null);
    mockClearProgress.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows a loading skeleton before data resolves", () => {
    renderWatchPage("v1", () => new Promise<Response>(() => {}));
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
    expect(
      screen.queryByRole("heading", { name: "cat.mp4" }),
    ).not.toBeInTheDocument();
  });

  it("renders the video element with correct src when format is playable", async () => {
    mockCanPlayType("probably");
    const { container } = renderWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });

    // `useStreamUrl` resolves async alongside `useVideoDetail`. Wait for the
    // `<video src>` to appear (T12: src comes from `/stream-url`, not inlined).
    const video = await waitFor(() => {
      const el = container.querySelector("video");
      expect(el).not.toBeNull();
      expect(el).toHaveAttribute("src");
      return el!;
    });
    expect(video).toHaveAttribute("src", "https://cdn.example.com/v1.mp4");
    expect(video).toHaveAttribute("poster", "/api/videos/v1/thumbnail");
  });

  it("renders the download fallback when format is unsupported", async () => {
    mockCanPlayType("");
    renderWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });

    // No video element — download card shown instead.
    expect(document.querySelector("video")).toBeNull();
    expect(
      screen.getByText("This format can't be played in-browser"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Download cat.mp4" }),
    ).toHaveAttribute("href", "/api/videos/v1/download");
  });

  it("renders the video optimistically when mime_type is null, then falls back on error", async () => {
    // jsdom canPlayType returns "" by default — no vi.spyOn needed.
    renderWatchPage("v1", (input) => {
      const url = String(input);
      if (url === "/api/videos/v1")
        return jsonResponse({ ...VIDEO_DETAIL, mime_type: null });
      if (url === "/api/videos/v1/thumbnail")
        return new Response("fake", { status: 200 });
      return jsonError(404, "unmocked");
    });

    await screen.findByRole("heading", { name: "cat.mp4" });

    // Initially renders a <video> (optimistic — canPlayType("null") returns ""
    // but mime_type null skips the probe).
    expect(document.querySelector("video")).not.toBeNull();
  });

  it("shows 'Video not found' on 404", async () => {
    renderWatchPage("missing", () => jsonError(404, "not found"));

    expect(await screen.findByText("Video not found")).toBeInTheDocument();
    expect(
      screen.getByText("The video you're looking for doesn't exist."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to browse" }),
    ).toHaveAttribute("href", "/");
    // FR-4.1: a 404 clears the stale IndexedDB progress entry so the dead
    // continue-watching card stops surfacing on every browse.
    await waitFor(() =>
      expect(mockClearProgress).toHaveBeenCalledWith("missing"),
    );
  });

  it("shows a generic error message on 500", async () => {
    renderWatchPage("v1", () => jsonError(500, "database is locked"));

    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText(/database is locked/)).toBeInTheDocument();
    // FR-4.2: non-404 errors are transient — must NOT wipe the progress entry.
    expect(mockClearProgress).not.toHaveBeenCalled();
  });

  it("renders video metadata (title, duration, resolution, provider)", async () => {
    mockCanPlayType("probably");
    renderWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });

    expect(screen.getByText("cat.mp4")).toBeInTheDocument();
    expect(screen.getByText("2:00")).toBeInTheDocument();
    expect(screen.getByText("1920×1080")).toBeInTheDocument();
    expect(screen.getByText("5.0 MB")).toBeInTheDocument();
    expect(screen.getByText("Google Drive")).toBeInTheDocument();
  });

  // --- M3 T7 extensions: subtitle <track>, badges, personalization controls ---

  it("renders a <track> element for each subtitle track (M3 T7)", async () => {
    mockCanPlayType("probably");
    renderWatchPage("v1", (input) => {
      const url = String(input);
      if (url === "/api/videos/v1")
        return jsonResponse({
          ...VIDEO_DETAIL,
          subtitle_tracks: [
            { id: "s1", language: "en", filename: "cat.en.vtt", format: "vtt" },
            { id: "s2", language: "es", filename: "cat.es.srt", format: "srt" },
          ],
        });
      if (url === "/api/videos/v1/thumbnail")
        return new Response("fake", { status: 200 });
      return jsonError(404, "unmocked");
    });

    await screen.findByRole("heading", { name: "cat.mp4" });

    const tracks = document.querySelectorAll("video > track");
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toHaveAttribute("kind", "subtitles");
    expect(tracks[0]).toHaveAttribute("src", "/api/videos/v1/subtitles/s1");
    expect(tracks[0]).toHaveAttribute("srclang", "en");
    expect(tracks[0]).toHaveAttribute("label", "en");
    // T8: no native `default` — PlayerControls drives track.mode explicitly
    // (default selection is "Off").
    expect(tracks[0]).not.toHaveAttribute("default");
    expect(tracks[1]).toHaveAttribute("src", "/api/videos/v1/subtitles/s2");
    expect(tracks[1]).toHaveAttribute("srclang", "es");
    expect(tracks[1]).not.toHaveAttribute("default");
  });

  it("renders no <track> elements when subtitle_tracks is empty (M3 T7)", async () => {
    mockCanPlayType("probably");
    renderWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });

    expect(document.querySelectorAll("video > track")).toHaveLength(0);
  });

  it("renders ProviderBadge and DedupBadge for cross-provider videos (M3 T7)", async () => {
    mockCanPlayType("probably");
    renderWatchPage("v1", (input) => {
      const url = String(input);
      if (url === "/api/videos/v1")
        return jsonResponse({
          ...VIDEO_DETAIL,
          sources: [
            {
              connection_id: "c1",
              provider: "google_drive",
              provider_file_id: "gd-1",
            },
            {
              connection_id: "c2",
              provider: "dropbox",
              provider_file_id: "db-1",
            },
          ],
        });
      if (url === "/api/videos/v1/thumbnail")
        return new Response("fake", { status: 200 });
      return jsonError(404, "unmocked");
    });

    await screen.findByRole("heading", { name: "cat.mp4" });

    expect(screen.getByText("Google Drive")).toBeInTheDocument();
    expect(screen.getByText(/Also in: Dropbox/)).toBeInTheDocument();
  });

  it("renders the hero-variant FavoriteToggle and RatingStars (M3 T7)", async () => {
    mockCanPlayType("probably");
    renderWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });

    // FavoriteToggle (hero variant) — aria-pressed reflects is_favorite=false.
    expect(
      screen.getByRole("button", { name: /Add to favorites/i }),
    ).toBeInTheDocument();
    // RatingStars (hero variant) — radio group with 5 stars.
    expect(
      screen.getByRole("group", { name: "Rate this video" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("radio", { name: /\d star/i })).toHaveLength(5);
  });

  // --- Task 012: Share action + creation dialog ---

  it("opens the Share dialog prefilled with the current item and creates a one-time link", async () => {
    mockCanPlayType("probably");
    setCsrfToken("csrf-test");
    mockSaveShareLink.mockResolvedValue(undefined);
    const base = watchFetch();
    const { fetchSpy } = renderWatchPage(
      "v1",
      (input, init) => {
        const url = String(input);
        if (url === "/api/shares" && (init?.method ?? "GET") === "POST") {
          return jsonResponse(
            {
              id: "s1",
              title: "cat.mp4",
              token: "tok_abc",
              share_url: "/share/tok_abc",
            },
            201,
          );
        }
        return base(input);
      },
    );

    await screen.findByRole("heading", { name: "cat.mp4" });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    // Dialog prefilled with the current item.
    expect(
      await screen.findByRole("heading", { name: "Share cat.mp4" }),
    ).toBeInTheDocument();

    // Create → exactly one POST for this item with defaults omitted. The
    // generated-name prefill is cleared first — title semantics live in
    // share-dialog.test.tsx; this test targets the page flow.
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /create share/i }));
    let posts: [unknown, RequestInit?][] = [];
    await waitFor(() => {
      posts = fetchSpy.mock.calls.filter(
        ([input, init]) =>
          String(input) === "/api/shares" && init?.method === "POST",
      );
      expect(posts).toHaveLength(1);
    });
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({
      video_ids: ["v1"],
    });

    // Link shown once, with copy + warning; stored per-device for Settings.
    expect(
      await screen.findByText(`${window.location.origin}/share/tok_abc`),
    ).toBeInTheDocument();
    expect(screen.getByText(/only once/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(mockSaveShareLink).toHaveBeenCalledWith("s1", "/share/tok_abc"),
    );

    setCsrfToken(null);
  });

  it("reflects is_favorite=true on the hero FavoriteToggle (M3 T7)", async () => {
    mockCanPlayType("probably");
    renderWatchPage("v1", (input) => {
      const url = String(input);
      if (url === "/api/videos/v1")
        return jsonResponse({
          ...VIDEO_DETAIL,
          is_favorite: true,
          my_rating: 4,
        });
      if (url === "/api/videos/v1/thumbnail")
        return new Response("fake", { status: 200 });
      return jsonError(404, "unmocked");
    });

    await screen.findByRole("heading", { name: "cat.mp4" });

    expect(
      screen.getByRole("button", { name: /Remove from favorites/i }),
    ).toHaveAttribute("aria-pressed", "true");
    // The radio pattern marks only the matching star `aria-checked=true`
    // (visual `filled` is a separate prop on the icon). Rating=4 → star 4.
    const checked = screen
      .getAllByRole("radio", { name: /\d star/i })
      .filter((el) => el.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAccessibleName("4 stars");
  });

  it("renders the back link to browse", async () => {
    mockCanPlayType("probably");
    renderWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });

    // Back link rendered above the video.
    // (Not checked via role since the text "Back to browse" isn't present —
    //  the page only renders the video info. The WatchPage renders the video
    //  section; the back link is part of the overall page structure.)
    expect(document.querySelector("video")).not.toBeNull();
  });

  // --- M3 T10: resume + progress tracking ---

  it("shows the resume toast and seeks to saved position when position > 30 (M3 T10)", async () => {
    mockCanPlayType("probably");
    mockGetProgress.mockResolvedValue({
      videoId: "v1",
      positionSeconds: 60,
      durationSeconds: 120,
      completed: false,
      updatedAt: Date.now(),
      videoName: "cat.mp4",
      videoDurationMs: 120_000,
      thumbnailStatus: "cached",
      height: 1080,
      provider: "google_drive",
    });
    renderWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });
    // Wait for the hook's IndexedDB read to resolve so the event listener
    // is attached.
    await waitFor(() => expect(mockGetProgress).toHaveBeenCalled());

    const video = document.querySelector("video")!;
    Object.defineProperty(video, "duration", {
      value: 120,
      configurable: true,
      writable: true,
    });

    fireEvent(video, new Event("loadedmetadata"));

    await waitFor(() => {
      expect(screen.getByText(/Resume from/)).toBeInTheDocument();
    });
    expect(screen.getByText("1:00")).toBeInTheDocument();
    expect((video as HTMLVideoElement).currentTime).toBe(60);
  });

  it("does not show the resume toast when position is null (M3 T10)", async () => {
    mockCanPlayType("probably");
    renderWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "duration", {
      value: 120,
      configurable: true,
      writable: true,
    });

    fireEvent(video, new Event("loadedmetadata"));

    expect(screen.queryByText(/Resume from/)).not.toBeInTheDocument();
  });

  it("does not show the resume toast when video is already completed (M3 T10)", async () => {
    mockCanPlayType("probably");
    mockGetProgress.mockResolvedValue({
      videoId: "v1",
      positionSeconds: 60,
      durationSeconds: 120,
      completed: true,
      updatedAt: Date.now(),
      videoName: "cat.mp4",
      videoDurationMs: 120_000,
      thumbnailStatus: "cached",
      height: 1080,
      provider: "google_drive",
    });
    renderWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });
    await waitFor(() => expect(mockGetProgress).toHaveBeenCalled());
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "duration", {
      value: 120,
      configurable: true,
      writable: true,
    });

    fireEvent(video, new Event("loadedmetadata"));

    // Give the (non-)seek a tick to settle.
    await Promise.resolve();
    expect(screen.queryByText(/Resume from/)).not.toBeInTheDocument();
  });

  it("'Start from beginning' in the resume toast seeks to 0 (M3 T10)", async () => {
    mockCanPlayType("probably");
    mockGetProgress.mockResolvedValue({
      videoId: "v1",
      positionSeconds: 60,
      durationSeconds: 120,
      completed: false,
      updatedAt: Date.now(),
      videoName: "cat.mp4",
      videoDurationMs: 120_000,
      thumbnailStatus: "cached",
      height: 1080,
      provider: "google_drive",
    });
    renderWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });
    await waitFor(() => expect(mockGetProgress).toHaveBeenCalled());
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "duration", {
      value: 120,
      configurable: true,
      writable: true,
    });
    fireEvent(video, new Event("loadedmetadata"));

    await waitFor(() => {
      expect((video as HTMLVideoElement).currentTime).toBe(60);
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Start from beginning" }),
    );

    expect((video as HTMLVideoElement).currentTime).toBe(0);
    expect(screen.queryByText(/Resume from/)).not.toBeInTheDocument();
  });

  // --- M3 T11: ephemeral queue + skip + auto-advance + up-next ---

  function watchFetchMultiple(details: Record<string, VideoDetailDto>) {
    return (input: RequestInfo | URL) => {
      const url = String(input);
      for (const [id, detail] of Object.entries(details)) {
        if (url === `/api/videos/${id}`) return jsonResponse(detail);
        if (url === `/api/videos/${id}/thumbnail`)
          return new Response("fake-image", { status: 200 });
        if (url === `/api/videos/${id}/stream-url`) {
          return jsonResponse({
            url: `https://cdn.example.com/${id}.mp4`,
            strategy: "direct",
            expires_at: "2026-01-01T01:00:00Z",
          });
        }
      }
      return jsonError(404, "unmocked");
    };
  }

  function renderWatchWithState(
    path: string,
    state: unknown,
    fetchImpl: (input: RequestInfo | URL) => Response | Promise<Response>,
  ) {
    return renderWithProviders(
      <Routes>
        <Route path="/watch/:id" element={<WatchPage />} />
      </Routes>,
      {
        initialEntries: [{ pathname: path, state }],
        fetchImplementation: fetchImpl,
      },
    );
  }

  it("hides skip controls and the up-next panel when no queue context (M3 T11)", async () => {
    mockCanPlayType("probably");
    renderWatchPage("v1");

    await screen.findByRole("heading", { name: "cat.mp4" });

    expect(
      screen.queryByRole("button", { name: "Previous video" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Next video" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Up next")).not.toBeInTheDocument();
  });

  it("renders skip controls + up-next panel when a queue is in router state (M3 T11)", async () => {
    mockCanPlayType("probably");
    renderWatchWithState(
      "/watch/v1",
      { queue: ["v1", "v2", "v3"] },
      watchFetchMultiple({
        v1: VIDEO_DETAIL,
        v2: { ...VIDEO_DETAIL, id: "v2", name: "dog.mp4" },
        v3: { ...VIDEO_DETAIL, id: "v3", name: "bird.mp4" },
      }),
    );

    await screen.findByRole("heading", { name: "cat.mp4" });

    expect(
      screen.getByRole("button", { name: "Previous video" }),
    ).toBeDisabled(); // at queue head
    expect(screen.getByRole("button", { name: "Next video" })).toBeEnabled();
    expect(screen.getByText("Up next")).toBeInTheDocument();
    // Up-next items load asynchronously.
    expect(
      await screen.findByRole("button", { name: "Play dog.mp4" }),
    ).toBeInTheDocument();
  });

  it("clicking Next navigates to the next queue entry (M3 T11)", async () => {
    mockCanPlayType("probably");
    renderWatchWithState(
      "/watch/v1",
      { queue: ["v1", "v2", "v3"] },
      watchFetchMultiple({
        v1: VIDEO_DETAIL,
        v2: { ...VIDEO_DETAIL, id: "v2", name: "dog.mp4" },
        v3: { ...VIDEO_DETAIL, id: "v3", name: "bird.mp4" },
      }),
    );

    await screen.findByRole("heading", { name: "cat.mp4" });

    fireEvent.click(screen.getByRole("button", { name: "Next video" }));

    expect(
      await screen.findByRole("heading", { name: "dog.mp4" }),
    ).toBeInTheDocument();
  });

  it("clicking Previous navigates backward in the queue (M3 T11)", async () => {
    mockCanPlayType("probably");
    renderWatchWithState(
      "/watch/v2",
      { queue: ["v1", "v2", "v3"] },
      watchFetchMultiple({
        v1: VIDEO_DETAIL,
        v2: { ...VIDEO_DETAIL, id: "v2", name: "dog.mp4" },
        v3: { ...VIDEO_DETAIL, id: "v3", name: "bird.mp4" },
      }),
    );

    await screen.findByRole("heading", { name: "dog.mp4" });

    fireEvent.click(screen.getByRole("button", { name: "Previous video" }));

    expect(
      await screen.findByRole("heading", { name: "cat.mp4" }),
    ).toBeInTheDocument();
  });

  it("shows the auto-advance countdown overlay when the video ends with a next entry (M3 T11)", async () => {
    mockCanPlayType("probably");
    renderWatchWithState(
      "/watch/v1",
      { queue: ["v1", "v2", "v3"] },
      watchFetchMultiple({
        v1: VIDEO_DETAIL,
        v2: { ...VIDEO_DETAIL, id: "v2", name: "dog.mp4" },
        v3: { ...VIDEO_DETAIL, id: "v3", name: "bird.mp4" },
      }),
    );

    // Resolve initial state under real timers — `findByRole`'s polling uses
    // setTimeout, which fake timers would freeze.
    await screen.findByRole("heading", { name: "cat.mp4" });
    const video = document.querySelector("video")!;

    expect(
      screen.queryByRole("status", { name: "Auto-advance countdown" }),
    ).not.toBeInTheDocument();

    vi.useFakeTimers();
    try {
      act(() => {
        fireEvent(video, new Event("ended"));
      });
      expect(
        screen.getByRole("status", { name: "Auto-advance countdown" }),
      ).toBeInTheDocument();
      expect(screen.getByText("5")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("'Play next now' immediately advances to the next queue entry (M3 T11)", async () => {
    mockCanPlayType("probably");
    renderWatchWithState(
      "/watch/v1",
      { queue: ["v1", "v2", "v3"] },
      watchFetchMultiple({
        v1: VIDEO_DETAIL,
        v2: { ...VIDEO_DETAIL, id: "v2", name: "dog.mp4" },
        v3: { ...VIDEO_DETAIL, id: "v3", name: "bird.mp4" },
      }),
    );

    await screen.findByRole("heading", { name: "cat.mp4" });
    const video = document.querySelector("video")!;
    fireEvent(video, new Event("ended"));

    fireEvent.click(screen.getByRole("button", { name: "Play next now" }));

    expect(
      await screen.findByRole("heading", { name: "dog.mp4" }),
    ).toBeInTheDocument();
  });

  it("shows the End of queue overlay when the last video ends (M3 T11)", async () => {
    mockCanPlayType("probably");
    renderWatchWithState(
      "/watch/v3",
      { queue: ["v1", "v2", "v3"] },
      watchFetchMultiple({
        v1: VIDEO_DETAIL,
        v2: { ...VIDEO_DETAIL, id: "v2", name: "dog.mp4" },
        v3: { ...VIDEO_DETAIL, id: "v3", name: "bird.mp4" },
      }),
    );

    await screen.findByRole("heading", { name: "bird.mp4" });
    const video = document.querySelector("video")!;

    expect(
      screen.queryByRole("status", { name: "End of queue" }),
    ).not.toBeInTheDocument();

    fireEvent(video, new Event("ended"));

    expect(
      screen.getByRole("status", { name: "End of queue" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to browse" }),
    ).toBeInTheDocument();
  });

  it("cancel the auto-advance countdown dismisses the overlay without advancing (M3 T11)", async () => {
    mockCanPlayType("probably");
    renderWatchWithState(
      "/watch/v1",
      { queue: ["v1", "v2", "v3"] },
      watchFetchMultiple({
        v1: VIDEO_DETAIL,
        v2: { ...VIDEO_DETAIL, id: "v2", name: "dog.mp4" },
        v3: { ...VIDEO_DETAIL, id: "v3", name: "bird.mp4" },
      }),
    );

    await screen.findByRole("heading", { name: "cat.mp4" });
    const video = document.querySelector("video")!;
    fireEvent(video, new Event("ended"));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("status", { name: "Auto-advance countdown" }),
    ).not.toBeInTheDocument();
    // Still on v1.
    expect(
      screen.getByRole("heading", { name: "cat.mp4" }),
    ).toBeInTheDocument();
  });

  it("clicking an up-next item navigates to that video (M3 T11)", async () => {
    mockCanPlayType("probably");
    renderWatchWithState(
      "/watch/v1",
      { queue: ["v1", "v2", "v3"] },
      watchFetchMultiple({
        v1: VIDEO_DETAIL,
        v2: { ...VIDEO_DETAIL, id: "v2", name: "dog.mp4" },
        v3: { ...VIDEO_DETAIL, id: "v3", name: "bird.mp4" },
      }),
    );

    await screen.findByRole("heading", { name: "cat.mp4" });

    const item = await screen.findByRole("button", { name: "Play bird.mp4" });
    fireEvent.click(item);

    expect(
      await screen.findByRole("heading", { name: "bird.mp4" }),
    ).toBeInTheDocument();
  });

  // ── T12 — Direct CDN streaming ────────────────────────────────────────
  //
  // `/api/videos/{id}/stream-url` resolves where the browser fetches bytes
  // from: a direct CDN URL (OneDrive/Dropbox) or our /stream proxy (Drive).
  // The player sets `<video src>` from the response and refreshes the URL
  // once if the CDN URL expires mid-session.

  function watchFetchDirect(
    detail: VideoDetailDto = VIDEO_DETAIL,
    cdnUrl = "https://cdn.example.com/video.mp4",
  ) {
    return (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/videos/${detail.id}`) return jsonResponse(detail);
      if (url === `/api/videos/${detail.id}/thumbnail`)
        return new Response("fake-image", { status: 200 });
      if (url === `/api/videos/${detail.id}/stream-url`) {
        return jsonResponse({
          url: cdnUrl,
          strategy: "direct",
          expires_at: "2026-01-01T01:00:00Z",
        });
      }
      return jsonError(404, "unmocked");
    };
  }

  it("sets <video src> to the CDN URL when strategy is direct (T12)", async () => {
    mockCanPlayType("probably");
    const { container } = renderWatchPage(
      "v1",
      watchFetchDirect(VIDEO_DETAIL, "https://cdn.example.com/v1.mp4"),
    );

    await screen.findByRole("heading", { name: "cat.mp4" });

    const video = await waitFor(() => {
      const el = container.querySelector("video");
      expect(el).not.toBeNull();
      expect(el).toHaveAttribute("src");
      return el!;
    });
    expect(video).toHaveAttribute("src", "https://cdn.example.com/v1.mp4");
  });

  it("retries once on <video> error when strategy is direct (CDN URL expiry) (T12)", async () => {
    mockCanPlayType("probably");
    // First fetch returns one CDN URL; after the stream-url query is
    // invalidated (retry), the second fetch returns a fresh URL.
    let streamUrlCallCount = 0;
    const fetchImpl = (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/videos/v1`) return jsonResponse(VIDEO_DETAIL);
      if (url === `/api/videos/v1/thumbnail`)
        return new Response("fake-image", { status: 200 });
      if (url === `/api/videos/v1/stream-url`) {
        streamUrlCallCount += 1;
        const cdn = `https://cdn.example.com/v1-attempt${streamUrlCallCount}.mp4`;
        return jsonResponse({
          url: cdn,
          strategy: "direct",
          expires_at: "2026-01-01T01:00:00Z",
        });
      }
      return jsonError(404, "unmocked");
    };

    const { container } = renderWatchPage("v1", fetchImpl);

    await screen.findByRole("heading", { name: "cat.mp4" });

    // First URL lands.
    const video = await waitFor(() => {
      const el = container.querySelector("video");
      expect(el).not.toBeNull();
      expect(el).toHaveAttribute("src");
      return el!;
    });
    expect(video).toHaveAttribute("src", "https://cdn.example.com/v1-attempt1.mp4");
    expect(streamUrlCallCount).toBe(1);

    // Simulate CDN URL expiry: the `<video>` element fires `error`. The
    // handler invalidates the stream-url query; TanStack refetches; React
    // swaps `src` to the fresh URL.
    fireEvent(video, new Event("error"));

    await waitFor(() => {
      expect(video).toHaveAttribute("src", "https://cdn.example.com/v1-attempt2.mp4");
    });
    expect(streamUrlCallCount).toBe(2);

    // No unsupported-format fallback rendered.
    expect(
      screen.queryByText("This format can't be played in-browser"),
    ).not.toBeInTheDocument();
  });

  it("falls back to unsupported-format after a second <video> error on direct strategy (T12)", async () => {
    mockCanPlayType("probably");
    const fetchImpl = watchFetchDirect(
      VIDEO_DETAIL,
      "https://cdn.example.com/broken.mp4",
    );
    const { container } = renderWatchPage("v1", fetchImpl);

    await screen.findByRole("heading", { name: "cat.mp4" });

    const video = await waitFor(() => {
      const el = container.querySelector("video");
      expect(el).not.toBeNull();
      expect(el).toHaveAttribute("src");
      return el!;
    });

    // First error → triggers one retry (invalidates stream-url, refetches,
    // but the mock returns the same URL).
    fireEvent(video, new Event("error"));

    // Wait for the retry to land (the same URL is returned, but the retry
    // counter has advanced).
    await waitFor(() => {
      expect(video).toHaveAttribute("src", "https://cdn.example.com/broken.mp4");
    });

    // Second error → now `hasError` flips and the unsupported-format card
    // replaces the `<video>`.
    fireEvent(video, new Event("error"));

    expect(
      await screen.findByText("This format can't be played in-browser"),
    ).toBeInTheDocument();
    expect(container.querySelector("video")).toBeNull();
  });

  // ── Reauth-required — refresh token expired/revoked ───────────────────
  //
  // When the backend detects OAuth `invalid_grant` during token refresh, it
  // returns `401 { code: "reauth_required" }` from `/stream-url` (instead of
  // a confusing `502 invalid_grant`). The watch page surfaces a structured
  // "Reconnect {Provider}" card linking to the Sources page so the user
  // has a clear recovery path. The hook also short-circuits TanStack retries
  // since recovery requires user action.

  function watchFetchReauth(detail: VideoDetailDto = VIDEO_DETAIL) {
    return (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/videos/${detail.id}`) return jsonResponse(detail);
      if (url === `/api/videos/${detail.id}/thumbnail`)
        return new Response("fake-image", { status: 200 });
      if (url === `/api/videos/${detail.id}/stream-url`) {
        // Mirror the backend's `ApiError::ReauthRequired` body — see
        // `crates/api/src/error.rs`.
        return jsonResponse(
          {
            status: "error",
            code: "reauth_required",
            message: "google_drive connection needs reconnecting.",
            connection_id: "c1",
            provider: "google_drive",
          },
          401,
        );
      }
      return jsonError(404, "unmocked");
    };
  }

  it("renders a Reconnect card when stream-url returns reauth_required", async () => {
    mockCanPlayType("probably");
    const { container } = renderWatchPage("v1", watchFetchReauth());

    // Card renders with the provider label resolved from the structured
    // error body — no raw `invalid_grant` text leaks to the user.
    expect(
      await screen.findByRole("heading", {
        name: "Reconnect Google Drive to play this video",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/invalid_grant/),
    ).not.toBeInTheDocument();

    // Call-to-action link points at the Sources page.
    expect(
      screen.getByRole("link", { name: "Go to Sources" }),
    ).toHaveAttribute("href", "/connections");

    // No `<video>` element — the player is replaced entirely.
    expect(container.querySelector("video")).toBeNull();

    // Video metadata still renders (DB row is local — only provider byte
    // access is blocked).
    expect(screen.getByRole("heading", { name: "cat.mp4" })).toBeInTheDocument();
  });

  it("falls back to the video's provider label when reauth body omits provider", async () => {
    mockCanPlayType("probably");
    const fetchImpl = (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/videos/v1`) return jsonResponse(VIDEO_DETAIL);
      if (url === `/api/videos/v1/thumbnail`)
        return new Response("fake-image", { status: 200 });
      if (url === `/api/videos/v1/stream-url`) {
        return jsonResponse(
          {
            status: "error",
            code: "reauth_required",
            message: "connection expired",
            // provider omitted to exercise the fallback in the component.
          },
          401,
        );
      }
      return jsonError(404, "unmocked");
    };

    renderWatchPage("v1", fetchImpl);

    // Falls back to VIDEO_DETAIL.provider = "google_drive".
    expect(
      await screen.findByRole("heading", {
        name: "Reconnect Google Drive to play this video",
      }),
    ).toBeInTheDocument();
  });

  it("does not render reconnect card for non-reauth 401 errors", async () => {
    mockCanPlayType("probably");
    const fetchImpl = (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/videos/v1`) return jsonResponse(VIDEO_DETAIL);
      if (url === `/api/videos/v1/thumbnail`)
        return new Response("fake-image", { status: 200 });
      if (url === `/api/videos/v1/stream-url`) {
        // A plain 502 — e.g. transient provider outage — must NOT trigger
        // the reconnect UI; only `code: "reauth_required"` does.
        return jsonResponse(
          { status: "error", message: "provider down" },
          502,
        );
      }
      return jsonError(404, "unmocked");
    };

    renderWatchPage("v1", fetchImpl);

    // Wait for the video metadata to render, then verify the reconnect
    // card never appears.
    await screen.findByRole("heading", { name: "cat.mp4" });
    expect(
      screen.queryByRole("heading", { name: /Reconnect/ }),
    ).not.toBeInTheDocument();
  });

  it("surfaces the Reconnect card even when the video's MIME type is unplayable", async () => {
    // Regression: when canPlayType returns "" (browser can't decode the
    // codec natively), WatchPage skips VideoPlayer and falls through to
    // UnsupportedFormat — which meant reauth_required errors never reached
    // the Reconnect card. The user saw "This format can't be played"
    // instead of "Reconnect {Provider}", blocking the only recovery path.
    // The fix hoists the reauth check above the canPlay branch so it
    // applies regardless of MIME type.
    mockCanPlayType("");
    const { container } = renderWatchPage("v1", watchFetchReauth());

    expect(
      await screen.findByRole("heading", {
        name: "Reconnect Google Drive to play this video",
      }),
    ).toBeInTheDocument();
    // Must NOT fall through to UnsupportedFormat.
    expect(
      screen.queryByText(/This format can't be played/),
    ).not.toBeInTheDocument();
    expect(container.querySelector("video")).toBeNull();
  });

  it("Reconnect button triggers the OAuth flow inline with return_to=/watch/{id}", async () => {
    mockCanPlayType("probably");
    // Industry-pattern inline reauth: clicking the primary CTA kicks off the
    // OAuth flow directly from the card — not a navigation to the Sources
    // page. The backend uses `return_to` to land the user back here after
    // the round-trip, so we assert the request includes it and the browser
    // is redirected to the provider's auth URL.
    const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === `/api/videos/v1`) return jsonResponse(VIDEO_DETAIL);
      if (url === `/api/videos/v1/thumbnail`)
        return new Response("fake-image", { status: 200 });
      if (url === `/api/videos/v1/stream-url`) {
        return jsonResponse(
          {
            status: "error",
            code: "reauth_required",
            message: "google_drive connection needs reconnecting.",
            connection_id: "c1",
            provider: "google_drive",
          },
          401,
        );
      }
      // The start endpoint must receive the return_to query param so the
      // backend knows where to redirect after OAuth.
      if (
        url.startsWith("/api/connections/google_drive/start") &&
        method === "POST"
      ) {
        expect(url).toContain(
          `return_to=${encodeURIComponent("/watch/v1")}`,
        );
        return jsonResponse({ auth_url: "https://provider.example/auth" });
      }
      return jsonError(404, "unmocked");
    };

    // Stub window.location.href setter so we can capture the redirect
    // without jsdom trying to actually navigate (and blowing up the test).
    const originalLocation = window.location;
    const hrefSetter = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new Proxy(
        { href: "" },
        {
          set(target, prop, value) {
            if (prop === "href") {
              hrefSetter(value);
              return true;
            }
            return Reflect.set(target, prop, value);
          },
        },
      ),
    });

    try {
      const { fetchSpy } = renderWatchPage("v1", fetchImpl);

      await screen.findByRole("heading", {
        name: "Reconnect Google Drive to play this video",
      });

      // Primary CTA is now "Reconnect {provider}", not "Try again".
      const reconnect = screen.getByRole("button", {
        name: "Reconnect Google Drive",
      });
      await act(async () => {
        fireEvent.click(reconnect);
      });

      // The OAuth start request fired with the return_to param.
      await waitFor(() => {
        const startCall = fetchSpy.mock.calls.find(
          ([url, init]) =>
            String(url).startsWith("/api/connections/google_drive/start") &&
            (init as RequestInit | undefined)?.method === "POST",
        );
        expect(startCall).toBeDefined();
      });

      // The browser was redirected to the provider's auth URL.
      expect(hrefSetter).toHaveBeenCalledWith("https://provider.example/auth");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("routes to the Reconnect card on the leak-path 502 (no structured code)", async () => {
    // Regression: when the backend returns the legacy/leak 502 with the
    // raw `ProviderError::Unauthorized` Display text and NO `code` field
    // (older binary, an uncovered leak path, or `factory.create` failing
    // before the refresh handler), the watch page used to fall through to
    // `StreamUrlError` — whose "Try again" button only refetched
    // `/stream-url`, looping forever on the same 502. The fix detects
    // reauth by error-signature (message substring) so the Reconnect card
    // surfaces regardless of whether the structured `code` is present.
    mockCanPlayType("probably");
    const fetchImpl = (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/videos/v1`) return jsonResponse(VIDEO_DETAIL);
      if (url === `/api/videos/v1/thumbnail`)
        return new Response("fake-image", { status: 200 });
      if (url === `/api/videos/v1/stream-url`) {
        // Exact shape produced by `ApiError::Provider(ProviderError::Unauthorized)`
        // → 502 with the provider error's Display text and NO `code` field.
        return jsonResponse(
          {
            status: "error",
            message: "unauthorized: token may be expired or revoked",
          },
          502,
        );
      }
      return jsonError(404, "unmocked");
    };

    renderWatchPage("v1", fetchImpl);

    // The Reconnect card must render — not the useless "Try again" card.
    expect(
      await screen.findByRole("heading", {
        name: "Reconnect Google Drive to play this video",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Try again/i }),
    ).not.toBeInTheDocument();
  });
});

// ── M8 Task 004 — ASS/SSA rendering via libass (jassub) ──────────────────
//
// ASS tracks bypass the native <track> element (which strips ASS styling to
// plain text) and route through a libass canvas overlay. The watch page
// filters ASS tracks out of the <track> render, mirrors the active subtitle
// selection up from PlayerControls, and initializes the libass hook with the
// track URL when an ASS track is selected.

function watchFetchWithSubtitles(tracks: VideoDetailDto["subtitle_tracks"]) {
  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/videos/v1`)
      return jsonResponse({ ...VIDEO_DETAIL, subtitle_tracks: tracks });
    if (url === `/api/videos/v1/thumbnail`)
      return new Response("fake-image", { status: 200 });
    if (url === `/api/videos/v1/stream-url`) {
      return jsonResponse({
        url: "https://cdn.example.com/v1.mp4",
        strategy: "direct",
        expires_at: "2026-01-01T01:00:00Z",
      });
    }
    return jsonError(404, "unmocked");
  };
}

const ASS_TRACK = {
  id: "a1",
  language: "ja",
  filename: "cat.ja.ass",
  format: "ass",
  format_family: "text" as const,
  embedded_track_id: null,
};
const SRT_TRACK = {
  id: "s1",
  language: "en",
  filename: "cat.en.srt",
  format: "srt",
  format_family: "text" as const,
  embedded_track_id: null,
};

describe("WatchPage — ASS rendering via libass (M8 Task 004)", () => {
  beforeEach(() => {
    libassMock.ctor.mockClear();
    libassMock.destroy.mockClear();
    // restoreMocks (vitest config) wipes mockGetProgress's implementation
    // before each test; the parent describe re-applies it, this sibling
    // describe must too — usePlaybackTracking calls .then on its return
    // value directly (no Promise.all guard), so undefined crashes.
    mockGetProgress.mockResolvedValue(null);
  });

  it("does not render a <track> for ASS tracks (they bypass native track)", async () => {
    mockCanPlayType("probably");
    renderWatchPage("v1", watchFetchWithSubtitles([ASS_TRACK, SRT_TRACK]));

    await screen.findByRole("heading", { name: "cat.mp4" });

    // Only the SRT track gets a <track>; the ASS track is routed to the
    // libass canvas overlay instead.
    const tracks = document.querySelectorAll("video > track");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toHaveAttribute("src", "/api/videos/v1/subtitles/s1");
  });

  it("does not initialize libass until an ASS track is selected", async () => {
    mockCanPlayType("probably");
    renderWatchPage("v1", watchFetchWithSubtitles([ASS_TRACK, SRT_TRACK]));

    await screen.findByRole("heading", { name: "cat.mp4" });

    // Default selection is "Off" — no libass instance yet.
    expect(libassMock.ctor).not.toHaveBeenCalled();
  });

  it("selecting an ASS track initializes libass with the track URL + canvas overlay", async () => {
    mockCanPlayType("probably");
    renderWatchPage("v1", watchFetchWithSubtitles([ASS_TRACK, SRT_TRACK]));

    await screen.findByRole("heading", { name: "cat.mp4" });

    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "ja (ASS)" }));

    await waitFor(() => expect(libassMock.ctor).toHaveBeenCalledTimes(1));
    expect(libassMock.ctor).toHaveBeenCalledWith(
      expect.objectContaining({
        subUrl: "/api/videos/v1/subtitles/a1",
        video: expect.any(HTMLVideoElement),
        canvas: expect.any(HTMLCanvasElement),
      }),
    );
    // The canvas overlay is rendered over the <video>.
    expect(document.querySelector("canvas")).not.toBeNull();
  });

  it("selecting 'Off' tears down the libass instance and removes the canvas", async () => {
    mockCanPlayType("probably");
    renderWatchPage("v1", watchFetchWithSubtitles([ASS_TRACK, SRT_TRACK]));

    await screen.findByRole("heading", { name: "cat.mp4" });

    // Select the ASS track first.
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "ja (ASS)" }));
    await waitFor(() => expect(libassMock.ctor).toHaveBeenCalledTimes(1));

    // Then switch to Off.
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Off" }));

    await waitFor(() => expect(libassMock.destroy).toHaveBeenCalledTimes(1));
    // Canvas overlay is removed when no ASS track is active.
    await waitFor(() => {
      expect(document.querySelector("canvas")).toBeNull();
    });
  });

  it("selecting a non-ASS (SRT) track does not initialize libass", async () => {
    mockCanPlayType("probably");
    renderWatchPage("v1", watchFetchWithSubtitles([ASS_TRACK, SRT_TRACK]));

    await screen.findByRole("heading", { name: "cat.mp4" });

    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "en (SRT)" }));

    // SRT renders via the native <track> mechanism — libass is never loaded.
    expect(libassMock.ctor).not.toHaveBeenCalled();
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("toggling ASS on/off does not change the <video> src (no re-fetch)", async () => {
    mockCanPlayType("probably");
    renderWatchPage("v1", watchFetchWithSubtitles([ASS_TRACK]));

    await screen.findByRole("heading", { name: "cat.mp4" });
    const video = document.querySelector("video")!;

    // Wait for the stream URL to land.
    await waitFor(() => expect(video).toHaveAttribute("src"));
    const srcBefore = video.getAttribute("src");

    // Toggle ASS on.
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "ja (ASS)" }));
    await waitFor(() => expect(libassMock.ctor).toHaveBeenCalledTimes(1));

    // Toggle ASS off.
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Off" }));
    await waitFor(() => expect(libassMock.destroy).toHaveBeenCalledTimes(1));

    // The underlying stream src is unchanged — toggling subtitles is purely
    // client-side and must not restart playback or re-fetch the stream.
    expect(video.getAttribute("src")).toBe(srcBefore);
  });
});

// ── M8 Task 010 — Burn-in stream refetch ───────────────────────────────
//
// When the user selects an image-family subtitle track (PGS/VobSub) during
// transcode playback, the watch page appends `?burn_subtitles={trackId}` to
// the master playlist URL. useHlsStream re-attaches to the burned variant;
// selecting "Off" removes the param and re-attaches to the unburned master.

const PGS_TRACK = {
  id: "p1",
  language: "es",
  filename: "mkv.es.pgs",
  format: "pgs",
  format_family: "image" as const,
  embedded_track_id: 2,
};

function watchFetchTranscode(tracks: VideoDetailDto["subtitle_tracks"]) {
  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/videos/v1`)
      return jsonResponse({ ...VIDEO_DETAIL, subtitle_tracks: tracks });
    if (url === `/api/videos/v1/thumbnail`)
      return new Response("fake-image", { status: 200 });
    if (url === `/api/videos/v1/stream-url`) {
      return jsonResponse({
        url: "/api/videos/v1/transcode/master.m3u8",
        strategy: "transcode",
        expires_at: null,
      });
    }
    return jsonError(404, "unmocked");
  };
}

describe("WatchPage — burn-in stream refetch (M8 Task 010)", () => {
  beforeEach(() => {
    hlsMock.ctor.mockClear();
    hlsMock.loadSource.mockClear();
    hlsMock.destroy.mockClear();
    hlsMock.attachMedia.mockClear();
    hlsMock.on.mockClear();
    hlsMock.isSupported.mockReturnValue(true);
    mockGetProgress.mockResolvedValue(null);
  });

  it("confirming burn appends ?burn_subtitles= to the master URL", async () => {
    renderWatchPage("v1", watchFetchTranscode([SRT_TRACK, PGS_TRACK]));

    await screen.findByRole("heading", { name: "cat.mp4" });

    // Wait for hls.js to attach with the base master URL (no burn yet).
    await waitFor(() =>
      expect(hlsMock.loadSource).toHaveBeenCalledWith(
        "/api/videos/v1/transcode/master.m3u8",
      ),
    );

    // Select the PGS track → burn confirmation dialog appears.
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /PGS/ }));
    expect(
      screen.getByRole("dialog", { name: /burn/i }),
    ).toBeInTheDocument();

    // Confirm → the master URL gains ?burn_subtitles=p1.
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() =>
      expect(hlsMock.loadSource).toHaveBeenCalledWith(
        "/api/videos/v1/transcode/master.m3u8?burn_subtitles=p1",
      ),
    );
  });

  it("selecting Off after burning removes the burn param", async () => {
    renderWatchPage("v1", watchFetchTranscode([SRT_TRACK, PGS_TRACK]));

    await screen.findByRole("heading", { name: "cat.mp4" });

    // Burn the PGS track first.
    await waitFor(() =>
      expect(hlsMock.loadSource).toHaveBeenCalledWith(
        "/api/videos/v1/transcode/master.m3u8",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /PGS/ }));
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() =>
      expect(hlsMock.loadSource).toHaveBeenCalledWith(
        "/api/videos/v1/transcode/master.m3u8?burn_subtitles=p1",
      ),
    );

    // Selecting Off clears the burn param — the master URL reverts.
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Off" }));

    // The last loadSource call should be the base URL (re-attaching to the
    // unburned variant). We check the most recent call since previous calls
    // include the initial attach + the burn attach.
    await waitFor(() => {
      const calls = hlsMock.loadSource.mock.calls;
      const lastUrl = calls[calls.length - 1]?.[0];
      expect(lastUrl).toBe("/api/videos/v1/transcode/master.m3u8");
    });
  });

  it("cancelling the burn dialog leaves the master URL unchanged", async () => {
    renderWatchPage("v1", watchFetchTranscode([SRT_TRACK, PGS_TRACK]));

    await screen.findByRole("heading", { name: "cat.mp4" });
    await waitFor(() =>
      expect(hlsMock.loadSource).toHaveBeenCalledWith(
        "/api/videos/v1/transcode/master.m3u8",
      ),
    );
    const initialCallCount = hlsMock.loadSource.mock.calls.length;

    // Open the burn dialog then cancel.
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /PGS/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // No new loadSource call — playback stays on the unburned master.
    expect(hlsMock.loadSource.mock.calls.length).toBe(initialCallCount);
  });

  it("image track is disabled when strategy is not transcode", async () => {
    // Direct strategy — burn-in is impossible without the transcode pipeline.
    mockCanPlayType("probably");
    renderWatchPage("v1", (input) => {
      const url = String(input);
      if (url === `/api/videos/v1`)
        return jsonResponse({ ...VIDEO_DETAIL, subtitle_tracks: [SRT_TRACK, PGS_TRACK] });
      if (url === `/api/videos/v1/thumbnail`)
        return new Response("fake-image", { status: 200 });
      if (url === `/api/videos/v1/stream-url`) {
        return jsonResponse({
          url: "https://cdn.example.com/v1.mp4",
          strategy: "direct",
          expires_at: "2026-01-01T01:00:00Z",
        });
      }
      return jsonError(404, "unmocked");
    });

    await screen.findByRole("heading", { name: "cat.mp4" });
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    expect(
      screen.getByRole("menuitemradio", { name: /PGS/ }),
    ).toBeDisabled();
  });
});
