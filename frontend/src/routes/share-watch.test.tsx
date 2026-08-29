// Share watch page tests (docs/specs/sharing task 010).
//
// Covers the recipient player page through the fetch boundary:
//   items (share-scoped) + subtitles (share-scoped) + stream-url
//   (share-scoped) → player rendering with share-rooted URLs, plus the
//   acceptance criteria:
//     * zero server writes — no POST/PUT/DELETE, no owner-route URLs
//     * progress persists to IndexedDB under `player-db` (same store the
//       owner player uses) — resume + write asserted through the mocked
//       module
//     * owner-only affordances hidden — favorite, rating, download
//       fallback, queue skip controls

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { ShareWatchPage } from "./share-watch";
import {
  jsonError,
  jsonResponse,
  renderWithProviders,
  type FetchHandler,
} from "../test/utils";
import type { SubtitleTrackDto, VideoSummaryDto } from "../api/types";

// Mock the IndexedDB layer — same mock surface as the owner watch page
// tests. The recipient player must read/write the exact same store.
vi.mock("../lib/player-db", () => ({
  getProgress: vi.fn().mockResolvedValue(null),
  saveProgressEntry: vi.fn().mockResolvedValue(undefined),
  clearProgress: vi.fn().mockResolvedValue(undefined),
  getGlobalPrefs: vi.fn().mockResolvedValue(null),
  getSubtitlePref: vi.fn().mockResolvedValue(null),
  saveGlobalPrefs: vi.fn().mockResolvedValue(undefined),
  saveSubtitlePref: vi.fn().mockResolvedValue(undefined),
}));

// Mock jassub — see watch.test.tsx for the rationale (dynamic-import seam).
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

// Mock hls.js — transcode-strategy tests assert on the share-rooted master
// URL without loading the real bundle or needing MediaSource in jsdom.
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
      if (event === "hlsManifestParsed") {
        cb({}, { levels: [] });
      }
    }
    destroy() {
      hlsMock.destroy();
    }
  },
}));

import { getProgress, saveProgressEntry } from "../lib/player-db";

const mockGetProgress = vi.mocked(getProgress);
const mockSaveProgressEntry = vi.mocked(saveProgressEntry);

const TOKEN = "tok_abc123";
const VIDEO_ID = "v1";
const BASE = `/api/share/${TOKEN}/videos/${VIDEO_ID}`;

const SUBTITLE_TRACKS: SubtitleTrackDto[] = [
  {
    id: "s1",
    language: "en",
    filename: "cat.en.srt",
    format: "srt",
    format_family: "text",
    embedded_track_id: null,
  },
];

function shareVideo(id = VIDEO_ID, name = "cat.mp4"): VideoSummaryDto {
  return {
    id,
    name,
    provider: "google_drive",
    size_bytes: 5_242_880,
    mime_type: "video/mp4",
    duration_ms: 120_000,
    width: 1920,
    height: 1080,
    sources: [],
    created_at: "2026-01-01T00:00:00Z",
    path: "/Movies/cat.mp4",
    is_favorite: false,
    my_rating: null,
    thumbnail_status: "cached",
    position_seconds: null,
    completed: false,
  };
}

interface WatchApi {
  items?: () => Response;
  subtitles?: () => Response;
  streamUrl?: () => Response;
}

function shareWatchHandler(api: WatchApi = {}): FetchHandler {
  return (input, init) => {
    const url = String(input);
    if (url === `/api/share/${TOKEN}/items`)
      return api.items ? api.items() : jsonResponse([shareVideo()]);
    if (url === `${BASE}/subtitles`)
      return api.subtitles ? api.subtitles() : jsonResponse(SUBTITLE_TRACKS);
    if (url === `${BASE}/stream-url`)
      return (
        api.streamUrl ??
        (() =>
          jsonResponse({
            url: "https://cdn.example.com/v1.mp4",
            strategy: "direct",
            expires_at: "2026-01-01T01:00:00Z",
          }))
      )();
    return jsonError(404, `unmocked ${init?.method ?? "GET"} ${url}`);
  };
}

function renderShareWatchPage(
  videoId = VIDEO_ID,
  fetchImplementation: FetchHandler = shareWatchHandler(),
) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/share/:token/watch/:videoId"
        element={<ShareWatchPage />}
      />
    </Routes>,
    {
      initialEntries: [`/share/${TOKEN}/watch/${videoId}`],
      fetchImplementation,
    },
  );
}

function mockCanPlayType(value: "maybe" | "probably" | "") {
  vi.spyOn(HTMLVideoElement.prototype, "canPlayType").mockReturnValue(value);
}

