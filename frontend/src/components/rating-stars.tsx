// RatingStars — 5-star rating widget.
//
// Placements (PRD FR-6, FR-8.2, FR-9.2):
//   * PosterCard (`variant="card"`): body row under the year/provider
//     line. Always visible (rated or not) — no hover gating, so the
//     rating state is glanceable and the affordance is discoverable.
//   * HeroShowcase (`variant="hero"`): always visible, larger stars.
//
// Interaction (plan L1119–1124):
//   * Hover over star N → preview stars 1..N filled (no network call).
//   * Click star N:
//       - If `my_rating === N` → clear (DELETE /rating).
//       - Otherwise → set rating N (PUT /rating `{ rating: N }`).
//   * Mouse leave → preview cleared, displayed rating reverts to `my_rating`.
//
// Optimistic UX: the `useSetRating` / `useUnsetRating` hooks patch
// `my_rating` in the `['videos']` cache before the network resolves, so
// stars flip immediately and roll back on error.

import { useState } from "react";

import { StarIcon } from "./icons";
import type { VideoSummaryDto } from "../api/types";
import { useSetRating, useUnsetRating } from "../hooks/use-rating";
import { useToast } from "../hooks/use-toast";

const STAR_VALUES = [1, 2, 3, 4, 5] as const;

type Variant = "card" | "hero";

type RatingStarsProps = {
  video: VideoSummaryDto;
  variant?: Variant;
};

export function RatingStars({ video, variant = "card" }: RatingStarsProps) {
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const setRating = useSetRating();
  const unsetRating = useUnsetRating();
  const toast = useToast();

  const currentRating = video.my_rating;
  const displayed = hoverRating ?? currentRating ?? 0;
  const pending = setRating.isPending || unsetRating.isPending;

  function handleClick(star: number) {
    if (pending) return;
    const onError = () => toast.error("Couldn't save rating. Try again.");
    if (currentRating === star) {
      unsetRating.mutate(video.id, { onError });
    } else {
      setRating.mutate({ videoId: video.id, rating: star }, { onError });
    }
  }

  if (variant === "hero") {
    return (
      <div
        role="group"
        aria-label="Rate this video"
        className="flex items-center gap-1"
      >
        {STAR_VALUES.map((star) => (
          <button
            key={star}
            type="button"
            onClick={() => handleClick(star)}
            disabled={pending}
            onMouseEnter={() => setHoverRating(star)}
            onMouseLeave={() => setHoverRating(null)}
            aria-label={`${star} star${star > 1 ? "s" : ""}`}
            aria-checked={currentRating === star}
            role="radio"
            className="text-amber-400 transition hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-50"
          >
            <StarIcon filled={star <= displayed} className="h-6 w-6" />
          </button>
        ))}
      </div>
    );
  }

  // Card variant: body row in PosterCard — always visible, no hover gating.
  return (
    <div
      role="group"
      aria-label="Rate this video"
      onMouseLeave={() => setHoverRating(null)}
      className="flex items-center gap-0.5"
    >
      {STAR_VALUES.map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => handleClick(star)}
          disabled={pending}
          onMouseEnter={() => setHoverRating(star)}
          aria-label={`${star} star${star > 1 ? "s" : ""}`}
          aria-checked={currentRating === star}
          role="radio"
          className="text-amber-400 transition hover:scale-110 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/50 disabled:opacity-50"
        >
          <StarIcon filled={star <= displayed} className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
