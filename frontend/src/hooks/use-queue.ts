// `useQueue` — ephemeral session-scoped play queue (PRD FR-10).
//
// Reads the sibling video IDs from `location.state.queue` (populated by
// PosterCard / Shelf click navigation) and the current
// `:id` route param, derives the queue position, and exposes navigation
// helpers that preserve the queue across skips.
//
// Skip navigation uses `navigate(/watch/:id, { state: { queue } })` (a new
// history entry, not `replace`). Each skip is a full page remount —
// `useVideoDetail` + `usePlaybackTracking` re-initialize cleanly for the new
// video, and the browser back button walks the queue history. Auto-advance
// (T11) uses the same `goToNext` entry point.
//
// The queue is NOT persisted. Reloading `/watch/:id` (no router state) or
// arriving via a shared link starts with no queue — skip controls and the
// UpNext panel are hidden. This satisfies PRD FR-10.5 ("reloading
// `/watch/:id` without router state starts with no queue").

import { useCallback } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

export interface UseQueue {
  /** The sibling video IDs (empty when no queue context). */
  queue: string[];
  /** Index of the current `:id` within `queue`, or -1 when not found / no queue. */
  currentIndex: number;
  /** Whether any queue state is present. */
  hasQueue: boolean;
  /** Whether `goToPrev` will navigate (currently past queue start). */
  hasPrev: boolean;
  /** Whether `goToNext` will navigate (currently before queue end). */
  hasNext: boolean;
  /** Navigate to the previous queue entry. No-op when `!hasPrev`. */
  goToPrev: () => void;
  /** Navigate to the next queue entry. No-op when `!hasNext`. */
  goToNext: () => void;
  /** Navigate to an arbitrary queue index. No-op when out of range. */
  goToIndex: (index: number) => void;
}

/**
 * Read the `queue` array from `location.state`. Defensive against malformed
 * state (non-array queue, wrong element type) — returns `[]` in those cases
 * so the watch page renders without skip controls rather than crashing.
 */
function readQueue(state: unknown): string[] {
  if (state === null || typeof state !== "object") return [];
  const maybeQueue = (state as { queue?: unknown }).queue;
  if (!Array.isArray(maybeQueue)) return [];
  return maybeQueue.filter((v): v is string => typeof v === "string");
}

export function useQueue(): UseQueue {
  const location = useLocation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const queue = readQueue(location.state);
  const currentIndex = id ? queue.indexOf(id) : -1;
  const hasQueue = queue.length > 0 && currentIndex >= 0;
  const hasPrev = hasQueue && currentIndex > 0;
  const hasNext =
    hasQueue && currentIndex >= 0 && currentIndex < queue.length - 1;

  const goToIndex = useCallback(
    (index: number) => {
      if (!queue.length) return;
      if (index < 0 || index >= queue.length) return;
      const targetId = queue[index];
      if (!targetId || targetId === id) return;
      navigate(`/watch/${encodeURIComponent(targetId)}`, {
        state: { queue },
      });
    },
    [queue, id, navigate],
  );

  const goToPrev = useCallback(() => {
    if (currentIndex > 0) goToIndex(currentIndex - 1);
  }, [currentIndex, goToIndex]);

  const goToNext = useCallback(() => {
    if (currentIndex >= 0 && currentIndex < queue.length - 1) {
      goToIndex(currentIndex + 1);
    }
  }, [currentIndex, queue.length, goToIndex]);

  return {
    queue,
    currentIndex,
    hasQueue,
    hasPrev,
    hasNext,
    goToPrev,
    goToNext,
    goToIndex,
  };
}
