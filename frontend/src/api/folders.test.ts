// Fetcher URL construction for the folder organizer API (M9 task 009).
//
// Asserts the exact query strings `fetchFolderTree` /
// `fetchFolderContents` build (params are the deep-link surface — a stray
// or missing param changes what the server returns) and the shape of the
// parsed response.

import { describe, expect, it, vi } from "vitest";

import {
  fetchFolderContents,
  fetchFolderTree,
  fileDownloadUrl,
} from "./folders";
import { jsonResponse } from "../test/utils";

function lastCall(fetchSpy: ReturnType<typeof vi.fn>): string {
  const input = fetchSpy.mock.calls.at(-1)![0] as RequestInfo | URL;
  return input.toString();
}

describe("folders API", () => {
  it("fetchFolderTree hits /api/folders/tree with no params", async () => {
    const fetchSpy = vi.fn(() => jsonResponse([]));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchFolderTree();

    expect(lastCall(fetchSpy)).toBe("/api/folders/tree");
  });

  it("fetchFolderContents builds the query from non-empty params only", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ entries: [], total: 0, page: 1, limit: 50 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchFolderContents({ path: "/Movies", page: 2, kind: "video" });

    const url = new URL(lastCall(fetchSpy), "http://x");
    expect(url.pathname).toBe("/api/folders/contents");
    expect(url.searchParams.get("path")).toBe("/Movies");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("kind")).toBe("video");
    expect(url.searchParams.has("provider")).toBe(false);
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("limit")).toBe(false);
  });

  it("fetchFolderContents encodes paths with special characters", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ entries: [], total: 0, page: 1, limit: 50 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchFolderContents({ path: "/Sci-fi/Season 1" });

    const url = new URL(lastCall(fetchSpy), "http://x");
    expect(url.searchParams.get("path")).toBe("/Sci-fi/Season 1");
  });

  it("fetchFolderContents with no params hits the bare endpoint", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ entries: [], total: 0, page: 1, limit: 50 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchFolderContents();

    expect(lastCall(fetchSpy)).toBe("/api/folders/contents");
  });

  it("fileDownloadUrl encodes the id", () => {
    expect(fileDownloadUrl("abc")).toBe("/api/files/abc/download");
    expect(fileDownloadUrl("id/with/slash")).toBe(
      "/api/files/id%2Fwith%2Fslash/download",
    );
  });
});