describe("ShareWatchPage", () => {
  beforeEach(() => {
    mockGetProgress.mockResolvedValue(null);
    mockSaveProgressEntry.mockResolvedValue(undefined);
  });

  it("renders the player with share-scoped stream, poster, and subtitle URLs (direct strategy)", async () => {
    mockCanPlayType("probably");
    const { container } = renderShareWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });

    const video = await waitFor(() => {
      const el = container.querySelector("video");
      expect(el).not.toBeNull();
      expect(el).toHaveAttribute("src");
      return el!;
    });
    expect(video).toHaveAttribute("src", "https://cdn.example.com/v1.mp4");
    expect(video).toHaveAttribute(
      "poster",
      `/api/share/${TOKEN}/videos/${VIDEO_ID}/thumbnail`,
    );

    const track = document.querySelector("video > track");
    expect(track).not.toBeNull();
    expect(track).toHaveAttribute(
      "src",
      `/api/share/${TOKEN}/videos/${VIDEO_ID}/subtitles/s1`,
    );
  });

  it("attaches hls.js to the share-rooted master playlist (transcode strategy)", async () => {
    hlsMock.loadSource.mockClear();
    renderShareWatchPage(VIDEO_ID, shareWatchHandler({
      streamUrl: () =>
        jsonResponse({
          url: `${BASE}/transcode/master.m3u8`,
          strategy: "transcode",
          expires_at: null,
        }),
    }));

    await screen.findByRole("heading", { name: "cat.mp4" });

    await waitFor(() =>
      expect(hlsMock.loadSource).toHaveBeenCalledWith(
        `${BASE}/transcode/master.m3u8`,
      ),
    );
  });

  it("issues zero server writes — every request is a GET under the share scope", async () => {
    mockCanPlayType("probably");
    const { fetchSpy } = renderShareWatchPage();

    const video = await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).not.toBeNull();
      expect(el).toHaveAttribute("src");
      return el!;
    });

    // Drive the playback-tracking path (pause after advancing) so any
    // latent progress POST would have fired by now.
    (video as HTMLVideoElement).currentTime = 42;
    fireEvent(video, new Event("pause"));

    await waitFor(() =>
      expect(mockSaveProgressEntry).toHaveBeenCalledWith(
        expect.objectContaining({ videoId: VIDEO_ID, positionSeconds: 42 }),
      ),
    );

    // Zero owner routes, zero mutations — the spec's "no server writes
    // during recipient playback" line, asserted at the fetch layer.
    for (const [input, init] of fetchSpy.mock.calls) {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      expect(url.startsWith(`/api/share/${TOKEN}/`)).toBe(true);
      expect(method).toBe("GET");
    }
  });

  it("hides owner affordances — favorite, rating, queue skips, download", async () => {
    mockCanPlayType("probably");
    renderShareWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });

    expect(
      screen.queryByRole("button", { name: /Add to favorites/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Rate this video" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Previous video" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Next video" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Download/i })).not.toBeInTheDocument();
  });

  it("shows the unsupported-format card without a download link when the browser can't decode", async () => {
    mockCanPlayType("");
    renderShareWatchPage();

    expect(
      await screen.findByText("This format can't be played in-browser"),
    ).toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
    // v1 line: no download endpoints for recipients (spec Never-list).
    expect(screen.queryByRole("link", { name: /Download/i })).not.toBeInTheDocument();
  });

  it("resumes from the same IndexedDB store the owner player uses", async () => {
    mockCanPlayType("probably");
    mockGetProgress.mockResolvedValue({
      videoId: VIDEO_ID,
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
    renderShareWatchPage();

    await screen.findByRole("heading", { name: "cat.mp4" });
    await waitFor(() => expect(mockGetProgress).toHaveBeenCalledWith(VIDEO_ID));

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

  it("renders a back-link state when the share is locked (items 401)", async () => {
    const { fetchSpy } = renderShareWatchPage(VIDEO_ID, shareWatchHandler({
      items: () => jsonError(401, "locked"),
    }));

    expect(
      await screen.findByText(/protected by a password/i),
    ).toBeInTheDocument();
    const back = screen.getByRole("link", { name: /share page/i });
    expect(back).toHaveAttribute("href", `/share/${TOKEN}`);

    // Membership never resolved, so no stream-url call fired.
    const streamUrlCalls = fetchSpy.mock.calls.filter(
      ([input]) => String(input) === `${BASE}/stream-url`,
    );
    expect(streamUrlCalls).toHaveLength(0);
  });

  it("renders the terminal state when the share died (items 410)", async () => {
    renderShareWatchPage(VIDEO_ID, shareWatchHandler({
      items: () => jsonError(410, "share expired"),
    }));

    expect(
      await screen.findByText("This share is no longer available."),
    ).toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
  });

  it("renders a not-in-share state for a non-member video id", async () => {
    renderShareWatchPage("vZ", shareWatchHandler({
      items: () => jsonResponse([shareVideo("vA", "Video A")]),
    }));

    expect(
      await screen.findByText(/isn't part of the share/i),
    ).toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
  });

  it("surfaces a generic stream error — never the owner's reconnect flow", async () => {
    mockCanPlayType("probably");
    renderShareWatchPage(VIDEO_ID, shareWatchHandler({
      streamUrl: () =>
        jsonResponse(
          {
            status: "error",
            code: "reauth_required",
            message: "google_drive connection needs reconnecting.",
            connection_id: "c1",
            provider: "google_drive",
          },
          401,
        ),
    }));

    await screen.findByRole("heading", { name: "cat.mp4" });
    expect(
      await screen.findByText(/Couldn't load this video/i),
    ).toBeInTheDocument();
    // The reconnect card is an owner recovery path — a recipient can't
    // re-grant the owner's OAuth tokens.
    expect(screen.queryByRole("heading", { name: /Reconnect/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Go to Connections" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
  });
});
