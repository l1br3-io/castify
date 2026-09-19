// Share-tree helper tests (share-folders task 005).
//
// The helpers are pure functions over the one-shot `{ folders, items }`
// payload — everything the landing page renders per level and every
// breadcrumb comes out of one O(n) build. These tests pin the ordering
// contracts (folders by `position`, items in payload order), the
// stale-id fallback (a `?folder=` id the owner deleted renders root,
// never an error), and loop-safety against malformed payloads.

import { describe, expect, it } from "vitest";

import { buildShareTree, type ShareTreeItem } from "./share-tree";
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
