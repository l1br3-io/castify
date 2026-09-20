// FolderOrganizer — the library's folder contents pane (FR-7.4;
// curated view added by the library-folders effort).
//
//   │ <folder name>     [All · Videos · Photos …] [name filter]
//   │ ┌────┐┌────┐ + list rows (documents etc.)
//   │ │ ▶  ││ ♪  │
//   │ └────┘└────┘ [Previous | Page N of M | Next]
//
// MODE (the single rule, shared with the sidebar — see
// `useLibraryFolderNav`): `?dir=` present (even empty) → the provider
// pane below, byte-for-byte as before this effort; otherwise → the
// CURATED pane, the new default. Per curated level: folder tiles first
// (subfolders of the current folder from the cached tree; the root also
// pins the Unfiled tile with its live count as the current location),
// then the mixed item listing — videos as `PosterCard` (play →
// `/watch/:id`, queue = this page's videos), audio/image as `FileCard`,
// documents/archives as `FileRow` — the provider organizer's rendering
// rules, shared through `ContentsBody`.
//
// The folder TREE lives in the app sidebar (SidebarFolders); this
// component owns the CONTENTS for the selection. Breadcrumb chips are
// the always-on navigation — on mobile the tree sits in the drawer, so
// the path itself navigates. Kind chips filter the pane; the name
// filter is a plain contains (the pane's own concern — global search
// stays video-scoped).
//
// Identity pass (task 004): a mono full-path line sits above the
// contents heading — deliberately duplicating the heading's leaf name.
// The heading names (large: "what is this"), the path line orients
// (mono, muted: "where am I in the tree"). Deep paths need both at a
// glance; the heading alone loses ancestors, the path alone reads as
// chaff at poster scale. Chips (kind/provider filters, breadcrumbs)
// wear the `.keycap` primitive; the name filter speaks the mono data
// voice.

import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

import { FileCard, FileRow } from "./file-card";
import { FolderTile } from "./folder-tile";
import { PosterCard } from "./poster-card";
import { FavoriteToggle } from "./favorite-toggle";
import {
  PROVIDER_LABELS,
  type FileEntryDto,
  type FolderEntryDto,
  type LibraryTreeDto,
  type ProviderKey,
} from "../api/types";
import { useFolderContents } from "../hooks/use-folder-contents";
import { useFolderDir } from "../hooks/use-folder-dir";
import {
  useLibraryFolderContents,
  useLibraryFolderNav,
  useLibraryFolderTree,
} from "../hooks/use-library-folders";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { describeError } from "../lib/format";
import { Skeleton } from "./ui/skeleton";
import { ErrorState } from "./ui/error-state";

type FolderOrganizerProps = {
  /** Connected providers, in display order — drives the provider pane's
   *  chip row. */
  connectedProviders: ProviderKey[];
  /** Wired to the create flow by the organizer CRUD task; the curated
   *  pane's empty-tree CTA calls it when present. */
  onNewFolder?: () => void;
};

export function FolderOrganizer({ connectedProviders, onNewFolder }: FolderOrganizerProps) {
  const providerMode = useSearchParams()[0].has("dir");
  return providerMode ? (
    <ProviderPane connectedProviders={connectedProviders} />
  ) : (
    <CuratedPane onNewFolder={onNewFolder} />
  );
}

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

/** A keycap chip — the shared filter/breadcrumb primitive styling. */
function Chip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`keycap transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)] ${
        active ? "keycap-active" : "keycap-inactive"
      }`}
    >
      {children}
    </button>
  );
}

/** A plain (current-location) keycap — the breadcrumb leaf. */
function CurrentChip({ children }: { children: ReactNode }) {
  return <span aria-current="page" className="keycap keycap-active">{children}</span>;
}

type ContentsBodyProps = {
  /** Contents query result (provider or curated hook — same wire shape). */
  contents: ReturnType<typeof useFolderContents>;
  page: number;
  onPageChange: (updater: (p: number) => number) => void;
  filtersActive: boolean;
};

/** The shared contents rendering: grid tiles + list rows + pagination +
 *  loading/error/empty states. Both panes render items through this —
 *  one rendering rule set, per the spec's "no forked siblings". */
