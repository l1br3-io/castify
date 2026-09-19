// Share-tree helpers (share-folders task 005) — pure functions over the
// one-shot `{ folders, items }` payload both items reads serve.
//
// The recipient landing page is a mini file manager driven entirely by
// client state: one items fetch carries the whole tree, descending is a
// `?folder=` URL param, and this module answers every per-level question
// from indexes built once (O(n) over the payload — memoized on payload
// identity by the caller via `useMemo`, never rebuilt per render):
//
//   * `childFolders(scope)` — direct subfolders, `position` order
//   * `childItems(scope)`   — direct member videos, payload order (the
//     server's per-scope curation order)
//   * `childCount(folderId)` — direct children (subfolders + videos),
//     the tile's badge
//   * `breadcrumbs(folderId)` — root → … → current chain, an O(depth)
//     parent walk over a by-id map
//   * `resolveFolderId(raw)` — stale-id fallback: an id the owner
//     deleted resolves to root (null), never an error state
//
// Scope is `parent_id`/`folder_id`: `null` is the share root. The server
// guarantees acyclicity (repo depth/cycle checks, cap 8); the walks here
// still carry a visited guard so a malformed payload degrades to
// something renderable instead of hanging.

import type { ShareFolderDto, ShareItemsDto, VideoSummaryDto } from "../api/types";

/** One member item in the tree payload — `VideoSummaryDto` plus its
 * folder placement (`null` = share root). */
export type ShareTreeItem = VideoSummaryDto & { folder_id: string | null };

export interface ShareTree {
  /** Direct subfolders of a scope (`null` = root), `position` order. */
  childFolders(parentId: string | null): ShareFolderDto[];
  /** Direct member videos of a scope, payload (curation) order. */
  childItems(parentId: string | null): ShareTreeItem[];
  /** Direct children of a folder — subfolders + videos. */
  childCount(folderId: string): number;
  /** Root → … → `folderId` chain, inclusive of `folderId` itself. */
  breadcrumbs(folderId: string): ShareFolderDto[];
  /** `folderId` when it exists in this tree, else `null` (root) — the
   * stale `?folder=` deep-link fallback. */
  resolveFolderId(folderId: string | null): string | null;
}

export function buildShareTree(payload: ShareItemsDto): ShareTree {
  const foldersByParent = new Map<string | null, ShareFolderDto[]>();
  const foldersById = new Map<string, ShareFolderDto>();
  for (const folder of payload.folders) {
    foldersById.set(folder.id, folder);
    const siblings = foldersByParent.get(folder.parent_id) ?? [];
    siblings.push(folder);
    foldersByParent.set(folder.parent_id, siblings);
  }
  // `position` orders siblings within a scope; ties (a torn write)
  // fall back to insertion order via the stable sort.
  for (const siblings of foldersByParent.values()) {
    siblings.sort((a, b) => a.position - b.position);
  }

  const itemsByFolder = new Map<string | null, ShareTreeItem[]>();
  for (const item of payload.items as ShareTreeItem[]) {
    const members = itemsByFolder.get(item.folder_id) ?? [];
    members.push(item);
    itemsByFolder.set(item.folder_id, members);
  }

  return {
    childFolders: (parentId) => foldersByParent.get(parentId) ?? [],
    childItems: (parentId) => itemsByFolder.get(parentId) ?? [],
    childCount: (folderId) =>
      (foldersByParent.get(folderId)?.length ?? 0) + (itemsByFolder.get(folderId)?.length ?? 0),
    breadcrumbs(folderId) {
      const chain: ShareFolderDto[] = [];
      const visited = new Set<string>();
      let current = foldersById.get(folderId);
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        chain.unshift(current);
        current = current.parent_id === null ? undefined : foldersById.get(current.parent_id);
      }
      return chain;
    },
    resolveFolderId: (folderId) => (folderId !== null && foldersById.has(folderId) ? folderId : null),
  };
}
