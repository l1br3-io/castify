// Collection queries + mutations (library-collections task 008).
//
// Invalidation map: any collection mutation invalidates the list key
// (shape/count changes); rename + membership changes also invalidate the
// specific detail so the page refetches its own row.
//
// Rename is optimistic against both cached shapes (collections-page task
// 004): the list row and the detail are patched in place on mutate so
// the grid updates with no refetch flash, rolled back on error, then
// reconciled by the authoritative refetch on settle.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  collectionsQueryKeys,
  deleteCollection,
  fetchCollection,
  fetchCollections,
  renameCollection,
} from "../api/collections";
import type { CollectionDetailDto, CollectionDto } from "../api/types";

export function useCollections() {
  return useQuery({
    queryKey: collectionsQueryKeys.all,
    queryFn: () => fetchCollections(),
  });
}

export function useCollection(id: string) {
  return useQuery({
    queryKey: collectionsQueryKeys.detail(id),
    queryFn: () => fetchCollection(id),
    enabled: id !== "",
  });
}

export function useRenameCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      renameCollection(id, name),
    onMutate: async ({ id, name }) => {
      // Cancel in-flight list refetches so they don't clobber the patch.
      await queryClient.cancelQueries({
        queryKey: collectionsQueryKeys.all,
      });
      // Snapshot both cached shapes for rollback.
      const listSnapshot = queryClient.getQueryData<CollectionDto[]>(
        collectionsQueryKeys.all,
      );
      const detailSnapshot = queryClient.getQueryData<CollectionDetailDto>(
        collectionsQueryKeys.detail(id),
      );
      // Patch the row in place — the grid updates without a refetch flash.
      queryClient.setQueryData<CollectionDto[]>(collectionsQueryKeys.all, (old) =>
        old?.map((c) => (c.id === id ? { ...c, name } : c)) ?? old,
      );
      queryClient.setQueryData<CollectionDetailDto>(
        collectionsQueryKeys.detail(id),
        (old) => (old ? { ...old, name } : old),
      );
      return { listSnapshot, detailSnapshot };
    },
    onError: (_error, { id }, context) => {
      if (context?.listSnapshot !== undefined) {
        queryClient.setQueryData(
          collectionsQueryKeys.all,
          context.listSnapshot,
        );
      }
      if (context?.detailSnapshot !== undefined) {
        queryClient.setQueryData(
          collectionsQueryKeys.detail(id),
          context.detailSnapshot,
        );
      }
    },
    onSettled: (_data, _error, { id }) => {
      void queryClient.invalidateQueries({ queryKey: collectionsQueryKeys.all });
      void queryClient.invalidateQueries({
        queryKey: collectionsQueryKeys.detail(id),
      });
    },
  });
}

export function useDeleteCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCollection(id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: collectionsQueryKeys.all });
    },
  });
}
