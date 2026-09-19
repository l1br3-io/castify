// Collections index page (`/collections`, collections-page task 002):
// the overview for the whole collection set — a responsive
// CollectionCard grid (2 cols mobile → 6 xl, mirroring the browse
// poster grid) over `GET /api/collections`.
//
// States: skeleton grid while loading, `ErrorState` with retry on
// failure, and — for the truly-empty library — a CTA pointing at the
// scan→review pipeline (filtered-empty is task 003's concern; the
// "New collection" button joins the header in task 006).
//
// The a11y identity is the sr-only `h1`; the visible identity is the
// header row below it (browse-page precedent — stats/counts live in
// the row, not the heading).

import { useNavigate } from "react-router-dom";

import { useCollections } from "../hooks/use-collections";
import { CollectionCard } from "../components/collections/collection-card";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Skeleton } from "../components/ui/skeleton";

export function CollectionsPage() {
  const collections = useCollections();
  const navigate = useNavigate();

  if (collections.isLoading) {
    return (
      <section className="space-y-6">
        <h1 className="sr-only">Collections</h1>
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-video w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (collections.isError) {
    return (
      <section className="space-y-6">
        <h1 className="sr-only">Collections</h1>
        <ErrorState
          title="Couldn't load collections."
          body="Your collections can't be reached right now."
          onRetry={() => void collections.refetch()}
        />
      </section>
    );
  }

  const data = collections.data ?? [];

  if (data.length === 0) {
    return (
      <section className="space-y-6">
        <h1 className="sr-only">Collections</h1>
        <EmptyState
          title="No collections yet"
          body="Connect a source and run a scan — Castify proposes collections you can review — or gather videos from any watch page."
          onAction={() => navigate("/connections")}
          actionLabel="Connect a source"
        />
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <h1 className="sr-only">Collections</h1>
      <div className="flex items-baseline gap-2">
        <h2 className="text-xl">Collections</h2>
        <span className="figure text-sm text-[var(--color-castify-muted)]">
          · {data.length}
        </span>
        {/* "New collection" button lands with task 006. */}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {data.map((collection) => (
          <CollectionCard key={collection.id} collection={collection} />
        ))}
      </div>
    </section>
  );
}
