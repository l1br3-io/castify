import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, act, waitFor } from "@testing-library/react";
import { useRef } from "react";

import { usePlaybackTracking } from "./use-playback-tracking";
import {
  getProgress,
  saveProgressEntry,
  type ProgressEntry,
} from "../lib/player-db";
import { renderWithProviders } from "../test/utils";
import type { VideoDetailDto } from "../api/types";

// Mock the IndexedDB layer — jsdom has no IndexedDB. Each test controls
// `getProgress`'s return value via `mockReturnValue`/`mockResolvedValueOnce`.
vi.mock("../lib/player-db", () => ({
  getProgress: vi.fn().mockResolvedValue(null),
  saveProgressEntry: vi.fn().mockResolvedValue(undefined),
}));

const mockGetProgress = vi.mocked(getProgress);
const mockSaveProgress = vi.mocked(saveProgressEntry);

// --- Test fixture: minimal VideoDetailDto the hook reads from. ---
const VIDEO: VideoDetailDto = {
  id: "v1",
  name: "test.mp4",
  provider: "google_drive",
  size_bytes: 5_000_000,
  mime_type: "video/mp4",
  duration_ms: 120_000,
  width: 1920,
  height: 1080,
  sources: [],
  created_at: "2026-01-01T00:00:00Z",
  path: "/test.mp4",
  is_favorite: false,
  my_rating: null,
  thumbnail_status: "cached",
  position_seconds: null,
  duration_seconds: 120,
  completed: false,
  subtitle_tracks: [],
};

// --- Harness: a <video> + the hook, mirroring how VideoPlayer composes
//     them in routes/watch.tsx. The toast indicator reflects `showResume`
//     so tests can assert on the resume-toast lifecycle without importing
//     the full WatchPage. ---
function Harness({ video = VIDEO }: { video?: VideoDetailDto }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  usePlaybackTracking(videoRef, video);
  return (
    <div>
      <video ref={videoRef} data-testid="video" />
    </div>
  );
}

// --- Helpers ---

function setProp(el: Element, prop: string, value: unknown) {
  Object.defineProperty(el, prop, {
    value,
    configurable: true,
    writable: true,
  });
}

function makeEntry(overrides: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    videoId: "v1",
    positionSeconds: 0,
    durationSeconds: null,
    completed: false,
    updatedAt: Date.now(),
    videoName: "test.mp4",
    videoDurationMs: 120_000,
    thumbnailStatus: "cached",
    height: 1080,
    provider: "google_drive",
    ...overrides,
  };
}

/**
 * Wait for the IndexedDB read in the hook's mount effect to settle AND
 * commit. The main effect attaches its media listeners only after the
 * `savedProgress` state update commits, which lags the `getProgress`
 * call by a promise resolution + render — waiting on the call alone
 * leaves a scheduler-dependent window where `fireEvent(pause)` & co.
 * dispatch before the listener exists (flaky "0 times" failures).
 */
async function waitForIdbLoad() {
  await waitFor(() => {
    expect(mockGetProgress).toHaveBeenCalled();
  });
  const results = mockGetProgress.mock.results;
  await act(async () => {
    await results[results.length - 1]?.value;
  });
}

beforeEach(() => {
  mockGetProgress.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ── Resume ─────────────────────────────────────────────────────────────

describe("usePlaybackTracking — resume", () => {
  it("seeks to saved position on loadedmetadata when position > 30 && !completed", async () => {
    mockGetProgress.mockResolvedValue(
      makeEntry({ positionSeconds: 60, completed: false }),
    );
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 120);

    await waitForIdbLoad();
    fireEvent(video, new Event("loadedmetadata"));

    await waitFor(() => {
      expect(video.currentTime).toBe(60);
    });
  });

  it("does not seek when position <= 30", async () => {
    mockGetProgress.mockResolvedValue(makeEntry({ positionSeconds: 15 }));
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 120);

    await waitForIdbLoad();
    fireEvent(video, new Event("loadedmetadata"));

    // Give the resume logic a tick to (not) fire.
    await Promise.resolve();
    expect(video.currentTime).toBe(0);
  });

  it("does not seek when completed is true", async () => {
    mockGetProgress.mockResolvedValue(
      makeEntry({ positionSeconds: 60, completed: true }),
    );
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 120);

    await waitForIdbLoad();
    fireEvent(video, new Event("loadedmetadata"));

    await Promise.resolve();
    expect(video.currentTime).toBe(0);
  });

  it("does not seek when no saved progress exists (null)", async () => {
    mockGetProgress.mockResolvedValue(null);
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 120);

    await waitForIdbLoad();
    fireEvent(video, new Event("loadedmetadata"));

    await Promise.resolve();
    expect(video.currentTime).toBe(0);
  });

  it("clamps resume position to duration", async () => {
    mockGetProgress.mockResolvedValue(
      makeEntry({ positionSeconds: 200, completed: false }),
    );
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 120);

    await waitForIdbLoad();
    fireEvent(video, new Event("loadedmetadata"));

    await waitFor(() => {
      // Position 200 > duration 120 → clamped to 120.
      expect(video.currentTime).toBe(120);
    });
  });
});

