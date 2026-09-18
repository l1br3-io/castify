import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { AppLayout } from "../layouts/app-layout";
import { BrowsePage } from "./browse";
import { setCsrfToken } from "../api/client";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";
import type { ProgressEntry } from "../lib/player-db";

// BrowsePage issues many GETs on mount:
//   * GET /api/connections                        — provider shelves data source
//   * GET /api/videos/folders                     — folder shelves data source
//   * GET /api/videos?page=1&sort=date-desc&limit=20  — hero + Recently Added
//   * GET /api/videos?page=1&sort=date-desc           — grid (no filters)
//   * GET /api/videos?...&limit=20&favorites_only=true — Favorites shelf
//   * GET /api/videos?...&limit=20&provider=X          — per-provider shelf
//   * GET /api/videos?...&limit=20&folder=Y            — per-folder shelf
//
// The mock distinguishes shelf queries (limit=20) from the grid query (no
// limit param) and returns configurable data per shelf type.

const VIDEO_PAGE_ONE = {
  videos: [
    {
      id: "v1",
      name: "cat.mp4",
      provider: "google_drive",
      size_bytes: 5_242_880,
      mime_type: "video/mp4",
      duration_ms: 120_000,
      width: 1920,
      height: 1080,
      sources: [
        {
          connection_id: "c1",
          provider: "google_drive",
          provider_file_id: "gd-1",
        },
      ],
      created_at: "2026-01-01T00:00:00Z",
      path: "/Movies/cat.mp4",
      is_favorite: false,
      my_rating: null,
      thumbnail_status: "pending",
      position_seconds: null,
      completed: false,
    },
    {
      id: "v2",
      name: "dedup-video.mp4",
      provider: "google_drive",
      size_bytes: 1_073_741_824,
      mime_type: "video/mp4",
      duration_ms: 3_661_000,
      width: 3840,
      height: 2160,
      sources: [
        {
          connection_id: "c1",
          provider: "google_drive",
          provider_file_id: "gd-2",
        },
        { connection_id: "c2", provider: "dropbox", provider_file_id: "db-1" },
      ],
      created_at: "2026-01-02T00:00:00Z",
      path: "/Movies/dedup.mp4",
      is_favorite: true,
      my_rating: 4,
      thumbnail_status: "cached",
      position_seconds: null,
      completed: false,
    },
  ],
  total: 60,
  page: 1,
  limit: 50,
};

const EMPTY_VIDEO_PAGE = {
  videos: [],
  total: 0,
  page: 1,
  limit: 50,
};

const SEARCH_PAGE = {
  videos: [
    {
      ...VIDEO_PAGE_ONE.videos[0],
      id: "s1",
      name: "concert-footage.mp4",
    },
  ],
  total: 1,
  page: 1,
  limit: 50,
};

const NO_CONNECTIONS: unknown[] = [];

interface BrowseFetchOpts {
  videoPage?: unknown;
  recentlyAdded?: unknown;
  favorites?: unknown;
  connections?: unknown;
  folders?: unknown;
  providerPages?: Record<string, unknown>;
  folderPages?: Record<string, unknown>;
  searchResults?: unknown;
}

function browseFetch(opts: BrowseFetchOpts = {}) {
  const videoPage = opts.videoPage ?? VIDEO_PAGE_ONE;
  const favorites = opts.favorites ?? EMPTY_VIDEO_PAGE;
  const connections = opts.connections ?? NO_CONNECTIONS;
  const folders = opts.folders ?? [];

  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/connections") return jsonResponse(connections);
    // Folder enumeration — check before generic /api/videos.
    if (url.startsWith("/api/videos/folders")) return jsonResponse(folders);

    const params = new URL(url, "http://x").searchParams;
    const limit = params.get("limit");

    // Shelf queries (limit=20) — distinguish by filter param.
    if (limit === "20") {
      if (params.get("favorites_only") === "true")
        return jsonResponse(favorites);
      const provider = params.get("provider");
      if (provider)
        return jsonResponse(opts.providerPages?.[provider] ?? EMPTY_VIDEO_PAGE);
      const folder = params.get("folder");
      if (folder)
        return jsonResponse(opts.folderPages?.[folder] ?? EMPTY_VIDEO_PAGE);
      // Recently Added (limit=20, no shelf-specific filter).
      return jsonResponse(opts.recentlyAdded ?? videoPage);
    }

    // Search query (grid-level, with q param — no limit).
    if (params.get("q") !== null) {
      return jsonResponse(opts.searchResults ?? videoPage);
    }

    // Grid query (no limit — backend default 50).
    if (url.startsWith("/api/videos")) return jsonResponse(videoPage);
    return jsonError(404, "unmocked");
  };
}

/** Render BrowsePage inside the app shell — the search field lives in the
 * topbar (AppLayout), so search tests drive it through the layout. The
 * wrapper answers the shell's own GETs (/api/session, /api/folders/tree)
 * before delegating to the browse handler. */
function renderBrowse(
  options: Parameters<typeof renderWithProviders>[1] = {},
): ReturnType<typeof renderWithProviders> {
  const inner = options.fetchImplementation;
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<BrowsePage />} />
      </Route>
    </Routes>,
    {
      ...options,
      fetchImplementation: (input, init) => {
        const url = String(input);
        if (url === "/api/session")
          return jsonResponse({ owner: { id: "u1", display_name: "Alex" } });
        if (url === "/api/folders/tree") return jsonResponse([]);
        if (inner) return inner(input, init);
        return browseFetch()(input);
      },
    },
  );
}

