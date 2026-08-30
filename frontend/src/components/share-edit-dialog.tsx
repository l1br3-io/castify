// Share-items edit dialog (docs/specs/mutable-share-list, task 007).
//
// Two-read data model: the dialog reads the share's current members
// (`GET /api/shares/{id}/items` — owner route, curation order) *and* the
// searchable catalog (`GET /api/videos?q=…&limit=200` — one generous page,
// personal-server scale, no pagination UI). Members render pre-checked at
// the top in the server's order; the catalog below is deduped against the
// original member ids so each video has exactly one row.
//
// Order contract: checkbox order IS curation order. Selection is an ordered
// id array — members initialize it in the server's order, newly checked
// catalog ids append, unchecking splices. Save PUTs that array verbatim
// (`replaceShareItems`); the server re-validates (non-empty, no duplicates,
// catalog ids) — the client's ≥1 guard is UX, not enforcement.
//
// Checked state is independent of what's on screen: re-searching narrows
// the catalog but never drops selections. A checked video that falls out of
// the results stays selected; the footer count keeps the tally visible.
//
// Save flow: one `PUT /api/shares/{id}/items` (`useMutation`); on success
// `SHARES_QUERY_KEY` is invalidated (Settings refetches — the server owns
// `item_count`, no local patching) and this dialog's own members cache is
// dropped (see `shareItemsOwnedKey`) so a reopen starts from the server.
// The dialog then closes. Failures surface
// inline via `describeError` and stay open for retry. Escape/backdrop
// dismissal is guarded mid-PUT, matching the creation dialog: a PUT fired
// behind a closed dialog leaves the user guessing whether it landed.

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchShareItemsOwned,
  replaceShareItems,
  type ShareDto,
} from "../api/shares";
import { fetchVideos } from "../api/videos";
import { describeError } from "../lib/format";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { SHARES_QUERY_KEY } from "../hooks/use-shares";
import { Skeleton } from "./ui/skeleton";

/** One generous page — a personal server's catalog fits; search narrows
 * further. No pagination UI in this effort's scope. */
const CATALOG_LIMIT = 200;

/** Matches the browse page's SearchBar debounce — one fetch per pause,
 * not per keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Owner-side members read for one share. Module-level so `save.onSuccess`
 * can drop the same entry the `useQuery` below populates: the moment the
 * PUT lands, that cache is known-stale, and the app-wide 30s staleTime
 * would otherwise serve the pre-edit list to the next mount — whose
 * adopt-once effect would turn it back into the selection (resurrecting
 * just-removed items on the next save).
 */
const shareItemsOwnedKey = (shareId: string) =>
  ["share-items-owned", shareId] as const;

