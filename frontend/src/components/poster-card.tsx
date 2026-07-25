// PosterCard — 16:9 thumbnail-dominant card for the browse grid and (T8)
// shelf variants. Replaces M1's text-row VideoCard.
//
// Layout (PRD FR-9.1):
//   ┌──────────────────────────────────┐
//   │                           [slot] │  top-right (T11 favorite)
//   │   <img aspect-video object-cover │
//   │        loading="lazy">           │
//   │ [1080p]               [2:00]     │  resolution bottom-left,
//   │       [slot]                     │  duration bottom-right
//   │                                  │  bottom-overlay (T11 rating)
//   └──────────────────────────────────┘
//   name (2-line clamp)
//   [Provider] [Also in: …]
//
// T11 slot reservation contract (revised):
//   * `topRightSlot`        — absolute top-right corner; renders above the img.
//   * `bottomOverlaySlot`   — absolute bottom strip; T11's rating stars.
//
// T11 deviation from T7 #38: badges (duration/resolution) now *always*
// render, regardless of `bottomOverlaySlot`. The slot is rendered on top
// of the badges and is responsible for its own hover visibility (the
// RatingStars component uses `opacity-0 group-hover:opacity-100` with a
// solid `bg-black/70` backdrop so it cleanly covers the badges while
// interacting). PRD FR-9.1 requires always-on badges; FR-9.2 requires
// hover-revealed rating — both are satisfied.
//
// Thumbnail state machine (PRD FR-1.4 / FR-9.3 / FR-9.4):
//   * `loading` → pulsing skeleton behind a transparent `<img>` (img becomes
//     opaque on `onLoad`).
//   * `loaded`  → opaque img + badges visible.
//   * `error`   → img unmounted, deterministic gradient + filename initial.
//     404 (FR-1.4, "unsupported") and 502 (FR-1.5) both land here; the next
//     page load remounts the img and retries.

import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import type { VideoSummaryDto } from "../api/types";
import { otherProviders } from "../lib/video";
import { DedupBadge, ProviderBadge } from "./badges";
import { Thumbnail } from "./thumbnail";

type PosterCardProps = {
  video: VideoSummaryDto;
  /** Optional link target — renders a stretched Link overlay for click-to-navigate. */
  href?: string;
  /**
   * Optional sibling video IDs for the ephemeral play queue (M3 T11).
   * When provided, the stretched `<Link>` carries `{ queue }` in router
   * state. The parent (BrowseGrid, Shelf, HeroShowcase) computes the
   * sibling list from its current result set and passes it here. The
   * watch page reads it via `location.state.queue` to enable next/prev
   * skip + auto-advance. Omit when there is no browse context (e.g. a
   * standalone card on a future detail page).
   */
  queue?: string[];
  /** Top-right corner slot — T11 FavoriteToggle. */
  topRightSlot?: ReactNode;
  /** Bottom-overlay slot — T11 RatingStars. Renders on top of the duration/
   *  resolution badges; the slot itself controls its hover visibility. */
  bottomOverlaySlot?: ReactNode;
};

export function PosterCard({
  video,
  href,
  queue,
  topRightSlot,
  bottomOverlaySlot,
}: PosterCardProps) {
  // Providers from `sources` excluding the representative's own. Used to
  // decide whether to render a DedupBadge. Shared helper (lib/video.ts).
  const others = otherProviders(video);

  return (
    <article className="relative group flex flex-col gap-2 rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-2 transition hover:border-white/20">
      {href && (
        <Link
          to={href}
          state={queue ? { queue } : undefined}
          className="absolute inset-0 rounded-lg z-0"
          aria-label={`Play ${video.name}`}
          tabIndex={-1}
        />
      )}
      <Thumbnail
        video={video}
        topRightSlot={topRightSlot}
        bottomOverlaySlot={bottomOverlaySlot}
      />
      <div className="flex flex-col gap-1 px-1 pb-1">
        <h3
          className="line-clamp-2 text-sm font-medium leading-tight"
          title={video.name}
        >
          {video.name}
        </h3>
        <div className="flex flex-wrap items-center gap-1">
          <ProviderBadge provider={video.provider} />
          {others.length > 0 && <DedupBadge providers={others} />}
        </div>
      </div>
    </article>
  );
}
