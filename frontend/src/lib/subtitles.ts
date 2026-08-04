// Subtitle format helpers shared across the watch page + burn-in UX.
//
// The backend normalizes `format` to a lowercase codec string at probe time
// (`crates/catalog/src/probe.rs`): `srt`, `vtt`, `ass`, `ssa`, `pgs`,
// `vobsub`, etc. `format_family` (`"text" | "image"`) is the coarse routing
// key; these helpers branch on the specific format where family isn't enough
// — notably ASS/SSA, which is text-family but must bypass the native
// `<track>` element and render through the libass canvas overlay (Task 004),
// and image-family tracks (PGS/VobSub), which require server-side burn-in
// (Task 009).

import type { SubtitleTrackDto } from "../api/types";

/**
 * True when the format is ASS or SSA — the two formats libass renders with
 * full styling (positioning, fonts, effects, karaoke). The native `<track>`
 * element strips these to plain text, so the watch route routes ASS tracks
 * to the libass canvas overlay instead.
 *
 * Case-sensitive: the backend stores lowercase, so an uppercase value
 * indicates a bug we want to surface rather than silently accept.
 */
export function isAssFormat(format: string): boolean {
  return format === "ass" || format === "ssa";
}

/**
 * True when the track is image-family (PGS, VobSub) — the formats that
 * cannot be rendered client-side and must be burned into the transcode
 * server-side (Task 008/009). The watch page uses this to route an
 * image-track selection to the burn-in flow instead of the `<track>` /
 * libass path.
 */
export function isImageFamily(
  track: Pick<SubtitleTrackDto, "format_family">,
): boolean {
  return track.format_family === "image";
}

/**
 * Build the subtitle menu item label with a format hint: `"en (VTT)"` for
 * text-family tracks, `"es (PGS — burned)"` for image-family tracks (Task
 * 010 FR-5.1). The burn suffix tells the user upfront that selecting this
 * track restarts playback with subtitles baked in — no surprise when the
 * transcode kicks off.
 */
export function subtitleLabel(
  track: Pick<SubtitleTrackDto, "language" | "format" | "format_family">,
): string {
  const lang = track.language ?? "Unknown";
  const fmt = track.format.toUpperCase();
  if (isImageFamily(track)) {
    return `${lang} (${fmt} — burned)`;
  }
  return `${lang} (${fmt})`;
}
