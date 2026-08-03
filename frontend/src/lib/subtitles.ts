// Subtitle format helpers shared across the watch page + future burn-in UX.
//
// The backend normalizes `format` to a lowercase codec string at probe time
// (`crates/catalog/src/probe.rs`): `srt`, `vtt`, `ass`, `ssa`, `pgs`,
// `vobsub`, etc. `format_family` (`"text" | "image"`) is the coarse routing
// key; these helpers branch on the specific format where family isn't enough
// — notably ASS/SSA, which is text-family but must bypass the native
// `<track>` element and render through the libass canvas overlay (Task 004).

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
