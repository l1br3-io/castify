import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useInProgressVideos } from "./use-in-progress-videos";
import { type ProgressEntry } from "../lib/player-db";

// Mock the IndexedDB layer — jsdom has no IndexedDB. Each test controls
// `getInProgressVideos` via `mockResolvedValue` / `mockResolvedValueOnce`.
vi.mock("../lib/player-db", () => ({
  getInProgressVideos: vi.fn().mockResolvedValue([]),
}));

import { getInProgressVideos } from "../lib/player-db";

const mockGetInProgressVideos = vi.mocked(getInProgressVideos);

const ENTRY_A: ProgressEntry = {
  videoId: "a",
  positionSeconds: 30,
  durationSeconds: 120,
  completed: false,
  updatedAt: 1000,
  videoName: "video-a.mp4",
  videoDurationMs: 120_000,
  thumbnailStatus: "cached",
  height: 1080,
  provider: "google_drive",
};

const ENTRY_B: ProgressEntry = {
  ...ENTRY_A,
  videoId: "b",
  updatedAt: 2000,
  videoName: "video-b.mp4",
};

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useInProgressVideos", () => {
  beforeEach(() => {
    mockGetInProgressVideos.mockReset();
    mockGetInProgressVideos.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls getInProgressVideos with the default limit (20)", async () => {
    renderHook(() => useInProgressVideos(), { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(mockGetInProgressVideos).toHaveBeenCalledTimes(1);
    });
    expect(mockGetInProgressVideos).toHaveBeenCalledWith(20);
  });

  it("passes a custom limit through to the underlying read", async () => {
    renderHook(() => useInProgressVideos(5), { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(mockGetInProgressVideos).toHaveBeenCalledWith(5);
    });
  });

  it("returns the entries from IndexedDB", async () => {
    mockGetInProgressVideos.mockResolvedValue([ENTRY_A, ENTRY_B]);
    const { result } = renderHook(() => useInProgressVideos(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([ENTRY_A, ENTRY_B]);
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it("surfaces an empty array (not an error) when nothing is in progress", async () => {
    mockGetInProgressVideos.mockResolvedValue([]);
    const { result } = renderHook(() => useInProgressVideos(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it("tolerates IndexedDB failure by surfacing an error state (caller hides the shelf)", async () => {
    // `getInProgressVideos` swallows IDB errors internally and returns `[]`,
    // so this branch is mostly defensive. If the implementation ever changes
    // to rethrow, the hook must still produce a query error rather than
    // crash the browse page.
    mockGetInProgressVideos.mockRejectedValue(new Error("idb blocked"));
    const { result } = renderHook(() => useInProgressVideos(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.data).toBeUndefined();
  });
});
