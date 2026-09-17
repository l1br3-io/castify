// Shared badge primitives used by PosterCard, Shelf, ContinueWatchingCard,
// and the watch-page header. Extracted from M1's `routes/videos.tsx` to
// keep the badge styling consistent across every surface that shows
// provider attribution + dedup state.

import { PROVIDER_LABELS, type ProviderKey } from "../api/types";

// ── Provider marks ────────────────────────────────────────────────────────
//
// Official brand artwork for the Sources page (connect buttons + connection
// cards). Brand color appears ONLY here and on the sign-in buttons (spec
// § Tokens: never large fills, never state indicators). All marks are
// aria-hidden: the provider name is always adjacent text, so identity is
// never conveyed by the mark — or its color — alone.
//
// Google's "G" and Microsoft's four squares are multicolor logo artwork
// (fixed official fills — they don't theme); Dropbox and the generic S3
// glyph draw with `currentColor` so the caller picks the hue (brand blue
// on cards, white on the Dropbox sign-in button, muted on S3 cards).

const GOOGLE_G_PATHS = (
  <>
    <path
      fill="#4285F4"
      d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
    />
    <path
      fill="#34A853"
      d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
    />
    <path
      fill="#FBBC05"
      d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
    />
    <path
      fill="#EA4335"
      d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
    />
  </>
);

const DROPBOX_GLYPH_PATH =
  "M6 1.807 0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z";

const MICROSOFT_SQUARES = (
  <>
    <rect x="1" y="1" width="10" height="10" fill="#f25022" />
    <rect x="13" y="1" width="10" height="10" fill="#7fba00" />
    <rect x="1" y="13" width="10" height="10" fill="#00a4ef" />
    <rect x="13" y="13" width="10" height="10" fill="#ffb900" />
  </>
);

type ProviderMarkProps = {
  provider: ProviderKey;
  className?: string;
  /** Test hook override — the sign-in buttons re-tag their embedded mark. */
  testId?: string;
};

const MARK_TEST_ID = "provider-mark";

/** Official provider mark. Decorative (aria-hidden) — pair with the
 * provider's name as adjacent text. */
export function ProviderMark({ provider, className, testId }: ProviderMarkProps) {
  const testIdAttr = { "data-testid": testId ?? MARK_TEST_ID };
  if (provider === "google_drive") {
    return (
      <svg
        viewBox="0 0 18 18"
        className={className}
        aria-hidden
        {...testIdAttr}
      >
        {GOOGLE_G_PATHS}
      </svg>
    );
  }
  if (provider === "dropbox") {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        aria-hidden
        {...testIdAttr}
      >
        <path fill="currentColor" d={DROPBOX_GLYPH_PATH} />
      </svg>
    );
  }
  if (provider === "onedrive") {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        aria-hidden
        {...testIdAttr}
      >
        {MICROSOFT_SQUARES}
      </svg>
    );
  }
  // S3-compatible storage is a category, not a brand — a neutral database
  // glyph in currentColor.
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...testIdAttr}
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

type ProviderBadgeProps = {
  provider: ProviderKey;
};

/** Neutral pill showing the provider display name. */
export function ProviderBadge({ provider }: ProviderBadgeProps) {
  return (
    <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium opacity-80">
      {PROVIDER_LABELS[provider] ?? provider}
    </span>
  );
}

type DedupBadgeProps = {
  providers: ProviderKey[];
};

/**
 * Accent pill listing providers *other than* the representative that also
 * hold this video. Pass only the additional providers (filter out the
 * representative's own provider upstream).
 */
export function DedupBadge({ providers }: DedupBadgeProps) {
  const labels = providers.map((p) => PROVIDER_LABELS[p] ?? p).join(", ");
  return (
    <span
      className="rounded-full bg-[var(--color-castify-accent)]/20 px-2 py-0.5 text-xs font-medium text-[var(--color-castify-accent)]"
      title="This video appears in multiple providers"
    >
      Also in: {labels}
    </span>
  );
}
