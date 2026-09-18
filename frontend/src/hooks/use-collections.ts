// Collection queries + mutations (library-collections task 008).
//
// Invalidation map: any collection mutation invalidates the list key
// (shape/count changes); rename + membership changes also invalidate the
// specific detail so the page refetches its own row.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  collectionsQueryKeys,
  deleteCollection,
  fetchCollection,
  fetchCollections,
  renameCollection,
} from "../api/collections";

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
