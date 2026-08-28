// Access-scope URL seam (sharing task 008).
//
// Two invariants:
//   1. Default (owner) output is byte-identical to the pre-seam builders —
//      every existing call site must keep resolving to the same routes.
//   2. Scoped output re-roots under `/api/share/{token}/videos/{id}/...`
//      so recipient pages hit the pre-auth mirrors, never owner routes.

import { describe, expect, it, vi } from "vitest";

import {
  downloadUrl,
  fetchStreamUrl,
  fetchSubtitles,
  streamUrl,
  subtitleTrackUrl,
  thumbnailUrl,
} from "./videos";
import { jsonResponse } from "../test/utils";

const SHARE = { kind: "share", token: "tok_abc" } as const;

function lastCall(fetchSpy: ReturnType<typeof vi.fn>): string {
  const input = fetchSpy.mock.calls.at(-1)![0] as RequestInfo | URL;
  return input.toString();
}

describe("URL builders — default (owner) scope is byte-identical", () => {
  it("streamUrl", () => {
    expect(streamUrl("v1")).toBe("/api/videos/v1/stream");
  });

  it("downloadUrl", () => {
    expect(downloadUrl("v1")).toBe("/api/videos/v1/download");
  });

  it("subtitleTrackUrl", () => {
    expect(subtitleTrackUrl("v1", "t1")).toBe("/api/videos/v1/subtitles/t1");
  });

  it("thumbnailUrl", () => {
    expect(thumbnailUrl("v1")).toBe("/api/videos/v1/thumbnail");
  });

  it("encodes ids in the owner scope", () => {
    expect(streamUrl("id/with/slash")).toBe(
      "/api/videos/id%2Fwith%2Fslash/stream",
    );
    expect(subtitleTrackUrl("v1", "track/2")).toBe(
      "/api/videos/v1/subtitles/track%2F2",
    );
  });
});

describe("URL builders — share scope", () => {
  it("roots every builder under /api/share/{token}/videos/{id}", () => {
    expect(streamUrl("v1", SHARE)).toBe("/api/share/tok_abc/videos/v1/stream");
    expect(downloadUrl("v1", SHARE)).toBe("/api/share/tok_abc/videos/v1/download");
    expect(subtitleTrackUrl("v1", "t1", SHARE)).toBe(
      "/api/share/tok_abc/videos/v1/subtitles/t1",
    );
    expect(thumbnailUrl("v1", SHARE)).toBe(
      "/api/share/tok_abc/videos/v1/thumbnail",
    );
  });

  it("encodes token and ids independently", () => {
    const odd = { kind: "share", token: "tok/1" } as const;
    expect(streamUrl("id/2", odd)).toBe(
      "/api/share/tok%2F1/videos/id%2F2/stream",
    );
    expect(subtitleTrackUrl("v1", "track/3", odd)).toBe(
      "/api/share/tok%2F1/videos/v1/subtitles/track%2F3",
    );
  });

  it("explicit owner scope renders the owner route", () => {
    expect(streamUrl("v1", { kind: "owner" })).toBe("/api/videos/v1/stream");
  });
});

describe("fetchers honor the scope", () => {
  it("fetchStreamUrl defaults to the owner stream-url route", async () => {
    const fetchSpy = vi.fn(() =>
      jsonResponse({ url: "/api/videos/v1/stream", strategy: "proxy", expires_at: null }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await fetchStreamUrl("v1");

    expect(lastCall(fetchSpy)).toBe("/api/videos/v1/stream-url");
  });

  it("fetchStreamUrl hits the share mirror when scoped", async () => {
    const fetchSpy = vi.fn(() =>
      jsonResponse({
        url: "/api/share/tok_abc/videos/v1/transcode/master.m3u8",
        strategy: "transcode",
        expires_at: null,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const dto = await fetchStreamUrl("v1", SHARE);

    expect(lastCall(fetchSpy)).toBe("/api/share/tok_abc/videos/v1/stream-url");
    expect(dto.url).toBe("/api/share/tok_abc/videos/v1/transcode/master.m3u8");
  });

  it("fetchSubtitles defaults to the owner route", async () => {
    const fetchSpy = vi.fn(() => jsonResponse([]));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchSubtitles("v1");

    expect(lastCall(fetchSpy)).toBe("/api/videos/v1/subtitles");
  });

  it("fetchSubtitles hits the share mirror when scoped", async () => {
    const fetchSpy = vi.fn(() => jsonResponse([]));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchSubtitles("v1", SHARE);

    expect(lastCall(fetchSpy)).toBe("/api/share/tok_abc/videos/v1/subtitles");
  });
});
