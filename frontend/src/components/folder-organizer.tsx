// FolderOrganizer — the two-pane spine of the M9 home page (FR-7.4).
//
//   ┌ FOLDERS (sidebar, lg+) │ <folder name>     [All · Drive · …] [name filter]
//   │ ▾ Media                │ ┌────┐┌────┐ + list rows (documents etc.)
//   │   ▸ Movies             │ │ ▶  ││ ♪  │
//   └────────────────────────┴ └────┘└────┘ [Previous | Page N of M | Next]
//
// Left: `FolderTree` (selection = `?dir=`, owned by the parent via
// `useFolderDir`). Right: `useFolderContents(dir)` — videos render as the
// existing `PosterCard` (play → `/watch/:id`, queue = this page's videos);
// audio/image render as `FileCard` tiles; document/archive/subtitle/other
// as `FileRow` list rows. The provider chip row filters the pane (replaces
// the old By Provider shelves); the name filter is a plain contains (the
// pane's own concern — global search stays video-scoped).
//
// File/kind filters (FR-5.2's `kind`) are wired through the hook params;
// no UI yet — the chips row is provider-scoped v1.
//
// Identity pass (task 004): a mono full-path line sits above the contents
// heading — deliberately duplicating the heading's leaf name. The heading
// names (large, sans: "what is this"), the path line orients (mono, muted:
// "where am I in the tree"). Deep paths need both at a glance; the heading
// alone loses ancestors, the path alone reads as chaff at poster scale.
// Chips (provider filters, breadcrumbs) wear the `.keycap` primitive; the
// name filter speaks the mono data voice.

import { useEffect, useMemo, useState } from "react";

import { FileCard, FileRow } from "./file-card";
import { FolderTree } from "./folder-tree";
import { PosterCard } from "./poster-card";
import { FavoriteToggle } from "./favorite-toggle";
import { PROVIDER_LABELS, type FileEntryDto, type FolderEntryDto, type FolderNodeDto, type ProviderKey } from "../api/types";
import { useFolderContents } from "../hooks/use-folder-contents";
import { useFolderTree } from "../hooks/use-folder-tree";
import { useFolderDir } from "../hooks/use-folder-dir";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { describeError } from "../lib/format";
import { Skeleton } from "./ui/skeleton";
import { ErrorState } from "./ui/error-state";

type FolderOrganizerProps = {
  /** Connected providers, in display order — drives the chip row. */
  connectedProviders: ProviderKey[];
};

const LIST_ROW_KINDS = new Set(["document", "archive", "subtitle", "other"]);

/** Type guard: entries rendered as dense list rows (see LIST_ROW_KINDS). */
function isListRowEntry(entry: FolderEntryDto): entry is FileEntryDto {
  return entry.kind !== "video" && LIST_ROW_KINDS.has(entry.kind);
}

/**
 * Entries rendered in the card grid: videos (PosterCard) + icon-tile kinds
 * (FileCard) — the complement of LIST_ROW_KINDS.
 *
 * Deliberately a plain boolean, NOT a type predicate: TS's inferred
 * predicates would narrow `filter((e) => !isListRowEntry(e))` to
 * videos-only (`Exclude<FolderEntryDto, FileEntryDto>`), silently dropping
 * audio/image tiles. The explicit `: boolean` return disables that
 * inference; the element union stays intact and narrows on `kind` at the
 * render site.
 */
function isTileEntry(entry: FolderEntryDto): boolean {
  return !isListRowEntry(entry);
}

/** Every node path in the tree, recursively ("" root included). */
function collectPaths(nodes: FolderNodeDto[]): Set<string> {
  const paths = new Set<string>();
  function walk(list: FolderNodeDto[]): void {
    for (const node of list) {
      paths.add(node.path);
      if (node.children.length > 0) walk(node.children);
    }
  }
  walk(nodes);
  return paths;
}

