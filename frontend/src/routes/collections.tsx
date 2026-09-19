// Collections index page (`/collections`, collections-page tasks 002+003):
// the overview for the whole collection set — a responsive
// CollectionCard grid (2 cols mobile → 6 xl, mirroring the browse
// poster grid) over `GET /api/collections`, browsable by kind chips
// and sort.
//
// Filtering is client-side (collections are dozens, not thousands):
// kind chips slice the already-fetched list with no refetch, and the
// active kind lives in the URL (`?kind=`) via a small local hook
// following `lib/filter-state.ts`'s single-select pattern — deep-
// linkable, back-button-safe. Chip clicks push (not replace) so the
// back button steps through filter history. Sort stays local state:
// an ephemeral preference, per the browse page's own precedent.
//
// States: skeleton grid while loading, `ErrorState` with retry on
// failure, truly-empty CTA pointing at the scan→review pipeline, and
// — distinct from it — the filtered-empty state ("No collections of
// this kind" + a clear action). The "New collection" button joins the
// header in task 006.
//
// The a11y identity is the sr-only `h1`; the visible identity is the
// header row below it (browse-page precedent).

import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import type { CollectionDto, CollectionKind } from "../api/types";
import { useCollections, useDeleteCollection, useRenameCollection } from "../hooks/use-collections";
import { useToast } from "../hooks/use-toast";
import { CollectionCard } from "../components/collections/collection-card";
import { Dialog } from "../components/ui/dialog";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Menu, MenuItem } from "../components/ui/menu";
import { Skeleton } from "../components/ui/skeleton";
import { buttonClasses } from "../components/ui/button-classes";

// ---------------------------------------------------------------------------
// Kind filter — URL-backed single select (`?kind=`)
// ---------------------------------------------------------------------------

const KIND_CHIPS: { value: CollectionKind | undefined; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "show", label: "Series" },
  { value: "movie", label: "Movies" },
  { value: "time", label: "Time groups" },
  { value: "manual", label: "Manual" },
];

const KIND_KEYS = new Set<string>(
  KIND_CHIPS.flatMap((c) => (c.value ? [c.value] : [])),
);

function isCollectionKind(value: string): value is CollectionKind {
  return KIND_KEYS.has(value);
}

function useCollectionKindFilter() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Unknown/invalid values fall back to All — no crash, no dead chip.
  const raw = searchParams.get("kind");
  const kind =
    raw !== null && isCollectionKind(raw) ? (raw as CollectionKind) : undefined;

  function setKind(value: CollectionKind | undefined): void {
    const next = new URLSearchParams(searchParams);
    if (value === undefined) {
      next.delete("kind");
    } else {
      next.set("kind", value);
    }
    // Push, not replace — back should step back through filter choices.
    setSearchParams(next);
  }

  return { kind, setKind };
}

// ---------------------------------------------------------------------------
// Sort — local, ephemeral
// ---------------------------------------------------------------------------

type CollectionSortKey = "newest" | "name" | "largest";

const COLLECTION_SORT_LABELS: Record<CollectionSortKey, string> = {
  newest: "Newest",
  name: "Name A–Z",
  largest: "Largest",
};

