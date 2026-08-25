// Shelf — horizontal scrollable row of PosterCards.
//
// Used by BrowsePage to display curated rails: Recently Added, Favorites
// (and, until M9 task 013 replaces them, By Provider / By Folder). Each
// shelf is backed by its own `useVideos` query in the parent; this
// component is purely presentational.
//
// Layout:
//   * Header: title (h2) + optional "View All" button.
//   * Horizontal scroll container: `overflow-x-auto` with hidden scrollbar
//     (`.no-scrollbar`) + scroll-snap for a magnetic feel.
//   * Each card: fixed-width wrapper (`flex-shrink-0`), scroll-snap aligned
//     to `start`. `compact` narrows the cards + gap — the M9 rails sit
//     above the folder organizer, not at Netflix scale.
//
// "View All": the parent owns the filter state and passes an `onViewAll`
// handler. When omitted, no button renders.

import type { VideoSummaryDto } from "../api/types";
import { FavoriteToggle } from "./favorite-toggle";
import { PosterCard } from "./poster-card";
import { RatingStars } from "./rating-stars";

type ShelfProps = {
  title: string;
  videos: VideoSummaryDto[];
  onViewAll?: () => void;
  /** Optional total count to display beside the title (e.g., "Recently Added · 47").
   *  Defaults to `videos.length` when omitted. */
  totalCount?: number;
  /** Compact sizing (M9 FR-7.3): 160px cards, tighter gap. */
  compact?: boolean;
};

export function Shelf({ title, videos, onViewAll, totalCount, compact }: ShelfProps) {
  // Full sibling list for the ephemeral play queue — every card on this
  // shelf carries the same `queue` so the watch page can offer next/prev
  // skip within the shelf context.
  const queue = videos.map((v) => v.id);
  const count = totalCount ?? videos.length;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <h2 className="eyebrow">{title}</h2>
          <span className="eyebrow tabular-nums">· {count}</span>
        </div>
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="-my-1 rounded-[var(--radius-button)] px-2 py-1 text-sm text-[var(--color-castify-accent)] transition hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
          >
            View All
          </button>
        )}
      </div>
      <div
        className={`no-scrollbar flex overflow-x-auto pb-2 pr-4 ${
          compact ? "gap-3" : "gap-4"
        }`}
        // `proximity` (not `mandatory`) lets the user settle between cards and
        // — importantly — freely scroll the last card fully into view. With
        // `mandatory`, the scroll container resists scrolling past the final
        // snap point, which is why the trailing card was cut at ~80%.
        style={{ scrollSnapType: "x proximity" }}
      >
        {videos.map((video) => (
          <div
            key={video.id}
            className={`${compact ? "w-[160px]" : "w-[200px]"} flex-shrink-0`}
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
