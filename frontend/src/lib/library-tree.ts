// Flat→nested tree building for the curated library tree
// (library-folders task 005).
//
// The server ships the curated tree as one flat, `(parent_id, position)`
// ordered list — one fetch, cumulative counts included. This module
// turns it into the nested `TreeNode` shape `FolderTree` renders, with
// the pinned Unfiled node first.

import type { TreeNode } from "../components/folder-tree";
import type { LibraryTreeDto, LibraryTreeFolderDto } from "../api/types";

/**
 * GOTCHA: duplicated from the server enforcer —
 * `crates/api/src/library_folders/repository.rs::MAX_FOLDER_DEPTH`.
 * The server is the backstop (its 4xx surfaces like dialog errors);
 * this client copy only pre-renders the invalid state so illegal drops
 * never leave the browser. Change both together.
 */
export const MAX_LIBRARY_FOLDER_DEPTH = 8;

function itemCount(n: number): string {
  if (n <= 0) return "";
  return `${n} item${n === 1 ? "" : "s"}`;
}

/** Group the flat folder list by parent, each sibling group in
 *  `position` order. */
function groupByParent(folders: LibraryTreeFolderDto[]): Map<
  string | null,
  LibraryTreeFolderDto[]
> {
  const byParent = new Map<string | null, LibraryTreeFolderDto[]>();
  for (const folder of folders) {
    const group = byParent.get(folder.parent_id) ?? [];
    group.push(folder);
    byParent.set(folder.parent_id, group);
  }
  // The server already orders by (parent_id, position); the explicit
  // sort pins the contract against future payload changes.
  for (const group of byParent.values()) {
    group.sort((a, b) => a.position - b.position);
  }
  return byParent;
}

/** The folder's depth counting itself (root-level folder = 1) — the
 *  client mirror of the server's `ancestor_chain_len`. */
export function folderDepth(
  folders: LibraryTreeFolderDto[],
  folderId: string,
): number {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let depth = 0;
  let cursor: string | null = folderId;
  while (cursor !== null) {
    depth += 1;
    cursor = byId.get(cursor)?.parent_id ?? null;
  }
  return depth;
}

/** The subtree's height counting the folder itself (a leaf = 1) — the
 *  client mirror of the server's `subtree_height`. */
export function subtreeHeight(
  folders: LibraryTreeFolderDto[],
  folderId: string,
): number {
  const childrenOf = groupByParent(folders);
  function height(id: string): number {
    const kids = childrenOf.get(id) ?? [];
    if (kids.length === 0) return 1;
    return 1 + Math.max(...kids.map((kid) => height(kid.id)));
  }
  return height(folderId);
}

/**
 * May `folderId` be reparented under `targetId` (null = tree root)?
 * Mirrors `update_folder`'s guards: the target must not live inside the
 * moved folder's own subtree (self included — one rule covers both),
 * and the combined depth (target's chain + subtree height) must stay
 * within the cap. Root moves can only reduce depth — always legal.
 */
export function canReparent(
  folders: LibraryTreeFolderDto[],
  folderId: string,
  targetId: string | null,
): boolean {
  if (targetId === null) return true;
  // Cycle: target inside the moved subtree, or the folder onto itself.
  const childrenOf = groupByParent(folders);
  const stack = [folderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === targetId) return false;
    stack.push(...(childrenOf.get(id) ?? []).map((kid) => kid.id));
  }
  return (
    folderDepth(folders, targetId) + subtreeHeight(folders, folderId) <=
    MAX_LIBRARY_FOLDER_DEPTH
  );
}

/** The curated tree as `FolderTree` nodes: the pinned Unfiled virtual
 *  node first (its live count), then the owner's folders in curation
 *  order with cumulative counts. Folder-id keys — the `?folder=` URL
 *  param values. */
export function buildLibraryTree(tree: LibraryTreeDto): TreeNode[] {
  const byParent = groupByParent(tree.folders);
  function build(parent: string | null): TreeNode[] {
    return (byParent.get(parent) ?? []).map((folder) => ({
      key: folder.id,
      label: folder.name,
      count: itemCount(folder.item_count),
      // Numeric twin of `count` — the drop-hover preview steps it to its
      // post-drop value (drag-and-drop task 003).
      countValue: folder.item_count,
      children: build(folder.id),
    }));
  }
  return [
    {
      key: "",
      label: "Unfiled",
      count: itemCount(tree.unfiled_count),
      countValue: tree.unfiled_count,
      children: [],
    },
    ...build(null),
  ];
}
