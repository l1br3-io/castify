// UpNext — collapsible panel showing the next videos in the ephemeral queue
// (PRD FR-10.4). Rendered below `VideoInfo` on the watch page when a queue
// exists.
//
// Data source: each `UpNextItem` calls `useQuery` against the existing
// `fetchVideoDetail` endpoint. T11 is frontend-only — no new `?ids=`
// filter. TanStack Query dedupes by `['videos', id]` across all callers, so
// (a) the actual skip navigation lands on a cache hit, and (b) batched
// fetches for the same id don't duplicate. Per-item loading placeholders
// render until each fetch resolves.
//
// Layout: horizontal scrollable row of small landscape cards (thumbnail +
// name + duration), matching the M2 shelf pattern. A toggle pill collapses
// the panel for users who want maximum video height. Default expanded when
// the panel is visible (i.e. when there are items beyond the current video).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchVideoDetail } from "../api/videos";
import { videoDetailQueryKey } from "../hooks/use-video-detail";
import { formatDuration, hashHue, resolutionBucket } from "../lib/format";

/** Maximum items to show beyond the current video (plan T11: "5 ahead"). */
const MAX_ITEMS = 5;

type UpNextProps = {
  /** Full queue of video IDs (current + siblings). */
  queue: string[];
  /** Index of the currently-playing video within `queue`. */
  currentIndex: number;
  /** Called when the user clicks an item. The watch page navigates. */
  onSelect: (videoId: string) => void;
};

export function UpNext({ queue, currentIndex, onSelect }: UpNextProps) {
  const [collapsed, setCollapsed] = useState(false);
  const upcoming = queue.slice(currentIndex + 1, currentIndex + 1 + MAX_ITEMS);

  // Nothing to show — hide entirely. The watch page guards on `hasQueue`
  // before rendering, but this guard handles the at-tail case.
  if (upcoming.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold tracking-tight">Up next</h2>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Show up next" : "Hide up next"}
          className="text-sm text-[var(--color-castify-accent)] transition hover:opacity-80"
        >
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>
      {!collapsed && (
        <div
          className="no-scrollbar flex gap-3 overflow-x-auto pb-2"
          style={{ scrollSnapType: "x mandatory" }}
        >
          {upcoming.map((id) => (
            <UpNextItem key={id} videoId={id} onSelect={onSelect} />
          ))}
        </div>
      )}
    </section>
  );
}

type UpNextItemProps = {
  videoId: string;
  onSelect: (videoId: string) => void;
};

function UpNextItem({ videoId, onSelect }: UpNextItemProps) {
  // Per-item `useQuery` (rules of hooks: each item is a component, hook at
  // the top level). TanStack Query dedupes by key, so multiple UpNextItems
  // never trigger duplicate requests for the same id.
  const query = useQuery({
    queryKey: videoDetailQueryKey(videoId),
    queryFn: () => fetchVideoDetail(videoId),
  });

  if (query.isLoading || !query.data) {
    return (
      <button
        type="button"
        onClick={() => onSelect(videoId)}
        className="w-[220px] flex-shrink-0 overflow-hidden rounded-md border border-white/10 bg-[var(--color-castify-surface)] text-left"
        style={{ scrollSnapAlign: "start" }}
        aria-label={`Play video ${videoId}`}
      >
        <div className="aspect-video w-full animate-pulse bg-white/10" />
        <div className="space-y-1 p-2">
          <div className="h-3 w-3/4 rounded bg-white/10" />
          <div className="h-3 w-1/2 rounded bg-white/5" />
        </div>
      </button>
    );
  }

  const video = query.data;
  const hue = hashHue(video.id);
  const resBucket = resolutionBucket(video.height);

  return (
    <button
      type="button"
      onClick={() => onSelect(videoId)}
      className="w-[220px] flex-shrink-0 overflow-hidden rounded-md border border-white/10 bg-[var(--color-castify-surface)] text-left transition hover:border-white/25"
      style={{ scrollSnapAlign: "start" }}
      aria-label={`Play ${video.name}`}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-black/40">
        {/* Hue-tinted backdrop visible behind transparent thumbnails (the
            `<img>` opacity transitions in once loaded). Mirrors PosterCard's
            gradient fallback without the loading/error state machine. */}
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(135deg, hsl(${hue} 40% 25%), hsl(${(hue + 60) % 360} 40% 18%))`,
          }}
          aria-hidden
        />
        <img
          src={`/api/videos/${encodeURIComponent(video.id)}/thumbnail`}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
        {video.duration_ms !== null && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {formatDuration(video.duration_ms)}
          </span>
        )}
        {resBucket !== null && (
          <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {resBucket}
          </span>
        )}
      </div>
      <div className="p-2">
        <p className="line-clamp-2 text-sm font-medium leading-tight">
          {video.name}
        </p>
      </div>
    </button>
  );
}
