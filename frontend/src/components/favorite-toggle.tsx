// FavoriteToggle — heart-icon button that flips a video's `is_favorite`.
//
// Placements (PRD FR-5, FR-8.2, FR-9.2):
//   * PosterCard (`variant="card"`): top-right corner. Hover-revealed when
//     *not* favorited; always visible when favorited, so the heart state
//     is glanceable without hovering. JS DOM `opacity-0 group-hover:opacity-100`
//     drives the reveal — the parent PosterCard's `group` class scopes it.
//   * HeroShowcase (`variant="hero"`): always visible, larger, with text label.
//
// Optimistic UX: the underlying `useSetFavorite` / `useUnsetFavorite` hooks
// patch the `['videos']` cache before the network resolves, so the heart
// flips immediately and rolls back on error. The component reads
// `video.is_favorite` straight from the (already-optimistic) prop — the
// parent re-renders when the cache changes, prop is the source of truth.

import { HeartIcon } from "./icons";
import type { VideoSummaryDto } from "../api/types";
import { useSetFavorite, useUnsetFavorite } from "../hooks/use-favorite";
import { useToast } from "../hooks/use-toast";

type Variant = "card" | "hero";

type FavoriteToggleProps = {
  video: VideoSummaryDto;
  variant?: Variant;
};

export function FavoriteToggle({
  video,
  variant = "card",
}: FavoriteToggleProps) {
  const setFav = useSetFavorite();
  const unsetFav = useUnsetFavorite();
  const toast = useToast();
  const isFavorite = video.is_favorite;

  function handleClick() {
    const onError = () => toast.error("Couldn't save favorite. Try again.");
    if (isFavorite) {
      unsetFav.mutate(video.id, { onError });
    } else {
      setFav.mutate(video.id, { onError });
    }
  }

  const pending = setFav.isPending || unsetFav.isPending;

  if (variant === "hero") {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        aria-pressed={isFavorite}
        aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
        className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white backdrop-blur transition hover:bg-white/20 disabled:opacity-50"
      >
        <HeartIcon filled={isFavorite} className="h-5 w-5" />
        <span>{isFavorite ? "Favorited" : "Favorite"}</span>
      </button>
    );
  }

  // Card variant: visible by default at low prominence; full opacity when
  // favorited or on hover/focus. Previously hover-gated which made the
  // control undiscoverable for new users (design-pass §4 audit).
  const visibility = isFavorite
    ? "opacity-100"
    : "opacity-70 group-hover:opacity-100 focus-visible:opacity-100";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      aria-pressed={isFavorite}
      aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
      title={isFavorite ? "Remove from favorites" : "Add to favorites"}
      className={`flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur transition ${visibility} hover:bg-black/70 hover:text-[var(--color-castify-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-50 ${
        isFavorite ? "text-[var(--color-castify-accent)]" : ""
      }`}
    >
      <HeartIcon filled={isFavorite} className="h-4 w-4" />
    </button>
  );
}
