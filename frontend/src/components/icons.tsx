// Inline SVG icon primitives. No icon library is used (zero new deps).
//
// Both icons render with `currentColor` so callers control hue via the
// `text-*` Tailwind utilities on the parent. The `filled` prop switches
// between solid (`fill="currentColor"`) and outline (`fill="none"` with a
// stroked path) — sized via the parent's `h-*` / `w-*` (the svg itself is
// `h-full w-full`).
//
// The player control icons (PlayIcon, etc.) are single-state filled glyphs —
// toggles render a *different* icon rather than flipping `filled` on one.
//
// ESLint `react-refresh/only-export-components` requires this file to
// export *only* components — no helpers alongside (deviation #43 lesson).

type IconProps = {
  filled: boolean;
  className?: string;
};

type PlayerIconProps = {
  className?: string;
};

/** Heart icon — favorite indicator. */
export function HeartIcon({ filled, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

/** Star icon — rating unit. */
export function StarIcon({ filled, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Player control icons (M3 T8). Single-state filled glyphs; a toggle renders
// a different icon rather than flipping `filled`.
// ---------------------------------------------------------------------------

/** Play (triangle) — shown when paused. */
export function PlayIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

/** Pause (two bars) — shown when playing. */
export function PauseIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="currentColor"
      aria-hidden
    >
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}

/** Volume high — speaker with sound waves. */
export function VolumeHighIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="currentColor"
      aria-hidden
    >
      <path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z" />
    </svg>
  );
}

/** Volume mute — speaker with X (Material "volume off"). */
export function VolumeMuteIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="currentColor"
      aria-hidden
    >
      <path d="M16.5 12a4.5 4.5 0 0 0-2.5-4v2.18l2.45 2.45A4.5 4.5 0 0 0 16.5 12zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.96 8.96 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.17v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
    </svg>
  );
}

/** Fullscreen enter — four expanding corner brackets. */
export function FullscreenEnterIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="currentColor"
      aria-hidden
    >
      <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
    </svg>
  );
}

/** Fullscreen exit — four contracting corner brackets. */
export function FullscreenExitIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="currentColor"
      aria-hidden
    >
      <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
    </svg>
  );
}

/** Subtitles (CC) — rectangle with caption lines. */
export function SubtitlesIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="currentColor"
      aria-hidden
    >
      <path d="M19 4H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H5V6h14v12zM7 15h4v-1H7v1zm5 0h5v-1h-5v1zm-5-3h5v-1H7v1zm6 0h4v-1h-4v1z" />
    </svg>
  );
}

/** Next track (skip) — triangle + bar. Shown for "skip to next video". */
export function NextIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="currentColor"
      aria-hidden
    >
      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
    </svg>
  );
}

/** Previous track (skip) — bar + triangle. Shown for "skip to previous video". */
export function PrevIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="currentColor"
      aria-hidden
    >
      <path d="M6 6h2v12H6zm3.5 6L18 18V6z" />
    </svg>
  );
}

/** Sun — light-mode indicator (shown when current theme is dark, click switches to light). */
export function SunIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

/** Moon — dark-mode indicator (shown when current theme is light, click switches to dark). */
export function MoonIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/** Close (×) — drawer/sheet dismissal and chip removal. */
export function CloseIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** Sliders — "more filters" drawer toggle. */
export function SlidersIcon({ className }: PlayerIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5" />
      <circle cx="16" cy="6" r="2" fill="currentColor" />
      <circle cx="8" cy="12" r="2" fill="currentColor" />
      <circle cx="13" cy="18" r="2" fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// File-kind icons (M9 task 010). Single-state outline glyphs identifying
// non-media entries in the folder organizer. A file's kind is identity, not
// a state — no `filled` prop.
// ---------------------------------------------------------------------------

type KindIconProps = {
  className?: string;
};

/** Music note — audio files. */
export function AudioIcon({ className }: KindIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

/** Photo frame — image files. */
export function ImageIcon({ className }: KindIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
    </svg>
  );
}

/** Caption dialog — subtitle files. */
export function SubtitleIcon({ className }: KindIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 14h4M14 14h4" />
    </svg>
  );
}

/** Document page — documents. */
export function DocIcon({ className }: KindIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M9 13h6M9 17h4" />
    </svg>
  );
}

/** Archive box — archives. */
export function ArchiveIcon({ className }: KindIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

/** Generic file — anything unrecognized. */
export function FileIcon({ className }: KindIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-full w-full"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
