// Browse page — M2 T7 poster-grid view + T8 scrollable shelves + T9 search
// + T10 filter panel / URL deep-linking + T13 continue-watching. M9 redesign
// §7: the featured-video hero is gone; a compact library header (stats +
// search) leads, rails stay compact, and the folder organizer (task 013)
// becomes the page's spine.
//
// Layout (M9 FR-7):
//   0. Compact header: "Your library · N videos · M clouds" + SearchBar
//      (always at top; "/" focuses it).
//   1. Continue-watching rail (T13, IndexedDB-backed; hidden when empty).
//   2. Rails section (horizontal scrollable rows):
//      - Recently Added (always shown)
//      - Favorites (shown only when owner has ≥1 favorite)
//   3. Folder organizer (M9 task 013: tree + contents + provider chips).
//   4. "All Videos" grid section (poster grid + sort + filter panel + pagination).
//
// Search (T9, FR-2): when the debounced query is non-empty, the layout enters
// a focused search-results mode — rails (incl. continue-watching) and the
// organizer are hidden and the grid section shows "Search results for "q"" +
// count. Search composes with sort and all filters (FR-2.2).
//
// URL state (T10): all filter + sort + search state lives in URL search params
// via `useBrowseFilters()` for deep-linking + back-button support; the tree's
// `?dir=` (use-folder-dir) is separate. `page` is the only state kept local
// (deep-linking to page N is fragile). The raw search input is also local
// (debounced before writing to URL).
//
// Empty states:
//   * Library truly empty (recentlyAdded has 0 videos): scan-aware CTA.
//   * Grid empty due to active filter: "No videos match this filter."
//   * Grid empty due to search query: 'No videos match "q".'

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { FilterPanel } from "../components/filter-panel";
import { FavoriteToggle } from "../components/favorite-toggle";
import { PosterCard } from "../components/poster-card";
import { RatingStars } from "../components/rating-stars";
import { SearchBar } from "../components/search-bar";
import { Shelf } from "../components/shelf";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Skeleton } from "../components/ui/skeleton";
import { useConnections } from "../hooks/use-connections";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { useInProgressVideos } from "../hooks/use-in-progress-videos";
import { useVideos } from "../hooks/use-videos";
import { ContinueWatchingCard } from "../components/continue-watching-card";
import { FolderOrganizer } from "../components/folder-organizer";
import { describeError } from "../lib/format";
import { useBrowseFilters } from "../lib/filter-state";
import {
  VIDEO_SORT_LABELS,
  VIDEO_SORT_OPTIONS,
  type ProviderKey,
  type VideoSortKey,
  type VideoSummaryDto,
} from "../api/types";

// ---------------------------------------------------------------------------
// BrowsePage
// ---------------------------------------------------------------------------

