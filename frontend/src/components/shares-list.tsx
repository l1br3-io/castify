// Shares list — `/shares` (app-redesign task 005) as the demo's table
// (task 017): Name / Items / Created / Expires / Status columns with
// per-row actions. Filters (status chips + search) are visible and
// resettable; zero-shares and no-results render EmptyState with a next
// action.
//
// Purge (FR-5.3, task 017): the destructive action is a ui/Dialog — it
// names the share, states exactly what is removed and that it cannot be
// undone, and its confirm button reads "Purge share", the same verb as the
// row button and the success toast ("Share purged"). Revoke keeps its
// lighter window.confirm: it is reversible-ish (the record stays, only the
// link dies) and predates this task's verb audit.
//
// Owner-facing list of every share (active and past) from a single
// `GET /api/shares` on mount — no polling. The server stays the source of
// truth for status: revoke confirms → `DELETE /api/shares/{id}` → the
// query is invalidated and refetched, and the row flips to the server's
// revoked state in place. Purge is `DELETE /api/shares/{id}?purge=true` —
// the row leaves the list on refetch and the recipient link 404s.
//
// Copy-link: the raw token crossed the wire only at creation time, so a
// row can offer a link only when *this browser* created the share
// (`lib/share-links-db.ts`). Shares created elsewhere render status only.
//
// Search + status chips (share-management task 006): everything is a
// synchronous client-side pass over the cached `useShares` data — zero
// network requests, and the server's newest-first order is preserved.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteShare, revokeShare, type ShareDto } from "../api/shares";
import { describeError, formatDate } from "../lib/format";
import { deleteShareLink, getShareLinkMap } from "../lib/share-links-db";
import { SHARES_QUERY_KEY, useShares } from "../hooks/use-shares";
import { useToast } from "../hooks/use-toast";
import { CopyLinkButton } from "./copy-link-button";
import { ShortLinkButton } from "./short-link-button";
import { StatusBadge } from "./status-badge";
import { Button } from "./ui/button";
import { buttonClasses, FOCUS_RING } from "./ui/button-classes";
import { Dialog } from "./ui/dialog";
import { EmptyState } from "./ui/empty-state";
import { ErrorState } from "./ui/error-state";
import { Input } from "./ui/field";
import { Skeleton } from "./ui/skeleton";

/** Chip values: the three server statuses plus "all". */
type StatusFilter = ShareDto["status"] | "all";

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "active", label: "Active" },
  { value: "expired", label: "Expired" },
  { value: "revoked", label: "Revoked" },
  { value: "all", label: "All" },
];

export function SharesSection() {
  return (
    <section aria-labelledby="shares-heading" className="space-y-4">
      <div>
        <h2 id="shares-heading" className="text-lg">
          Shares
        </h2>
        <p className="mt-1 text-sm text-[var(--color-castify-muted)]">
          Links you've shared. A link can be copied only on the device that
          created it — lost links can't be recovered.
        </p>
      </div>
      <SharesList />
    </section>
  );
}

