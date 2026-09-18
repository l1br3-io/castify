// SidebarFolders — the app sidebar's FOLDERS section (the design's frame
// interior carries the folder tree in the sidebar, on the Library view
// only). Owns the `?dir=` tree semantics that used to live in the
// organizer's tree pane: selection via FolderTree, plus the FR-9.2
// unknown-dir fallback (a stale `?dir=` deep link snaps back to the root
// listing once the tree has loaded).
//
// Mounted only on "/" by AppLayout, so no other route pays the tree fetch.

import { useEffect, useMemo } from "react";

import type { FolderNodeDto } from "../api/types";
import { useFolderDir } from "../hooks/use-folder-dir";
import { useFolderTree } from "../hooks/use-folder-tree";
import { FolderTree } from "./folder-tree";
import { Skeleton } from "./ui/skeleton";

/** Every node path in the tree, recursively ("" root included). */
function collectPaths(nodes: FolderNodeDto[]): Set<string> {
  const paths = new Set<string>();
  function walk(list: FolderNodeDto[]): void {
    for (const node of list) {
      paths.add(node.path);
      if (node.children.length > 0) walk(node.children);
    }
  }
  walk(nodes);
  return paths;
}

export function SidebarFolders() {
  const [dir, setDir] = useFolderDir();
  const tree = useFolderTree();

  // FR-9.2: an unknown `?dir=` (stale bookmark, hand-edited URL) falls
  // back to the root listing. Only once the tree is loaded — a pending
  // tree must not clobber a possibly-valid deep link. `replace` — this is
  // a correction of the current entry, not a navigation; pushing would
  // trap Back in a loop (back → bogus dir → push → …).
  const knownPaths = useMemo(
    () => (tree.data ? collectPaths(tree.data) : null),
    [tree.data],
  );
  useEffect(() => {
    if (knownPaths && dir !== "" && !knownPaths.has(dir)) {
      setDir("", { replace: true });
    }
  }, [dir, knownPaths, setDir]);

  return (
    <div className="mt-4 border-t border-[var(--color-castify-rule)] pt-3">
      <p className="eyebrow px-2.5 pb-1.5">Folders</p>
      {tree.isLoading && (
        <div className="px-2 pt-1">
          <Skeleton className="h-32 w-full" />
        </div>
      )}
      {tree.isError && (
        <p className="px-2.5 text-xs text-[var(--color-castify-muted)]">
          Couldn't load folders.
        </p>
      )}
      {tree.data && (
        <FolderTree
          nodes={tree.data}
          selectedPath={dir}
          onSelect={(path) => setDir(path)}
        />
      )}
    </div>
  );
}
