// Browse page — M2 T7 poster-grid view + T8 scrollable shelves + T9 search
// + T10 filter panel / URL deep-linking + T13 continue-watching.
//
// Layout (the design's Library view, castify-design.html):
//   0. sr-only h1 "Your library" (a11y page heading — stats live in cells).
//   1. Stat cells row (the design's joined stat-row): Files (catalog
//      total) · Providers (connections) · Now scanning (provider label, or
//      an em-dash when idle). The design's Cache cell is deliberately
//      absent: the app exposes no cache-size API and the spec forbids new
//      queries. The design's 4th cell (Favorites) has no count API either.
//   2. Rails: Continue watching & listening (IndexedDB-backed, hidden when
//      empty), Recently added, Favorites (when any).
//   3. All-videos section: heading + mono result count + sort + filter
//      panel + poster grid + pagination. Search lives in the app topbar
//      (the design's placement) and writes this page's `?q=` param.
//   4. Folder organizer (sidebar tree + contents + provider chips).
//
// Search (T9, FR-2): the topbar owns the input and writes the debounced
// query into the URL. When `?q` is non-empty, the layout enters a focused
// search-results mode — rails (incl. continue-watching) and the organizer
// are hidden and the grid section shows "Search results for "q"" + count.
// Search composes with sort and all filters (FR-2.2).
//
// URL state (T10): all filter + sort + search state lives in URL search
// params via `useBrowseFilters()` for deep-linking + back-button support;
// the tree's `?dir=` (use-folder-dir) is separate. `page` is the only
// state kept local (deep-linking to page N is fragile).
//
// Empty states:
//   * Library truly empty (recentlyAdded has 0 videos): scan-aware CTA.
//   * Grid empty due to active filter: "No videos match this filter."
//   * Grid empty due to search query: 'No videos match "q".'
//
// Multi-select share mode (task 012): "Select" in the grid header toggles
// a selection mode where PosterCards toggle instead of navigating; the
// action bar's "Share N items" opens the shared creation dialog with the
// click order as curation order.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { FilterPanel } from "../components/filter-panel";
import { FavoriteToggle } from "../components/favorite-toggle";
import { PosterCard } from "../components/poster-card";
import { RatingStars } from "../components/rating-stars";
import { Shelf } from "../components/shelf";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Skeleton } from "../components/ui/skeleton";
import { useConnections } from "../hooks/use-connections";
import { useInProgressVideos } from "../hooks/use-in-progress-videos";
import { useVideos } from "../hooks/use-videos";
import { ContinueWatchingCard } from "../components/continue-watching-card";
import { FolderOrganizer } from "../components/folder-organizer";
import { ShareDialog } from "../components/share-dialog";
import { describeError } from "../lib/format";
import { useBrowseFilters } from "../lib/filter-state";
import {
  PROVIDER_LABELS,
  VIDEO_SORT_LABELS,
  VIDEO_SORT_OPTIONS,
  type ProviderKey,
  type VideoSortKey,
  type VideoSummaryDto,
} from "../api/types";
import { Button } from "../components/ui/button";

// ---------------------------------------------------------------------------
// BrowsePage
// ---------------------------------------------------------------------------