function SharesList() {
  const navigate = useNavigate();
  const query = useShares();

  // Default Active (spec decision: past shares hide until asked for).
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [searchQuery, setSearchQuery] = useState("");

  // Local link map, read once on mount — it only changes when this browser
  // creates or revokes a share.
  const [linkMap, setLinkMap] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let alive = true;
    void getShareLinkMap().then((map) => {
      if (alive) setLinkMap(map);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (query.isPending) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load shares."
        body={describeError(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const shares = query.data;
  if (shares.length === 0) {
    return (
      <EmptyState
        title="No shares yet"
        body="Share a video from your library and it will appear here."
        onAction={() => navigate("/")}
        actionLabel="Share something"
      />
    );
  }

  // No debounce: this is a synchronous in-memory pass over the cached
  // list — nothing async happens, so there is nothing to wait for (unlike
  // the edit dialog's debounced search, which fronts a fetch-backed
  // picker). Filter (search AND chip), never re-sort — the server's
  // newest-first order stands.
  const needle = searchQuery.trim().toLowerCase();
  const searched = needle
    ? shares.filter((s) => s.title.toLowerCase().includes(needle))
    : shares;
  const visible =
    statusFilter === "all"
      ? searched
      : searched.filter((s) => s.status === statusFilter);
  const countFor = (filter: StatusFilter): number =>
    filter === "all"
      ? searched.length
      : searched.filter((s) => s.status === filter).length;

  function clearFilters(): void {
    setSearchQuery("");
    setStatusFilter("active");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Filter by status"
          className="flex flex-wrap gap-1"
        >
          {STATUS_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={statusFilter === value}
              onClick={() => setStatusFilter(value)}
              className={`keycap transition ${FOCUS_RING} ${
                statusFilter === value
                  ? "keycap-active"
                  : "keycap-inactive"
              }`}
            >
              {label} {countFor(value)}
            </button>
          ))}
        </div>
        <Input
          type="search"
          aria-label="Search shares by title"
          placeholder="Search shares…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-44"
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="No shares match"
          body="Try a different search or status filter."
          onAction={clearFilters}
          actionLabel="Clear search"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--color-castify-rule)] text-left">
                <th scope="col" className="px-2 py-2 font-medium">Name</th>
                <th scope="col" className="px-2 py-2 font-medium">Items</th>
                <th scope="col" className="px-2 py-2 font-medium">Created</th>
                <th scope="col" className="px-2 py-2 font-medium">Expires</th>
                <th scope="col" className="px-2 py-2 font-medium">Status</th>
                <th scope="col" className="px-2 py-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map((share) => (
                <ShareRow
                  key={share.id}
                  share={share}
                  linkPath={linkMap?.[share.id] ?? null}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ShareRow({ share, linkPath }: { share: ShareDto; linkPath: string | null }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [purgeOpen, setPurgeOpen] = useState(false);

  const revoke = useMutation({
    mutationFn: () => revokeShare(share.id),
    onSuccess: () => {
      // Refetch rather than patching locally — the server owns status.
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY });
      // The link is dead; stop offering it on this device.
      void deleteShareLink(share.id);
    },
  });

  const purge = useMutation({
    mutationFn: () => deleteShare(share.id),
    onSuccess: () => {
      // Refetch rather than patching locally — the server owns the list.
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY });
      void deleteShareLink(share.id);
      setPurgeOpen(false);
      // FR-5.3 verb audit: button "Purge share" → confirmation "Purge
      // share" → toast "Share purged".
      toast.success("Share purged");
    },
  });

  function handleRevoke(): void {
    if (
      window.confirm(
        `Revoke "${share.title}"? Recipients with the link immediately lose access.`,
      )
    ) {
      revoke.mutate();
    }
  }

  return (
    <tr className="border-b border-[var(--color-castify-rule)]">
      <td className="max-w-48 truncate px-2 py-2.5 font-medium" title={share.title}>
        {share.title}
      </td>
      <td className="figure px-2 py-2.5">{share.item_count}</td>
      <td className="px-2 py-2.5 text-[var(--color-castify-muted)]">
        {formatDate(share.created_at)}
      </td>
      <td className="px-2 py-2.5 text-[var(--color-castify-muted)]">
        {share.expires_at ? formatDate(share.expires_at) : "Never"}
      </td>
      <td className="px-2 py-2.5">
        <StatusBadge status={share.status} />
      </td>
      <td className="px-2 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {share.status === "active" && linkPath && (
            <>
              {/* Short alias is button-feedback only here (table density);
                  the dialog's post-creation view is where it shows as text. */}
              <CopyLinkButton linkPath={linkPath} />
              <ShortLinkButton shareId={share.id} linkPath={linkPath} />
            </>
          )}
          {share.status === "active" && (
            <Link
              to={`/settings/shares/${encodeURIComponent(share.id)}`}
              className={buttonClasses("secondary", "sm")}
            >
              Manage
            </Link>
          )}
          {share.status === "active" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleRevoke}
              pending={revoke.isPending}
            >
              {revoke.isPending ? "Revoking…" : "Revoke"}
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setPurgeOpen(true)}
          >
            Purge share
          </Button>
          {revoke.isError && (
            <p className="text-xs text-[var(--color-danger)]">
              {describeError(revoke.error)}
            </p>
          )}
        </div>

        {/* FR-5.3 purge confirmation: names the share, states exactly what
            is removed and that it cannot be undone; the confirm button
            carries the row button's verb. Dismissal is blocked mid-DELETE
            via `closeable` so the outcome can't land behind a closed
            dialog; failures surface inside the dialog for retry. */}
        <Dialog
          open={purgeOpen}
          onClose={() => setPurgeOpen(false)}
          closeable={!purge.isPending}
          title={`Purge "${share.title}"`}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setPurgeOpen(false)}
                disabled={purge.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => purge.mutate()}
                pending={purge.isPending}
              >
                {purge.isPending ? "Purging…" : "Purge share"}
              </Button>
            </>
          }
        >
          <p className="text-sm text-[var(--color-castify-muted)]">
            The share and its {share.item_count}{" "}
            {share.item_count === 1 ? "item" : "items"} will be removed from
            your list, and recipients with the link immediately lose access.
          </p>
          <p className="text-sm font-semibold">This cannot be undone.</p>
          {purge.isError && (
            <p role="alert" className="text-sm text-[var(--color-danger)]">
              {describeError(purge.error)}
            </p>
          )}
        </Dialog>
      </td>
    </tr>
  );
}
