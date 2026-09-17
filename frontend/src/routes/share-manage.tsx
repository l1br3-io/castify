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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { PosterCard } from "../components/poster-card";
import { ShareEditDialog } from "../components/share-edit-dialog";
import { ShareItemMenu } from "../components/share-item-menu";
import { StatusBadge } from "../components/status-badge";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Skeleton } from "../components/ui/skeleton";
import { SkeletonGrid } from "../components/ui/skeleton-grid";
import { replaceShareItems, fetchShareItemsOwned, type ShareDto } from "../api/shares";
import type { VideoSummaryDto } from "../api/types";
import { describeError, formatDate } from "../lib/format";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { shareItemsOwnedKey, useShareItemsOwned } from "../hooks/use-share-items";
import { SHARES_QUERY_KEY, useShares } from "../hooks/use-shares";
import { useToast } from "../hooks/use-toast";

/** Undo window — the spec's 5 seconds (info default is 4s). */
const UNDO_TTL_MS = 5000;

/** Last-item guard copy (task 004; server enforces non-empty with 400). */
const LAST_ITEM_HINT =
  "A share needs at least one item — revoke the share instead.";

/** Matches the dialog + browse SearchBar debounce — one filter per pause.
 * The filter itself is client-side (no fetch): members are already loaded. */
const SEARCH_DEBOUNCE_MS = 300;