function sortCollections(
  data: CollectionDto[],
  sort: CollectionSortKey,
): CollectionDto[] {
  const sorted = [...data];
  switch (sort) {
    case "name":
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case "largest":
      // member_count desc; name as the stable tiebreaker.
      return sorted.sort(
        (a, b) => b.member_count - a.member_count || a.name.localeCompare(b.name),
      );
    case "newest":
      // created_at desc; name as the stable tiebreaker.
      return sorted.sort(
        (a, b) =>
          b.created_at.localeCompare(a.created_at) ||
          a.name.localeCompare(b.name),
      );
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CollectionsPage() {
  const collections = useCollections();
  const navigate = useNavigate();
  const { kind, setKind } = useCollectionKindFilter();
  const [sort, setSort] = useState<CollectionSortKey>("newest");

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

  // Client-side filter + sort — dozens of rows, recomputed per render is
  // fine (and keeps every hook above the early returns).
  const visible = sortCollections(
    kind ? data.filter((c) => c.kind === kind) : data,
    sort,
  );

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

      {/* Chip row + sort — chips wrap on mobile (no horizontal
          overflow); the FilterPanel chip grammar (preset-active /
          preset-inactive) keeps them consistent with browse. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div
          role="group"
          aria-label="Filter by kind"
          className="flex flex-wrap gap-1.5"
        >
          {KIND_CHIPS.map(({ value, label }) => {
            const isActive = kind === value;
            return (
              <button
                key={label}
                type="button"
                onClick={() => setKind(value)}
                aria-pressed={isActive}
                className={isActive ? "preset-active" : "preset-inactive"}
              >
                {label}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-[var(--color-castify-muted)]">Sort</span>
          <select
            aria-label="Sort collections"
            value={sort}
            onChange={(e) => setSort(e.target.value as CollectionSortKey)}
            className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-3 py-1.5 text-sm transition hover:bg-[var(--color-castify-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-canvas)]"
          >
            {(Object.keys(COLLECTION_SORT_LABELS) as CollectionSortKey[]).map(
              (key) => (
                <option key={key} value={key}>
                  {COLLECTION_SORT_LABELS[key]}
                </option>
              ),
            )}
          </select>
        </label>
      </div>

      {visible.length === 0 ? (
        // Filtered-empty: the library has collections, just none of the
        // selected kind. Distinct from the truly-empty CTA above.
        <EmptyState
          title="No collections of this kind"
          body="Try another kind, or clear the filter to see everything."
          onAction={() => setKind(undefined)}
          actionLabel="Show all kinds"
          compact
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {visible.map((collection) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              menuSlot={<CollectionCardMenu collection={collection} />}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Card menu + rename dialog (task 004)
// ---------------------------------------------------------------------------

// Kebab chip styling — the same quiet dark chip add-to-collection's card
// variant rides on PosterCard, so both meta-row menus read as one family.
const KEBAB_TRIGGER_CLASS =
  "flex h-7 w-7 items-center justify-center rounded-[var(--radius-button)] " +
  "text-[var(--color-castify-muted)] transition hover:bg-[var(--color-castify-accent-subtle)] " +
  "hover:text-[var(--color-castify-text)] focus:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-[var(--color-focus)]";

/** Kebab menu riding the card's menuSlot: Rename, then Delete. */
function CollectionCardMenu({ collection }: { collection: CollectionDto }) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <Menu
        label={`Actions for ${collection.name}`}
        triggerClassName={KEBAB_TRIGGER_CLASS}
      >
        <MenuItem onSelect={() => setRenaming(true)}>Rename</MenuItem>
        <MenuItem onSelect={() => setDeleting(true)}>Delete</MenuItem>
      </Menu>
      {renaming && (
        <RenameCollectionDialog
          collection={collection}
          onClose={() => setRenaming(false)}
        />
      )}
      {deleting && (
        <DeleteCollectionDialog
          collection={collection}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}

/** Rename dialog — prefilled single field; the same Rename/Save/Cancel
 *  vocabulary as the detail page's inline rename. Enter submits,
 *  Escape/Cancel aborts (the Dialog primitive's contract). */
function RenameCollectionDialog({
  collection,
  onClose,
}: {
  collection: CollectionDto;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(collection.name);
  const rename = useRenameCollection();
  const toast = useToast();

  function submit(): void {
    const trimmed = draft.trim();
    // Empty or unchanged names are a cancel, not a PATCH.
    if (trimmed === "" || trimmed === collection.name) {
      onClose();
      return;
    }
    rename.mutate(
      { id: collection.id, name: trimmed },
      {
        onError: () =>
          toast.error(
            `Couldn't rename "${collection.name}". Please try again.`,
          ),
        onSettled: onClose,
      },
    );
  }

  return (
    <Dialog open onClose={onClose} title="Rename collection"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className={buttonClasses("ghost")}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={rename.isPending}
            className={buttonClasses("primary")}
          >
            {rename.isPending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <input
        aria-label="Collection name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        className="w-full rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-canvas)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
      />
    </Dialog>
  );
}

/** Delete confirm dialog — the same copy shape as the detail page's
 *  delete (names the collection + member count, videos stay in the
 *  library), so both surfaces speak identically. */
function DeleteCollectionDialog({
  collection,
  onClose,
}: {
  collection: CollectionDto;
  onClose: () => void;
}) {
  const remove = useDeleteCollection();
  const toast = useToast();

  const countLabel =
    collection.member_count === 1
      ? "1 video"
      : `${collection.member_count} videos`;

  return (
    <Dialog open onClose={onClose} title="Delete collection"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className={buttonClasses("ghost")}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(collection.id, {
                onError: () =>
                  toast.error(
                    `Couldn't delete "${collection.name}". Please try again.`,
                  ),
                onSettled: onClose,
              })
            }
            className={buttonClasses("destructive")}
          >
            {remove.isPending ? "Deleting…" : "Yes, delete"}
          </button>
        </>
      }
    >
      <p className="text-sm text-[var(--color-castify-muted)]">
        Delete &ldquo;{collection.name}&rdquo; ({countLabel})? The collection
        and its member list are removed — your videos stay in the library.
      </p>
    </Dialog>
  );
}