export function ShareEditDialog({
  share,
  onClose,
}: {
  /** The row being edited — the dialog only needs id + title. */
  share: Pick<ShareDto, "id" | "title">;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  // null = members not loaded yet. On load it becomes the server's
  // curation order; thereafter it is the user's document (member order
  // preserved, additions appended, removals spliced) and is PUT verbatim.
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);

  const members = useQuery({
    queryKey: shareItemsOwnedKey(share.id),
    queryFn: () => fetchShareItemsOwned(share.id),
  });
  const catalog = useQuery({
    queryKey: ["share-edit-catalog", debouncedSearch],
    queryFn: () =>
      fetchVideos({ q: debouncedSearch || undefined, limit: CATALOG_LIMIT }),
  });

  // Adopt the server's order exactly once — a later refetch (window
  // refocus) must not clobber in-progress edits.
  useEffect(() => {
    if (members.data && selectedIds === null) {
      setSelectedIds(members.data.map((v) => v.id));
    }
  }, [members.data, selectedIds]);

  const save = useMutation({
    mutationFn: () => replaceShareItems(share.id, selectedIds ?? []),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY });
      // Invalidate alone isn't enough for this dialog's own read: with the
      // app's 30s staleTime the next mount would still serve the cached
      // pre-edit members while refetching. Drop the entry so the next
      // open starts from the server's list.
      queryClient.removeQueries({ queryKey: shareItemsOwnedKey(share.id) });
      onClose();
    },
  });

  // Escape dismisses only while idle — never mid-PUT (same rationale as
  // the backdrop guard below).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !save.isPending) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save.isPending, onClose]);

  function toggle(id: string): void {
    setSelectedIds((prev) => {
      if (prev === null) return prev;
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    if (selectedIds === null || selectedIds.length === 0 || save.isPending)
      return;
    save.mutate();
  }

  function handleBackdropClick(): void {
    if (!save.isPending) onClose();
  }

  const checked = new Set(selectedIds ?? []);
  const memberIds = new Set((members.data ?? []).map((v) => v.id));
  const catalogRows = (catalog.data?.videos ?? []).filter(
    (v) => !memberIds.has(v.id),
  );
  const selectionCount = selectedIds?.length ?? 0;

  return (
    <div
      role="presentation"
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-edit-dialog-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-md flex-col rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-6 shadow-xl"
      >
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <div>
            <h2
              id="share-edit-dialog-title"
              className="text-lg font-semibold tracking-tight"
            >
              Edit share items
            </h2>
            <p className="mt-0.5 truncate text-sm opacity-60" title={share.title}>
              {share.title}
            </p>
          </div>

          <input
            type="search"
            aria-label="Search videos"
            placeholder="Search videos…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-canvas)] px-3 py-2 text-sm placeholder:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
          />

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
            {/* Current members — always in the server's curation order. */}
            <fieldset className="space-y-1">
              <legend className="text-xs font-semibold uppercase tracking-wide text-[var(--color-castify-muted)]">
                In this share
              </legend>
              {members.isPending && (
                <div className="space-y-2 pt-1">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              )}
              {members.isError && (
                <p
                  role="alert"
                  className="text-sm text-[var(--color-castify-accent-dim)]"
                >
                  Couldn&apos;t load this share&apos;s items:{" "}
                  {describeError(members.error)}{" "}
                  <button
                    type="button"
                    onClick={() => void members.refetch()}
                    className="underline"
                  >
                    Retry
                  </button>
                </p>
              )}
              {members.data?.map((v) => (
                <PickerRow
                  key={v.id}
                  name={v.name}
                  checked={checked.has(v.id)}
                  onToggle={() => toggle(v.id)}
                />
              ))}
            </fieldset>

            {/* Catalog — search results minus the members above. */}
            <fieldset className="space-y-1">
              <legend className="text-xs font-semibold uppercase tracking-wide text-[var(--color-castify-muted)]">
                Library
              </legend>
              {catalog.isPending && (
                <div className="space-y-2 pt-1">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              )}
              {catalog.isError && (
                <p
                  role="alert"
                  className="text-sm text-[var(--color-castify-accent-dim)]"
                >
                  Couldn&apos;t load the library: {describeError(catalog.error)}{" "}
                  <button
                    type="button"
                    onClick={() => void catalog.refetch()}
                    className="underline"
                  >
                    Retry
                  </button>
                </p>
              )}
              {catalog.data && catalogRows.length === 0 && (
                <p className="px-2 py-1.5 text-sm opacity-60">
                  No other videos match.
                </p>
              )}
              {catalogRows.map((v) => (
                <PickerRow
                  key={v.id}
                  name={v.name}
                  checked={checked.has(v.id)}
                  onToggle={() => toggle(v.id)}
                />
              ))}
            </fieldset>
          </div>

          {save.isError && (
            <p
              role="alert"
              className="text-sm text-[var(--color-castify-accent-dim)]"
            >
              {describeError(save.error)}
            </p>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <p aria-live="polite" className="text-xs opacity-60">
              {selectionCount} {selectionCount === 1 ? "item" : "items"}{" "}
              selected
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={save.isPending}
                className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-4 py-2 text-sm transition hover:bg-[var(--color-castify-accent-subtle)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={selectionCount === 0 || save.isPending}
                className="rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 disabled:opacity-50"
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/** One checkbox row — label wraps the input so the video name is the
 * checkbox's accessible name. */
function PickerRow({
  name,
  checked,
  onToggle,
}: {
  name: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-button)] px-2 py-1.5 text-sm transition hover:bg-[var(--color-castify-accent-subtle)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 accent-[var(--color-castify-accent)]"
      />
      <span className="truncate" title={name}>
        {name}
      </span>
    </label>
  );
}
