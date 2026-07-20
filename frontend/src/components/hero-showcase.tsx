// HeroShowcase — full-width featured video at the top of the browse page.
//
// Layout (PRD FR-8.2):
//   ┌──────────────────────────────────────────────┐
//   │  [blurred backdrop: thumbnail, scale(1.15)]  │
//   │  [gradient: transparent → dark bottom]        │
//   │                                               │
//   │  Title (2xl/3xl)                              │
//   │  2:00 · 1080p · 5.0 MB                        │
//   │  [Google Drive] [Also in: Dropbox]            │
//   │  [favoriteSlot]  [ratingSlot]                 │
//   └──────────────────────────────────────────────┘
//
// Featured video: always the first item from Recently Added
// (`GET /api/videos?sort=date-desc`). Deterministic — stable across reloads.
//
// T11 slot reservation:
//   * `favoriteSlot` — prominent favorite toggle area.
//   * `ratingSlot`   — 5-star rating widget area.
//   T8 renders nothing into these; T11 passes its controls.
//
// Thumbnail state machine (same approach as PosterCard):
//   * `loading` → dark background, subtle pulse.
//   * `loaded`  → blurred backdrop visible (opacity transition).
//   * `error`   → deterministic gradient fallback via hashHue.

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import type { VideoSummaryDto } from "../api/types";
import { DedupBadge, ProviderBadge } from "./badges";
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
    <section className="relative h-[40vh] min-h-[280px] w-full overflow-hidden rounded-xl">
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
            <div className="absolute inset-0 animate-pulse bg-white/5" />
          )}
        </div>
      )}

      {/* Blurred backdrop image — scaled up to prevent blur edge artifacts. */}
      {state !== "error" && (
        <img
          src={`/api/videos/${encodeURIComponent(video.id)}/thumbnail`}
          alt=""
          onLoad={() => setState("loaded")}
          onError={() => setState("error")}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
            state === "loaded" ? "opacity-100" : "opacity-0"
          }`}
          style={{ filter: "blur(20px)", transform: "scale(1.15)" }}
        />
      )}

      {/* Gradient overlay for text legibility — dark at the bottom. */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />

      {/* Stretched link — covers the hero background area. The content
          overlay sits at z-10 above it so the title/metadata doesn't navigate;
          the favorite/rating slots are above the link and receive clicks. */}
      <Link
        to={`/watch/${video.id}`}
        state={queue ? { queue } : undefined}
        className="absolute inset-0 z-0 rounded-xl"
        aria-label={`Play ${video.name}`}
        tabIndex={-1}
      />

      {/* Content overlay — bottom-aligned for a cinematic feel. */}
      <div className="relative z-10 flex h-full flex-col justify-end gap-2 p-6 sm:p-8">
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

        {(favoriteSlot || ratingSlot) && (
          <div className="flex items-center gap-4 pt-1">
            {favoriteSlot}
            {ratingSlot}
          </div>
        )}
      </div>
    </section>
  );
}

/** Pulsing skeleton shown while the featured video is still loading. */
export function HeroSkeleton() {
  return (
    <section className="h-[40vh] min-h-[280px] w-full animate-pulse rounded-xl bg-[var(--color-castify-surface)]">
      <div className="flex h-full flex-col justify-end gap-2 p-6 sm:p-8">
        <div className="h-8 w-64 rounded bg-white/10" />
        <div className="h-4 w-48 rounded bg-white/5" />
        <div className="h-5 w-32 rounded bg-white/5" />
      </div>
    </section>
  );
}
