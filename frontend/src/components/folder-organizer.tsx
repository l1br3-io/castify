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

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

import { FileCard, FileRow, KindIcon } from "./file-card";
import { KIND_HUES } from "./kind-hues";
import { FolderNameDialog } from "./folder-name-dialog";
import { FolderPickerDialog } from "./folder-picker-dialog";
import { FolderTile } from "./folder-tile";
import { LibraryFolderMenu } from "./library-folder-menu";
import { LibraryItemMenu } from "./library-item-menu";
import { PosterCard } from "./poster-card";
import { FavoriteToggle } from "./favorite-toggle";
import { ListView, type ListViewRow } from "./list-view";
import { ViewToggle } from "./view-toggle";
import { FolderIcon } from "./icons";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { useDrag } from "./drag-context";
import { carryPayload, type DragItem } from "../lib/drag-engine";
import { useDropTarget } from "../hooks/use-drop-target";
import { useToast } from "../hooks/use-toast";
import {
  FILE_KIND_LABELS,
  PROVIDER_LABELS,
  type FileEntryDto,
  type FolderEntryDto,
  type LibraryTreeDto,
  type LibraryTreeFolderDto,
  type ProviderKey,
} from "../api/types";
import { fileDownloadUrl } from "../api/folders";
import { useFolderContents } from "../hooks/use-folder-contents";
import { useFolderDir } from "../hooks/use-folder-dir";
import { useViewMode, type ViewMode } from "../hooks/use-view-mode";
import {
  useCreateLibraryFolder,
  useDeleteLibraryFolder,
  useLibraryFolderContents,
  useLibraryFolderNav,
  useLibraryFolderTree,
  useMoveLibraryItems,
  useUpdateLibraryFolder,
} from "../hooks/use-library-folders";
import type { LibraryMoveItem } from "../api/library-folders";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { describeError, formatDate, formatDuration, formatSize } from "../lib/format";
import { onNewFolder as onNewFolderSignal } from "../lib/new-folder-event";
import { Skeleton } from "./ui/skeleton";
import { ErrorState } from "./ui/error-state";

type FolderOrganizerProps = {
  /** Connected providers, in display order — drives the provider pane's
   *  chip row. */
  connectedProviders: ProviderKey[];
};

