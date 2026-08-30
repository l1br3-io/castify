// Share manage page (share-manage-page task 003) — the owner-facing detail
// route at `/settings/shares/:id`.
//
// Two-read composition, no new endpoints:
//   * meta   — `useShares()` (the Settings list query, already cached) with
//     a find-by-id; there is no single-share GET, and the list is the
//     server-owned source for status/expiry.
//   * members — `useShareItemsOwned` (curation order). Serves terminal
//     shares too: read-only history, same as the edit dialog's GET.
//
// State machine mirrors the recipient landing (`share.tsx`): pending →
// skeleton, list error → ErrorState retry, unknown id after load →
// not-found card. Terminal shares render the grid with a read-only note —
// removal/add affordances are active-share-only and arrive with tasks
// 004/005; the server would 409 any edit anyway.
//
// Cards reuse `PosterCard` with the owner scope (session-gated thumbnails,
// `/watch/:id` links) — this page is the owner's mirror of what recipients
// see, plus management on top.

import { Link, useParams } from "react-router-dom";

import { PosterCard } from "../components/poster-card";
import { StatusBadge } from "../components/shares-list";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Skeleton } from "../components/ui/skeleton";
import type { ShareDto } from "../api/shares";
import { describeError } from "../lib/format";
import { useShareItemsOwned } from "../hooks/use-share-items";
import { useShares } from "../hooks/use-shares";

export function ShareManagePage() {
  const { id } = useParams<{ id: string }>();
  const shares = useShares();
  const share =
    shares.data?.find((s) => s.id === id) ?? null;

  if (shares.isPending) {
    return (
      <section className="mx-auto max-w-7xl space-y-4 px-4 py-10">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-40" />
        <SkeletonGrid />
      </section>
    );
  }

  if (shares.isError) {
    return (
      <section className="mx-auto max-w-7xl px-4 py-10">
        <ErrorState
          title="Couldn't load this share."
          body={describeError(shares.error)}
          onRetry={() => void shares.refetch()}
        />
      </section>
    );
  }

  if (!share) {
    return (
      <section className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-4 py-10">
        <EmptyState
          title="This share doesn't exist."
          body="It may have been created on another device — the list below is everything on this server."
        />
        <div className="mt-4 text-center">
          <Link
            to="/settings"
            className="text-sm text-[var(--color-castify-accent)] hover:underline"
          >
            Back to shares
          </Link>
        </div>
      </section>
    );
  }

  return <ShareDetail share={share} />;
}

function ShareDetail({ share }: { share: ShareDto }) {
  const items = useShareItemsOwned(share.id);
  const count = items.data?.length ?? share.item_count;

  return (
    <section className="mx-auto max-w-7xl space-y-4 px-4 py-10">
      <div>
        <Link
          to="/settings"
          className="text-sm text-[var(--color-castify-accent)] hover:underline"
        >
          ← Back to shares
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{share.title}</h1>
          <StatusBadge status={share.status} />
        </div>
        <p className="mt-1 text-sm opacity-60">
          {count} {count === 1 ? "item" : "items"} · created{" "}
          {formatDate(share.created_at)}
          {share.expires_at ? ` · expires ${formatDate(share.expires_at)}` : ""}
        </p>
        {share.status !== "active" && (
          <p className="mt-1 text-sm opacity-60">
            This share is {share.status === "revoked" ? "revoked" : "expired"} —
            its link is no longer available. The list below is read-only.
          </p>
        )}
      </div>

      {items.isPending && <SkeletonGrid />}

      {items.isError && (
        <ErrorState
          title="Couldn't load this share's items."
          body={describeError(items.error)}
          onRetry={() => void items.refetch()}
        />
      )}

      {items.data && items.data.length === 0 && (
        <EmptyState
          title="Nothing in this share."
          body="Add items to make the link useful."
        />
      )}

      {items.data && items.data.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.data.map((video) => (
            <PosterCard
              key={video.id}
              video={video}
              href={`/watch/${encodeURIComponent(video.id)}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-2"
        >
          <Skeleton className="aspect-video w-full" />
          <div className="space-y-1.5 px-1 pb-1">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** ISO timestamp → "Aug 1, 2026" (or the raw string when parsing fails). */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
