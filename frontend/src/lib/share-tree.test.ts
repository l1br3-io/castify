// Share-tree helper tests (share-folders task 005; search helpers added by
// share-search-ux task 001).
//
// The helpers are pure functions over the one-shot `{ folders, items }`
// payload — everything the landing page renders per level and every
// breadcrumb comes out of one O(n) build. These tests pin the ordering
// contracts (folders by `position`, items in payload order), the
// stale-id fallback (a `?folder=` id the owner deleted renders root,
// never an error), and loop-safety against malformed payloads. The
// search tests pin the whole-share contract: case-insensitive substring
// on names, folder-name matches as folder entries, video-name matches
// as video entries carrying their root→leaf path, empty query as the
// browse-mode signal.

import { describe, expect, it } from "vitest";

import { buildShareTree, searchTree, type ShareTreeItem } from "./share-tree";
import type { ShareFolderDto, ShareItemsDto, VideoSummaryDto } from "../api/types";

function video(id: string): VideoSummaryDto {
  return {
    id,
    name: `${id}.mp4`,
    provider: "google_drive",
    size_bytes: 1024,
    mime_type: "video/mp4",
    duration_ms: 60_000,
    width: 1920,
    height: 1080,
    sources: [],
    created_at: "2026-09-01T00:00:00Z",
    path: null,
    is_favorite: false,
    my_rating: null,
    thumbnail_status: "pending",
    position_seconds: null,
    completed: false,
  };
}

function folder(id: string, parentId: string | null, position: number): ShareFolderDto {
  return { id, parent_id: parentId, name: id, position };
}

function item(id: string, folderId: string | null): ShareTreeItem {
  return { ...video(id), folder_id: folderId };
}

function fixture(): ShareItemsDto {
  return {
    // Deliberately not in position order in the array — the tree sorts
    // per scope; `parent_id` groups before `position` orders.
    folders: [
      folder("f2", null, 1),
      folder("f1", null, 0),
      folder("f1b", "f1", 0),
    ],
    // Payload order per scope is the server's curation order (root
    // items first, then each folder's) — helpers must preserve it.
    items: [item("vA", null), item("vB", null), item("vC", "f1"), item("vD", "f1b")],
  };
}

