// Browse page — M2 T7 poster-grid view + T8 hero showcase + scrollable shelves
// + T9 search + T10 filter panel / URL deep-linking + T13 continue-watching.
//
// Layout (PRD FR-8 + FR-11):
//   0. Search bar (always at top; "/" focuses it).
//   1. Hero showcase (featured video: most-recently-scanned, full-width ~40vh).
//   2. Continue-watching shelf (T13, IndexedDB-backed; hidden when empty).
//   3. Shelves section (horizontal scrollable rows):
//      - Recently Added (always shown)
//      - Favorites (shown only when owner has ≥1 favorite)
//      - By Provider (one shelf per connected provider)
//      - By Folder (one per top-5 folder by count)
//   4. "All Videos" grid section (poster grid + sort + filter panel + pagination).
//
// Search (T9, FR-2): when the debounced query is non-empty, the layout enters
// a focused search-results mode — hero + shelves (incl. continue-watching)
// are hidden and the grid section shows "Search results for "q"" + count.
// Search composes with sort and all filters (FR-2.2).
//
// URL state (T10): all filter + sort + search state lives in URL search params
// via `useBrowseFilters()` for deep-linking + back-button support. `page` is
// the only state kept local (deep-linking to page N is fragile). The raw
// search input is also local (debounced before writing to URL).
//
// "View All" (FR-8.5): each shelf's button resets filters, applies the shelf's
// single filter, and scrolls to `#all-videos`.
//
// Empty states:
//   * Library truly empty (recentlyAdded has 0 videos): scan-aware CTA.
//   * Grid empty due to active filter: "No videos match this filter."
//   * Grid empty due to search query: 'No videos match "q".'

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { FilterPanel } from "../components/filter-panel";
import { FavoriteToggle } from "../components/favorite-toggle";
import { HeroShowcase, HeroSkeleton } from "../components/hero-showcase";
import { PosterCard } from "../components/poster-card";
import { RatingStars } from "../components/rating-stars";
import { SearchBar } from "../components/search-bar";
import { Shelf } from "../components/shelf";
import { useConnections } from "../hooks/use-connections";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { useFolders } from "../hooks/use-folders";
import { useInProgressVideos } from "../hooks/use-in-progress-videos";
import { useVideos } from "../hooks/use-videos";
import { ContinueWatchingCard } from "../components/continue-watching-card";
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

  // Hero + Recently Added shelf — always fires; also drives the empty check.
  const recentlyAdded = useVideos({ page: 1, sort: "date-desc", limit: 20 });

  // Grid query — reads all filter params from the URL hook.
  const videos = useVideos({
    page,
    ...filters.params,
  });

  const isSearching = filters.values.q !== "";

  // Provider shelves data source.
  const connections = useConnections();
  const connectedProviders: ProviderKey[] = Array.from(
    new Set((connections.data ?? []).map((c) => c.provider)),
  );

  // Folder shelves data source.
  const folders = useFolders();
  const topFolders = (folders.data ?? []).slice(0, 5);

  function handleViewAll(filter: ViewAllFilter): void {
    // Clear search input + URL immediately, then clear all filters and apply
    // the shelf's single filter.
    setQuery("");
    filters.setQ("");
    filters.clearAll();
    if (filter.provider) filters.setProvider(filter.provider);
    if (filter.folder) filters.setFolder(filter.folder);
    if (filter.favoritesOnly) filters.setFavoritesOnly(true);
    document
      .getElementById("all-videos")
      ?.scrollIntoView({ behavior: "smooth" });
  }

  // --- Initial load: skeleton hero + skeleton grid ---
  if (recentlyAdded.isLoading) {
    return (
      <div className="space-y-6">
        <HeroSkeleton />
        <LoadingSkeletonGrid />
      </div>
    );
  }

  // --- Recently Added query failed (DB error, network) ---
  if (recentlyAdded.isError) {
    return (
      <p className="text-red-400">
        Couldn't load videos. {describeError(recentlyAdded.error)}
      </p>
    );
  }

  // --- Library is truly empty ---
  if (!recentlyAdded.data || recentlyAdded.data.videos.length === 0) {
    return <EmptyState />;
  }

  const heroVideo = recentlyAdded.data.videos[0];
  const hasActiveFilter = filters.activeCount > 0;
  // Recently Added list also feeds the hero — same queue for both so the
  // watch page can next/prev through recently-added context.
  const recentlyAddedQueue = recentlyAdded.data.videos.map((v) => v.id);

  return (
    <div className="space-y-8">
      {/* Search bar — always at top (T9) */}
      <SearchBar ref={searchRef} value={query} onChange={setQuery} />

      {/* Hero + shelves — hidden during active search (focused results mode) */}
      {!isSearching && (
        <>
          <HeroShowcase
            video={heroVideo}
            queue={recentlyAddedQueue}
            favoriteSlot={<FavoriteToggle video={heroVideo} variant="hero" />}
            ratingSlot={<RatingStars video={heroVideo} variant="hero" />}
          />

          {/* T13: continue-watching shelf (IndexedDB-backed) */}
          <ContinueWatchingShelf />

          {/* Shelves */}
          <div className="space-y-6">
            <Shelf
              title="Recently Added"
              videos={recentlyAdded.data.videos}
              onViewAll={() => handleViewAll({})}
            />

            <FavoritesShelf
              onViewAll={() => handleViewAll({ favoritesOnly: true })}
            />

            {connectedProviders.map((provider) => (
              <ProviderShelf
                key={provider}
                provider={provider}
                onViewAll={() => handleViewAll({ provider })}
              />
            ))}

            {topFolders.map((f) => (
              <FolderShelf
                key={f.folder}
                folder={f.folder}
                onViewAll={() => handleViewAll({ folder: f.folder })}
              />
            ))}
          </div>
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
          <div className="flex items-center gap-3">
            <FilterPanel filters={filters} />
            <label className="flex items-center gap-2 text-sm">
              <span className="opacity-60">Sort</span>
              <select
                aria-label="Sort videos"
                value={filters.values.sort}
                onChange={(e) =>
                  filters.setSort(e.target.value as VideoSortKey)
                }
                className="rounded-md border border-white/15 bg-[var(--color-castify-surface)] px-3 py-1.5 text-sm transition hover:bg-white/5 focus:outline-none focus:ring-1 focus:ring-[var(--color-castify-accent)]"
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

        <BrowseGrid
          videos={videos}
          page={page}
          onPageChange={setPage}
          hasActiveFilter={hasActiveFilter}
          searchQuery={isSearching ? filters.values.q : undefined}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter type for "View All" handlers
// ---------------------------------------------------------------------------

interface ViewAllFilter {
  provider?: string;
  folder?: string;
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
        className="no-scrollbar flex gap-4 overflow-x-auto pb-2"
        style={{ scrollSnapType: "x mandatory" }}
      >
        {entries.map((entry) => (
          <div
            key={entry.videoId}
            className="w-[200px] flex-shrink-0"
            style={{ scrollSnapAlign: "start" }}
          >
            <ContinueWatchingCard entry={entry} queue={queue} />
          </div>
        ))}
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
  if (query.isLoading || !query.data || query.data.videos.length === 0)
    return null;
  return (
    <Shelf title="Favorites" videos={query.data.videos} onViewAll={onViewAll} />
  );
}

function ProviderShelf({
  provider,
  onViewAll,
}: {
  provider: ProviderKey;
  onViewAll: () => void;
}) {
  const query = useVideos({
    page: 1,
    sort: "date-desc",
    limit: 20,
    provider,
  });
  if (query.isLoading || !query.data || query.data.videos.length === 0)
    return null;
  return (
    <Shelf
      title={PROVIDER_LABELS[provider]}
      videos={query.data.videos}
      onViewAll={onViewAll}
    />
  );
}

function FolderShelf({
  folder,
  onViewAll,
}: {
  folder: string;
  onViewAll: () => void;
}) {
  const query = useVideos({
    page: 1,
    sort: "date-desc",
    limit: 20,
    folder,
  });
  if (query.isLoading || !query.data || query.data.videos.length === 0)
    return null;
  return (
    <Shelf title={folder} videos={query.data.videos} onViewAll={onViewAll} />
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
}

function BrowseGrid({
  videos,
  page,
  onPageChange,
  hasActiveFilter,
  searchQuery,
}: BrowseGridProps) {
  if (videos.isLoading) {
    return <LoadingSkeletonGrid />;
  }
  if (videos.isError) {
    return (
      <p className="text-red-400">
        Couldn't load videos. {describeError(videos.error)}
      </p>
    );
  }

  const data = videos.data;
  if (!data || data.videos.length === 0) {
    if (searchQuery) {
      return (
        <div className="rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-8 text-center">
          <p className="text-lg font-medium">
            No videos match &ldquo;{searchQuery}&rdquo;
          </p>
          <p className="mt-2 text-sm opacity-60">
            Try a different search term.
          </p>
        </div>
      );
    }
    if (hasActiveFilter) {
      return (
        <div className="rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-8 text-center">
          <p className="text-lg font-medium">No videos match this filter</p>
          <p className="mt-2 text-sm opacity-60">
            Try adjusting or clearing your filters.
          </p>
        </div>
      );
    }
    // Library-empty case is handled at the top level, but guard just in case.
    return <EmptyState />;
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.limit));
  // Sibling list for the ephemeral play queue — the current grid page.
  // Passed through PosterCard → router state → watch page (T11).
  const gridQueue = data.videos.map((v) => v.id);

  return (
    <div className="space-y-4">
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

function EmptyState() {
  const connections = useConnections();
  const isScanning =
    connections.data?.some((c) => c.scan_status === "scanning") ?? false;

  return (
    <div className="rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-8 text-center">
      <p className="text-lg font-medium">
        {isScanning ? "Scanning your cloud\u2026" : "No videos yet"}
      </p>
      <p className="mt-2 text-sm opacity-60">
        {isScanning
          ? "Videos will appear here as the scan progresses."
          : "Connect a cloud provider to populate your library."}
      </p>
      {!isScanning && (
        <Link
          to="/connections"
          className="mt-4 inline-block rounded-md bg-[var(--color-castify-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90"
        >
          Connect a provider
        </Link>
      )}
    </div>
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