export function ShareManagePage() {
  const { id } = useParams<{ id: string }>();
  const shares = useShares();
  const share =
    shares.data?.find((s) => s.id === id) ?? null;

  if (shares.isPending) {
    return (
      <section className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-40" />
        <SkeletonGrid />
      </section>
    );
  }

  if (shares.isError) {
    return (
      <section className="space-y-4">
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
      <section className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
        <EmptyState
          title="This share doesn't exist."
          body="It may have been created on another device — the list below is everything on this server."
        />
        <div className="mt-4 text-center">
          <Link
            to="/shares"
            className="text-sm text-[var(--color-castify-accent-strong)] hover:underline"
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
  const queryClient = useQueryClient();
  const toast = useToast();

  // In-flight removals, subtracted when computing the next PUT's id list.
  // Set membership spans the whole stale-cache window — from onMutate until
  // the post-PUT refetch LANDS (not just the 204): between the PUT's success
  // and that refetch, the cached list is stale, and a second removal
  // computed from it would resurrect the first-removed item. The undo path
  // filters the same set so a restore can never re-assert an id whose
  // removal is still in flight.
  const pendingRemovals = useRef(new Set<string>());
  // Single-slot undo: a newer removal dismisses the prior toast (undo
  // restores only the most recent — the page copy names the item).
  const lastToastId = useRef<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  function invalidateMemberQueries(): Promise<void> {
    void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY });
    return queryClient.invalidateQueries({
      queryKey: shareItemsOwnedKey(share.id),
    });
  }

  /** Freshest member list, deduped against any in-flight refetch.
   * `ensureQueryData` (not `getQueryData`) because the cache can be absent
   * or stale at exactly the wrong moments: the add-only dialog drops the
   * entry on save (`removeQueries`) while this page's refetch is starting,
   * and an Undo can outlive navigation away (inactive query, no observer,
   * stale data). Joining the in-flight fetch beats reading around it. */
  function freshMemberIds(): Promise<VideoSummaryDto[]> {
    return queryClient.ensureQueryData({
      queryKey: shareItemsOwnedKey(share.id),
      queryFn: () => fetchShareItemsOwned(share.id),
    });
  }

  async function undoRemoval(snapshot: {
    video: VideoSummaryDto;
    index: number;
  }): Promise<void> {
    try {
      const current = await freshMemberIds();
      // Never re-assert an id whose removal is still in flight — an undo
      // racing a newer removal must not resurrect what that removal is
      // taking out (last-writer-wins would otherwise flip either way).
      const ids = current
        .filter((v) => !pendingRemovals.current.has(v.id))
        .map((v) => v.id);
      const at = Math.min(snapshot.index, ids.length);
      await replaceShareItems(share.id, [
        ...ids.slice(0, at),
        snapshot.video.id,
        ...ids.slice(at),
      ]);
      await invalidateMemberQueries();
    } catch {
      toast.error("Couldn't restore the item. Reload the page and try again.");
    }
  }

  function pushUndoToast(snapshot: {
    video: VideoSummaryDto;
    index: number;
  }): void {
    if (lastToastId.current !== null) {
      toast.dismiss(lastToastId.current);
    }
    lastToastId.current = toast.info(`Removed '${snapshot.video.name}'`, {
      ttlMs: UNDO_TTL_MS,
      action: {
        label: "Undo",
        onAction: () => void undoRemoval(snapshot),
      },
    });
  }

  const remove = useMutation({
    mutationFn: async ({ video }: { video: VideoSummaryDto; index: number }) => {
      // Freshest list (deduped against any in-flight refetch — see
      // freshMemberIds) minus in-flight removals. Never the render
      // closure's items.data, which can predate a dialog save.
      const base = await freshMemberIds();
      const ids = base
        .filter(
          (v) => v.id !== video.id && !pendingRemovals.current.has(v.id),
        )
        .map((v) => v.id);
      return replaceShareItems(share.id, ids);
    },
    onMutate: ({ video }) => {
      setRemoveError(null);
      pendingRemovals.current.add(video.id);
    },
    onSuccess: async (_data, snapshot) => {
      // Pop the guard only AFTER the refetch lands (see pendingRemovals):
      // the stale-cache window is exactly PUT-204 → refetch-completion.
      // Also: await before offering Undo — undo splices into the cached
      // list, which must already reflect the removal or the restore could
      // double-insert (a duplicate the server would 400).
      await invalidateMemberQueries();
      pendingRemovals.current.delete(snapshot.video.id);
      pushUndoToast(snapshot);
    },
    onError: (error: unknown, { video }) => {
      pendingRemovals.current.delete(video.id);
      setRemoveError(describeError(error));
    },
  });

  function handleRemove(video: VideoSummaryDto): void {
    const index = (items.data ?? []).findIndex((v) => v.id === video.id);
    remove.mutate({ video, index: Math.max(index, 0) });
  }

  const count = items.data?.length ?? share.item_count;
  const canRemoveItems = (items.data?.length ?? 0) > 1;

  // Task 005: client-side search over the loaded members. Filtering is
  // render-only — removal targets, undo indices, and the last-item guard
  // all read the unfiltered `items.data`.
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const [isAdding, setIsAdding] = useState(false);
  const query = debouncedSearch.trim().toLowerCase();
  const visibleItems = query
    ? items.data?.filter((v) => v.name.toLowerCase().includes(query))
    : items.data;

  return (
    <section className="space-y-4">
      <div>
        <Link
          to="/shares"
          className="text-sm text-[var(--color-castify-accent-strong)] hover:underline"
        >
          ← Back to shares
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{share.title}</h1>
          <StatusBadge status={share.status} />
        </div>
        <p className="mt-1 text-sm text-[var(--color-castify-muted)]">
          {count} {count === 1 ? "item" : "items"} · created{" "}
          {formatDate(share.created_at)}
          {share.expires_at ? ` · expires ${formatDate(share.expires_at)}` : ""}
        </p>
        {share.status !== "active" && (
          <p className="mt-1 text-sm text-[var(--color-castify-muted)]">
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

      {/* Unreachable while the server enforces non-empty lists — kept so
          the page degrades sanely if that ever changes. */}
      {items.data && items.data.length === 0 && (
        <EmptyState
          title="Nothing in this share."
          body="Add items to make the link useful."
        />
      )}

      {items.data && items.data.length > 0 && (
        <>
          {share.status === "active" && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <input
                type="search"
                aria-label="Search this share"
                placeholder="Search this share…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full max-w-xs rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-canvas)] px-3 py-2 text-sm placeholder:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
              />
              <button
                type="button"
                onClick={() => setIsAdding(true)}
                className="rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-on-accent)] transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
              >
                Add items
              </button>
            </div>
          )}
          {visibleItems && visibleItems.length === 0 && query && (
            <EmptyState
              title="No videos match."
              body={`Nothing in this share matches “${debouncedSearch.trim()}”.`}
            />
          )}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {visibleItems?.map((video) => {
            // With two removals in flight this dims only the latest's
            // card (mutation.variables holds one); the earlier card's PUT
            // is still protected by pendingRemovals — cosmetic only.
            const isRemoving =
              remove.isPending && remove.variables?.video.id === video.id;
            return (
              <div
                key={video.id}
                className={`transition-opacity ${isRemoving ? "pointer-events-none opacity-50" : ""}`}
              >
                <PosterCard
                  video={video}
                  href={`/watch/${encodeURIComponent(video.id)}`}
                  topRightSlot={
                    share.status === "active" ? (
                      <ShareItemMenu
                        videoName={video.name}
                        videoHref={`/watch/${encodeURIComponent(video.id)}`}
                        canRemove={canRemoveItems}
                        removeHint={LAST_ITEM_HINT}
                        onRemove={() => handleRemove(video)}
                      />
                    ) : undefined
                  }
                />
              </div>
            );
          })}
          </div>
        </>
      )}

      {isAdding && (
        <ShareEditDialog share={share} onClose={() => setIsAdding(false)} />
      )}

      {remove.isError && removeError && (
        <p
          role="alert"
          aria-label="Couldn't remove"
          className="text-sm text-[var(--color-castify-accent-dim)]"
        >
          Couldn&apos;t remove this item: {removeError}
        </p>
      )}
    </section>
  );
}

