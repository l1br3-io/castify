// Share add-items dialog (share-manage-page task 005; supersedes the
// mutable-share-list full-edit dialog, whose Settings entry point was
// replaced by the manage page — removal now lives there, so this picker
// is add-only).
//
// Two-read data model: the dialog reads the share's current members
// (`GET /api/shares/{id}/items` — owner route, curation order) *and* the
// searchable catalog (`GET /api/videos?q=…&limit=200` — one generous page,
// personal-server scale, no pagination UI). Members render checked AND
// disabled at the top in the server's order; the catalog below is deduped
// against the original member ids so each video has exactly one row.
//
// Order contract: selection is an ordered id array — members initialize it
// in the server's order (locked; they cannot be unchecked), newly checked
// catalog ids append. Save PUTs that array verbatim
// (`replaceShareItems`); the server re-validates (non-empty, no
// duplicates, catalog ids).
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

import { replaceShareItems, type ShareDto } from "../api/shares";
import { fetchVideos } from "../api/videos";
import { describeError } from "../lib/format";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { useShareItemsOwned, shareItemsOwnedKey } from "../hooks/use-share-items";
import { SHARES_QUERY_KEY } from "../hooks/use-shares";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/field";
import { Skeleton } from "./ui/skeleton";

/** One generous page — a personal server's catalog fits; search narrows
 * further. No pagination UI in this effort's scope. */
const CATALOG_LIMIT = 200;

/** Matches the browse page's SearchBar debounce — one fetch per pause,
 * not per keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Owner-side members read for one share. Lifted to
 * `hooks/use-share-items.ts` (share-manage-page task 002) so the manage
 * page and this dialog share one cache entry; `save.onSuccess` drops the
 * same entry the hook populates — the moment the PUT lands, that cache is
 * known-stale, and the app-wide 30s staleTime would otherwise serve the
 * pre-edit list to the next mount — whose adopt-once effect would turn it
 * back into the selection (resurrecting just-removed items on the next
 * save).
 */

export function ShareEditDialog({
  share,
  onClose,
}: {
  /** The share being appended to — the dialog only needs id + title. */
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

  const members = useShareItemsOwned(share.id);
  const catalog = useQuery({
    queryKey: ["share-edit-catalog", debouncedSearch],
    queryFn: () =>
      fetchVideos({ q: debouncedSearch || undefined, limit: CATALOG_LIMIT }),
  });

  // Adopt the server's order exactly once — a later refetch (window
  // refocus) must not clobber in-progress edits. The dialog is
  // folder-blind by design: it pre-checks members and appends at root;
  // `folder_id` is the manage page's axis, not this picker's.
  useEffect(() => {
    if (members.data && selectedIds === null) {
      setSelectedIds(members.data.items.map((v) => v.id));
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

  // Escape/backdrop dismissal now comes from the Dialog primitive
  // (task 014); `closeable` guards mid-PUT dismissal, matching the
  // creation dialog — a PUT fired behind a closed dialog leaves the user
  // guessing whether it landed.

  function toggle(id: string): void {
    setSelectedIds((prev) => {
      if (prev === null) return prev;
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    // Members are locked in, so a loaded selection is never empty — the
    // null check is the members-still-loading guard.
    if (selectedIds === null || save.isPending) return;
    save.mutate();
  }

  const checked = new Set(selectedIds ?? []);
  const memberIds = new Set((members.data?.items ?? []).map((v) => v.id));
  const catalogRows = (catalog.data?.videos ?? []).filter(
    (v) => !memberIds.has(v.id),
  );
  const selectionCount = selectedIds?.length ?? 0;

  return (
    <Dialog
      open
      onClose={onClose}
      closeable={!save.isPending}
      title="Edit share items"
    >
      <form
        onSubmit={handleSubmit}
        className="flex min-h-0 flex-1 flex-col gap-4"
      >
        <p className="-mt-2 truncate text-sm text-[var(--color-castify-muted)]" title={share.title}>
          {share.title}
        </p>

        <Input
          type="search"
          aria-label="Search videos"
          placeholder="Search videos…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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
                className="text-sm text-[var(--color-danger)]"
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
            {members.data?.items.map((v) => (
              <PickerRow
                key={v.id}
                name={v.name}
                checked={checked.has(v.id)}
                onToggle={() => toggle(v.id)}
                // Add-only picker: members are locked in — removal is
                // the manage page's job, not this dialog's.
                disabled
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
                className="text-sm text-[var(--color-danger)]"
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
              <p className="px-2 py-1.5 text-sm text-[var(--color-castify-muted)]">
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
            className="text-sm text-[var(--color-danger)]"
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
            <Button
              variant="secondary"
              onClick={onClose}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={selectedIds === null}
              pending={save.isPending}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

/** One checkbox row — label wraps the input so the video name is the
 * checkbox's accessible name. `disabled` locks members in add-only mode. */
function PickerRow({
  name,
  checked,
  onToggle,
  disabled = false,
}: {
  name: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-3 rounded-[var(--radius-button)] px-2 py-1.5 text-sm transition ${disabled ? "" : "cursor-pointer hover:bg-[var(--color-castify-accent-subtle)]"}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        className="h-4 w-4 accent-[var(--color-castify-accent)]"
      />
      <span className="truncate" title={name}>
        {name}
      </span>
    </label>
  );
}