function ContentsBody({ contents, page, onPageChange, filtersActive }: ContentsBodyProps) {
  const gridEntries = contents.data?.entries.filter(isTileEntry) ?? [];
  const listEntries = contents.data?.entries.filter(isListRowEntry) ?? [];
  const videoQueue =
    contents.data?.entries
      .filter((entry) => entry.kind === "video")
      .map((entry) => entry.id) ?? [];
  const totalPages = contents.data
    ? Math.max(1, Math.ceil(contents.data.total / contents.data.limit))
    : 1;

  return (
    <>
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
                onClick={() => onPageChange((p) => Math.max(1, p - 1))}
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
                onClick={() => onPageChange((p) => p + 1)}
                disabled={page >= totalPages || contents.isFetching}
                className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-4 py-2 text-sm transition hover:bg-[var(--color-castify-accent-subtle)] disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- provider

function ProviderPane({ connectedProviders }: { connectedProviders: ProviderKey[] }) {
  const [dir, setDir] = useFolderDir();
  const [page, setPage] = useState(1);
  const [providerFilter, setProviderFilter] = useState<string | undefined>();
  const [nameQuery, setNameQuery] = useState("");
  // Debounced like the global SearchBar (300ms) — one fetch per pause, not
  // per keystroke.
  const debouncedNameQuery = useDebouncedValue(nameQuery, 300);

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

  const folderName =
    dir === ""
      ? "(Root)"
      : dir === "(Unsorted)"
        ? "(Unsorted)"
        : (dir.split("/").filter(Boolean).pop() ?? dir);

  // Full-dir path line (identity FR-5): root renders "/", "(Unsorted)"
  // as-is.
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

  const filtersActive = providerFilter !== undefined || nameQuery.trim() !== "";

  return (
    <section aria-label="Folder organizer" className="space-y-4">
      {/* Contents pane */}
      <div className="min-w-0 flex-1 space-y-4">
        {/* Breadcrumbs — the folder navigation in the contents pane. The
            tree lives in the app sidebar (drawer on mobile), so the path
            itself navigates here at every width. Rendered for nested dirs;
            root has nothing to climb. */}
        <nav
          aria-label="Folder path"
          className="flex flex-wrap items-center gap-1"
        >
          <Chip active={dir === ""} onClick={() => handleSelect("")}>
            All folders
          </Chip>
          {breadcrumbSegments.map((segment, index) => (
            <span key={segment.path} className="flex items-center gap-1">
              <span
                aria-hidden
                className="text-xs text-[var(--color-castify-muted)]"
              >
                /
              </span>
              {index < breadcrumbSegments.length - 1 ? (
                <Chip active={false} onClick={() => handleSelect(segment.path)}>
                  {segment.name}
                </Chip>
              ) : (
                <CurrentChip>{segment.name}</CurrentChip>
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
            <div
              role="group"
              aria-label="Filter by provider"
              className="flex flex-wrap gap-1"
            >
              <Chip active={providerFilter === undefined} onClick={() => handleChip(undefined)}>
                All
              </Chip>
              {connectedProviders.map((provider) => (
                <Chip
                  key={provider}
                  active={providerFilter === provider}
                  onClick={() => handleChip(provider)}
                >
                  {PROVIDER_LABELS[provider]}
                </Chip>
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

        <ContentsBody
          contents={contents}
          page={page}
          onPageChange={setPage}
          filtersActive={filtersActive}
        />
      </div>
    </section>
  );
}

// ----------------------------------------------------------------- curated

/** Curated kind chips: label + the `kind` query value (undefined = All). */
const KIND_CHIPS: Array<{ label: string; kind?: string }> = [
  { label: "All" },
  { label: "Videos", kind: "video" },
  { label: "Photos", kind: "image" },
  { label: "Audio", kind: "audio" },
  { label: "Documents", kind: "document" },
  { label: "Archives", kind: "archive" },
];

/** Ancestor chain root→leaf for the selected folder, from the flat tree. */
function curatedCrumbs(tree: LibraryTreeDto, folderId: string | null) {
  const byId = new Map(tree.folders.map((f) => [f.id, f]));
  const crumbs: Array<{ id: string; name: string }> = [];
  let cursor = folderId;
  while (cursor !== null) {
    const folder = byId.get(cursor);
    if (folder === undefined) break;
    crumbs.unshift({ id: folder.id, name: folder.name });
    cursor = folder.parent_id;
  }
  return crumbs;
}

function CuratedPane({ onNewFolder }: { onNewFolder?: () => void }) {
  const { selectedFolder, selectCurated } = useLibraryFolderNav();
  const tree = useLibraryFolderTree();
  const [page, setPage] = useState(1);
  const [kindFilter, setKindFilter] = useState<string | undefined>();
  const [nameQuery, setNameQuery] = useState("");
  const debouncedNameQuery = useDebouncedValue(nameQuery, 300);

  // Folder/kind/filter switches always land on page 1.
  useEffect(() => {
    setPage(1);
  }, [selectedFolder, kindFilter, debouncedNameQuery]);

  const contents = useLibraryFolderContents({
    folder_id: selectedFolder ?? undefined,
    page,
    limit: 50,
    kind: kindFilter,
    q: debouncedNameQuery || undefined,
  });

  const folders = tree.data?.folders ?? [];
  const crumbs = tree.data ? curatedCrumbs(tree.data, selectedFolder) : [];
  const currentName = selectedFolder === null ? "Unfiled" : (crumbs.at(-1)?.name ?? "");
  const fullPath =
    selectedFolder === null ? "Unfiled" : `/${crumbs.map((c) => c.name).join("/")}`;

  // Folder tiles: subfolders of the current level; the root also pins
  // the Unfiled tile — the current location there, so it renders as a
  // plain tile (aria-current), not a self-link.
  const subfolders = folders
    .filter((f) => f.parent_id === selectedFolder)
    .sort((a, b) => a.position - b.position);
  const emptyTree = tree.data !== undefined && folders.length === 0;

  function handleChip(value: string | undefined): void {
    setKindFilter(value);
    setPage(1);
  }

  const filtersActive = kindFilter !== undefined || nameQuery.trim() !== "";

  return (
    <section aria-label="Folder organizer" className="space-y-4">
      <div className="min-w-0 flex-1 space-y-4">
        {/* Breadcrumbs — "Library" root (the Unfiled view) + the curated
            path; same always-on-navigation contract as the provider pane. */}
        <nav
          aria-label="Folder path"
          className="flex flex-wrap items-center gap-1"
        >
          <Chip active={selectedFolder === null} onClick={() => selectCurated(null)}>
            Library
          </Chip>
          {crumbs.map((crumb, index) => (
            <span key={crumb.id} className="flex items-center gap-1">
              <span
                aria-hidden
                className="text-xs text-[var(--color-castify-muted)]"
              >
                /
              </span>
              {index < crumbs.length - 1 ? (
                <Chip active={false} onClick={() => selectCurated(crumb.id)}>
                  {crumb.name}
                </Chip>
              ) : (
                <CurrentChip>{crumb.name}</CurrentChip>
              )}
            </span>
          ))}
        </nav>

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
            title={selectedFolder ?? "Unfiled"}
          >
            {currentName}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {/* Kind chips — the curated pane's filter axis (placement is
                single-valued; kinds are what a folder holds). */}
            <div
              role="group"
              aria-label="Filter by kind"
              className="flex flex-wrap gap-1"
            >
              {KIND_CHIPS.map(({ label, kind }) => (
                <Chip
                  key={label}
                  active={kindFilter === kind}
                  onClick={() => handleChip(kind)}
                >
                  {label}
                </Chip>
              ))}
            </div>
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

        {/* Folder tiles first — from the cached tree, so pagination of
            the item listing never drops a folder off a page boundary. */}
        {tree.isLoading && <Skeleton className="h-24 w-full" />}
        {tree.data && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {selectedFolder === null && (
              <article className="group relative flex flex-col gap-2">
                <div
                  aria-current="page"
                  className="flex aspect-video items-center justify-center rounded-[var(--radius-card)]
                             border border-[var(--color-castify-accent)] bg-[var(--color-castify-surface)]
                             text-[var(--color-castify-muted)]"
                >
                  {/* Folder glyph — visual twin of FolderTile's, without
                      the link (the current location doesn't navigate). */}
                  <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="h-10 w-10"
                  >
                    <path
                      d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <div className="flex flex-col gap-1">
                  <h3 className="line-clamp-2 text-[13px] font-semibold leading-snug" title="Unfiled">
                    Unfiled
                  </h3>
                  <p className="text-xs text-[var(--color-castify-muted)]">
                    {tree.data.unfiled_count}{" "}
                    {tree.data.unfiled_count === 1 ? "item" : "items"}
                  </p>
                </div>
              </article>
            )}
            {subfolders.map((folder) => (
              <FolderTile
                key={folder.id}
                name={folder.name}
                folderId={folder.id}
                to="/"
                count={folder.item_count}
              />
            ))}
          </div>
        )}

        {/* First-run empty tree: an invitation, not a lone Unfiled dump. */}
        {emptyTree && (
          <div className="rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-4 py-8 text-center">
            <p className="text-sm font-semibold">Organize your library.</p>
            <p className="mt-1 text-sm text-[var(--color-castify-muted)]">
              Create folders and file your unfiled items into them.
            </p>
            <button
              type="button"
              onClick={() => onNewFolder?.()}
              className="mt-4 rounded-[var(--radius-button)] border border-[var(--color-castify-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-castify-accent)] transition hover:bg-[var(--color-castify-accent-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
            >
              New folder
            </button>
          </div>
        )}

        <ContentsBody
          contents={contents}
          page={page}
          onPageChange={setPage}
          filtersActive={filtersActive}
        />
      </div>
    </section>
  );
}
