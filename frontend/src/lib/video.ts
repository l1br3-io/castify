// Video-domain helpers shared across PosterCard and Shelf. Extracted from
// poster-card.tsx when the second caller arrived (deviation #43 — Rule 0:
// single caller = inline, second caller = lift into shared module).

import type { ProviderKey, VideoSummaryDto } from "../api/types";

/**
 * Providers from `video.sources` excluding the representative's own provider.
 * Used to decide whether to render a DedupBadge ("Also in: …").
 */
export function otherProviders(video: VideoSummaryDto): ProviderKey[] {
  return video.sources
    .map((s) => s.provider)
    .filter((p) => p !== video.provider);
}
