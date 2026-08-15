// Shared badge primitives used by PosterCard, Shelf, ContinueWatchingCard,
// and the watch-page header. Extracted from M1's `routes/videos.tsx` to
// keep the badge styling consistent across every surface that shows
// provider attribution + dedup state.

import { PROVIDER_LABELS, type ProviderKey } from "../api/types";

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
