// `useLibraryFolders` — the curated tree query, placement mutations,
// contents query, and the `?folder=` URL param (library-folders effort).
//
// Invalidation map: every mutation invalidates the tree key AND the
// contents family — the server owns the tree and the counts, so a
// settled mutation always reconciles through refetch (no optimistic
// placement caching to roll back).
//
// `useLibraryFolderParam` owns the browse route's `?folder=` state:
// `?folder=<id>` selects a curated folder; absent, empty, or `none`
// selects the pinned Unfiled node (the default). Selections PUSH a
// history entry (file-browser mental model, matching `useFolderDir`);
// `{ replace: true }` is for corrections (stale-folder fallback).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import {
  createLibraryFolder,
  deleteLibraryFolder,
  fetchLibraryFolderContents,
  fetchLibraryFolderTree,
  moveLibraryItems,
  reorderLibraryFolders,
  reorderLibraryItems,
  updateLibraryFolder,
} from "../api/library-folders";
import type { LibraryMoveItem } from "../api/library-folders";
import type { LibraryContentsParams } from "../api/library-folders";

export const libraryFolderKeys = {
  all: ["library-folders"] as const,
  tree: () => [...libraryFolderKeys.all, "tree"] as const,
  contents: (params: LibraryContentsParams) =>
    [...libraryFolderKeys.all, "contents", params] as const,
};

export function useLibraryFolderTree() {
  return useQuery({
    queryKey: libraryFolderKeys.tree(),
    queryFn: fetchLibraryFolderTree,
  });
}

export function useLibraryFolderContents(params: LibraryContentsParams) {
  return useQuery({
    queryKey: libraryFolderKeys.contents(params),
    queryFn: () => fetchLibraryFolderContents(params),
  });
}

/** Invalidate everything a folder/placement mutation can change. */
function useInvalidateLibraryFolders() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: libraryFolderKeys.all });
  };
}

export function useCreateLibraryFolder() {
  const invalidate = useInvalidateLibraryFolders();
  return useMutation({
    mutationFn: ({ name, parentId }: { name: string; parentId?: string }) =>
      createLibraryFolder(name, parentId),
    onSettled: invalidate,
  });
}

export function useUpdateLibraryFolder() {
  const invalidate = useInvalidateLibraryFolders();
  return useMutation({
    mutationFn: ({
      id,
      name,
      parentId,
    }: {
      id: string;
      name?: string;
      parentId?: string | null;
    }) => {
      const patch: { name?: string; parent_id?: string | null } = {};
      if (name !== undefined) patch.name = name;
      if (parentId !== undefined) patch.parent_id = parentId;
      return updateLibraryFolder(id, patch);
    },
    onSettled: invalidate,
  });
}

export function useDeleteLibraryFolder() {
  const invalidate = useInvalidateLibraryFolders();
  return useMutation({
    mutationFn: (id: string) => deleteLibraryFolder(id),
    onSettled: invalidate,
  });
}

export function useMoveLibraryItems() {
  const invalidate = useInvalidateLibraryFolders();
  return useMutation({
    mutationFn: ({
      items,
      folderId,
    }: {
      items: LibraryMoveItem[];
      folderId: string | null;
    }) => moveLibraryItems(items, folderId),
    onSettled: invalidate,
  });
}

export function useReorderLibraryItems() {
  const invalidate = useInvalidateLibraryFolders();
  return useMutation({
    mutationFn: ({
      folderId,
      items,
    }: {
      folderId: string | null;
      items: LibraryMoveItem[];
    }) => reorderLibraryItems(folderId, items),
    onSettled: invalidate,
  });
}

export function useReorderLibraryFolders() {
  const invalidate = useInvalidateLibraryFolders();
  return useMutation({
    mutationFn: ({
      parentId,
      folderIds,
    }: {
      parentId: string | null;
      folderIds: string[];
    }) => reorderLibraryFolders(parentId, folderIds),
    onSettled: invalidate,
  });
}

/**
 * The organizer's selected curated folder, URL-backed. Returns the
 * folder id or `null` for the Unfiled selection, plus a setter that
 * pushes history entries (or replaces, for corrections).
 */
export function useLibraryFolderParam(): [
  string | null,
  (next: string | null, options?: { replace?: boolean }) => void,
] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("folder");
  const folder = raw === null || raw === "" || raw === "none" ? null : raw;

  function setFolder(
    next: string | null,
    options?: { replace?: boolean },
  ): void {
    const params = new URLSearchParams(searchParams);
    if (next === null) {
      params.delete("folder");
    } else {
      params.set("folder", next);
    }
    setSearchParams(params, options?.replace ? { replace: true } : undefined);
  }

  return [folder, setFolder];
}

/**
 * The browse route's two-tree navigation state — the single mode rule
 * (documented atop `sidebar-folders.tsx`), shared by the sidebar and the
 * organizer:
 *
 *   * `?dir=` present (even empty) → provider mode; its value selects
 *     the provider node ("" = provider root).
 *   * otherwise → curated mode; `?folder=<id>` selects a curated
 *     folder, absent/empty/`none` selects Unfiled (the default).
 *   * Selecting in either tree clears the other's param — one atomic
 *     write per selection (two single-param setters would clobber each
 *     other from the same render's stale snapshot).
 */
export function useLibraryFolderNav() {
  const [searchParams, setSearchParams] = useSearchParams();

  const rawFolder = searchParams.get("folder");
  const selectedFolder =
    rawFolder === null || rawFolder === "" || rawFolder === "none"
      ? null
      : rawFolder;
  const providerMode = searchParams.has("dir");
  const selectedDir = searchParams.get("dir") ?? "";

  function navigateWith(
    mutate: (params: URLSearchParams) => void,
    options?: { replace?: boolean },
  ): void {
    const params = new URLSearchParams(searchParams);
    mutate(params);
    setSearchParams(params, options?.replace ? { replace: true } : undefined);
  }

  /** `null` selects Unfiled (the curated root view). */
  const selectCurated = (id: string | null, options?: { replace?: boolean }) =>
    navigateWith((params) => {
      params.delete("dir");
      if (id === null) {
        params.delete("folder");
      } else {
        params.set("folder", id);
      }
    }, options);

  /** Always sets `dir` (even to "") — an absent `dir` is the curated
   *  default, so the provider root must keep the param to stay
   *  reachable. */
  const selectProvider = (path: string, options?: { replace?: boolean }) =>
    navigateWith((params) => {
      params.delete("folder");
      params.set("dir", path);
    }, options);

  return { selectedFolder, providerMode, selectedDir, selectCurated, selectProvider };
}