export function BrowsePage() {
  // URL-backed filter state (T10). All filters, sort, and the debounced search
  // query live in URL search params via this hook.
  const filters = useBrowseFilters();

  // Local state: page (not deep-linked — fragile across library churn) and the
  // raw search input (debounced before syncing to URL).
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState(filters.values.q);
  const debouncedQuery = useDebouncedValue(query, 300);
  const searchRef = useRef<HTMLInputElement>(null);

  // Sync debounced search → URL. URL `q` is the single source of truth for the
  // API call + `isSearching` display. The setter identity changes per render
  // (closure over searchParams); only fire on debouncedQuery change.
  useEffect(() => {
    filters.setQ(debouncedQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  // Reset page to 1 whenever any filter value changes (not on initial mount).
  const filterSignature = JSON.stringify(filters.values);
  const prevSignature = useRef(filterSignature);
  useEffect(() => {
    if (prevSignature.current !== filterSignature) {
      prevSignature.current = filterSignature;
      setPage(1);
    }
  }, [filterSignature]);

  // Keyboard shortcut: "/" focuses the search bar (T9). Ignored when the user
  // is already typing in an input/textarea or holding a modifier key.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable
      )
        return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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
    // Clear search input + URL immediately, then clear all filters and apply
    // the shelf's single filter.
    setQuery("");
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
  const libraryStats = `Your library · ${recentlyAdded.data.total} ${
    recentlyAdded.data.total === 1 ? "video" : "videos"
  } · ${connections.data?.length ?? 0} ${connections.data?.length === 1 ? "cloud" : "clouds"}`;

  return (
    <div className="space-y-8">
      {/* Compact library header (M9 FR-7.2): stats + search in one sticky
          row. This replaces the old 40vh featured-video hero — an organizer,
          not a premiere. */}
      <div className="sticky top-0 z-20 -mx-4 bg-[var(--color-castify-canvas)]/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-[var(--color-castify-canvas)]/80">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <h1 className="text-lg font-semibold tracking-tight">{libraryStats}</h1>
          <div className="md:w-96">
            <SearchBar ref={searchRef} value={query} onChange={setQuery} />
          </div>
        </div>
      </div>

      {/* Rails + shelves — hidden during active search (focused results mode) */}
      {!isSearching && (
        <>
          {/* T13: continue-watching rail (IndexedDB-backed) */}
          <ContinueWatchingShelf />

          {/* Rails */}
          <div className="space-y-6">
            <Shelf
              title="Recently Added"
              videos={recentlyAdded.data.videos}
              totalCount={recentlyAdded.data.total}
              onViewAll={() => handleViewAll({})}
              compact
            />

            <FavoritesShelf
              onViewAll={() => handleViewAll({ favoritesOnly: true })}
            />
          </div>

          {/* Folder organizer (M9 FR-7.4): tree + contents + provider
              chips — replaces the old By Provider / By Folder shelves. */}
          <FolderOrganizer connectedProviders={connectedProviders} />
        </>
      )}

      {/* Grid section — "View All" scroll target */}
      <div id="all-videos" className="space-y-4 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            {isSearching ? (
              <>
                <h2 className="text-2xl font-semibold tracking-tight">
                  Search results for &ldquo;{filters.values.q}&rdquo;
                </h2>
                {videos.data && (
                  <p className="mt-1 text-sm opacity-60">
                    {videos.data.total}{" "}
                    {videos.data.total === 1 ? "result" : "results"}
                  </p>
                )}
              </>
            ) : (
              <h2 className="text-2xl font-semibold tracking-tight">
                All Videos
              </h2>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="opacity-60">Sort</span>
            <select
              aria-label="Sort videos"
              value={filters.values.sort}
              onChange={(e) => filters.setSort(e.target.value as VideoSortKey)}
              className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-3 py-1.5 text-sm transition hover:bg-[var(--color-castify-accent-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
            >
              {VIDEO_SORT_OPTIONS.map((key) => (
                <option key={key} value={key}>
                  {VIDEO_SORT_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
        </div>

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
          onClearSearch={() => {
            setQuery("");
            filters.setQ("");
          }}
        />
      </div>
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
        <h2 className="text-xl font-semibold tracking-tight">
          Continue Watching
        </h2>
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
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-4 py-3 text-sm text-[var(--color-castify-muted)]">
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
}

function BrowseGrid({
  videos,
  page,
  onPageChange,
  hasActiveFilter,
  searchQuery,
  onClearFilters,
  onClearSearch,
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
      <p className="text-sm opacity-60">
        {data.total} {data.total === 1 ? "video" : "videos"}
      </p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {data.videos.map((video: VideoSummaryDto) => (
          <PosterCard
            key={video.id}
            video={video}
            href={`/watch/${video.id}`}
            queue={gridQueue}
            topRightSlot={<FavoriteToggle video={video} />}
            bottomOverlaySlot={<RatingStars video={video} />}
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
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1 || isFetching}
        className="rounded-md border border-white/15 px-4 py-2 text-sm transition hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        Previous
      </button>
      <span className="text-sm opacity-60">
        Page {page} of {totalPages}
        {isFetching ? " \u00b7 loading\u2026" : ""}
      </span>
      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages || isFetching}
        className="rounded-md border border-white/15 px-4 py-2 text-sm transition hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        Next
      </button>
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
      <div className="h-4 w-24 rounded bg-white/10" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-2"
          >
            <div className="aspect-video w-full animate-pulse rounded-md bg-white/10" />
            <div className="space-y-1.5 px-1 pb-1">
              <div className="h-3 w-3/4 rounded bg-white/10" />
              <div className="h-3 w-1/2 rounded bg-white/5" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
