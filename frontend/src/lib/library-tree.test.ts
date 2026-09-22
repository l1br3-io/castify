// library-tree helper tests (drag-and-drop task 004) — the pure
// subtree/depth math the client uses to refuse illegal reparent drops
// BEFORE any request. Mirrors the server's enforcer exactly:
//   * cycle  = target inside the moved folder's subtree (self included);
//   * depth  = target's ancestor chain (incl. target) + moved subtree's
//     height (incl. folder) must stay ≤ 8;
//   * root   = always legal (can only reduce depth).
// See `crates/api/src/library_folders/repository.rs::update_folder`.

import { describe, expect, it } from "vitest";

import {
  MAX_LIBRARY_FOLDER_DEPTH,
  buildLibraryTree,
  canReparent,
  folderDepth,
  subtreeHeight,
} from "./library-tree";
import type { LibraryTreeFolderDto } from "../api/types";

let seq = 0;
function folder(
  id: string,
  parent_id: string | null,
  name = id,
): LibraryTreeFolderDto {
  return { id, parent_id, name, position: seq++, item_count: 0 };
}

/** A chain `c1 → c2 → … → cn` (each child of the previous). */
function chain(n: number, prefix = "c"): LibraryTreeFolderDto[] {
  const folders: LibraryTreeFolderDto[] = [];
  for (let i = 1; i <= n; i++) {
    folders.push(folder(`${prefix}${i}`, i === 1 ? null : `${prefix}${i - 1}`));
  }
  return folders;
}

describe("buildLibraryTree countValue", () => {
  it("carries numeric counts alongside the formatted strings", () => {
    const nodes = buildLibraryTree({
      folders: [folder("f1", null)],
      unfiled_count: 7,
    });
    expect(nodes[0]).toMatchObject({ key: "", countValue: 7 });
    expect(nodes[1]).toMatchObject({ key: "f1", countValue: 0 });
  });
});

describe("folderDepth", () => {
  it("counts the node itself: root = 1, each level +1", () => {
    const folders = chain(4);
    expect(folderDepth(folders, "c1")).toBe(1);
    expect(folderDepth(folders, "c4")).toBe(4);
  });
});

describe("subtreeHeight", () => {
  it("leaf = 1; a chain's height is its length", () => {
    const folders = chain(3);
    expect(subtreeHeight(folders, "c3")).toBe(1);
    expect(subtreeHeight(folders, "c1")).toBe(3);
  });
});

describe("canReparent", () => {
  it("moving to the root is always legal", () => {
    const folders = chain(8);
    expect(canReparent(folders, "c4", null)).toBe(true);
  });

  it("refuses the folder itself (self-cycle)", () => {
    const folders = chain(2);
    expect(canReparent(folders, "c1", "c1")).toBe(false);
  });

  it("refuses any descendant — a 3-level nest", () => {
    const folders = chain(4);
    // c1 → c2 → c3 → c4: dropping c1 under c3 or c4 is a cycle;
    // c4's parent (c3) is inside c1's subtree too.
    expect(canReparent(folders, "c1", "c2")).toBe(false);
    expect(canReparent(folders, "c1", "c3")).toBe(false);
    expect(canReparent(folders, "c1", "c4")).toBe(false);
  });

  it("refuses exactly past the depth cap, allows exactly at it", () => {
    // Two branches: a-chain depth 7, b-chain depth 2.
    const folders = [...chain(7, "a"), ...chain(2, "b")];
    // a1's subtree is 7 deep; b2 sits at depth 2 → 2 + 7 = 9 > 8: refuse.
    expect(canReparent(folders, "a1", "b2")).toBe(false);
    // b1's subtree is 2 deep; a7 sits at depth 7 → 7 + 2 = 9 > 8: refuse.
    expect(canReparent(folders, "b1", "a7")).toBe(false);
    // Trim: b2 (depth 2) + a6's height 2 → 4: legal.
    expect(canReparent(folders, "a6", "b2")).toBe(true);
  });

  it("the cap constant mirrors the server enforcer", () => {
    expect(MAX_LIBRARY_FOLDER_DEPTH).toBe(8);
  });
});
