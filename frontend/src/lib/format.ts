// Cross-cutting formatting helpers extracted from the route modules.
// Previously duplicated in `routes/videos.tsx` and `routes/connections.tsx`;
// centralized here so PosterCard, browse page, hero, shelves, etc. all share
// one source of truth.

import { ApiError } from "../api/client";

/**
 * Human-readable error message from a TanStack Query `error` field.
 * Returns the provider message for `ApiError`, a generic fallback otherwise.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

/** Bytes → "5.0 MB" / "1.0 GB". Binary units (1024-based). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Seconds → "M:SS" or "H:MM:SS". Floors fractional seconds (the `<video>`
 * `currentTime` / `duration` are floats). Used by the player time display.
 */
export function formatTime(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** Milliseconds → "H:MM:SS" or "M:SS". Delegates to `formatTime`. */
export function formatDuration(ms: number): string {
  return formatTime(ms / 1000);
}

/** Pixels → "1920×1080" (uses U+00D7 multiplication sign). */
export function formatResolution(width: number, height: number): string {
  return `${width}\u00d7${height}`;
}

/**
 * Plain container label for a video MIME type (FR-3.4 codec facts).
 *
 * Mapping table (mime → everyday label):
 *   video/mp4        → MP4   (also handles `; codecs=…` parameters)
 *   video/x-matroska → MKV
 *   video/quicktime  → MOV
 *   video/webm       → WebM
 *   video/x-msvideo  → AVI
 *   video/mpeg       → MPEG
 *
 * Returns `null` for `null` input or unrecognized types — the caller skips
 * the chip rather than showing a wrong label; the raw mime stays available
 * in the watch page's technical-details group.
 */
export function containerLabel(mime: string | null): string | null {
  if (mime === null) return null;
  const base = mime.split(";")[0].trim().toLowerCase();
  const LABELS: Record<string, string> = {
    "video/mp4": "MP4",
    "video/x-matroska": "MKV",
    "video/quicktime": "MOV",
    "video/webm": "WebM",
    "video/x-msvideo": "AVI",
    "video/mpeg": "MPEG",
  };
  return LABELS[base] ?? null;
}

/**
 * Map a video's pixel height to a coarse resolution bucket label for badges.
 * Returns the *highest* applicable bucket, or `null` if `height` is below 360
 * (too small to badge) — `null` lets the caller skip rendering entirely.
 *
 * Buckets follow common marketing tiers: SD floor (480), HD (720), FHD (1080),
 * 4K (2160). Height is used because provider metadata occasionally omits
 * width (rotated/mobile clips); height is the more reliable signal.
 */
export function resolutionBucket(height: number | null): string | null {
  if (height === null) return null;
  if (height >= 2160) return "4K";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  if (height >= 480) return "480p";
  if (height >= 360) return "360p";
  return null;
}

/**
 * First letter of a video filename for placeholder rendering. Strips the
 * extension first (so "cat.mp4" → "C", not "c"), uppercases, and falls back
 * to "?" for empty/whitespace-only names.
 */
export function filenameInitial(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "").trim();
  if (stem.length === 0) return "?";
  return stem.charAt(0).toUpperCase();
}

/** Deterministic 0–359 hue from a string — stable per video id. Used for
 *  gradient placeholder backgrounds when thumbnails fail. */
export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) % 360;
  }
  return h;
}

/** ISO timestamp → "Aug 1, 2026" (or the raw string when parsing fails). */
export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
