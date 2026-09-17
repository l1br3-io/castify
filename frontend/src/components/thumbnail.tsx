// Thumbnail — shared 16:9 image surface with a loading/loaded/error state
// machine and optional corner/overlay slots.
//
// Extracted from `poster-card.tsx` so the M3 T13 continue-watching card can
// reuse the same state machine without re-implementing it. Both
// `VideoSummaryDto` (poster grid/shelves) and the IndexedDB-backed
// `ProgressEntry` (continue-watching shelf) map into `ThumbnailVideo` at the
// call site — Thumbnail itself stays decoupled from either DTO.
//
// Classical (task 011): the wrapper carries the `.plate` archival treatment
// (index.css) — every poster/thumbnail is matted, never raw. The fixed
// aspect-video ratio holds through loading/loaded/error so nothing shifts
// (FR-3.5).
//
// State machine (PRD FR-1.4 / FR-9.3 / FR-9.4):
//   * `loading` → pulsing skeleton behind a transparent `<img>` (img becomes
//     opaque on `onLoad`).
//   * `loaded`  → opaque img + badges visible.
//   * `error`   → img unmounted, deterministic gradient + filename initial.
//     404 (FR-1.4, "unsupported") and 502 (FR-1.5) both land here; the next
//     page load remounts the img and retries.

import { useState, type ReactNode } from "react";

import {
  filenameInitial,
  formatDuration,
  hashHue,
  resolutionBucket,
} from "../lib/format";

// Structural shape consumed by Thumbnail. Callers pass either a
// `VideoSummaryDto` directly (it satisfies this) or a small adapter object
// built from `ProgressEntry` for the continue-watching shelf.
export type ThumbnailVideo = {
  id: string;
  name: string;
  height: number | null;
  duration_ms: number | null;
};

export type ThumbnailProps = {
  video: ThumbnailVideo;
  /**
   * Override for the thumbnail image URL. Defaults to the owner route
   * (`/api/videos/{id}/thumbnail`); share pages pass the share-mirror URL
   * (via `thumbnailUrl(videoId, scope)`) so recipients — who hold no owner
   * session — get images through the pre-auth share route.
   */
  src?: string;
  /** Top-right corner slot — T11 FavoriteToggle (unused by CW cards). */
  topRightSlot?: ReactNode;
  /**
   * Optional full-width bar pinned to the bottom edge of the thumbnail
   * (e.g. the continue-watching progress bar). Renders above the badges.
   * Unused by PosterCard.
   */
  bottomBarSlot?: ReactNode;
};

type ThumbState = "loading" | "loaded" | "error";

export function Thumbnail({
  video,
  src,
  topRightSlot,
  bottomBarSlot,
}: ThumbnailProps) {
  const [state, setState] = useState<ThumbState>("loading");
  const resBucket = resolutionBucket(video.height);

  // Deterministic gradient hue so failed thumbnails don't all look identical.
  const hue = hashHue(video.id);

  return (
    <div className="plate relative aspect-video w-full overflow-hidden rounded-[var(--radius-button)] bg-[var(--color-castify-rule)]">
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
            <div className="absolute inset-0 animate-pulse bg-[var(--color-castify-accent-subtle)]" />
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
          src={src ?? `/api/videos/${encodeURIComponent(video.id)}/thumbnail`}
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

      {/* Metadata badges — render when the image is loaded. Always visible. */}
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

      {/* Full-width bottom-edge slot (e.g. CW progress bar). Pinned to
          bottom-0 so it sits below the badges (which sit at bottom-1). */}
      {bottomBarSlot && (
        <div className="absolute inset-x-0 bottom-0 z-10">{bottomBarSlot}</div>
      )}

      {topRightSlot && (
        <div className="absolute right-1 top-1 z-10">{topRightSlot}</div>
      )}
    </div>
  );
}
