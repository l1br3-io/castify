// SidebarFolders — the app sidebar's FOLDERS section (the design's frame
// interior carries the folder tree in the sidebar, on the Library view
// only). Upgraded by the library-folders effort: the **curated** tree is
// primary (Unfiled pinned first with its live count), the auto-detected
// provider tree demoted to a secondary "Cloud" toggle.
//
// MODE DERIVATION — the single rule the browse route follows:
//   * `?dir=` present (even empty) → provider mode; its value selects
//     the provider node ("" = provider root).
//   * otherwise → curated mode (the default); `?folder=<id>` selects a
//     curated folder, and absent/empty/`none` selects Unfiled.
//   * Selecting in either tree CLEARS the other tree's param — the two
//     params never mix.
//   * Provider selection always sets `dir` (even to ""), because an
//     absent `dir` is the curated default — provider root must stay
//     reachable.
//
// Stale deep links fall back once the relevant tree loads (the FR-9.2
// pattern, `replace: true` so Back isn't trapped): an unknown `?dir=`
// snaps to the provider root; an unknown `?folder=` snaps to Unfiled.
// A `?dir=` deep link also opens the Cloud section so the link lands on
// the view it named.
//
// Mounted only on "/" by AppLayout, so no other route pays the fetches.

import { useEffect, useMemo, useState } from "react";

import type { FolderNodeDto } from "../api/types";
import { useFolderTree } from "../hooks/use-folder-tree";
import { useLibraryFolderNav, useLibraryFolderTree } from "../hooks/use-library-folders";
import { FolderTree, type TreeNode } from "./folder-tree";
import { buildLibraryTree } from "../lib/library-tree";
import { Skeleton } from "./ui/skeleton";

/** Every node path in the provider tree, recursively ("" root included). */
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

/** Provider `FolderNodeDto` tree → generic nodes, counts formatted
 *  exactly as the pre-library-folders sidebar rendered them. */
function toProviderNodes(nodes: FolderNodeDto[]): TreeNode[] {
  return nodes.map((node) => ({
    key: node.path,
    label: node.name,
    count: [
      node.video_count > 0 ? `${node.video_count} videos` : null,
      node.file_count > 0 ? `${node.file_count} files` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    children: toProviderNodes(node.children),
  }));
}

type SidebarFoldersProps = {
  /** Wired to the create flow by the organizer CRUD task; the empty
   *  tree's "New folder" entry point calls it when present. */
  onNewFolder?: () => void;
};

export function SidebarFolders({ onNewFolder }: SidebarFoldersProps = {}) {
  const {
    selectedFolder,
    providerMode,
    selectedDir,
    selectCurated,
    selectProvider,
  } = useLibraryFolderNav();
  const libraryTree = useLibraryFolderTree();
  const providerTree = useFolderTree();
  const [cloudOpen, setCloudOpen] = useState(false);

  // A provider deep link opens the Cloud section — the link names the
  // view it should land on.
  useEffect(() => {
    if (providerMode) setCloudOpen(true);
  }, [providerMode]);

  const curatedNodes = useMemo(
    () => (libraryTree.data ? buildLibraryTree(libraryTree.data) : null),
    [libraryTree.data],
  );

  // Stale `?folder=` (deleted folder, hand-edited URL) snaps back to the
  // Unfiled selection once the tree loads — only then, so a pending tree
  // can't clobber a possibly-valid deep link. `replace` — a correction,
  // not a navigation.
  useEffect(() => {
    if (!curatedNodes || selectedFolder === null) return;
    const known = new Set(
      libraryTree.data!.folders.map((folder) => folder.id),
    );
    if (!known.has(selectedFolder)) {
      selectCurated(null, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curatedNodes, selectedFolder]);

  // FR-9.2: an unknown `?dir=` falls back to the provider root — staying
  // in provider mode (`?dir=` kept, emptied), same replace semantics.
  const knownPaths = useMemo(
    () => (providerTree.data ? collectPaths(providerTree.data) : null),
    [providerTree.data],
  );
  useEffect(() => {
    if (knownPaths && providerMode && selectedDir !== "" && !knownPaths.has(selectedDir)) {
      selectProvider("", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownPaths, providerMode, selectedDir]);

  const emptyCurated = curatedNodes !== null && curatedNodes.length <= 1;

  return (
    <div className="mt-4 border-t border-[var(--color-castify-rule)] pt-3">
      <p className="eyebrow px-2.5 pb-1.5">Folders</p>
      {libraryTree.isLoading && (
        <div className="px-2 pt-1">
          <Skeleton className="h-32 w-full" />
        </div>
      )}
      {libraryTree.isError && (
        <p className="px-2.5 text-xs text-[var(--color-castify-muted)]">
          Couldn't load folders.
        </p>
      )}
      {curatedNodes && (
        <>
          <FolderTree
            ariaLabel="Library folders"
            nodes={curatedNodes}
            selectedKey={selectedFolder ?? ""}
            onSelect={(key) => selectCurated(key === "" ? null : key)}
          />
          {emptyCurated && (
            <div className="px-2 pt-1.5">
              <button
                type="button"
                onClick={() => onNewFolder?.()}
                className="w-full rounded border border-dashed border-[var(--color-castify-rule)] px-2 py-1.5 text-left text-[13px] text-[var(--color-castify-muted)] transition hover:border-[var(--color-castify-accent)] hover:text-[var(--color-castify-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
              >
                + New folder
              </button>
            </div>
          )}
        </>
      )}

      <div className="mt-2">
        <button
          type="button"
          onClick={() => setCloudOpen((open) => !open)}
          aria-expanded={cloudOpen}
          className="flex w-full items-center gap-1 rounded px-2.5 py-1.5 text-left text-[13px] text-[var(--color-castify-muted)] transition hover:bg-[var(--color-castify-hover)] hover:text-[var(--color-castify-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
        >
          <span aria-hidden className="text-xs">
            {cloudOpen ? "▾" : "▸"}
          </span>
          Cloud
        </button>
        {cloudOpen && (
          <div className="pt-0.5">
            {providerTree.isLoading && (
              <div className="px-2 pt-1">
                <Skeleton className="h-24 w-full" />
              </div>
            )}
            {providerTree.isError && (
              <p className="px-2.5 text-xs text-[var(--color-castify-muted)]">
                Couldn't load cloud folders.
              </p>
            )}
            {providerTree.data && (
              <FolderTree
                ariaLabel="Cloud folders"
                nodes={toProviderNodes(providerTree.data)}
                selectedKey={selectedDir}
                onSelect={(key) => selectProvider(key)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