describe("BrowsePage", () => {
  // `restoreMocks: true` in vitest config resets the module-level
  // `vi.mock` factory defaults between tests. Re-establish the
  // `getInProgressVideos → []` default before every BrowsePage test so
  // the CW shelf stays hidden by default; the CW describe block below
  // overrides this per-test with non-empty entries.
  beforeEach(() => {
    setCsrfToken("csrf-test");
    mockGetInProgressVideos.mockResolvedValue([]);
  });
  afterEach(() => setCsrfToken(null));

  // --- Classical stat cards row (task 011) ---

  it("renders the Classical stat cards row with honest figures and no featured hero", async () => {
    renderBrowse({
      fetchImplementation: browseFetch({
        connections: [
          {
            id: "c1",
            provider: "google_drive",
            provider_account_email: "u@example.com",
            connected_at: "2026-01-01T00:00:00Z",
            scan_status: "idle",
            last_scan_at: null,
            video_count: 10,
          },
        ],
      }),
    });

    // Stat cards: Files (catalog total), Providers (connection count),
    // Now scanning (provider label or an em-dash when idle). The demo's
    // Cache card has no data source in the app — no endpoint, and the spec
    // forbids new queries — so it is deliberately absent.
    expect(await screen.findByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Providers")).toBeInTheDocument();
    expect(screen.getByText("Now scanning")).toBeInTheDocument();
    // 60 videos from VIDEO_PAGE_ONE, 1 connection, nothing scanning.
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    // The featured-video hero stays gone — no h2 with a video name.
    expect(
      screen.queryByRole("heading", { level: 2, name: "cat.mp4" }),
    ).not.toBeInTheDocument();
  });

  it("names the scanning provider in the Now scanning card while a scan runs", async () => {
    renderBrowse({
      fetchImplementation: browseFetch({
        connections: [
          {
            id: "c1",
            provider: "dropbox",
            provider_account_email: "u@example.com",
            connected_at: "2026-01-01T00:00:00Z",
            scan_status: "scanning",
            last_scan_at: null,
            video_count: 0,
          },
        ],
      }),
    });

    expect(await screen.findByText("Now scanning")).toBeInTheDocument();
    // The provider label sits in the same stat card as the kicker.
    const scanningCard = screen.getByText("Now scanning").closest("div");
    expect(
      within(scanningCard as HTMLElement).getByText("Dropbox"),
    ).toBeInTheDocument();
  });

  it("keeps a single page heading for a11y while stats move into cards", async () => {
    renderBrowse({ fetchImplementation: browseFetch() });

    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("Your library");
  });

  it("staggers the four top-level sections with ~60ms offsets on mount", async () => {
    const { container } = renderBrowse({
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 1 });

    const staggered = Array.from(
      container.querySelectorAll(".animate-stagger-in"),
    );
    // stats → rails → all-files grid → folder organizer (spec IA order).
    expect(staggered).toHaveLength(4);
    expect(staggered[2]).toHaveAttribute("id", "all-videos");
    const delays = staggered.map(
      (el) => el.className.match(/animation-delay:(\d+)ms/)?.[1] ?? "0",
    );
    expect(delays).toEqual(["0", "60", "120", "180"]);
  });

  it("does not replay the stagger when search clears — animated containers stay mounted", async () => {
    const { container } = renderBrowse({
      fetchImplementation: browseFetch({ searchResults: SEARCH_PAGE }),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });
    // The rails stagger wrapper (2nd animated section).
    const railsWrapper = container.querySelectorAll(".animate-stagger-in")[1];

    // Enter search mode — rails unmount their children, wrapper stays.
    fireEvent.change(screen.getByLabelText("Search videos"), {
      target: { value: "concert" },
    });
    expect(await screen.findByText("concert-footage.mp4")).toBeInTheDocument();

    // Clear search — rails reappear inside the same wrapper node.
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await screen.findByRole("heading", { name: "Recently added" });

    // Same DOM node survived the round-trip: the mount-time animation was
    // never canceled by unmounting, so it cannot replay.
    expect(container.contains(railsWrapper)).toBe(true);
  });

  it("renders skeleton header on initial load before data resolves", async () => {
    renderBrowse({
      // Session settles (chrome renders) while the catalog stays pending —
      // BrowsePage holds its skeleton.
      fetchImplementation: (input) => {
        if (String(input) === "/api/session")
          return jsonResponse({ owner: { id: "u1", display_name: "Alex" } });
        return new Promise<Response>(() => {});
      },
    });
    // Skeleton has animate-pulse and no heading text. The shell settles
    // the session query first (async), so poll for the browse skeleton.
    expect(
      screen.queryByRole("heading", { name: "cat.mp4" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector(".animate-pulse")).not.toBeNull();
    });
  });

  // --- Grid ---

  it("renders poster cards in the grid section with thumbnail srcs", async () => {
    const { container } = renderBrowse({
      fetchImplementation: browseFetch(),
    });

    // Wait for data to load.
    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    // Scope to the grid section — the hero + shelves also render PosterCards.
    const gridSection = container.querySelector("#all-videos");
    expect(gridSection).not.toBeNull();
    const gridImgs = gridSection!.querySelectorAll("img");
    expect(gridImgs.length).toBe(2);
    expect(gridImgs[0]).toHaveAttribute("src", "/api/videos/v1/thumbnail");
    expect(gridImgs[1]).toHaveAttribute("src", "/api/videos/v2/thumbnail");
  });

  it("renders all nine sort options in the dropdown", async () => {
    renderBrowse({ fetchImplementation: browseFetch() });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });
    const select = screen.getByLabelText("Sort videos");
    const options = select.querySelectorAll("option");
    expect(options.length).toBe(9);
    expect(screen.getByRole("option", { name: "Newest" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Top Rated" }),
    ).toBeInTheDocument();
  });

  it("changes the sort query param and resets to page 1 when sort changes", async () => {
    const { fetchSpy } = renderBrowse({
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    fireEvent.change(screen.getByLabelText("Sort videos"), {
      target: { value: "size" },
    });

    await waitFor(() => {
      const sizeCall = fetchSpy.mock.calls.find(
        ([url]) =>
          String(url).includes("sort=size") &&
          !String(url).includes("limit=20") &&
          String(url).startsWith("/api/videos"),
      );
      expect(sizeCall).toBeDefined();
    });
  });

  it("navigates to the next page when Next is clicked", async () => {
    renderBrowse({
      fetchImplementation: (input) => {
        const url = String(input);
        if (url === "/api/connections") return jsonResponse([]);
        if (url.startsWith("/api/videos/folders")) return jsonResponse([]);
        if (url.startsWith("/api/videos")) {
          const params = new URL(url, "http://x").searchParams;
          const page = Number(params.get("page") ?? 1);
          return jsonResponse({
            ...VIDEO_PAGE_ONE,
            page,
            videos:
              page === 1
                ? VIDEO_PAGE_ONE.videos
                : [
                    {
                      ...VIDEO_PAGE_ONE.videos[0],
                      id: "v-page2",
                      name: "page2.mp4",
                    },
                  ],
          });
        }
        return jsonError(404, "unmocked");
      },
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await screen.findByText("page2.mp4");
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument();
  });

  it("uses a responsive grid with the spec'd breakpoints in the grid section", async () => {
    const { container } = renderBrowse({
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });
    const gridSection = container.querySelector("#all-videos");
    const grid = gridSection!.querySelector(
      ".grid.grid-cols-2.sm\\:grid-cols-3.md\\:grid-cols-4.lg\\:grid-cols-5.xl\\:grid-cols-6",
    );
    expect(grid).not.toBeNull();
  });

  it("shows an error message when the videos request fails", async () => {
    renderBrowse({
      fetchImplementation: (input) => {
        const url = String(input);
        if (url === "/api/connections") return jsonResponse([]);
        if (url.startsWith("/api/videos/folders")) return jsonResponse([]);
        if (url.startsWith("/api/videos"))
          return jsonError(500, "database is locked");
        return jsonError(404, "unmocked");
      },
    });

    expect(await screen.findByText(/Couldn't load videos/)).toBeInTheDocument();
  });

  // --- Empty states ---

  it("shows the scan-aware empty state when the library is empty", async () => {
    renderBrowse({
      fetchImplementation: browseFetch({ videoPage: EMPTY_VIDEO_PAGE }),
    });

    expect(await screen.findByText("No videos yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect a provider" }),
    ).toBeInTheDocument();
  });

  it("shows the scanning message when a connection is mid-scan", async () => {
    renderBrowse({
      fetchImplementation: browseFetch({
        videoPage: EMPTY_VIDEO_PAGE,
        connections: [
          {
            id: "c1",
            provider: "google_drive",
            provider_account_email: "u@example.com",
            connected_at: "2026-01-01T00:00:00Z",
            scan_status: "scanning",
            last_scan_at: null,
            video_count: 0,
          },
        ],
      }),
    });

    expect(
      await screen.findByText("Scanning your cloud\u2026"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect a provider" }),
    ).not.toBeInTheDocument();
  });

  // --- Shelves ---

  it("renders the Recently added shelf with a View All button", async () => {
    renderBrowse({ fetchImplementation: browseFetch() });

    // "Recently added" appears as a rail heading (level 2), alongside
    // "All videos" in the grid section.
    await screen.findByRole("heading", { level: 1, name: /Your library/ });
    expect(
      screen.getByRole("heading", { name: "Recently added" }),
    ).toBeInTheDocument();

    // View All button for Recently Added.
    const viewAllButtons = screen.getAllByRole("button", { name: "View All" });
    expect(viewAllButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("hides the Favorites shelf when owner has no favorites", async () => {
    renderBrowse({ fetchImplementation: browseFetch() });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });
    expect(
      screen.queryByRole("heading", { name: "Favorites" }),
    ).not.toBeInTheDocument();
  });

  it("shows the Favorites shelf when favorites exist", async () => {
    renderBrowse({
      fetchImplementation: browseFetch({
        favorites: {
          videos: [{ ...VIDEO_PAGE_ONE.videos[1], is_favorite: true }],
          total: 1,
          page: 1,
          limit: 20,
        },
      }),
    });

    expect(
      await screen.findByRole("heading", { name: "Favorites" }),
    ).toBeInTheDocument();
  });

  // --- View All ---

  it("View All on Favorites applies favorites filter to the grid section", async () => {
    const { container } = renderBrowse({
      fetchImplementation: browseFetch({
        favorites: {
          videos: [{ ...VIDEO_PAGE_ONE.videos[1], is_favorite: true }],
          total: 1,
          page: 1,
          limit: 20,
        },
      }),
    });

    // Wait for the Favorites shelf to appear.
    const favoritesHeading = await screen.findByRole("heading", {
      name: "Favorites",
    });

    // The Favorites shelf's View All is the button within the same section.
    const favoritesSection = favoritesHeading.closest("section")!;
    const viewAllBtn = within(favoritesSection).getByRole("button", {
      name: "View All",
    });

    fireEvent.click(viewAllBtn);

    // T10: the "Showing:" indicator was replaced by filter chips.
    // The Favorites chip should appear in the grid section.
    await waitFor(() => {
      const gridSection = container.querySelector("#all-videos");
      expect(
        within(gridSection as HTMLElement).getByText("Favorites"),
      ).toBeInTheDocument();
    });
  });

  // --- Search (T9) ---

  it("fires a search request after debounce when the user types", async () => {
    const { fetchSpy } = renderBrowse({
      fetchImplementation: browseFetch({ searchResults: SEARCH_PAGE }),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    fireEvent.change(screen.getByLabelText("Search videos"), {
      target: { value: "concert" },
    });

    // Debounce is 300ms — waitFor polls until the request fires.
    await waitFor(() => {
      const searchCall = fetchSpy.mock.calls.find(
        ([url]) =>
          String(url).includes("q=concert") &&
          !String(url).includes("limit=20"),
      );
      expect(searchCall).toBeDefined();
    });
  });

  it("coalesces rapid keystrokes into a single debounced request", async () => {
    const { fetchSpy } = renderBrowse({
      fetchImplementation: browseFetch({ searchResults: SEARCH_PAGE }),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    const input = screen.getByLabelText("Search videos");
    fireEvent.change(input, { target: { value: "c" } });
    fireEvent.change(input, { target: { value: "co" } });
    fireEvent.change(input, { target: { value: "con" } });
    fireEvent.change(input, { target: { value: "concert" } });

    await waitFor(() => {
      const qCalls = fetchSpy.mock.calls.filter(
        ([url]) =>
          String(url).includes("q=") && !String(url).includes("limit=20"),
      );
      expect(qCalls).toHaveLength(1);
      expect(String(qCalls[0][0])).toContain("q=concert");
    });
  });

  it("hides rails and shows search results header when searching", async () => {
    renderBrowse({
      fetchImplementation: browseFetch({ searchResults: SEARCH_PAGE }),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    fireEvent.change(screen.getByLabelText("Search videos"), {
      target: { value: "concert" },
    });

    // Wait for search results to appear.
    await waitFor(() => {
      expect(
        screen.getByText("Search results for \u201cconcert\u201d"),
      ).toBeInTheDocument();
    });

    // Wait for the search-result video to render in the grid. The grid uses
    // keepPreviousData so the old cards (cat.mp4) are briefly visible while
    // the new query resolves — we must wait for the new data before asserting
    // the old card is gone.
    expect(await screen.findByText("concert-footage.mp4")).toBeInTheDocument();

    // Rails are gone (the poster cards + their headings).
    expect(
      screen.queryByRole("heading", { name: "Recently added" }),
    ).not.toBeInTheDocument();
  });

  it("shows the search-specific empty state when results are empty", async () => {
    renderBrowse({
      fetchImplementation: browseFetch({
        searchResults: EMPTY_VIDEO_PAGE,
      }),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    fireEvent.change(screen.getByLabelText("Search videos"), {
      target: { value: "xyz" },
    });

    await waitFor(() => {
      expect(
        screen.getByText("No videos match \u201cxyz\u201d"),
      ).toBeInTheDocument();
    });
  });

  it("clears the search and returns to browse layout when clear button is clicked", async () => {
    renderBrowse({
      fetchImplementation: browseFetch({ searchResults: SEARCH_PAGE }),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    // Type and enter search mode.
    fireEvent.change(screen.getByLabelText("Search videos"), {
      target: { value: "concert" },
    });
    await waitFor(() => {
      expect(
        screen.getByText("Search results for \u201cconcert\u201d"),
      ).toBeInTheDocument();
    });

    // Click clear.
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    // Should return to browse layout (rails reappear).
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "All videos" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("heading", { name: /Search results/ }),
    ).not.toBeInTheDocument();
  });

  it("focuses the search bar when the / keyboard shortcut is pressed", async () => {
    renderBrowse({
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 1 });

    const searchInput = screen.getByLabelText("Search videos");
    expect(searchInput).not.toHaveFocus();

    fireEvent.keyDown(window, { key: "/" });

    expect(searchInput).toHaveFocus();
  });

  it("places the search field in the topbar, outside the grid section (design IA)", async () => {
    const { container } = renderBrowse({
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 1 });

    // The search field lives in the app topbar (its role="search" region),
    // NOT inside the All-videos grid section.
    const search = screen.getByRole("search");
    expect(within(search).getByLabelText("Search videos")).toBeInTheDocument();
    const gridSection = container.querySelector("#all-videos");
    expect(gridSection).not.toBeNull();
    expect(
      within(gridSection as HTMLElement).queryByLabelText("Search videos"),
    ).not.toBeInTheDocument();
  });

  it("does not trigger the shortcut when typing inside an input", async () => {
    renderBrowse({
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    // Focus the search input, then dispatch / keydown from it.
    const searchInput = screen.getByLabelText("Search videos");
    searchInput.focus();

    const event = new KeyboardEvent("keydown", { key: "/", bubbles: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");

    searchInput.dispatchEvent(event);

    // preventDefault should NOT have been called — the / should be typed, not
    // swallowed by the shortcut handler.
    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });

  // --- T10: Filter panel + URL deep-linking ---

  it("deep-links: applies provider filter from URL on initial render", async () => {
    const { fetchSpy } = renderBrowse({
      initialEntries: ["/?provider=dropbox"],
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    // The grid query should include provider=dropbox.
    await waitFor(() => {
      const providerCall = fetchSpy.mock.calls.find(
        ([url]) =>
          String(url).includes("provider=dropbox") &&
          !String(url).includes("limit=20"),
      );
      expect(providerCall).toBeDefined();
    });
  });

  it("writes sort to URL when the dropdown changes", async () => {
    const { fetchSpy } = renderBrowse({
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    fireEvent.change(screen.getByLabelText("Sort videos"), {
      target: { value: "name" },
    });

    // The grid query should include sort=name (URL-driven).
    await waitFor(() => {
      const nameCall = fetchSpy.mock.calls.find(
        ([url]) =>
          String(url).includes("sort=name") &&
          !String(url).includes("limit=20"),
      );
      expect(nameCall).toBeDefined();
    });
  });

  it("composes search with filters (both q and provider in the request)", async () => {
    const { fetchSpy } = renderBrowse({
      initialEntries: ["/?provider=google_drive"],
      fetchImplementation: browseFetch({ searchResults: SEARCH_PAGE }),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    fireEvent.change(screen.getByLabelText("Search videos"), {
      target: { value: "concert" },
    });

    // After debounce, the grid query should include BOTH q=concert and
    // provider=google_drive.
    await waitFor(() => {
      const composedCall = fetchSpy.mock.calls.find(
        ([url]) =>
          String(url).includes("q=concert") &&
          String(url).includes("provider=google_drive") &&
          !String(url).includes("limit=20"),
      );
      expect(composedCall).toBeDefined();
    });
  });

  it("renders the FilterPanel More filters toggle in the grid section", async () => {
    const { container } = renderBrowse({
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    const gridSection = container.querySelector("#all-videos");
    const filterToggle = within(gridSection as HTMLElement).getByRole(
      "button",
      {
        name: /More filters/i,
      },
    );
    expect(filterToggle).toBeInTheDocument();
    expect(filterToggle).toHaveAttribute("aria-expanded", "false");
  });

  it("shows inline provider chips without opening the drawer", async () => {
    renderBrowse({
      fetchImplementation: browseFetch({
        connections: [
          {
            id: "c1",
            provider: "google_drive",
            provider_account_email: "u@example.com",
            connected_at: "2026-01-01T00:00:00Z",
            scan_status: "idle",
            last_scan_at: null,
            video_count: 10,
          },
        ],
      }),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    // Provider chips are always visible inline — no toggle click required.
    // (Both the FilterPanel and the organizer render a chip group.)
    expect(
      screen.getAllByRole("group", { name: "Filter by provider" }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "Google Drive" }).length,
    ).toBeGreaterThan(0);
  });

  it("applies a filter via the drawer and sends the param in the grid query", async () => {
    const { fetchSpy } = renderBrowse({
      fetchImplementation: browseFetch({
        connections: [
          {
            id: "c1",
            provider: "google_drive",
            provider_account_email: "u@example.com",
            connected_at: "2026-01-01T00:00:00Z",
            scan_status: "idle",
            last_scan_at: null,
            video_count: 10,
          },
        ],
      }),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    // Open the More filters drawer, then click the duration preset.
    fireEvent.click(screen.getByRole("button", { name: /More filters/i }));
    fireEvent.click(screen.getByRole("button", { name: "< 5 min" }));

    await waitFor(() => {
      const durationCall = fetchSpy.mock.calls.find(
        ([url]) =>
          (String(url).includes("duration_min=") ||
            String(url).includes("duration_max=")) &&
          !String(url).includes("limit=20"),
      );
      expect(durationCall).toBeDefined();
    });
  });

  it("shows active-filter chips when a filter is applied via the drawer", async () => {
    renderBrowse({
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    fireEvent.click(screen.getByRole("button", { name: /More filters/i }));
    fireEvent.click(screen.getByRole("button", { name: "HD+" }));

    // Close the drawer via Done so HD+ only appears as a chip (not also as
    // a selected preset inside the drawer).
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    // HD+ chip appears in the always-visible chip strip.
    expect(screen.getByText("HD+")).toBeInTheDocument();
  });

  it("removes a filter when its chip is clicked", async () => {
    const { fetchSpy } = renderBrowse({
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    fireEvent.click(screen.getByRole("button", { name: /More filters/i }));
    fireEvent.click(screen.getByRole("button", { name: "FHD+" }));
    // Close drawer so FHD+ only appears as a chip.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.getByText("FHD+")).toBeInTheDocument();

    fireEvent.click(screen.getByText("FHD+"));

    expect(screen.queryByText("FHD+")).not.toBeInTheDocument();

    await waitFor(() => {
      const recentGridCalls = fetchSpy.mock.calls.filter(
        ([url]) =>
          String(url).startsWith("/api/videos") &&
          !String(url).includes("limit=20") &&
          !String(url).includes("folders"),
      );
      const lastGridCall = recentGridCalls[recentGridCalls.length - 1];
      expect(lastGridCall).toBeDefined();
      expect(String(lastGridCall[0])).not.toContain("min_height=");
    });
  });

  it("Clear all resets all filters", async () => {
    const { fetchSpy } = renderBrowse({
      initialEntries: ["/?provider=google_drive&duration=short&resolution=hd"],
      fetchImplementation: browseFetch({
        connections: [
          {
            id: "c1",
            provider: "google_drive",
            provider_account_email: "u@example.com",
            connected_at: "2026-01-01T00:00:00Z",
            scan_status: "idle",
            last_scan_at: null,
            video_count: 10,
          },
        ],
      }),
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    // Long-tail filter chips (HD+, < 5 min) are visible. Provider chip text
    // ("Google Drive") is intentionally not asserted here because it also
    // appears on poster-card provider badges, creating text ambiguity.
    expect(screen.getByText("< 5 min")).toBeInTheDocument();
    expect(screen.getByText("HD+")).toBeInTheDocument();

    // Click Clear all.
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    // Long-tail chips gone.
    expect(screen.queryByText("< 5 min")).not.toBeInTheDocument();
    expect(screen.queryByText("HD+")).not.toBeInTheDocument();

    // Grid query should have no filter params.
    await waitFor(() => {
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      const url = String(lastCall[0]);
      if (
        url.startsWith("/api/videos") &&
        !url.includes("limit=20") &&
        !url.includes("folders")
      ) {
        expect(url).not.toContain("provider=");
        expect(url).not.toContain("duration=");
        expect(url).not.toContain("resolution=");
      }
    });
  });

  it("View All on Favorites writes favorites filter to URL (deep-linkable)", async () => {
    const { container } = renderBrowse({
      fetchImplementation: browseFetch({
        favorites: {
          videos: [{ ...VIDEO_PAGE_ONE.videos[1], is_favorite: true }],
          total: 1,
          page: 1,
          limit: 20,
        },
      }),
    });

    const favoritesHeading = await screen.findByRole("heading", {
      name: "Favorites",
    });
    const favoritesSection = favoritesHeading.closest("section")!;
    const viewAllBtn = within(favoritesSection).getByRole("button", {
      name: "View All",
    });

    fireEvent.click(viewAllBtn);

    // Favorites chip should appear in the grid section.
    await waitFor(() => {
      const gridSection = container.querySelector("#all-videos");
      expect(
        within(gridSection as HTMLElement).getByText("Favorites"),
      ).toBeInTheDocument();
    });
  });

  // --- T11 personalization integration ---

  it("favorite toggle on a grid card fires POST /favorite", async () => {
    const { container, fetchSpy } = renderBrowse({
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections") return jsonResponse(NO_CONNECTIONS);
        if (url.startsWith("/api/videos/folders")) return jsonResponse([]);
        if (url === "/api/videos/v1/favorite" && method === "POST")
          return jsonResponse({ is_favorite: true });
        return browseFetch()(input);
      },
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    // Scope to the grid section — the hero + Recently added shelf also have
    // favorite toggles for v1.
    const gridSection = container.querySelector("#all-videos")!;
    const gridFavoriteBtns = within(gridSection as HTMLElement).getAllByRole(
      "button",
      {
        name: /add to favorites/i,
      },
    );
    expect(gridFavoriteBtns.length).toBeGreaterThan(0);
    fireEvent.click(gridFavoriteBtns[0]);

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/videos/v1/favorite" &&
          (init as RequestInit)?.method === "POST",
      );
      expect(call).toBeDefined();
    });
  });

  it("rating star click on a grid card fires PUT /rating", async () => {
    const { container, fetchSpy } = renderBrowse({
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections") return jsonResponse(NO_CONNECTIONS);
        if (url.startsWith("/api/videos/folders")) return jsonResponse([]);
        if (url === "/api/videos/v1/rating" && method === "PUT")
          return jsonResponse({ my_rating: 4 });
        return browseFetch()(input);
      },
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    const gridSection = container.querySelector("#all-videos")!;
    const gridStarBtns = within(gridSection as HTMLElement).getAllByRole(
      "radio",
      {
        name: "4 stars",
      },
    );
    expect(gridStarBtns.length).toBeGreaterThan(0);
    fireEvent.click(gridStarBtns[0]);

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/videos/v1/rating" &&
          (init as RequestInit)?.method === "PUT",
      );
      expect(call).toBeDefined();
      const body = (call![1] as RequestInit).body;
      expect(body).toBe(JSON.stringify({ rating: 4 }));
    });
  });
});

// ── M3 T13: continue-watching shelf ────────────────────────────────────────
//
// The shelf reads from IndexedDB via `useInProgressVideos`, not from any
// `/api/*` endpoint. Each test in this block controls the IndexedDB mock
// directly. The browse-page-wide mock at file scope is intentionally not
// installed for these tests — the existing browse-fetch mock covers all
// `/api/*` calls, while the player-db mock controls the shelf content.
//
// The mock is hoisted to the top of the module by vitest's plugin, so the
// import of `getInProgressVideos` below is the mocked version, not the real
// implementation.

vi.mock("../lib/player-db", () => ({
  getInProgressVideos: vi.fn().mockResolvedValue([]),
  // Other exports exist on the module; provide no-op stubs so any
  // incidental imports elsewhere in the tree don't crash. None are
  // exercised by these tests.
  getProgress: vi.fn().mockResolvedValue(null),
  saveProgressEntry: vi.fn().mockResolvedValue(undefined),
  clearProgress: vi.fn().mockResolvedValue(undefined),
  getGlobalPrefs: vi.fn().mockResolvedValue(null),
  saveGlobalPrefs: vi.fn().mockResolvedValue(undefined),
  getSubtitlePref: vi.fn().mockResolvedValue(null),
  saveSubtitlePref: vi.fn().mockResolvedValue(undefined),
}));

import { getInProgressVideos } from "../lib/player-db";

const mockGetInProgressVideos = vi.mocked(getInProgressVideos);

function inProgressEntry(
  overrides: Partial<ProgressEntry> = {},
): ProgressEntry {
  return {
    videoId: "cw-1",
    positionSeconds: 30,
    durationSeconds: 120,
    completed: false,
    updatedAt: 1_000,
    videoName: "continue-me.mp4",
    videoDurationMs: 120_000,
    thumbnailStatus: "cached",
    height: 1080,
    provider: "google_drive",
    ...overrides,
  };
}

describe("BrowsePage — continue-watching shelf (T13)", () => {
  beforeEach(() => {
    setCsrfToken("csrf-test");
    mockGetInProgressVideos.mockReset();
    mockGetInProgressVideos.mockResolvedValue([]);
  });
  afterEach(() => setCsrfToken(null));

  it("hides the Continue watching & listening shelf when no entries exist (FR-11.5)", async () => {
    mockGetInProgressVideos.mockResolvedValue([]);
    renderBrowse({ fetchImplementation: browseFetch() });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });
    expect(
      screen.queryByRole("heading", { name: "Continue watching & listening" }),
    ).not.toBeInTheDocument();
  });

  it("hides the Continue watching & listening shelf while IndexedDB is still loading", async () => {
    // Never-resolving promise keeps the query in `isLoading` state.
    mockGetInProgressVideos.mockReturnValue(
      new Promise<ProgressEntry[]>(() => {}),
    );
    renderBrowse({ fetchImplementation: browseFetch() });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });
    expect(
      screen.queryByRole("heading", { name: "Continue watching & listening" }),
    ).not.toBeInTheDocument();
  });

  it("renders the Continue watching & listening shelf when entries exist (FR-11.1)", async () => {
    mockGetInProgressVideos.mockResolvedValue([inProgressEntry()]);
    renderBrowse({ fetchImplementation: browseFetch() });

    expect(
      await screen.findByRole("heading", {
        name: "Continue watching & listening",
      }),
    ).toBeInTheDocument();
    // Card renders the entry's name.
    expect(screen.getByText("continue-me.mp4")).toBeInTheDocument();
  });

  it("renders a progress bar on each continue-watching card (FR-11.3)", async () => {
    mockGetInProgressVideos.mockResolvedValue([inProgressEntry()]);
    renderBrowse({ fetchImplementation: browseFetch() });

    await screen.findByRole("heading", {
      name: "Continue watching & listening",
    });
    const bar = screen.getByRole("progressbar", { name: "Watch progress" });
    // 30s of 120s = 25%
    expect(bar).toHaveAttribute("aria-valuenow", "25");
  });

  it("resume link points at /watch/:id (FR-11.4)", async () => {
    mockGetInProgressVideos.mockResolvedValue([inProgressEntry()]);
    renderBrowse({ fetchImplementation: browseFetch() });

    await screen.findByRole("heading", {
      name: "Continue watching & listening",
    });
    const resumeLink = screen.getByRole("link", {
      name: "Resume continue-me.mp4",
    });
    expect(resumeLink).toHaveAttribute("href", "/watch/cw-1");
  });

  it("places the Continue watching & listening rail between the library header and Recently Added", async () => {
    mockGetInProgressVideos.mockResolvedValue([inProgressEntry()]);
    renderBrowse({ fetchImplementation: browseFetch() });

    const cwHeading = await screen.findByRole("heading", {
      name: "Continue watching & listening",
    });
    const recentlyAddedHeading = screen.getByRole("heading", {
      name: "Recently added",
    });

    // Both headings are h2 siblings in the document; CW must precede
    // Recently Added in DOM order.
    expect(
      cwHeading.compareDocumentPosition(recentlyAddedHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("styles the Continue watching & listening heading in the display serif voice", async () => {
    mockGetInProgressVideos.mockResolvedValue([inProgressEntry()]);
    renderBrowse({ fetchImplementation: browseFetch() });

    const heading = await screen.findByRole("heading", {
      name: "Continue watching & listening",
    });
    // Classical rails: display serif, not the mono eyebrow strip.
    expect(heading).not.toHaveClass("eyebrow");
    expect(heading).toHaveTextContent("Continue watching & listening");
  });

  it("hides the Continue watching & listening shelf during active search (T9 focused-results mode)", async () => {
    mockGetInProgressVideos.mockResolvedValue([inProgressEntry()]);
    renderBrowse({ fetchImplementation: browseFetch() });

    await screen.findByRole("heading", {
      name: "Continue watching & listening",
    });

    // Type a query — hero + shelves (incl. CW) hide during search.
    fireEvent.change(screen.getByRole("textbox", { name: "Search videos" }), {
      target: { value: "anything" },
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "Continue watching & listening",
        }),
      ).not.toBeInTheDocument();
    });
  });

  it("passes the sibling list as router state queue on each card (T11)", async () => {
    mockGetInProgressVideos.mockResolvedValue([
      inProgressEntry({ videoId: "cw-a", videoName: "cw-a.mp4" }),
      inProgressEntry({
        videoId: "cw-b",
        videoName: "cw-b.mp4",
        updatedAt: 2_000,
      }),
    ]);
    renderBrowse({ fetchImplementation: browseFetch() });

    await screen.findByRole("heading", {
      name: "Continue watching & listening",
    });

    // Clicking the first card should navigate to /watch/cw-a carrying the
    // full sibling list in router state.
    const link = screen.getByRole("link", { name: "Resume cw-a.mp4" });
    expect(link).toHaveAttribute("href", "/watch/cw-a");
    // We can't read router state directly off the link; the existing
    // PosterCard queue-state probe pattern covers that in unit tests. Here
    // we assert the link is wired to the right id, which is enough at the
    // integration level — the queue plumbing through <ContinueWatchingCard>
    // is unit-tested in continue-watching-card.test.tsx.
  });
});

// Multi-select share mode (task 012): "Select" swaps card navigation for
// toggle-selection; "Share N items" opens the creation dialog with the
// click order as curation order. The dialog itself is unit-tested in
// share-dialog.test.tsx — these cover the browse entry point only.

vi.mock("../lib/share-links-db", () => ({
  saveShareLink: vi.fn().mockResolvedValue(undefined),
}));

import { saveShareLink } from "../lib/share-links-db";

const mockSaveShareLink = vi.mocked(saveShareLink);

describe("BrowsePage — multi-select share mode (task 012)", () => {
  beforeEach(() => {
    setCsrfToken("csrf-test");
    mockSaveShareLink.mockResolvedValue(undefined);
  });
  afterEach(() => setCsrfToken(null));

  it("selects items, shares them in click order, and shows the link once", async () => {
    const { container, fetchSpy } = renderBrowse({
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/shares" && method === "POST") {
          return jsonResponse(
            {
              id: "s9",
              title: "2 videos",
              token: "tok_9",
              share_url: "/share/tok_9",
            },
            201,
          );
        }
        return browseFetch()(input);
      },
    });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    // Enter select mode — Share starts disabled at 0 selections.
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    const shareButton = screen.getByRole("button", { name: /share 0 items/i });
    expect(shareButton).toBeDisabled();

    // Toggle v2 via its checkbox, v1 via the card body (title click) —
    // the click order becomes the share's curation order.
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select dedup-video.mp4" }),
    );
    const gridSection = container.querySelector("#all-videos")!;
    fireEvent.click(within(gridSection as HTMLElement).getByText("cat.mp4"));
    expect(screen.getByText(/2 items selected/)).toBeInTheDocument();

    // Share → dialog with item count → create.
    fireEvent.click(screen.getByRole("button", { name: /share 2 items/i }));
    expect(
      await screen.findByRole("heading", { name: "Share 2 videos" }),
    ).toBeInTheDocument();
    // Create → one POST in click order. The generated-name prefill is
    // cleared first — title semantics live in share-dialog.test.tsx; this
    // test targets the page flow.
    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create share/i }));

    let posts: [unknown, RequestInit?][] = [];
    await waitFor(() => {
      posts = fetchSpy.mock.calls.filter(
        ([input, init]) =>
          String(input) === "/api/shares" && init?.method === "POST",
      );
      expect(posts).toHaveLength(1);
    });
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({
      video_ids: ["v2", "v1"],
    });

    // Link displayed once with copy + warning; persisted per-device.
    expect(
      await screen.findByText(`${window.location.origin}/share/tok_9`),
    ).toBeInTheDocument();
    expect(screen.getByText(/only once/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(mockSaveShareLink).toHaveBeenCalledWith("s9", "/share/tok_9"),
    );
  });

  it("Cancel exits select mode and clears the selection", async () => {
    renderBrowse({ fetchImplementation: browseFetch() });

    await screen.findByRole("heading", { level: 1, name: /Your library/ });

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select cat.mp4" }));
    expect(screen.getByText(/1 item selected/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("checkbox", { name: /select /i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    // Cards navigate again — the stretched link is back.
    expect(
      screen.getAllByRole("link", { name: "Play cat.mp4" }).length,
    ).toBeGreaterThan(0);
  });
});
