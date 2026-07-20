import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import type { VideoPageDto, VideoSummaryDto } from "../api/types";
import { VIDEOS_QUERY_KEY } from "../hooks/use-videos";
import {
  patchVideoSummaries,
  restoreVideoQueries,
  snapshotVideoQueries,
} from "./video-cache";

function video(id: string, over: Partial<VideoSummaryDto> = {}): VideoSummaryDto {
  return {
    id,
    name: `${id}.mp4`,
    provider: "google_drive",
    size_bytes: 1024,
    mime_type: "video/mp4",
    duration_ms: null,
    width: null,
    height: null,
    sources: [],
    created_at: "2026-01-01T00:00:00Z",
    path: null,
    is_favorite: false,
    my_rating: null,
    thumbnail_status: "pending",
    position_seconds: null,
    completed: false,
    ...over,
  };
}

function page(ids: string[]): VideoPageDto {
  return { videos: ids.map((id) => video(id)), total: ids.length, page: 1, limit: 50 };
}

describe("video-cache helpers", () => {
  it("snapshots all cached ['videos', ...] pages", () => {
    const qc = new QueryClient();
    qc.setQueryData([...VIDEOS_QUERY_KEY, { sort: "date-desc" }], page(["a", "b"]));
    qc.setQueryData([...VIDEOS_QUERY_KEY, { sort: "date-desc", favorites_only: true }], page(["c"]));

    const snapshot = snapshotVideoQueries(qc);
    expect(snapshot.length).toBe(2);
    const ids = snapshot
      .flatMap((s) => (s.data?.videos ?? []).map((v) => v.id))
      .sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("patchVideoSummaries updates the matching video across all cached pages", () => {
    const qc = new QueryClient();
    const keyA = [...VIDEOS_QUERY_KEY, { sort: "date-desc" }];
    const keyB = [...VIDEOS_QUERY_KEY, { sort: "date-desc", favorites_only: true }];
    qc.setQueryData(keyA, page(["a", "b"]));
    qc.setQueryData(keyB, page(["b", "c"]));

    patchVideoSummaries(qc, "b", (v) => ({ ...v, is_favorite: true }));

    const afterA = qc.getQueryData(keyA) as VideoPageDto;
    const afterB = qc.getQueryData(keyB) as VideoPageDto;
    expect(afterA.videos.map((v) => [v.id, v.is_favorite])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(afterB.videos.map((v) => [v.id, v.is_favorite])).toEqual([
      ["b", true],
      ["c", false],
    ]);
  });

  it("patchVideoSummaries leaves the page untouched when the video isn't present", () => {
    const qc = new QueryClient();
    const key = [...VIDEOS_QUERY_KEY, { sort: "date-desc" }];
    const original = page(["a"]);
    qc.setQueryData(key, original);

    patchVideoSummaries(qc, "missing", (v) => ({ ...v, is_favorite: true }));

    // Reference equality — patch is a no-op when no video matched.
    expect(qc.getQueryData(key)).toBe(original);
  });

  it("restoreVideoQueries reverts the cache to the snapshotted state", () => {
    const qc = new QueryClient();
    const key = [...VIDEOS_QUERY_KEY, { sort: "date-desc" }];
    qc.setQueryData(key, page(["a", "b"]));

    const snapshot = snapshotVideoQueries(qc);
    patchVideoSummaries(qc, "a", (v) => ({ ...v, is_favorite: true, my_rating: 5 }));
    // Sanity: the patch took effect.
    const patched = qc.getQueryData(key) as VideoPageDto;
    expect(patched.videos[0]).toMatchObject({ is_favorite: true, my_rating: 5 });

    restoreVideoQueries(qc, snapshot);

    const restored = qc.getQueryData(key) as VideoPageDto;
    expect(restored.videos[0]).toMatchObject({ is_favorite: false, my_rating: null });
  });

  it("snapshot excludes unrelated query keys", () => {
    const qc = new QueryClient();
    qc.setQueryData([...VIDEOS_QUERY_KEY, { sort: "date-desc" }], page(["a"]));
    qc.setQueryData(["connections"], [{ id: "c1" }]);
    qc.setQueryData(["session"], null);

    const snapshot = snapshotVideoQueries(qc);
    expect(snapshot.length).toBe(1);
  });
});
