// Fetcher URL + body construction for the library-folders API
// (library-folders task 004).
//
// Asserts the exact query strings / request bodies the client fns build —
// they are the deep-link and wire surface: a stray param or an always-set
// `parent_id` key changes what the server does (absent vs null is the
// don't-move vs move-to-root distinction on PATCH).

import { describe, expect, it, vi } from "vitest";

import {
  createLibraryFolder,
  deleteLibraryFolder,
  fetchLibraryFolderContents,
  fetchLibraryFolderTree,
  moveLibraryItems,
  updateLibraryFolder,
} from "./library-folders";
import { jsonResponse } from "../test/utils";

function lastCall(fetchSpy: ReturnType<typeof vi.fn>): { url: string; init?: RequestInit } {
  const [input, init] = fetchSpy.mock.calls.at(-1)!;
  return { url: input.toString(), init };
}

const TREE = { folders: [], unfiled_count: 0 };

describe("library-folders API", () => {
  it("fetchLibraryFolderTree hits the bare tree endpoint", async () => {
    const fetchSpy = vi.fn(() => jsonResponse(TREE));
    vi.stubGlobal("fetch", fetchSpy);

    const tree = await fetchLibraryFolderTree();

    expect(lastCall(fetchSpy).url).toBe("/api/library-folders/tree");
    expect(tree).toEqual(TREE);
  });

  it("fetchLibraryFolderContents sends folder_id only when present, plus filters", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ entries: [], total: 0, page: 1, limit: 50 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchLibraryFolderContents({ folder_id: "f1", kind: "video", q: "trip" });

    const url = new URL(lastCall(fetchSpy).url, "http://x");
    expect(url.pathname).toBe("/api/library-folders/contents");
    expect(url.searchParams.get("folder_id")).toBe("f1");
    expect(url.searchParams.get("kind")).toBe("video");
    expect(url.searchParams.get("q")).toBe("trip");
    expect(url.searchParams.has("page")).toBe(false);
  });

  it("fetchLibraryFolderContents without folder_id hits the Unfiled bucket", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ entries: [], total: 0, page: 2, limit: 10 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchLibraryFolderContents({ page: 2, limit: 10 });

    const url = new URL(lastCall(fetchSpy).url, "http://x");
    expect(url.pathname).toBe("/api/library-folders/contents");
    expect(url.searchParams.has("folder_id")).toBe(false);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("createLibraryFolder POSTs name and omits absent parent_id", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ id: "f1", parent_id: null, name: "Trip", position: 0 }));
    vi.stubGlobal("fetch", fetchSpy);

    await createLibraryFolder("Trip");

    const { url, init } = lastCall(fetchSpy);
    expect(url).toBe("/api/library-folders");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Trip" });
  });

  it("createLibraryFolder includes parent_id when given", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ id: "f2", parent_id: "f1", name: "Day 1", position: 0 }));
    vi.stubGlobal("fetch", fetchSpy);

    await createLibraryFolder("Day 1", "f1");

    const { init } = lastCall(fetchSpy);
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Day 1", parent_id: "f1" });
  });

  it("updateLibraryFolder PATCHes only the keys the caller set", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ id: "f1", parent_id: null, name: "Renamed", position: 0 }));
    vi.stubGlobal("fetch", fetchSpy);

    await updateLibraryFolder("f1", { name: "Renamed" });

    const { url, init } = lastCall(fetchSpy);
    expect(url).toBe("/api/library-folders/f1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Renamed" });
  });

  it("updateLibraryFolder sends parent_id null (not absent) for move-to-root", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ id: "f1", parent_id: null, name: "x", position: 2 }));
    vi.stubGlobal("fetch", fetchSpy);

    await updateLibraryFolder("f1", { parent_id: null });

    const { init } = lastCall(fetchSpy);
    expect(JSON.parse(String(init?.body))).toEqual({ parent_id: null });
  });

  it("deleteLibraryFolder DELETEs the folder", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await deleteLibraryFolder("f1");

    const { url, init } = lastCall(fetchSpy);
    expect(url).toBe("/api/library-folders/f1");
    expect(init?.method).toBe("DELETE");
  });

  it("moveLibraryItems PATCHes the batch with folder_id null for Unfiled", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await moveLibraryItems(
      [
        { kind: "video", id: "v1" },
        { kind: "file", id: "x1" },
      ],
      null,
    );

    const { url, init } = lastCall(fetchSpy);
    expect(url).toBe("/api/library-folders/items");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [
        { kind: "video", id: "v1" },
        { kind: "file", id: "x1" },
      ],
      folder_id: null,
    });
  });

  it("moveLibraryItems sends the target folder id", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await moveLibraryItems([{ kind: "video", id: "v1" }], "f9");

    const { init } = lastCall(fetchSpy);
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [{ kind: "video", id: "v1" }],
      folder_id: "f9",
    });
  });
});
