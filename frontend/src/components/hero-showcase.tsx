// HeroShowcase — full-width featured video at the top of the browse page.
//
// Design-pass changes:
//   * Explicit "▶ Play" CTA button — previously the entire hero was a
//     stretched link with no visible affordance (audit: "no play overlay
//     or quick-preview on hover").
//   * The caller now picks the featured video. BrowsePage rotates the pick
//     per session so reloads within a session stay stable but different
//     visits vary the hero.
//
// Layout (PRD FR-8.2 + design-pass):
//   ┌──────────────────────────────────────────────┐
//   │  [blurred backdrop: thumbnail, scaled 1.1]     │
//   │  [gradient: transparent → dark bottom]         │
//   │                                                │
//   │  Title (2xl/3xl)                               │
//   │  2:00 · 1080p · 5.0 MB                         │
//   │  [Google Drive] [Also in: Dropbox]             │
//   │  [▶ Play]  [♡ Favorite]  [★★★★☆]              │
//   └──────────────────────────────────────────────┘
//
// Thumbnail state machine (same approach as PosterCard):
//   * `loading` → muted surface, subtle pulse.
//   * `loaded`  → blurred backdrop visible (opacity transition).
//   * `error`   → deterministic gradient fallback via hashHue.

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import type { VideoSummaryDto } from "../api/types";
import { DedupBadge, ProviderBadge } from "./badges";
import { PlayIcon } from "./icons";
import {
  formatDuration,
  formatResolution,
  formatSize,
  hashHue,
} from "../lib/format";
import { otherProviders } from "../lib/video";

type HeroShowcaseProps = {
  video: VideoSummaryDto | undefined;
  /**
   * Optional sibling video IDs for the ephemeral play queue (M3 T11).
   * Typically the Recently Added list the hero was drawn from, so clicking
   * the hero enters the queue at the featured video's position. Omitted
   * when the hero is shown without a browse context.
   */
  queue?: string[];
  /** T11 FavoriteToggle slot. */
  favoriteSlot?: ReactNode;
  /** T11 RatingStars slot. */
  ratingSlot?: ReactNode;
};

export function HeroShowcase({
  video,
  queue,
  favoriteSlot,
  ratingSlot,
}: HeroShowcaseProps) {
  if (!video) {
    return <HeroSkeleton />;
  }
  return (
    <HeroBackdrop
      video={video}
      queue={queue}
      favoriteSlot={favoriteSlot}
      ratingSlot={ratingSlot}
    />
  );
}

type HeroBackdropProps = {
  video: VideoSummaryDto;
  queue?: string[];
  favoriteSlot?: ReactNode;
  ratingSlot?: ReactNode;
};

type BackdropState = "loading" | "loaded" | "error";

function HeroBackdrop({
  video,
  queue,
  favoriteSlot,
  ratingSlot,
}: HeroBackdropProps) {
  const [state, setState] = useState<BackdropState>("loading");
  const hue = hashHue(video.id);
  const others = otherProviders(video);

  return (
    <section className="relative h-[40vh] min-h-[300px] w-full overflow-hidden rounded-[var(--radius-card)]">
      {/* Gradient fallback — visible while loading and on error. */}
      {state !== "loaded" && (
        <div
          className="absolute inset-0"
          style={{
            background:
              state === "error"
                ? `linear-gradient(135deg, hsl(${hue} 40% 25%), hsl(${(hue + 60) % 360} 40% 18%))`
                : "var(--color-castify-surface)",
          }}
          aria-hidden
        >
          {state === "loading" && (
            <div className="absolute inset-0 animate-pulse bg-[var(--color-castify-accent-subtle)]" />
          )}
        </div>
      )}

      {/* Blurred backdrop image — scaled to prevent blur edge artifacts. */}
      {state !== "error" && (
        <img
          src={`/api/videos/${encodeURIComponent(video.id)}/thumbnail`}
          alt=""
          onLoad={() => setState("loaded")}
          onError={() => setState("error")}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
            state === "loaded" ? "opacity-100" : "opacity-0"
          }`}
          style={{ filter: "blur(32px)", transform: "scale(1.1)" }}
        />
      )}

      {/* Gradient overlay for text legibility — dark at the bottom. */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />

      {/* Content overlay — bottom-aligned for a cinematic feel. */}
      <div className="relative z-10 flex h-full flex-col justify-end gap-3 p-6 sm:p-8">
        <h2 className="text-2xl font-bold tracking-tight drop-shadow-lg sm:text-3xl">
          {video.name}
        </h2>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/80">
          {video.duration_ms !== null && (
            <span>{formatDuration(video.duration_ms)}</span>
          )}
          {video.width !== null && video.height !== null && (
            <>
              {video.duration_ms !== null && <span aria-hidden>·</span>}
              <span>{formatResolution(video.width, video.height)}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span>{formatSize(video.size_bytes)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ProviderBadge provider={video.provider} />
          {others.length > 0 && <DedupBadge providers={others} />}
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Link
            to={`/watch/${video.id}`}
            state={queue ? { queue } : undefined}
            className="inline-flex items-center gap-2 rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-castify-canvas)] shadow-lg transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            <PlayIcon className="h-4 w-4 translate-x-0.5" />
            <span>Play</span>
          </Link>
          {favoriteSlot}
          {ratingSlot}
        </div>
      </div>
    </section>
  );
}

/** Pulsing skeleton shown while the featured video is still loading. */
export function HeroSkeleton() {
  return (
    <section className="h-[40vh] min-h-[300px] w-full animate-pulse rounded-[var(--radius-card)] bg-[var(--color-castify-surface)]">
      <div className="flex h-full flex-col justify-end gap-3 p-6 sm:p-8">
        <div className="h-8 w-64 rounded-[var(--radius-button)] bg-[var(--color-castify-rule)]" />
        <div className="h-4 w-48 rounded-[var(--radius-button)] bg-[var(--color-castify-rule)]" />
        <div className="h-9 w-32 rounded-[var(--radius-button)] bg-[var(--color-castify-rule)]" />
      </div>
    </section>
  );
}