export function BrowsePage() {
  // URL-backed filter state (T10). All filters, sort, and the search query
  // (written by the topbar search) live in URL search params via this hook.
  const filters = useBrowseFilters();

  // Local state: page (not deep-linked — fragile across library churn).
  const [page, setPage] = useState(1);

  // Task 012: multi-select share mode. `selectedIds` is an array (not a
  // Set) so the owner's click order becomes the share's curation order.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [shareOpen, setShareOpen] = useState(false);

  function toggleSelected(id: string): void {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function exitSelectMode(): void {
    setSelectMode(false);
    setSelectedIds([]);
  }

  // Reset page to 1 whenever any filter value changes (not on initial mount).
  const filterSignature = JSON.stringify(filters.values);
  const prevSignature = useRef(filterSignature);
  useEffect(() => {
    if (prevSignature.current !== filterSignature) {
      prevSignature.current = filterSignature;
      setPage(1);
    }
  }, [filterSignature]);

  // Recently Added rail — always fires; also drives the empty check.
  const recentlyAdded = useVideos({ page: 1, sort: "date-desc", limit: 20 });

  // Grid query — reads all filter params from the URL hook.
  const videos = useVideos({
    page,
    ...filters.params,
  });

  const isSearching = filters.values.q !== "";

  // Connected providers — drives the organizer's chip row + watch-page
  // source pickers.
  const connections = useConnections();
  const connectedProviders: ProviderKey[] = Array.from(
    new Set((connections.data ?? []).map((c) => c.provider)),
  );

  function handleViewAll(filter: ViewAllFilter): void {
    // Clear the URL query immediately, then clear all filters and apply
    // the shelf's single filter.
    filters.setQ("");
    filters.clearAll();
    if (filter.favoritesOnly) filters.setFavoritesOnly(true);
    document
      .getElementById("all-videos")
      ?.scrollIntoView({ behavior: "smooth" });
  }

  // --- Initial load: skeleton header + skeleton grid ---
  if (recentlyAdded.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-full" />
        <LoadingSkeletonGrid />
      </div>
    );
  }

  // --- Recently Added query failed (DB error, network) ---
  if (recentlyAdded.isError) {
    return (
      <ErrorState
        title="Couldn't load videos."
        body={describeError(recentlyAdded.error)}
        onRetry={() => recentlyAdded.refetch()}
      />
    );
  }

  // --- Library is truly empty ---
  if (!recentlyAdded.data || recentlyAdded.data.videos.length === 0) {
    return <LibraryEmptyState />;
  }

  const hasActiveFilter = filters.activeCount > 0;
  const scanningConnection = connections.data?.find(
    (c) => c.scan_status === "scanning",
  );

  return (
    <div className="space-y-8">
      {/* A11y page heading — the visible identity is the stat cards below. */}
      <h1 className="sr-only">Your library</h1>

      {/* Stat cells row (the design's joined stat-row): figures share a
           hairline-ruled strip, mono counts. Stagger step 1. */}
      <div className="grid animate-stagger-in grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-rule)] shadow-sm sm:grid-cols-3 motion-reduce:animate-none">
        <StatCell
          label="Files"
          value={recentlyAdded.data.total.toLocaleString()}
        />
        <StatCell
          label="Providers"
          value={String(connections.data?.length ?? 0)}
        />
        <StatCell
          label="Now scanning"
          value={
            scanningConnection
              ? (PROVIDER_LABELS[scanningConnection.provider] ??
                scanningConnection.provider)
              : "—"
          }
          muted={!scanningConnection}
        />
      </div>

      {/* Stagger steps 2 + 3 (identity-pass task 003): the page-load
          stagger plays once down header → rails → organizer → grid at
          ~60ms offsets. Search hide/show would unmount + remount these
          sections and replay the 240ms animation on every search-clear.
          Chosen fix: the animated containers are these always-mounted
          wrappers — only their *children* swap on isSearching, so the
          animation runs once at mount and is never canceled. (The
          alternative — hiding via `display:none` on the animated node —
          cancels a finished CSS animation and replays it on re-display, so
          it was rejected; the wrapper restructure is thin, not invasive.) */}
      <div className="animate-stagger-in space-y-8 [animation-delay:60ms] motion-reduce:animate-none">
        {/* Rails + shelves — children hidden during active search (focused
            results mode); the wrapper above stays mounted. */}
        {!isSearching && (
          <>
            {/* T13: continue-watching rail (IndexedDB-backed) */}
            <ContinueWatchingShelf />

            {/* Rails */}
            <div className="space-y-6">
              <Shelf
                title="Recently added"
                videos={recentlyAdded.data.videos}
                totalCount={recentlyAdded.data.total}
                onViewAll={() => handleViewAll({})}
                compact
              />

              <FavoritesShelf
                onViewAll={() => handleViewAll({ favoritesOnly: true })}
              />
            </div>
          </>
        )}
      </div>

      {/* Stagger step 3: the All-files section — heading, search field
          (demo placement: above the grid), select/sort, filters, grid. */}
      <div
        id="all-videos"
        className="animate-stagger-in space-y-4 pt-2 [animation-delay:120ms] motion-reduce:animate-none"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-baseline gap-3">
            {isSearching ? (
              <>
                <h2 className="text-xl">
                  Search results for &ldquo;{filters.values.q}&rdquo;
                </h2>
                {videos.data && (
                  <p className="figure font-mono text-xs text-[var(--color-castify-muted)]">
                    {videos.data.total}{" "}
                    {videos.data.total === 1 ? "result" : "results"}
                  </p>
                )}
              </>
            ) : (
              <>
                <h2 className="text-xl">All videos</h2>
                {videos.data && (
                  <p className="figure font-mono text-xs text-[var(--color-castify-muted)]">
                    {videos.data.total.toLocaleString()}{" "}
                    {videos.data.total === 1 ? "video" : "videos"}
                  </p>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              aria-pressed={selectMode || undefined}
              onClick={() =>
                selectMode ? exitSelectMode() : setSelectMode(true)
              }
            >
              {selectMode ? "Cancel" : "Select"}
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-[var(--color-castify-muted)]">Sort</span>
              <select
                aria-label="Sort videos"
                value={filters.values.sort}
                onChange={(e) =>
                  filters.setSort(e.target.value as VideoSortKey)
                }
                className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-3 py-1.5 text-sm transition hover:bg-[var(--color-castify-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-canvas)]"
              >
                {VIDEO_SORT_OPTIONS.map((key) => (
                  <option key={key} value={key}>
                    {VIDEO_SORT_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* Task 012: multi-select action bar — shown while select mode is
            active. "Share N items" opens the same creation dialog the
            watch page uses; it needs ≥1 selection. */}
        {selectMode && (
          <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] px-4 py-3">
            <span className="text-sm">
              {selectedIds.length} {selectedIds.length === 1 ? "item" : "items"}{" "}
              selected
            </span>
            <Button
              size="sm"
              onClick={() => {
                if (selectedIds.length > 0) setShareOpen(true);
              }}
              disabled={selectedIds.length === 0}
            >
              Share {selectedIds.length}{" "}
              {selectedIds.length === 1 ? "item" : "items"}
            </Button>
            {selectedIds.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSelectedIds([])}
              >
                Clear
              </Button>
            )}
          </div>
        )}

        {/* Filter panel — top bar (provider chips + More filters drawer) +
            active-filter chips. */}
        <FilterPanel filters={filters} />

        <BrowseGrid
          videos={videos}
          page={page}
          onPageChange={setPage}
          hasActiveFilter={hasActiveFilter}
          searchQuery={isSearching ? filters.values.q : undefined}
          onClearFilters={() => filters.clearAll()}
          onClearSearch={() => filters.setQ("")}
          selection={
            selectMode ? { selectedIds, onToggle: toggleSelected } : undefined
          }
        />
      </div>

      {/* Stagger step 4: the folder organizer (spec IA: after the grid). */}
      <div className="animate-stagger-in [animation-delay:180ms] motion-reduce:animate-none">
        {!isSearching && (
          <FolderOrganizer connectedProviders={connectedProviders} />
        )}
      </div>

      {/* Task 012: creation dialog from the multi-select bar. Closing it
          (Done or Cancel) clears the selection — a second share wants a
          fresh curation, and a cancelled one has nothing to keep. */}
      {shareOpen && selectedIds.length > 0 && (
        <ShareDialog
          videoIds={selectedIds}
          itemLabel={`${selectedIds.length} ${
            selectedIds.length === 1 ? "video" : "videos"
          }`}
          onClose={() => {
            setShareOpen(false);
            setSelectedIds([]);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat cell (the design's joined stat-row cell: figure over label)
// ---------------------------------------------------------------------------

function StatCell({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="bg-[var(--color-castify-surface)] px-4 py-3.5">
      <span
        className={`figure block truncate text-[22px] font-semibold leading-tight ${
          muted ? "text-[var(--color-castify-muted)]" : ""
        }`}
      >
        {value}
      </span>
      <span className="mt-0.5 block text-xs text-[var(--color-castify-muted)]">
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter type for "View All" handlers
// ---------------------------------------------------------------------------

interface ViewAllFilter {
  favoritesOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Shelf sub-components (own their queries, conditionally render)
// ---------------------------------------------------------------------------

// Continue-watching shelf (M3 T13, FR-11).
//
// Reads from IndexedDB via `useInProgressVideos` — zero server calls per
// `docs/data-storage-principles.md` anti-pattern #3. Hidden while the query
// is loading and when no entries exist (FR-11.5). Renders its own row of
// `ContinueWatchingCard`s rather than reusing `<Shelf>` because the data
// shape (`ProgressEntry`) differs from `VideoSummaryDto`; a parallel layout
// keeps the shelf component typed against the catalog DTO and avoids an
// adapter layer just to share markup.
function ContinueWatchingShelf() {
  const query = useInProgressVideos();
  if (query.isLoading || !query.data || query.data.length === 0) return null;
  const entries = query.data;
  // Sibling list for the ephemeral play queue (T11) — every card on this
  // shelf carries the same `queue` so the watch page can next/prev through
  // the continue-watching context.
  const queue = entries.map((e) => e.videoId);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl">Continue watching &amp; listening</h2>
      </div>
      <div
        className="no-scrollbar flex gap-4 overflow-x-auto pb-2 pr-4"
        style={{ scrollSnapType: "x proximity" }}
      >
        {entries.map((entry) => (
          <div
            key={entry.videoId}
            className="w-[160px] flex-shrink-0"
            style={{ scrollSnapAlign: "start" }}
          >
            <ContinueWatchingCard entry={entry} queue={queue} />
          </div>
        ))}
        {/* Trailing spacer so the last card can scroll fully into view. */}
        <div aria-hidden className="w-1 flex-shrink-0" />
      </div>
    </section>
  );
}

function FavoritesShelf({ onViewAll }: { onViewAll: () => void }) {
  const query = useVideos({
    page: 1,
    sort: "date-desc",
    limit: 20,
    favorites_only: true,
  });
  if (query.isLoading) return null;
  if (query.isError) return <ShelfError title="Favorites" />;
  if (!query.data || query.data.videos.length === 0) return null;
  return (
    <Shelf
      title="Favorites"
      videos={query.data.videos}
      totalCount={query.data.total}
      onViewAll={onViewAll}
      compact
    />
  );
}

// Compact inline error for shelf queries (audit §2a: shelves previously
// returned null on error, silently hiding failures).
function ShelfError({ title }: { title: string }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xl">{title}</h2>
      <div className="rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] px-4 py-3 text-sm text-[var(--color-castify-muted)]">
        Couldn't load this shelf.
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Grid section
// ---------------------------------------------------------------------------

interface BrowseGridProps {
  videos: ReturnType<typeof useVideos>;
  page: number;
  onPageChange: (page: number) => void;
  hasActiveFilter: boolean;
  searchQuery?: string;
  onClearFilters: () => void;
  onClearSearch: () => void;
  /** Present while browse multi-select is active (task 012) — cards
   * toggle selection instead of navigating to the watch page. */
  selection?: {
    selectedIds: string[];
    onToggle: (id: string) => void;
  };
}

function BrowseGrid({
  videos,
  page,
  onPageChange,
  hasActiveFilter,
  searchQuery,
  onClearFilters,
  onClearSearch,
  selection,
}: BrowseGridProps) {
  if (videos.isLoading) {
    return <LoadingSkeletonGrid />;
  }
  if (videos.isError) {
    return (
      <ErrorState
        title="Couldn't load videos."
        body={describeError(videos.error)}
        onRetry={() => videos.refetch()}
      />
    );
  }

  const data = videos.data;
  if (!data || data.videos.length === 0) {
    if (searchQuery) {
      return (
        <EmptyState
          title={`No videos match \u201c${searchQuery}\u201d`}
          body="Try a different search term."
          onAction={onClearSearch}
          actionLabel="Clear search"
        />
      );
    }
    if (hasActiveFilter) {
      return (
        <EmptyState
          title="No videos match this filter"
          body="Try adjusting or clearing your filters."
          onAction={onClearFilters}
          actionLabel="Clear filters"
        />
      );
    }
    // Library-empty case is handled at the top level, but guard just in case.
    return <LibraryEmptyState />;
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.limit));
  // Sibling list for the ephemeral play queue — the current grid page.
  // Passed through PosterCard → router state → watch page (T11).
  const gridQueue = data.videos.map((v) => v.id);

  // Dim the grid slightly during a background refetch (filter/page change)
  // instead of replacing it with a skeleton — preserves scroll position and
  // avoids the flash. Skeleton is reserved for the initial load above.
  const containerOpacity = videos.isFetching ? "opacity-60" : "opacity-100";

  return (
    <div
      className={`space-y-4 transition-opacity duration-150 ${containerOpacity}`}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {data.videos.map((video: VideoSummaryDto) => (
          <PosterCard
            key={video.id}
            video={video}
            href={`/watch/${video.id}`}
            queue={gridQueue}
            // Selection mode replaces navigation + personalization with
            // toggling — the slots would fight the card-level click.
            topRightSlot={
              selection ? undefined : <FavoriteToggle video={video} />
            }
            ratingSlot={selection ? undefined : <RatingStars video={video} />}
            selection={
              selection
                ? {
                    isSelected: selection.selectedIds.includes(video.id),
                    onToggle: () => selection.onToggle(video.id),
                  }
                : undefined
            }
          />
        ))}
      </div>
      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={onPageChange}
          isFetching={videos.isFetching}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  isFetching: boolean;
}

function Pagination({
  page,
  totalPages,
  onPageChange,
  isFetching,
}: PaginationProps) {
  return (
    <div className="flex items-center justify-between gap-4 pt-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1 || isFetching}
      >
        Previous
      </Button>
      <span className="figure text-sm text-[var(--color-castify-muted)]">
        Page {page} of {totalPages}
        {isFetching ? " · loading…" : ""}
      </span>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages || isFetching}
      >
        Next
      </Button>
    </div>
  );
}

function LibraryEmptyState() {
  const navigate = useNavigate();
  const connections = useConnections();
  const isScanning =
    connections.data?.some((c) => c.scan_status === "scanning") ?? false;

  if (isScanning) {
    return (
      <EmptyState
        title={"Scanning your cloud\u2026"}
        body="Videos will appear here as the scan progresses."
      />
    );
  }
  return (
    <EmptyState
      title="No videos yet"
      body="Connect a cloud provider to populate your library."
      onAction={() => navigate("/connections")}
      actionLabel="Connect a provider"
    />
  );
}

// Skeleton mirrors the responsive poster grid (2/3/4/5/6 cols) with 12
// placeholder cards — enough to fill the first viewport at any breakpoint.
function LoadingSkeletonGrid() {
  return (
    <div className="space-y-4">
      <div className="h-4 w-24 rounded bg-[var(--color-castify-hover)]" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] p-2"
          >
            <div className="aspect-video w-full animate-pulse rounded-[var(--radius-button)] bg-[var(--color-castify-hover)]" />
            <div className="space-y-1.5 px-1 pb-1">
              <div className="h-3 w-3/4 rounded bg-[var(--color-castify-hover)]" />
              <div className="h-3 w-1/2 rounded bg-[var(--color-castify-hover)]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
