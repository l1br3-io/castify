// Share landing page (docs/specs/sharing task 009) — the recipient's entry
// point at `/share/:token`, fully public (no session, no AppLayout).
//
// State machine, driven by exactly the spec's request budget (criterion 8:
// resolve, unlock, items — nothing else, no polling):
//
//   mount → GET resolve
//     ├─ 410 → terminal "no longer available" (sticky, no retry)
//     ├─ 404 → terminal "doesn't exist" variant (sticky, no retry)
//     ├─ other error → generic ErrorState with retry (network/5xx can be
//     │   transient; 410/404 never are, hence the split)
//     ├─ locked → password gate; POST unlock only on submit
//     │    ├─ 401 → inline "Wrong password.", stay on the form
//     │    ├─ 429 → inline try-later state, stay on the form
//     │    ├─ other error → inline server error, stay on the form
//     │    └─ 204 → flip cached resolve to unlocked, GET items → grid
//     └─ unlocked → GET items → grid
//
// The resolve query is `staleTime: Infinity` + `retry: false`: a dead share
// stays dead on this mount (no re-resolve loop), and revisiting the page
// within the session reads from cache. A successful unlock flips that
// cached entry to `locked: false` in place (no refetch), so returning
// later in the session renders the grid — not the gate — while the
// unlock cookie is still valid.
//
// The grid reuses `PosterCard` read-only — no `topRightSlot` favorite, no
// `ratingSlot` rating, no progress bar. Cards carry the share scope
// so thumbnails resolve through the pre-auth mirror, and link to
// `/share/:token/watch/:videoId` (task 010's player page). Share members
// are always videos, so `FileCard` has no role here.
//
// The unlock cookie is HttpOnly + `Path=/api/share/`, so the items fetch
// after a successful unlock carries it automatically. If the cookie lapses
// between resolve and items (24h rolling window edge), items answers 401
// and the page falls back to the gate — unlock again and items refetch.

import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { PosterCard } from "../components/poster-card";
import { EmptyState } from "../components/ui/empty-state";
import { SkeletonGrid } from "../components/ui/skeleton-grid";
import { ErrorState } from "../components/ui/error-state";
import { Skeleton } from "../components/ui/skeleton";
import { fetchShareItems, resolveShare, unlockShare, type ShareResolveDto } from "../api/shares";
import { ApiError } from "../api/client";
import { describeError } from "../lib/format";

export function SharePage() {
  const { token } = useParams<{ token: string }>();

  const resolve = useQuery({
    queryKey: ["share", token, "resolve"],
    queryFn: () => resolveShare(token as string),
    enabled: token !== undefined,
    retry: false,
    staleTime: Infinity,
  });

  const canFetchItems = resolve.data !== undefined && !resolve.data.locked;

  const items = useQuery({
    queryKey: ["share", token, "items"],
    queryFn: () => fetchShareItems(token as string),
    enabled: canFetchItems,
    retry: false,
    staleTime: Infinity,
  });

  // Cookie lapsed mid-flight (resolve said unlocked, items says 401) → the
  // gate is the honest state again.
  const itemsLockedOut =
    items.isError && items.error instanceof ApiError && items.error.status === 401;

  if (resolve.isPending) {
    return (
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-10">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-40" />
        <SkeletonGrid />
      </main>
    );
  }

  if (resolve.isError) {
    const status = resolve.error instanceof ApiError ? resolve.error.status : null;
    if (status === 410) {
      return (
        <TerminalState
          title="This share is no longer available."
          body="The link expired or was revoked by whoever shared it."
        />
      );
    }
    if (status === 404) {
      return (
        <TerminalState
          title="This share doesn't exist."
          body="Double-check the link, or ask whoever sent it for a new one."
        />
      );
    }
    return (
      <main className="mx-auto max-w-7xl px-4 py-10">
        <ErrorState
          title="Couldn't load this share."
          body={describeError(resolve.error)}
          onRetry={() => resolve.refetch()}
        />
      </main>
    );
  }

  const share = resolve.data;

  if (!canFetchItems || itemsLockedOut) {
    return <PasswordGate title={share.title} token={token as string} />;
  }

  if (items.isPending) {
    return (
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">{share.title}</h1>
        <SkeletonGrid />
      </main>
    );
  }

  if (items.isError) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-10">
        <ErrorState
          title="Couldn't load this share."
          body={describeError(items.error)}
          onRetry={() => items.refetch()}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl space-y-4 px-4 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{share.title}</h1>
        <p className="mt-1 text-sm opacity-60">
          {items.data.length} {items.data.length === 1 ? "video" : "videos"} shared with you
        </p>
      </div>
      {items.data.length === 0 ? (
        <EmptyState title="Nothing in this share." body="Whoever shared it hasn't added any videos." />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.data.map((video) => (
            <PosterCard
              key={video.id}
              video={video}
              href={`/share/${encodeURIComponent(token as string)}/watch/${encodeURIComponent(video.id)}`}
              scope={{ kind: "share", token: token as string }}
            />
          ))}
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Password gate
// ---------------------------------------------------------------------------

function PasswordGate({ title, token }: { title: string; token: string }) {
  const [password, setPassword] = useState("");
  const queryClient = useQueryClient();

  const unlock = useMutation({
    mutationFn: () => unlockShare(token, password),
    onSuccess: () => {
      // Flip the cached resolve to unlocked in place (setQueryData, not a
      // refetch): unlocking costs exactly one unlock POST + one items GET,
      // and the cache no longer claims `locked` — so returning to this
      // page later in the session (watch → back) renders the grid from
      // cache instead of re-showing the gate for a still-valid cookie.
      // If the cookie has since lapsed, items answers 401 and the gate
      // returns via `itemsLockedOut`.
      queryClient.setQueryData<ShareResolveDto>(["share", token, "resolve"], (old) =>
        old ? { ...old, locked: false } : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["share", token, "items"] });
    },
  });

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    unlock.mutate();
  }

  const errorStatus =
    unlock.error instanceof ApiError ? unlock.error.status : null;

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-8">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm opacity-60">
          This share is protected by a password. Enter it to see the videos.
        </p>
        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <label className="block space-y-1.5 text-sm">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
              aria-invalid={errorStatus === 401}
              className="w-full rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-canvas)] px-3 py-2 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
            />
          </label>
          {errorStatus === 401 && (
            <p role="alert" className="text-sm text-[var(--color-castify-muted)]">
              Wrong password. Try again.
            </p>
          )}
          {errorStatus === 429 && (
            <p role="alert" className="text-sm text-[var(--color-castify-muted)]">
              Too many attempts. Please try again in about 15 minutes.
            </p>
          )}
          {unlock.isError && errorStatus !== 401 && errorStatus !== 429 && (
            <p role="alert" className="text-sm text-[var(--color-castify-muted)]">
              Couldn't unlock this share: {describeError(unlock.error)}
            </p>
          )}
          <button
            type="submit"
            disabled={unlock.isPending}
            className="w-full rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-5 py-2 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)] disabled:opacity-50"
          >
            {unlock.isPending ? "Unlocking…" : "Unlock"}
          </button>
        </form>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

// 410/404 render through EmptyState with no action — deliberately no retry.
// A dead link re-fetching on every visit would be a loop with no exit, and
// the resolve query's `retry: false` + `staleTime: Infinity` already pins
// the result for this mount.
function TerminalState({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-4 py-10">
      <EmptyState title={title} body={body} />
    </main>
  );
}