// ── Progress saves (IndexedDB) ─────────────────────────────────────────

describe("usePlaybackTracking — progress saves", () => {
  it("writes to IndexedDB every 10 seconds during playback", async () => {
    vi.useFakeTimers();
    mockGetProgress.mockResolvedValue(null);
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 120);
    setProp(video, "currentTime", 30);
    fireEvent(video, new Event("timeupdate"));

    // Wait for the hook's IDB read to settle so the main effect activates.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockSaveProgress).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    const entry = mockSaveProgress.mock.calls[0][0];
    expect(entry.positionSeconds).toBe(30);
    expect(entry.durationSeconds).toBe(120);
  });

  it("writes on pause", async () => {
    mockGetProgress.mockResolvedValue(null);
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 120);
    setProp(video, "currentTime", 45);

    await waitForIdbLoad();

    await act(async () => {
      fireEvent(video, new Event("pause"));
    });

    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][0].positionSeconds).toBe(45);
  });

  it("writes on seeked", async () => {
    mockGetProgress.mockResolvedValue(null);
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 120);
    setProp(video, "currentTime", 72);

    await waitForIdbLoad();

    await act(async () => {
      fireEvent(video, new Event("seeked"));
    });

    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][0].positionSeconds).toBe(72);
  });

  it("writes on ended with completed: true", async () => {
    mockGetProgress.mockResolvedValue(null);
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 120);
    setProp(video, "currentTime", 120);

    await waitForIdbLoad();

    await act(async () => {
      fireEvent(video, new Event("ended"));
    });

    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][0].completed).toBe(true);
  });

  it("auto-marks completed at 95% on a regular save", async () => {
    mockGetProgress.mockResolvedValue(null);
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 100);
    setProp(video, "currentTime", 96);

    await waitForIdbLoad();

    await act(async () => {
      fireEvent(video, new Event("pause"));
    });

    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][0].completed).toBe(true);
  });

  it("does not mark completed below 95%", async () => {
    mockGetProgress.mockResolvedValue(null);
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 100);
    setProp(video, "currentTime", 94);

    await waitForIdbLoad();

    await act(async () => {
      fireEvent(video, new Event("pause"));
    });

    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][0].completed).toBe(false);
  });

  it("skips writes when position hasn't meaningfully changed", async () => {
    mockGetProgress.mockResolvedValue(null);
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 120);
    setProp(video, "currentTime", 50);

    await waitForIdbLoad();

    // First pause saves (delta > 5s from initial 0).
    await act(async () => {
      fireEvent(video, new Event("pause"));
    });
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);

    // Second pause without moving → skipped (delta < 5s).
    await act(async () => {
      fireEvent(video, new Event("pause"));
    });
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
  });

  it("denormalizes video metadata into the progress entry", async () => {
    mockGetProgress.mockResolvedValue(null);
    renderWithProviders(<Harness />);
    const video = screen.getByTestId("video") as HTMLVideoElement;
    setProp(video, "duration", 120);
    setProp(video, "currentTime", 10);

    await waitForIdbLoad();

    await act(async () => {
      fireEvent(video, new Event("pause"));
    });

    const entry = mockSaveProgress.mock.calls[0][0];
    expect(entry.videoName).toBe("test.mp4");
    expect(entry.videoDurationMs).toBe(120_000);
    expect(entry.thumbnailStatus).toBe("cached");
    expect(entry.height).toBe(1080);
    expect(entry.provider).toBe("google_drive");
  });
});