export function FolderOrganizer({ connectedProviders }: FolderOrganizerProps) {
  const [dir, setDir] = useFolderDir();
  const tree = useFolderTree();
  const [page, setPage] = useState(1);
  const [providerFilter, setProviderFilter] = useState<string | undefined>();
  const [nameQuery, setNameQuery] = useState("");
  // Debounced like the global SearchBar (300ms) — one fetch per pause, not
  // per keystroke.
  const debouncedNameQuery = useDebouncedValue(nameQuery, 300);

  // FR-9.2: an unknown `?dir=` (stale bookmark, hand-edited URL) falls back
  // to the root listing. Only once the tree is loaded — a pending tree must
  // not clobber a possibly-valid deep link.
  const knownPaths = useMemo(
    () => (tree.data ? collectPaths(tree.data) : null),
    [tree.data],
  );
  useEffect(() => {
    // replace: this is a correction of the current entry, not a navigation —
    // pushing would trap Back in a loop (back → bogus dir → push → …).
    if (knownPaths && dir !== "" && !knownPaths.has(dir)) {
      setDir("", { replace: true });
    }
  }, [dir, knownPaths, setDir]);

  // Folder switches always land on page 1 — covers tree selection,
  // breadcrumbs, and back/forward popstate alike.
  useEffect(() => {
    setPage(1);
  }, [dir]);

  const contents = useFolderContents({
    path: dir,
    page,
    provider: providerFilter,
    q: debouncedNameQuery || undefined,
  });

  const folderName = dir === "" ? "(Root)" : dir === "(Unsorted)" ? "(Unsorted)" : dir.split("/").filter(Boolean).pop() ?? dir;

  // Full-dir path line (identity FR-5): root renders "/", "(Unsorted)"
  // as-is. Sanctioned new visible text — everything else is copy-frozen.
  const fullPath = dir === "" ? "/" : dir;

  // Breadcrumb segments (responsive, FR-10.1): under lg the sidebar is
  // hidden and the path itself becomes the navigation — root + each real
  // folder is a chip; the deepest segment is the current location (plain).
  const breadcrumbSegments =
    dir === "" || dir === "(Unsorted)"
      ? []
      : dir
          .split("/")
          .filter(Boolean)
          .map((segment, index, all) => ({
            name: segment,
            path: `/${all.slice(0, index + 1).join("/")}`,
          }));

  function handleSelect(path: string): void {
    setDir(path);
  }

  function handleChip(value: string | undefined): void {
    setProviderFilter(value);
    setPage(1);
  }

  // Hoisted once per render: grid vs list split derives from a single
  // source of truth (`isListRowEntry`), and the play queue is computed
  // once — not per card.
  const gridEntries = contents.data?.entries.filter(isTileEntry) ?? [];
  const listEntries = contents.data?.entries.filter(isListRowEntry) ?? [];
  const videoQueue =
    contents.data?.entries
      .filter((entry) => entry.kind === "video")
      .map((entry) => entry.id) ?? [];
  const filtersActive = providerFilter !== undefined || nameQuery.trim() !== "";
  const totalPages = contents.data
    ? Math.max(1, Math.ceil(contents.data.total / contents.data.limit))
    : 1;

  return (
    <section aria-label="Folder organizer" className="flex flex-col gap-4 lg:flex-row">
      {/* Tree sidebar — full-width pane below lg gets breadcrumbs in task 014. */}
      <div className="hidden w-64 flex-shrink-0 lg:block">
        <div className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto pr-2">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-castify-muted)]">
            Folders
          </h2>
          {tree.isLoading && <Skeleton className="h-40 w-full" />}
          {tree.isError && (
            <p className="text-sm text-[var(--color-castify-muted)]">
              Couldn't load folders.
            </p>
          )}
          {tree.data && (
            <FolderTree nodes={tree.data} selectedPath={dir} onSelect={handleSelect} />
          )}
        </div>
      </div>

      {/* Contents pane */}
      <div className="min-w-0 flex-1 space-y-4">
        {/* Breadcrumbs — the mobile/small-screen folder navigation (the
            sidebar is lg+ only). Rendered always; hidden above lg so the
            tree is the navigation there. */}
        <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 lg:hidden">
          <button
            type="button"
            onClick={() => handleSelect("")}
            className={`keycap transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)] ${
              dir === "" ? "keycap-active" : "keycap-inactive"
            }`}
          >
            All folders
          </button>
          {breadcrumbSegments.map((segment, index) => (
            <span key={segment.path} className="flex items-center gap-1">
              <span aria-hidden className="text-xs text-[var(--color-castify-muted)]">
                /
              </span>
              {index < breadcrumbSegments.length - 1 ? (
                <button
                  type="button"
                  onClick={() => handleSelect(segment.path)}
                  className="keycap keycap-inactive transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)]"
                >
                  {segment.name}
                </button>
              ) : (
                <span
                  aria-current="page"
                  className="keycap keycap-active"
                >
                  {segment.name}
                </span>
              )}
            </span>
          ))}
        </nav>

        {/* Orientation vs naming: the path line carries full depth, the
            heading below carries the leaf (see file header). */}
        <p
          data-testid="contents-full-path"
          title={fullPath}
          className="truncate font-mono text-xs text-[var(--color-castify-muted)]"
        >
          {fullPath}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            className="text-xl font-semibold tracking-tight"
            data-testid="contents-path"
            title={dir}
          >
            {folderName}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {/* Provider chips (replaces the old By Provider shelves). */}
            <div role="group" aria-label="Filter by provider" className="flex flex-wrap gap-1">
              <button
                type="button"
                aria-pressed={providerFilter === undefined}
                onClick={() => handleChip(undefined)}
                className={`keycap transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)] ${
                  providerFilter === undefined ? "keycap-active" : "keycap-inactive"
                }`}
              >
                All
              </button>
              {connectedProviders.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  aria-pressed={providerFilter === provider}
                  onClick={() => handleChip(provider)}
                  className={`keycap transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)] ${
                    providerFilter === provider ? "keycap-active" : "keycap-inactive"
                  }`}
                >
                  {PROVIDER_LABELS[provider]}
                </button>
              ))}
            </div>
            {/* Name filter — the pane's own contains-filter (no FTS). */}
            <input
              type="search"
              aria-label="Filter by name"
              placeholder="Filter by name"
              value={nameQuery}
              onChange={(e) => {
                setNameQuery(e.target.value);
                setPage(1);
              }}
              className="w-44 rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-3 py-1.5 font-mono text-sm placeholder:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
            />
          </div>
        </div>

        {contents.isLoading && <Skeleton className="h-48 w-full" />}
        {contents.isError && (
          <ErrorState
            title="Couldn't load this folder."
            body={describeError(contents.error)}
            onRetry={() => contents.refetch()}
          />
        )}
        {contents.data && contents.data.entries.length === 0 && (
          <p className="rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-4 py-6 text-center text-sm text-[var(--color-castify-muted)]">
            {filtersActive
              ? "No entries match the current filters."
              : "This folder is empty."}
          </p>
        )}
        {contents.data && contents.data.entries.length > 0 && (
          <>
            {/* Grid children: videos + tile files; list kinds render as rows
                below (a mixed grid breaks on wildly different card heights). */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
              {gridEntries.map((entry) =>
                entry.kind === "video" ? (
                  <PosterCard
                    key={entry.id}
                    video={entry}
                    href={`/watch/${entry.id}`}
                    queue={videoQueue}
                    topRightSlot={<FavoriteToggle video={entry} />}
                  />
                ) : (
                  <FileCard key={entry.id} file={entry} />
                ),
              )}
            </div>
            {/* List children: documents/archives/subtitles/other. */}
            <div className="space-y-2">
              {listEntries.map((entry) => (
                <FileRow key={entry.id} file={entry} />
              ))}
            </div>

            {contents.data.total > contents.data.limit && (
              <div className="flex items-center justify-between gap-4 pt-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || contents.isFetching}
                  className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-4 py-2 text-sm transition hover:bg-[var(--color-castify-accent-subtle)] disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-sm text-[var(--color-castify-muted)]">
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page >= totalPages || contents.isFetching}
                  className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-4 py-2 text-sm transition hover:bg-[var(--color-castify-accent-subtle)] disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
