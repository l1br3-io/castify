// PosterCard — 16:9 thumbnail-dominant card for the browse grid and shelves.
//
// Design-pass changes:
//   * The stretched link is now keyboard-focusable (removed the old
//     `tabIndex={-1}` that made the entire card unreachable via Tab —
//     audit §4: "Cards have no in-card keyboard focus").
//   * Body shows a year + provider line (year derived from `created_at`).
//   * Hover discipline (identity pass task 005): no lift — the border
//     shifts toward the accent and the video name underlines instead,
//     per the effort's motion budget ("hovers shift borders/underlines
//     only — no lifts").
//
// Layout:
//   ┌──────────────────────────────────┐
//   │                           [slot] │  top-right (T11 favorite)
//   │   <img aspect-video object-cover │
//   │        loading="lazy">           │
//   │ [1080p]               [2:00]     │  resolution bottom-left,
//   └──────────────────────────────────┘  duration bottom-right
//   name (2-line clamp)
//   2023 · [provider mark] [also-in marks]   ← compact identity, full
//                                             names in title/sr-only
//   [slot]                                 rating stars (T11)
//
// Slot contracts:
//   * `topRightSlot` — absolute top-right corner of the thumbnail;
//     renders above the img.
//   * `ratingSlot`   — body row below the year/provider line. Must stay
//     clickable above the stretched link, hence `relative z-10 w-fit`
//     (`w-fit` so the rest of the row's strip still clicks through to
//     the link).

import { type ReactNode } from "react";
import { Link } from "react-router-dom";

import { thumbnailUrl, type AccessScope } from "../api/videos";
import type { VideoSummaryDto } from "../api/types";
import { otherProviders } from "../lib/video";
import { DedupBadge, ProviderMarkBadge } from "./badges";
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
  /** Rating row in the card body — T11 RatingStars, below the year/provider
   *  line. Always visible (the slot itself controls its own styling). */
  ratingSlot?: ReactNode;
  /**
   * Compact action menu anchored to the card body's meta row (e.g. the
   * library-collections add-to-collection kebab). Stays above the
   * stretched link so its controls remain clickable. Owner contexts
   * only — share pages never pass one.
   */
  menuSlot?: ReactNode;
  /**
   * Access scope for media URLs. Defaults to owner routes; share pages pass
   * `{ kind: "share", token }` so thumbnails resolve through the pre-auth
   * share mirror instead of the session-gated owner route.
   */
  scope?: AccessScope;
  /**
   * Selection mode (task 012 browse multi-select). When set, the card
   * stops navigating (no stretched link), the top-right corner carries a
   * real checkbox, and clicking anywhere on the card toggles selection.
   * Keyboard users drive the checkbox itself — the card body is
   * pointer-only, so interactive slots (favorite/rating) can be omitted
   * by the caller without losing accessibility.
   */
  selection?: {
    isSelected: boolean;
    onToggle: () => void;
  };
  /**
   * Drag source (drag-and-drop effort): pointer-down wiring for the
   * card. The pane decides what a press carries (selection rule lives
   * there); the card only reports the press. The engine's threshold —
   * not this handler — separates a click from a drag.
   */
  dragHandle?: {
    onPointerDown: (event: React.PointerEvent) => void;
  };
};

export function PosterCard({
  video,
  href,
  queue,
  topRightSlot,
  ratingSlot,
  menuSlot,
  scope,
  selection,
  dragHandle,
}: PosterCardProps) {
  // Providers from `sources` excluding the representative's own. Used to
  // decide whether to render a DedupBadge. Shared helper (lib/video.ts).
  const others = otherProviders(video);
  const year = formatYear(video.created_at);

  return (
    <article
      onClick={selection ? selection.onToggle : undefined}
      onPointerDown={dragHandle?.onPointerDown}
      className={`
        relative group flex flex-col gap-2
        ${selection ? "cursor-pointer" : ""}
        ${selection?.isSelected ? "rounded-[var(--radius-card)] ring-2 ring-[var(--color-castify-accent)]" : ""}
      `}
    >
      {!selection && href && (
        <Link
          to={href}
          state={queue ? { queue } : undefined}
          // No longer `tabIndex={-1}` — the link is the keyboard entry to
          // the card. The focus ring is rendered on the article via
          // `focus-within:ring` below so it visually wraps the whole card.
          className="absolute inset-0 rounded-[var(--radius-card)] z-0
                     outline-none focus-visible:ring-2
                     focus-visible:ring-[var(--color-focus)]
                     focus-visible:ring-offset-2
                     focus-visible:ring-offset-[var(--color-castify-canvas)]"
          aria-label={`Play ${video.name}`}
        />
      )}
      {selection && (
        <input
          type="checkbox"
          checked={selection.isSelected}
          onChange={selection.onToggle}
          // Both the checkbox and the card body toggle — stop the bubble
          // so a checkbox click doesn't fire twice.
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${video.name}`}
          className="absolute right-2 top-2 z-20 h-5 w-5 cursor-pointer accent-[var(--color-castify-accent)]"
        />
      )}
      <Thumbnail
        video={video}
        src={scope ? thumbnailUrl(video.id, scope) : undefined}
        topRightSlot={topRightSlot}
      />
      <div className="flex flex-col gap-1">
        <h3
          className="line-clamp-2 text-[13px] font-semibold leading-snug group-hover:underline group-focus-within:underline"
          title={video.name}
        >
          {video.name}
        </h3>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--color-castify-muted)]">
          {year && <span>{year}</span>}
          <ProviderMarkBadge provider={video.provider} />
          {others.length > 0 && <DedupBadge providers={others} />}
          {menuSlot && (
            <span className="relative z-10 ml-auto">
              {menuSlot}
            </span>
          )}
        </div>
        {ratingSlot && <div className="relative z-10 w-fit">{ratingSlot}</div>}
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
