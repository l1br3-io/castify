// Shares management section for the Settings page (task 011).
//
// Owner-facing list of every share (active and past) from a single
// `GET /api/shares` on mount — no polling. The server stays the source of
// truth for status: revoke confirms → `DELETE /api/shares/{id}` → the
// query is invalidated and refetched, and the row flips to the server's
// revoked state in place.
//
// Copy-link: the raw token crossed the wire only at creation time (task
// 002), so a row can offer a link only when *this browser* created the
// share — the link is remembered per-device in IndexedDB
// (`lib/share-links-db.ts`). Shares created elsewhere render status only;
// there is nothing to reconstruct from (the server stores a hash). The
// button itself is the shared `CopyLinkButton` (`copy-link-button.tsx`,
// also used by the task 012 creation dialog).
//
// Manage: active rows get a "Manage" button (share-manage-page task 003)
// that navigates to `/settings/shares/:id` — the detail page owns removal
// (task 004) and adding (task 005). Revoked/expired rows render status
// only.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { revokeShare, type ShareDto } from "../api/shares";
import { describeError, formatDate } from "../lib/format";
import { deleteShareLink, getShareLinkMap } from "../lib/share-links-db";
import { SHARES_QUERY_KEY, useShares } from "../hooks/use-shares";
import { CopyLinkButton } from "./copy-link-button";
import { StatusBadge } from "./status-badge";
import { ErrorState } from "./ui/error-state";
import { Skeleton } from "./ui/skeleton";

export function SharesSection() {
  return (
    <section aria-labelledby="shares-heading" className="space-y-4">
      <div>
        <h2 id="shares-heading" className="text-lg font-semibold">
          Shares
        </h2>
        <p className="mt-1 text-sm opacity-70">
          Links you've shared. A link can be copied only on the device that
          created it — lost links can't be recovered.
        </p>
      </div>
      <SharesList />
    </section>
  );
}

function SharesList() {
  const query = useShares();

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
      <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-8 text-center">
        <p className="font-medium">No shares yet</p>
        <p className="mt-2 text-sm opacity-60">
          Shares you create will appear here.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {shares.map((share) => (
        <ShareRow
          key={share.id}
          share={share}
          linkPath={linkMap?.[share.id] ?? null}
        />
      ))}
    </ul>
  );
}

function ShareRow({ share, linkPath }: { share: ShareDto; linkPath: string | null }) {
  const queryClient = useQueryClient();

  const revoke = useMutation({
    mutationFn: () => revokeShare(share.id),
    onSuccess: () => {
      // Refetch rather than patching locally — the server owns status.
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY });
      // The link is dead; stop offering it on this device.
      void deleteShareLink(share.id);
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
    <li className="rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{share.title}</h3>
          <p className="mt-0.5 text-sm opacity-60">
            {share.item_count} {share.item_count === 1 ? "item" : "items"} ·
            created {formatDate(share.created_at)}
            {share.expires_at
              ? ` · expires ${formatDate(share.expires_at)}`
              : ""}
          </p>
        </div>
        <StatusBadge status={share.status} />
      </div>
      {share.status === "active" && linkPath && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <CopyLinkButton linkPath={linkPath} />
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        {share.status === "active" && (
          <>
            <Link
              to={`/settings/shares/${encodeURIComponent(share.id)}`}
              className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-3 py-1.5 text-xs transition hover:bg-[var(--color-castify-accent-subtle)]"
            >
              Manage
            </Link>
            <button
              type="button"
              onClick={handleRevoke}
              disabled={revoke.isPending}
              className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-3 py-1.5 text-xs transition hover:bg-[var(--color-castify-accent-subtle)] disabled:opacity-50"
            >
              {revoke.isPending ? "Revoking…" : "Revoke"}
            </button>
          </>
        )}
        {revoke.isError && (
          <p className="text-xs text-[var(--color-castify-accent-dim)]">
            {describeError(revoke.error)}
          </p>
        )}
      </div>
    </li>
  );
}
