// PosterCard — 16:9 thumbnail-dominant card for the browse grid and shelves.
//
// Design-pass changes:
//   * The stretched link is now keyboard-focusable (removed the old
//     `tabIndex={-1}` that made the entire card unreachable via Tab —
//     audit §4: "Cards have no in-card keyboard focus").
//   * A decorative play-overlay appears on hover/focus-within to make the
//     click target's purpose obvious (the overlay itself is `pointer-events-
//     none` and `aria-hidden`; clicks still go to the link).
//   * Body shows a year + provider line (year derived from `created_at`).
//   * Hover now lifts the card 2px and shifts the border toward the accent.
//
// Layout:
//   ┌──────────────────────────────────┐
//   │                           [slot] │  top-right (T11 favorite)
//   │   <img aspect-video object-cover │
//   │        loading="lazy">           │
//   │      [▶ overlay on hover]        │
//   │ [1080p]               [2:00]     │  resolution bottom-left,
//   │       [slot]                     │  duration bottom-right
//   │                                  │  bottom-overlay (T11 rating)
//   └──────────────────────────────────┘
//   name (2-line clamp)
//   2023 · [Provider] [Also in: …]
//
// T11 slot reservation contract (unchanged):
//   * `topRightSlot`        — absolute top-right corner; renders above the img.
//   * `bottomOverlaySlot`   — absolute bottom strip; T11's rating stars.

import { type ReactNode } from "react";
import { Link } from "react-router-dom";

import type { VideoSummaryDto } from "../api/types";
import { otherProviders } from "../lib/video";
import { DedupBadge, ProviderBadge } from "./badges";
import { Thumbnail } from "./thumbnail";
import { PlayIcon } from "./icons";

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
  const year = formatYear(video.created_at);

  return (
    <article
      className={`
        relative group flex flex-col gap-2
        rounded-[var(--radius-card)] border
        border-[var(--color-castify-rule)]
        bg-[var(--color-castify-surface)] p-2
        transition duration-150 ease-out
        hover:-translate-y-0.5 hover:border-[var(--color-castify-accent)]/40
        focus-within:-translate-y-0.5
        focus-within:border-[var(--color-castify-accent)]/40
      `}
    >
      {href && (
        <>
          <Link
            to={href}
            state={queue ? { queue } : undefined}
            // No longer `tabIndex={-1}` — the link is the keyboard entry to
            // the card. The focus ring is rendered on the article via
            // `focus-within:ring` below so it visually wraps the whole card.
            className="absolute inset-0 rounded-[var(--radius-card)] z-0
                       outline-none focus-visible:ring-2
                       focus-visible:ring-[var(--color-castify-accent)]
                       focus-visible:ring-offset-2
                       focus-visible:ring-offset-[var(--color-castify-surface)]"
            aria-label={`Play ${video.name}`}
          />
          {/* Decorative play overlay — pointer-events-none so clicks pass
              through to the link. aria-hidden because the link already
              conveys "play this video". */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center rounded-[var(--radius-card)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-castify-accent)] text-[var(--color-castify-canvas)] shadow-lg">
              <PlayIcon className="h-5 w-5 translate-x-0.5" />
            </div>
          </div>
        </>
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
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--color-castify-muted)]">
          {year && <span>{year}</span>}
          <ProviderBadge provider={video.provider} />
          {others.length > 0 && <DedupBadge providers={others} />}
        </div>
      </div>
    </article>
  );
}

/** ISO timestamp → "2024" (or null when parsing fails). */
function formatYear(iso: string): string | null {
  try {
    const year = new Date(iso).getFullYear();
    return Number.isFinite(year) ? String(year) : null;
  } catch {
    return null;
  }
}