describe("buildShareTree", () => {
  it("returns root folders in position order regardless of array order", () => {
    const tree = buildShareTree(fixture());
    expect(tree.childFolders(null).map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("returns nested folders scoped to their parent", () => {
    const tree = buildShareTree(fixture());
    expect(tree.childFolders("f1").map((f) => f.id)).toEqual(["f1b"]);
    expect(tree.childFolders("f2")).toEqual([]);
  });

  it("returns each scope's items in payload order", () => {
    const tree = buildShareTree(fixture());
    expect(tree.childItems(null).map((i) => i.id)).toEqual(["vA", "vB"]);
    expect(tree.childItems("f1").map((i) => i.id)).toEqual(["vC"]);
    expect(tree.childItems("f1b").map((i) => i.id)).toEqual(["vD"]);
  });

  it("counts a folder's direct children (subfolders + videos)", () => {
    const tree = buildShareTree(fixture());
    expect(tree.childCount("f1")).toBe(2); // f1b + vC
    expect(tree.childCount("f1b")).toBe(1); // vD
    expect(tree.childCount("f2")).toBe(0);
  });

  it("walks the breadcrumb chain root → … → current", () => {
    const tree = buildShareTree(fixture());
    expect(tree.breadcrumbs("f1b").map((f) => f.id)).toEqual(["f1", "f1b"]);
    expect(tree.breadcrumbs("f1").map((f) => f.id)).toEqual(["f1"]);
  });

  it("falls back to root for a stale or unknown folder id", () => {
    const tree = buildShareTree(fixture());
    expect(tree.resolveFolderId("f1b")).toBe("f1b");
    expect(tree.resolveFolderId("deleted-long-ago")).toBeNull();
    expect(tree.resolveFolderId(null)).toBeNull();
  });

  it("terminates on a malformed cyclic payload instead of hanging", () => {
    // The server enforces acyclicity (repo depth/cycle checks); this is
    // defense in depth for the client — a bad payload must degrade to
    // something renderable, never spin.
    const cyclic: ShareItemsDto = {
      folders: [folder("a", "b", 0), folder("b", "a", 0)],
      items: [],
    };
    const tree = buildShareTree(cyclic);
    expect(() => tree.breadcrumbs("a")).not.toThrow();
    expect(tree.resolveFolderId("a")).toBe("a");
  });

  it("treats the degenerate flat share as an empty root scope", () => {
    const tree = buildShareTree({ folders: [], items: [item("vA", null)] });
    expect(tree.childFolders(null)).toEqual([]);
    expect(tree.childItems(null).map((i) => i.id)).toEqual(["vA"]);
    expect(tree.resolveFolderId(null)).toBeNull();
  });
});

function namedFolder(id: string, name: string, parentId: string | null, position: number): ShareFolderDto {
  return { id, parent_id: parentId, name, position };
}

function namedItem(id: string, name: string, folderId: string | null): ShareTreeItem {
  return { ...video(id), name, folder_id: folderId };
}

// Whole-tree fixture with human names — search reads `name`, unlike the
// browse helpers whose tests key on ids.
//
//   root
//   ├─ Movies (f1)
//   │  └─ Sci-Fi (f1b)
//   │     └─ Dune.mkv (vDeep)
//   ├─ Concerts (f2)
//   │  └─ Live in Berlin.mkv (vLive)
//   ├─ Intro.mkv (vRoot)
//   └─ Extras (f3) / Extras (f3b, nested in f3) — duplicate names
//      └─ Trailer.mk4 in each
function searchFixture(): ShareItemsDto {
  return {
    folders: [
      namedFolder("f1", "Movies", null, 0),
      namedFolder("f2", "Concerts", null, 1),
      namedFolder("f3", "Extras", null, 2),
      namedFolder("f1b", "Sci-Fi", "f1", 0),
      namedFolder("f3b", "Extras", "f3", 0),
    ],
    items: [
      namedItem("vRoot", "Intro.mkv", null),
      namedItem("vDeep", "Dune.mkv", "f1b"),
      namedItem("vLive", "Live in Berlin.mkv", "f2"),
      namedItem("vTrailerA", "Trailer.mp4", "f3"),
      namedItem("vTrailerB", "Trailer.mp4", "f3b"),
    ],
  };
}

describe("searchTree", () => {
  it("finds a video folders-deep from a root search and labels its path", () => {
    const results = searchTree(buildShareTree(searchFixture()), "dune");
    expect(results.videos).toHaveLength(1);
    expect(results.videos[0]!.id).toBe("vDeep");
    expect(results.videos[0]!.folderPath).toEqual(["Movies", "Sci-Fi"]);
  });

  it("matches case-insensitively and by substring", () => {
    const tree = buildShareTree(searchFixture());
    expect(searchTree(tree, "DUNE").videos.map((v) => v.id)).toEqual(["vDeep"]);
    expect(searchTree(tree, "un").videos.map((v) => v.id)).toEqual(["vDeep"]);
  });

  it("returns folder-name matches as folder entries in tree-walk order", () => {
    const results = searchTree(buildShareTree(searchFixture()), "c");
    // DFS from root, `position` order: f1 (no match) → f1b "Sci-Fi" →
    // f2 "Concerts" → f3 (no match). No video name contains "c".
    expect(results.folders.map((f) => f.id)).toEqual(["f1b", "f2"]);
    expect(results.videos).toEqual([]);
  });

  it("orders duplicate-name hits shallower scopes first", () => {
    const results = searchTree(buildShareTree(searchFixture()), "trailer");
    expect(results.folders).toEqual([]);
    expect(results.videos.map((v) => v.id)).toEqual(["vTrailerA", "vTrailerB"]);
  });

  it("distinguishes duplicate names across folders by path", () => {
    const results = searchTree(buildShareTree(searchFixture()), "extras");
    expect(results.folders.map((f) => f.id)).toEqual(["f3", "f3b"]);
  });

  it("gives root-level videos an empty folderPath", () => {
    const results = searchTree(buildShareTree(searchFixture()), "intro");
    expect(results.videos[0]!.folderPath).toEqual([]);
  });

  it("treats empty and whitespace-only queries as browse mode", () => {
    const tree = buildShareTree(searchFixture());
    expect(searchTree(tree, "")).toEqual({ folders: [], videos: [] });
    expect(searchTree(tree, "   ")).toEqual({ folders: [], videos: [] });
  });

  it("searches a flat share with no folders", () => {
    const payload: ShareItemsDto = { folders: [], items: [namedItem("vA", "Solo.mp4", null)] };
    const results = searchTree(buildShareTree(payload), "solo");
    expect(results.videos.map((v) => v.id)).toEqual(["vA"]);
    expect(results.videos[0]!.folderPath).toEqual([]);
  });

  it("returns empty results on an empty share", () => {
    const results = searchTree(buildShareTree({ folders: [], items: [] }), "anything");
    expect(results).toEqual({ folders: [], videos: [] });
  });

  it("skips folders unreachable from the root on a cyclic payload without hanging", () => {
    // Same defense-in-depth stance as `breadcrumbs`: a malformed cycle
    // degrades to "not found" rather than spinning. The cycle members
    // are unreachable from the root scope, so the walk never enters it.
    const cyclic: ShareItemsDto = {
      folders: [namedFolder("a", "Alpha", "b", 0), namedFolder("b", "Beta", "a", 0)],
      items: [namedItem("vLoop", "Looped.mp4", "a")],
    };
    const results = searchTree(buildShareTree(cyclic), "alpha");
    expect(results).toEqual({ folders: [], videos: [] });
  });
});
