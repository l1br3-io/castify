// ContinueWatchingCard — shelf card for an in-progress video.
//
// Renders against an IndexedDB-backed `ProgressEntry` (not the server's
// `VideoSummaryDto`). The denormalized metadata captured at save time
// (`videoName`, `videoDurationMs`, `height`, `thumbnailStatus`, `provider`)
// drives rendering — no `/api/videos` round-trip per card (PRD FR-11.1,
// `docs/data-storage-principles.md` anti-pattern #3).
//
// Layout (PRD FR-11.3):
//   ┌──────────────────────────────────┐
//   │                                  │
//   │   <Thumbnail> (img + badges)     │
//   │                                  │
//   │ ▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░     │  progress bar (bottom edge)
//   └──────────────────────────────────┘
//   name (2-line clamp)
//   [Provider badge]
//
// Click (FR-11.4): the stretched `<Link>` navigates to `/watch/:id`. Resume
// is handled by `usePlaybackTracking` on the watch page reading the same
// IndexedDB entry — no special-casing or query-string hint needed.

import { Link } from "react-router-dom";

import type { ProgressEntry } from "../lib/player-db";
import { formatDuration } from "../lib/format";
import type { ProviderKey } from "../api/types";
import { ProviderBadge } from "./badges";
import { Thumbnail, type ThumbnailVideo } from "./thumbnail";

type ContinueWatchingCardProps = {
  entry: ProgressEntry;
  /** Sibling video IDs for the ephemeral play queue (M3 T11). */
  queue?: string[];
};

export function ContinueWatchingCard({
  entry,
  queue,
}: ContinueWatchingCardProps) {
  // Map the IndexedDB entry into the structural shape Thumbnail expects.
  // `ProgressEntry` uses `videoName` / `videoDurationMs` (the names chosen
  // to avoid colliding with future catalog fields at write time); Thumbnail
  // reads `name` / `duration_ms` (the canonical VideoSummaryDto names).
  const thumbVideo: ThumbnailVideo = {
    id: entry.videoId,
    name: entry.videoName,
    height: entry.height,
    duration_ms: entry.videoDurationMs,
  };

  const progressFraction = computeProgressFraction(entry);

  return (
    <article className="relative group flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-2 transition duration-150 ease-out hover:-translate-y-0.5 hover:border-[var(--color-castify-accent)]/40 focus-within:-translate-y-0.5 focus-within:border-[var(--color-castify-accent)]/40">
      <Link
        to={`/watch/${encodeURIComponent(entry.videoId)}`}
        state={queue ? { queue } : undefined}
        className="absolute inset-0 rounded-[var(--radius-card)] z-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)]"
        aria-label={`Resume ${entry.videoName}`}
      />
      <Thumbnail
        video={thumbVideo}
        bottomBarSlot={<ProgressBar fraction={progressFraction} />}
      />
      <div className="flex flex-col gap-1 px-1 pb-1">
        <h3
          className="line-clamp-2 text-sm font-medium leading-tight"
          title={entry.videoName}
        >
          {entry.videoName}
        </h3>
        <div className="flex flex-wrap items-center gap-1">
          <ProviderBadge provider={entry.provider as ProviderKey} />
          {entry.durationSeconds !== null && (
            <span className="text-[10px] opacity-60">
              {formatDuration(entry.durationSeconds * 1000)} total
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

// Full-width progress bar pinned to the thumbnail's bottom edge. Width is
// `fraction * 100%`. Hidden entirely when fraction is null (no duration
// known) — the bar would be meaningless without a denominator.
function ProgressBar({ fraction }: { fraction: number | null }) {
  if (fraction === null) return null;
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div
      className="h-1 w-full bg-white/20"
      role="progressbar"
      aria-label="Watch progress"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full bg-[var(--color-castify-accent)]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// Position/duration → [0,1] fraction. Returns null when the duration is
// unknown or non-positive, in which case the bar is suppressed rather than
// rendering a meaningless sliver.
function computeProgressFraction(entry: ProgressEntry): number | null {
  if (
    entry.durationSeconds === null ||
    entry.durationSeconds <= 0 ||
    entry.positionSeconds <= 0
  ) {
    return null;
  }
  return entry.positionSeconds / entry.durationSeconds;
}
