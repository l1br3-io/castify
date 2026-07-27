// Shelf — horizontal scrollable row of PosterCards (Netflix/Plex style).
//
// Used by BrowsePage (T8) to display curated collections: Recently Added,
// Favorites, By Provider, By Folder. Each shelf is backed by its own
// `useVideos` query in the parent; this component is purely presentational.
//
// Layout (PRD FR-8.3):
//   * Header: title (h2) + optional "View All" button.
//   * Horizontal scroll container: `overflow-x-auto` with hidden scrollbar
//     (`.no-scrollbar`) + scroll-snap for a magnetic feel.
//   * Each card: fixed-width 200px wrapper (`flex-shrink-0`), scroll-snap
//     aligned to `start`. PosterCard fills the wrapper naturally.
//
// "View All" (PRD FR-8.5): the parent owns the filter state and passes an
// `onViewAll` handler. When omitted, no button renders (e.g., for shelves
// without a meaningful "all" view).

import type { VideoSummaryDto } from "../api/types";
import { FavoriteToggle } from "./favorite-toggle";
import { PosterCard } from "./poster-card";
import { RatingStars } from "./rating-stars";

type ShelfProps = {
  title: string;
  videos: VideoSummaryDto[];
  onViewAll?: () => void;
  /** Optional total count to display beside the title (e.g., "Recently Added · 47").
    Defaults to `videos.length` when omitted. */
  totalCount?: number;
};

export function Shelf({ title, videos, onViewAll, totalCount }: ShelfProps) {
  // Full sibling list for the ephemeral play queue — every card on this
  // shelf carries the same `queue` so T11's watch page can offer next/prev
  // skip within the shelf context.
  const queue = videos.map((v) => v.id);
  const count = totalCount ?? videos.length;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          <span className="text-sm text-[var(--color-castify-muted)]">
            · {count}
          </span>
        </div>
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="text-sm text-[var(--color-castify-accent)] transition hover:opacity-80"
          >
            View All
          </button>
        )}
      </div>
      <div
        className="no-scrollbar flex gap-4 overflow-x-auto pb-2 pr-4"
        // `proximity` (not `mandatory`) lets the user settle between cards and
        // — importantly — freely scroll the last card fully into view. With
        // `mandatory`, the scroll container resists scrolling past the final
        // snap point, which is why the trailing card was cut at ~80%.
        style={{ scrollSnapType: "x proximity" }}
      >
        {videos.map((video) => (
          <div
            key={video.id}
            className="w-[200px] flex-shrink-0"
            style={{ scrollSnapAlign: "start" }}
          >
            <PosterCard
              video={video}
              href={`/watch/${video.id}`}
              queue={queue}
              topRightSlot={<FavoriteToggle video={video} />}
              bottomOverlaySlot={<RatingStars video={video} />}
            />
          </div>
        ))}
        {/* Trailing spacer so the last card can scroll past the viewport
            edge and be fully visible. Without this, the container ends
            flush with the last card's right edge. */}
        <div aria-hidden className="w-1 flex-shrink-0" />
      </div>
    </section>
  );
}
