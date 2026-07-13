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

import { useState, type ReactNode } from "react";

import type { VideoSummaryDto } from "../api/types";
import {
  filenameInitial,
  formatDuration,
  hashHue,
  resolutionBucket,
} from "../lib/format";
import { otherProviders } from "../lib/video";
import { DedupBadge, ProviderBadge } from "./badges";

type PosterCardProps = {
  video: VideoSummaryDto;
  /** Top-right corner slot — T11 FavoriteToggle. */
  topRightSlot?: ReactNode;
  /** Bottom-overlay slot — T11 RatingStars. Renders on top of the duration/
   *  resolution badges; the slot itself controls its hover visibility. */
  bottomOverlaySlot?: ReactNode;
};

export function PosterCard({
  video,
  topRightSlot,
  bottomOverlaySlot,
}: PosterCardProps) {
  // Providers from `sources` excluding the representative's own. Used to
  // decide whether to render a DedupBadge. Shared helper (lib/video.ts).
  const others = otherProviders(video);

  return (
    <article className="group flex flex-col gap-2 rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-2 transition hover:border-white/20">
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

type ThumbnailProps = {
  video: VideoSummaryDto;
  topRightSlot?: ReactNode;
  bottomOverlaySlot?: ReactNode;
};

type ThumbState = "loading" | "loaded" | "error";

function Thumbnail({ video, topRightSlot, bottomOverlaySlot }: ThumbnailProps) {
  const [state, setState] = useState<ThumbState>("loading");
  const resBucket = resolutionBucket(video.height);

  // Deterministic gradient hue so failed thumbnails don't all look identical.
  const hue = hashHue(video.id);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black/40">
      {/* Placeholder layer — visible while loading and on error. */}
      {state !== "loaded" && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            background:
              state === "error"
                ? `linear-gradient(135deg, hsl(${hue} 40% 25%), hsl(${(hue + 60) % 360} 40% 18%))`
                : undefined,
          }}
          aria-hidden
        >
          {state === "loading" && (
            <div className="absolute inset-0 animate-pulse bg-white/5" />
          )}
          {state === "error" && (
            <span className="text-4xl font-bold text-white/30">
              {filenameInitial(video.name)}
            </span>
          )}
        </div>
      )}

      {state !== "error" && (
        <img
          src={`/api/videos/${encodeURIComponent(video.id)}/thumbnail`}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setState("loaded")}
          onError={() => setState("error")}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${
            state === "loaded" ? "opacity-100" : "opacity-0"
          }`}
        />
      )}

      {/* Metadata badges — render when the image is loaded. Always visible;
          the bottomOverlaySlot (when present) sits on top via absolute
          positioning + its own hover-gated visibility. */}
      {state === "loaded" && (
        <>
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
        </>
      )}

      {topRightSlot && (
        <div className="absolute right-1 top-1">{topRightSlot}</div>
      )}
      {bottomOverlaySlot && (
        <div className="absolute inset-x-1 bottom-1">{bottomOverlaySlot}</div>
      )}
    </div>
  );
}
