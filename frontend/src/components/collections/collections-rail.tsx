// Collections rail (library-collections task 008, spec F5): horizontal
// rail of collection cards above the browse grid. Self-fetching and
// silent — no collections (or a failed query) renders nothing, so the
// browse layout is untouched for users without collections. Mirrors the
// `Shelf` scroll conventions (hidden scrollbar, snap proximity, trailing
// spacer) with collection cards instead of PosterCards.

import { Link } from "react-router-dom";

import type { CollectionDto, CollectionKind } from "../../api/types";
import { useCollections } from "../../hooks/use-collections";
import { Thumbnail } from "../thumbnail";

const KIND_LABELS: Record<CollectionKind, string> = {
  show: "Series",
  movie: "Movie",
  time: "Time group",
  manual: "Collection",
};

export function CollectionsRail() {
  const collections = useCollections();

  // Quiet by contract: empty or errored renders nothing (spec F3 — the
  // section exists only once the user has collections).
  const data = collections.data;
  if (!data || data.length === 0) return null;

  return (
    <section className="space-y-2" aria-label="Collections">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xl">Collections</h2>
        <span className="figure text-sm text-[var(--color-castify-muted)]">
          · {data.length}
        </span>
      </div>
      <div
        className="no-scrollbar flex gap-3 overflow-x-auto pb-2 pr-4"
        style={{ scrollSnapType: "x proximity" }}
      >
        {data.map((collection) => (
          <CollectionCard key={collection.id} collection={collection} />
        ))}
        <div aria-hidden className="w-1 flex-shrink-0" />
      </div>
    </section>
  );
}

function CollectionCard({ collection }: { collection: CollectionDto }) {
  const preview = collection.preview[0];

  return (
    <Link
      to={`/collections/${collection.id}`}
      className="w-[200px] flex-shrink-0 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-2 transition hover:border-[var(--color-castify-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-canvas)]"
      style={{ scrollSnapAlign: "start" }}
    >
      <div className="aspect-video overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-castify-rule)]">
        {preview ? (
          <Thumbnail video={preview} />
        ) : (
          // Empty collections (or preview members that vanished) get a
          // quiet tinted block — the card stays meaningful via its text.
          <div className="h-full w-full bg-[var(--color-castify-muted)]/20" />
        )}
      </div>
      <div className="mt-2 space-y-1">
        <p className="line-clamp-2 text-sm font-medium">{collection.name}</p>
        <p className="text-xs text-[var(--color-castify-muted)]">
          {`${KIND_LABELS[collection.kind]} · ${
            collection.member_count === 1
              ? "1 video"
              : `${collection.member_count} videos`
          }`}
        </p>
      </div>
    </Link>
  );
}
