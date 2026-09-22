// Flat→nested tree building for the curated library tree
// (library-folders task 005).
//
// The server ships the curated tree as one flat, `(parent_id, position)`
// ordered list — one fetch, cumulative counts included. This module
// turns it into the nested `TreeNode` shape `FolderTree` renders, with
// the pinned Unfiled node first.

import type { TreeNode } from "../components/folder-tree";
import type { LibraryTreeDto, LibraryTreeFolderDto } from "../api/types";

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