export function FolderOrganizer({ connectedProviders }: FolderOrganizerProps) {
  const providerMode = useSearchParams()[0].has("dir");
  return providerMode ? (
    <ProviderPane connectedProviders={connectedProviders} />
  ) : (
    <CuratedPane />
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
  /** Current presentation (library-list-view task 005) — the pane above
   *  owns the toggle + preference; this is the rendered mode. */
  viewMode: ViewMode;
  /** Select mode (curated pane): when set, cards toggle instead of
   *  navigating and per-item menus hide. */
  selection?: {
    selectedIds: Set<string>;
    onToggle: (entry: FolderEntryDto) => void;
  };
  /** Per-item kebab factory (curated pane, outside select mode). */
  itemMenu?: (entry: FolderEntryDto) => ReactNode;
  /** Drag source wiring (drag-and-drop effort, curated pane): a
   *  pointer-down on a contents card. The pane computes the carried
   *  payload (selection rule); the engine's threshold separates click
   *  from drag. */
  itemDragStart?: (entry: FolderEntryDto, event: ReactPointerEvent) => void;
};

/** One contents entry → one slate row (library-list-view task 005). The
 *  mixed table wears a uniform column set — the header comes from the
 *  first row, so video and file rows must agree on keys (videos report
 *  Kind "Video"; non-media kinds report Duration "—"). */
function entryToRow(
  entry: FolderEntryDto,
  videoQueue: string[],
  itemMenu?: (entry: FolderEntryDto) => ReactNode,
): ListViewRow {
  const providerLabel = PROVIDER_LABELS[entry.provider] ?? entry.provider;
  if (entry.kind === "video") {
    return {
      id: entry.id,
      name: entry.name,
      href: `/watch/${entry.id}`,
      linkState: { queue: videoQueue },
      thumbnail: { video: entry },
      columns: [
        { key: "kind", label: "Kind", className: "hidden lg:table-cell", value: "Video" },
        { key: "duration", label: "Duration", mono: true, value: entry.duration_ms !== null ? formatDuration(entry.duration_ms) : "—" },
        { key: "size", label: "Size", mono: true, numeric: true, className: "hidden md:table-cell", value: formatSize(entry.size_bytes) },
        { key: "provider", label: "Provider", className: "hidden xl:table-cell", value: providerLabel },
        { key: "modified", label: "Modified", mono: true, className: "hidden lg:table-cell", value: formatDate(entry.created_at) },
      ],
      favoriteSlot: <FavoriteToggle video={entry} />,
      menuSlot: itemMenu?.(entry),
    };
  }
  return {
    id: entry.id,
    name: entry.name,
    kindHue: KIND_HUES[entry.kind].tab,
    kindIcon: <KindIcon kind={entry.kind} className="h-6 w-6" />,
    columns: [
      { key: "kind", label: "Kind", className: "hidden lg:table-cell", value: FILE_KIND_LABELS[entry.kind] },
      { key: "duration", label: "Duration", mono: true, value: "—" },
      { key: "size", label: "Size", mono: true, numeric: true, className: "hidden md:table-cell", value: formatSize(entry.size_bytes) },
      { key: "provider", label: "Provider", className: "hidden xl:table-cell", value: providerLabel },
      { key: "modified", label: "Modified", mono: true, className: "hidden lg:table-cell", value: entry.modified_at !== null ? formatDate(entry.modified_at) : "—" },
    ],
    // The download affordance rides the trailing cell — FileRow's link,
    // relocated (a click here downloads, never navigates).
    favoriteSlot: (
      <a
        href={fileDownloadUrl(entry.id)}
        aria-label={`Download ${entry.name}`}
        download
        className="rounded-[var(--radius-button)] px-2 py-1 text-xs font-semibold text-[var(--color-castify-accent)] transition hover:bg-[var(--color-castify-accent-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-castify-accent)]"
      >
        Download
      </a>
    ),
    menuSlot: itemMenu?.(entry),
  };
}

/** The shared contents rendering: grid tiles + list rows + pagination +
 *  loading/error/empty states. Both panes render items through this —
 *  one rendering rule set, per the spec's "no forked siblings". */
function ContentsBody({
  contents,
  page,
  onPageChange,
  filtersActive,
  viewMode,
  selection,
  itemMenu,
  itemDragStart,
}: ContentsBodyProps) {
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
      {contents.data && contents.data.entries.length > 0 && viewMode === "list" && (
        <>
          {/* List mode (library-list-view task 005): every kind as a slate
              row, display-only headers — the server's name-asc order
              stands (spec decision: no folder-contents sort param). */}
          <ListView
            ariaLabel="Folder contents"
            rows={contents.data.entries.map((entry) =>
              entryToRow(entry, videoQueue, itemMenu),
            )}
            selection={
              selection && {
                isSelected: (row) => selection.selectedIds.has(row.id),
                onToggle: (row) => {
                  const entry = contents.data?.entries.find((e) => e.id === row.id);
                  if (entry !== undefined) selection.onToggle(entry);
                },
              }
            }
          />

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
      {contents.data && contents.data.entries.length > 0 && viewMode === "grid" && (
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
                  dragHandle={
                    itemDragStart && {
                      onPointerDown: (event) => itemDragStart(entry, event),
                    }
                  }
                  topRightSlot={
                    <>
                      <FavoriteToggle video={entry} />
                      {itemMenu?.(entry)}
                    </>
                  }
                  selection={
                    selection && {
                      isSelected: selection.selectedIds.has(entry.id),
                      onToggle: () => selection.onToggle(entry),
                    }
                  }
                />
              ) : (
                <FileCard
                  key={entry.id}
                  file={entry}
                  dragHandle={
                    itemDragStart && {
                      onPointerDown: (event) => itemDragStart(entry, event),
                    }
                  }
                  selection={
                    selection && {
                      isSelected: selection.selectedIds.has(entry.id),
                      onToggle: () => selection.onToggle(entry),
                    }
                  }
                  menuSlot={itemMenu?.(entry)}
                />
              ),
            )}
          </div>
          {/* List children: documents/archives/subtitles/other. */}
          <div className="space-y-2">
            {listEntries.map((entry) => (
              <FileRow
                key={entry.id}
                file={entry}
                dragHandle={
                  itemDragStart && {
                    onPointerDown: (event) => itemDragStart(entry, event),
                  }
                }
                selection={
                  selection && {
                    isSelected: selection.selectedIds.has(entry.id),
                    onToggle: () => selection.onToggle(entry),
                  }
                }
                menuSlot={itemMenu?.(entry)}
              />
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
  const [viewMode, setViewMode] = useViewMode();
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
            <ViewToggle mode={viewMode} onModeChange={setViewMode} />
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
          viewMode={viewMode}
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

/** Owner CRUD dialog state — one slot, four kinds, like share-manage. */
type FolderDialog =
  | { kind: "create" }
  | { kind: "rename"; folder: LibraryTreeFolderDto }
  | { kind: "move"; folder: LibraryTreeFolderDto }
  | { kind: "delete"; folder: LibraryTreeFolderDto }
  | null;

/** Pairwise kind+id equality in order — the carried payload vs the live
 *  selection, to clear exactly what a drop carried away. */
function sameItems(a: LibraryMoveItem[], b: LibraryMoveItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, i) => item.kind === b[i]!.kind && item.id === b[i]!.id)
  );
}

/**
 * A folder tile that accepts item drops (drag-and-drop task 002).
 * Registers with the drag context, previews the post-drop count while
 * hovered, and hands the carried items to the pane's single batch-move
 * mutation. The menu slot keeps the tile's non-drag affordances intact
 * — drag is a convenience layer, never the only path.
 */
function DroppableFolderTile({
  folder,
  topRightSlot,
  onDropItems,
}: {
  folder: LibraryTreeFolderDto;
  topRightSlot?: ReactNode;
  onDropItems: (folderId: string | null, folderName: string, items: LibraryMoveItem[]) => void;
}) {
  const { state } = useDrag();
  const { isDropHovered, dropProps } = useDropTarget(`folder:${folder.id}`, {
    canDrop: (payload) => payload.type === "items",
    onDrop: (payload) => {
      if (payload.type === "items") {
        onDropItems(folder.id, folder.name, payload.items);
      }
    },
  });
  const preview =
    isDropHovered && state.phase === "dragging" && state.payload.type === "items"
      ? folder.item_count + state.payload.items.length
      : null;

  return (
    <FolderTile
      name={folder.name}
      folderId={folder.id}
      to="/"
      count={folder.item_count}
      topRightSlot={topRightSlot}
      {...dropProps}
      dropHovered={isDropHovered}
      countPreview={preview}
    />
  );
}

function CuratedPane() {
  const { selectedFolder, selectCurated } = useLibraryFolderNav();
  const tree = useLibraryFolderTree();
  const [page, setPage] = useState(1);
  const [kindFilter, setKindFilter] = useState<string | undefined>();
  const [nameQuery, setNameQuery] = useState("");
  const [folderDialog, setFolderDialog] = useState<FolderDialog>(null);
  const debouncedNameQuery = useDebouncedValue(nameQuery, 300);
  const [viewMode, setViewMode] = useViewMode();

  // Select mode (task 009, the browse grid's pattern): mixed selection
  // in click order; one batch mutation per action. Selection is client
  // state — cleared on folder change, Escape, and successful moves.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<LibraryMoveItem[]>([]);
  const [moveTarget, setMoveTarget] = useState<"batch" | LibraryMoveItem | null>(null);

  const createFolder = useCreateLibraryFolder();
  const updateFolder = useUpdateLibraryFolder();
  const deleteFolder = useDeleteLibraryFolder();
  const moveItems = useMoveLibraryItems();

  // Drag-and-drop (drag-and-drop effort): cards arm the engine with the
  // selection-carry rule; folder tiles + the Unfiled pin accept drops.
  // One drop → the same `moveItems` mutation the dialogs use — one
  // request, one transaction, unchanged contract.
  const { state: dragState, beginDrag } = useDrag();
  const toast = useToast();
  // A completed drag swallows its ghost click (see the section handlers
  // below) so releasing over a card or tile never navigates.
  const swallowClickRef = useRef(false);

  // The sidebar's "New folder" entry points open the create dialog here
  // (open dialogs are ephemeral client state — the DOM event keeps the
  // siblings decoupled without URL or server involvement).
  useEffect(
    () => onNewFolderSignal(() => setFolderDialog({ kind: "create" })),
    [],
  );

  // Folder switches always land on page 1.
  useEffect(() => {
    setPage(1);
  }, [selectedFolder, kindFilter, debouncedNameQuery]);

  // A different level's listing must not carry the old selection.
  useEffect(() => {
    setSelected([]);
  }, [selectedFolder]);

  // Escape cancels select mode — the grid's Cancel affordance for
  // keyboard users.
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSelectMode(false);
        setSelected([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode]);

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

  function toggleSelected(entry: FolderEntryDto): void {
    setSelected((prev) => {
      const index = prev.findIndex((item) => item.id === entry.id);
      if (index >= 0) return prev.filter((_, i) => i !== index);
      return [
        ...prev,
        { kind: entry.kind === "video" ? "video" : "file", id: entry.id },
      ];
    });
  }

  /** The picker's submit: one mutation for the whole batch (or the
   *  single degenerate one). Success clears the selection; failure
   *  keeps it and surfaces the error in the action bar. */
  function handleMovePick(target: string | null): void {
    if (moveTarget === null) return;
    const items: LibraryMoveItem[] =
      moveTarget === "batch" ? selected : [moveTarget];
    moveItems.mutate(
      { items, folderId: target },
      {
        onSuccess: () => {
          setMoveTarget(null);
          if (moveTarget === "batch") setSelected([]);
        },
      },
    );
  }

  /** A card press arms the engine. The payload carries the selection
   *  when the grabbed card is in it (the engine's carry rule); the
   *  threshold keeps plain clicks untouched. Primary button only —
   *  right/middle clicks keep their browser meanings. */
  function handleItemPointerDown(entry: FolderEntryDto, event: ReactPointerEvent): void {
    if (event.button !== 0) return;
    const grabbed: DragItem = {
      kind: entry.kind === "video" ? "video" : "file",
      id: entry.id,
    };
    beginDrag({ x: event.clientX, y: event.clientY }, carryPayload(grabbed, selected));
  }

  /** A drop onto a folder tile or the Unfiled pin: the same single batch
   *  mutation as the picker, plus the toast the drop promises. Success
   *  clears a selection the payload carried away. */
  function handleDropIntoFolder(
    folderId: string | null,
    folderName: string,
    items: LibraryMoveItem[],
  ): void {
    moveItems.mutate(
      { items, folderId },
      {
        onSuccess: () => {
          toast.success(`Moved to ${folderName}`);
          setSelected((prev) => (sameItems(prev, items) ? [] : prev));
        },
        onError: (error) => toast.error(`Move failed — ${describeError(error)}`),
      },
    );
  }

  const selectedIds = new Set(selected.map((item) => item.id));

  // The Unfiled pin accepts drops the same way tiles do — move with
  // `folder_id: null` (the pane's own pin only renders at the root,
  // where Unfiled is the current view; the drop is still a legal move).
  const unfiledDrop = useDropTarget("unfiled", {
    canDrop: (payload) => payload.type === "items",
    onDrop: (payload) => {
      if (payload.type === "items") {
        handleDropIntoFolder(null, "Unfiled", payload.items);
      }
    },
  });
  const unfiledCount = tree.data?.unfiled_count ?? 0;
  const unfiledPreview =
    unfiledDrop.isDropHovered &&
    dragState.phase === "dragging" &&
    dragState.payload.type === "items"
      ? unfiledCount + dragState.payload.items.length
      : null;

  const filtersActive = kindFilter !== undefined || nameQuery.trim() !== "";

  return (
    <section
      aria-label="Folder organizer"
      className="space-y-4"
      // Ghost-click swallow: the browser fires a click after a completed
      // drag's pointerup (on the down/up targets' common ancestor). The
      // capture handlers run before the provider's window pointerup
      // resolves the drop, so `dragState` still reads "dragging" — mark
      // the swallow, then eat exactly one click. Without this, releasing
      // over a card or tile navigates through its link.
      onPointerDownCapture={() => {
        swallowClickRef.current = false;
      }}
      onPointerUpCapture={() => {
        if (dragState.phase === "dragging") swallowClickRef.current = true;
      }}
      onClickCapture={(event) => {
        if (swallowClickRef.current) {
          swallowClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
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
            <ViewToggle mode={viewMode} onModeChange={setViewMode} />
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
            <button
              type="button"
              aria-pressed={selectMode}
              onClick={() => {
                setSelectMode((mode) => !mode);
                setSelected([]);
              }}
              className={`keycap transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)] ${
                selectMode ? "keycap-active" : "keycap-inactive"
              }`}
            >
              {selectMode ? "Done" : "Select items"}
            </button>
            <button
              type="button"
              onClick={() => setFolderDialog({ kind: "create" })}
              className="keycap keycap-inactive transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)]"
            >
              + New folder
            </button>
          </div>
        </div>

        {/* Select-mode action bar — the count plus the one move action
            that fires a single batch mutation. */}
        {selectMode && (
          <div
            role="group"
            aria-label="Selection actions"
            className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-castify-accent)] bg-[var(--color-castify-accent-subtle)] px-3 py-2 text-sm"
          >
            <span className="font-semibold">
              {selected.length} {selected.length === 1 ? "item" : "items"} selected
            </span>
            <button
              type="button"
              disabled={selected.length === 0 || moveItems.isPending}
              onClick={() => setMoveTarget("batch")}
              className="rounded-[var(--radius-button)] border border-[var(--color-castify-accent)] px-3 py-1.5 font-semibold text-[var(--color-castify-accent)] transition hover:bg-[var(--color-castify-canvas)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
            >
              Move to folder
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectMode(false);
                setSelected([]);
              }}
              className="rounded-[var(--radius-button)] px-3 py-1.5 text-[var(--color-castify-muted)] transition hover:text-[var(--color-castify-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
            >
              Cancel
            </button>
            {moveItems.isError && (
              <span className="text-sm text-[var(--color-castify-danger,inherit)]">
                {describeError(moveItems.error)}
              </span>
            )}
          </div>
        )}

        {/* Folder tiles first — from the cached tree, so pagination of
            the item listing never drops a folder off a page boundary.
            List mode renders them as slate rows instead (task 005): the
            Unfiled pin is the current-location row, subfolders navigate
            via the name button (the tile's click, relocated). */}
        {tree.isLoading && <Skeleton className="h-24 w-full" />}
        {tree.data && viewMode === "list" && subfolders.length + (selectedFolder === null ? 1 : 0) > 0 && (
          <ListView
            ariaLabel="Folders"
            rows={[
              ...(selectedFolder === null
                ? [{
                    id: "unfiled",
                    name: "Unfiled",
                    current: true,
                    kindIcon: <FolderIcon className="h-6 w-6" />,
                    columns: [
                      {
                        key: "items",
                        label: "Items",
                        value: tree.data.unfiled_count,
                        mono: true,
                        numeric: true,
                      },
                    ],
                    menuSlot: (
                      <LibraryFolderMenu
                        label="Unfiled"
                        onNewFolder={() => setFolderDialog({ kind: "create" })}
                      />
                    ),
                  }]
                : []),
              ...subfolders.map((folder) => ({
                id: folder.id,
                name: folder.name,
                nameAction: { onClick: () => selectCurated(folder.id) },
                kindIcon: <FolderIcon className="h-6 w-6" />,
                columns: [
                  {
                    key: "items",
                    label: "Items",
                    value: folder.item_count,
                    mono: true,
                    numeric: true,
                  },
                ],
                menuSlot: (
                  <LibraryFolderMenu
                    label={folder.name}
                    onRename={() => setFolderDialog({ kind: "rename", folder })}
                    onMove={() => setFolderDialog({ kind: "move", folder })}
                    onDelete={() => setFolderDialog({ kind: "delete", folder })}
                  />
                ),
              })),
            ]}
          />
        )}
        {tree.data && viewMode === "grid" && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {selectedFolder === null && (
              <article
                className="group relative flex flex-col gap-2"
                {...unfiledDrop.dropProps}
              >
                <div
                  aria-current="page"
                  className={`relative flex aspect-video items-center justify-center rounded-[var(--radius-card)]
                             border text-[var(--color-castify-muted)] transition-colors
                             ${
                               unfiledDrop.isDropHovered
                                 ? "border-[var(--color-castify-accent)] bg-[var(--color-castify-accent-subtle)]"
                                 : "border-[var(--color-castify-accent)] bg-[var(--color-castify-surface)]"
                             }`}
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
                  <span className="absolute right-2 top-2 z-10">
                    <LibraryFolderMenu
                      label="Unfiled"
                      onNewFolder={() => setFolderDialog({ kind: "create" })}
                    />
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <h3 className="line-clamp-2 text-[13px] font-semibold leading-snug" title="Unfiled">
                    Unfiled
                  </h3>
                  <p className="text-xs text-[var(--color-castify-muted)]">
                    {unfiledPreview !== null
                      ? `${unfiledCount} → ${unfiledPreview} items`
                      : `${unfiledCount} ${unfiledCount === 1 ? "item" : "items"}`}
                  </p>
                </div>
              </article>
            )}
            {subfolders.map((folder) => (
              <DroppableFolderTile
                key={folder.id}
                folder={folder}
                onDropItems={handleDropIntoFolder}
                topRightSlot={
                  <LibraryFolderMenu
                    label={folder.name}
                    onRename={() => setFolderDialog({ kind: "rename", folder })}
                    onMove={() => setFolderDialog({ kind: "move", folder })}
                    onDelete={() => setFolderDialog({ kind: "delete", folder })}
                  />
                }
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
              onClick={() => setFolderDialog({ kind: "create" })}
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
          viewMode={viewMode}
          itemDragStart={handleItemPointerDown}
          selection={
            selectMode ? { selectedIds, onToggle: toggleSelected } : undefined
          }
          itemMenu={
            selectMode
              ? undefined
              : (entry) => (
                  <LibraryItemMenu
                    itemName={entry.name}
                    onMove={() =>
                      setMoveTarget({
                        kind: entry.kind === "video" ? "video" : "file",
                        id: entry.id,
                      })
                    }
                  />
                )
          }
        />
      </div>

      {/* Batch/single move picker — one dialog, one request per pick. */}
      {moveTarget !== null && (
        <FolderPickerDialog
          title={
            moveTarget === "batch"
              ? `Move ${selected.length} ${
                  selected.length === 1 ? "item" : "items"
                }`
              : "Move to folder"
          }
          rootLabel="Unfiled"
          folders={tree.data?.folders ?? []}
          currentFolderId={selectedFolder}
          pending={moveItems.isPending}
          onPick={handleMovePick}
          onClose={() => setMoveTarget(null)}
        />
      )}

      {/* Owner CRUD dialogs — mutations invalidate the tree + contents
          families (the task-004 hooks); a success closes the dialog, an
          error keeps it open with the server's copy under the field. */}
      {folderDialog?.kind === "create" && (
        <FolderNameDialog
          title="New folder"
          initialName=""
          pending={createFolder.isPending}
          error={createFolder.isError ? describeError(createFolder.error) : undefined}
          onSubmit={(name) =>
            createFolder.mutate(
              { name, parentId: selectedFolder ?? undefined },
              { onSuccess: () => setFolderDialog(null) },
            )
          }
          onClose={() => setFolderDialog(null)}
        />
      )}
      {folderDialog?.kind === "rename" && (
        <FolderNameDialog
          title={`Rename "${folderDialog.folder.name}"`}
          initialName={folderDialog.folder.name}
          pending={updateFolder.isPending}
          error={updateFolder.isError ? describeError(updateFolder.error) : undefined}
          onSubmit={(name) =>
            updateFolder.mutate(
              { id: folderDialog.folder.id, name },
              { onSuccess: () => setFolderDialog(null) },
            )
          }
          onClose={() => setFolderDialog(null)}
        />
      )}
      {folderDialog?.kind === "move" && (
        <FolderPickerDialog
          title={`Move "${folderDialog.folder.name}"`}
          rootLabel="Unfiled"
          folders={tree.data?.folders ?? []}
          excludeSubtreeOf={folderDialog.folder.id}
          currentFolderId={folderDialog.folder.parent_id}
          pending={updateFolder.isPending}
          onPick={(target) =>
            updateFolder.mutate(
              { id: folderDialog.folder.id, parentId: target },
              { onSuccess: () => setFolderDialog(null) },
            )
          }
          onClose={() => setFolderDialog(null)}
        />
      )}
      {folderDialog?.kind === "delete" && (
        <Dialog
          open
          onClose={() => setFolderDialog(null)}
          closeable={!deleteFolder.isPending}
          title={`Delete "${folderDialog.folder.name}"?`}
        >
          <div className="space-y-4">
            <p className="text-sm text-[var(--color-castify-muted)]">
              Items in it return to Unfiled and its subfolders move to the
              top level — nothing is deleted from your library.
            </p>
            {deleteFolder.isError && (
              <p className="text-sm text-[var(--color-castify-danger,inherit)]">
                {describeError(deleteFolder.error)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setFolderDialog(null)}
                disabled={deleteFolder.isPending}
              >
                Cancel
              </Button>
              <Button
                pending={deleteFolder.isPending}
                onClick={() =>
                  deleteFolder.mutate(folderDialog.folder.id, {
                    onSuccess: () => {
                      setFolderDialog(null);
                      // Deleting the folder we're standing in strands
                      // the view — climb to the root (Unfiled).
                      if (folderDialog.folder.id === selectedFolder) {
                        selectCurated(null);
                      }
                    },
                  })
                }
              >
                Delete
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
