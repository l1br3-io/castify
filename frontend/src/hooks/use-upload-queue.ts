// `useUploadQueue` (drag-and-drop task 012) — the sequential upload
// queue: one file in flight, per-file progress/cancel/retry, a summary
// toast when the batch settles. Queue state is deliberately CLIENT
// ONLY (docs/data-storage-principles.md: progress is ephemeral UI
// state — never server-side, no upload history table).

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { uploadFile, type UploadTask } from "../api/uploads";
import { libraryFolderKeys } from "./use-library-folders";
import { useToast } from "./use-toast";

export type UploadStatus = "queued" | "uploading" | "done" | "error" | "cancelled";

export interface UploadEntry {
  /** Client-side id (name+index — names repeat in one batch). */
  key: string;
  file: File;
  status: UploadStatus;
  progress: { loaded: number; total: number } | null;
  error: string | null;
}

export interface UploadQueue {
  entries: UploadEntry[];
  /** Enqueue a batch for one destination and start the pump. */
  start: (files: File[], connectionId: string, dir: string) => void;
  cancelOne: (key: string) => void;
  cancelAll: () => void;
  /** Re-queue a failed entry at the end of the line. */
  retry: (key: string) => void;
  dismiss: () => void;
}

export function useUploadQueue(): UploadQueue {
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const [destination, setDestination] = useState<{
    connectionId: string;
    dir: string;
  } | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();

  const inFlightRef = useRef<UploadTask | null>(null);
  // The batch summary fires once per settled batch, not per effect run.
  const announcedRef = useRef(false);

  const patch = useCallback((key: string, fields: Partial<UploadEntry>) => {
    setEntries((prev) =>
      prev.map((entry) => (entry.key === key ? { ...entry, ...fields } : entry)),
    );
  }, []);

  // The pump: whenever no entry is uploading and a queued one waits,
  // start it. One in flight — sequential by design (the destination is
  // one connection; parallel uploads would fight its rate limits).
  useEffect(() => {
    const uploading = entries.some((entry) => entry.status === "uploading");
    if (uploading || destination === null) return;
    const next = entries.find((entry) => entry.status === "queued");
    if (next !== undefined) {
      patch(next.key, {
        status: "uploading",
        progress: { loaded: 0, total: next.file.size },
      });
      const task = uploadFile(
        next.file,
        destination.connectionId,
        destination.dir,
        (progress) => patch(next.key, { progress }),
      );
      inFlightRef.current = task;
      void task.promise
        .then(() => {
          patch(next.key, { status: "done", error: null });
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") {
            patch(next.key, { status: "cancelled" });
          } else {
            patch(next.key, {
              status: "error",
              error: error instanceof Error ? error.message : "Upload failed.",
            });
          }
        })
        .finally(() => {
          inFlightRef.current = null;
        });
      return;
    }
    // No queued, none uploading: the batch settled.
    if (entries.length > 0 && !announcedRef.current) {
      announcedRef.current = true;
      const done = entries.filter((entry) => entry.status === "done").length;
      if (done > 0) {
        toast.success(`Uploaded ${done} ${done === 1 ? "file" : "files"}`);
        // The scans the uploads kicked reconcile the library: tree +
        // contents refetch so Unfiled picks the files up.
        void queryClient.invalidateQueries({ queryKey: libraryFolderKeys.all });
        void queryClient.invalidateQueries({ queryKey: ["folder-tree"] });
      }
    }
  }, [entries, destination, patch, toast, queryClient]);

  const start = useCallback(
    (files: File[], connectionId: string, dir: string) => {
      announcedRef.current = false;
      setDestination({ connectionId, dir });
      setEntries((prev) => [
        ...prev,
        ...files.map((file, index) => ({
          key: `${file.name}#${Date.now()}-${index}`,
          file,
          status: "queued" as const,
          progress: null,
          error: null,
        })),
      ]);
    },
    [],
  );

  const cancelOne = useCallback((key: string) => {
    setEntries((prev) =>
      prev.map((entry) => {
        if (entry.key !== key) return entry;
        if (entry.status === "uploading") {
          inFlightRef.current?.abort();
          return entry;
        }
        if (entry.status === "queued") {
          return { ...entry, status: "cancelled" as const };
        }
        return entry;
      }),
    );
  }, []);

  const cancelAll = useCallback(() => {
    inFlightRef.current?.abort();
    setEntries((prev) =>
      prev.map((entry) =>
        entry.status === "queued" || entry.status === "uploading"
          ? { ...entry, status: "cancelled" }
          : entry,
      ),
    );
  }, []);

  const retry = useCallback((key: string) => {
    announcedRef.current = false;
    patch(key, { status: "queued", progress: null, error: null });
  }, [patch]);

  const dismiss = useCallback(() => {
    if (inFlightRef.current !== null) return; // never yank a live batch
    setEntries([]);
    setDestination(null);
  }, []);

  return { entries, start, cancelOne, cancelAll, retry, dismiss };
}
