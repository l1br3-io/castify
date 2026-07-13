import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";

import { BrowsePage } from "./browse";
import { setCsrfToken } from "../api/client";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";

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
        { connection_id: "c1", provider: "google_drive", provider_file_id: "gd-1" },
      ],
      created_at: "2026-01-01T00:00:00Z",
      path: "/Movies/cat.mp4",
      is_favorite: false,
      my_rating: null,
      thumbnail_status: "pending",
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
        { connection_id: "c1", provider: "google_drive", provider_file_id: "gd-2" },
        { connection_id: "c2", provider: "dropbox", provider_file_id: "db-1" },
      ],
      created_at: "2026-01-02T00:00:00Z",
      path: "/Movies/dedup.mp4",
      is_favorite: true,
      my_rating: 4,
      thumbnail_status: "cached",
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

describe("BrowsePage", () => {
  beforeEach(() => setCsrfToken("csrf-test"));
  afterEach(() => setCsrfToken(null));

  // --- Hero ---

  it("renders the hero with the featured video name", async () => {
    renderWithProviders(<BrowsePage />, { fetchImplementation: browseFetch() });

    // Hero h2 shows the first video's name.
    expect(await screen.findByRole("heading", { level: 2, name: "cat.mp4" })).toBeInTheDocument();
  });

  it("renders skeleton hero on initial load before data resolves", () => {
    renderWithProviders(<BrowsePage />, {
      fetchImplementation: () => new Promise<Response>(() => {}),
    });
    // Skeleton has animate-pulse and no heading text.
    expect(screen.queryByRole("heading", { name: "cat.mp4" })).not.toBeInTheDocument();
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });

  // --- Grid ---

  it("renders poster cards in the grid section with thumbnail srcs", async () => {
    const { container } = renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch(),
    });

    // Wait for data to load.
    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

    // Scope to the grid section — the hero + shelves also render PosterCards.
    const gridSection = container.querySelector("#all-videos");
    expect(gridSection).not.toBeNull();
    const gridImgs = gridSection!.querySelectorAll("img");
    expect(gridImgs.length).toBe(2);
    expect(gridImgs[0]).toHaveAttribute("src", "/api/videos/v1/thumbnail");
    expect(gridImgs[1]).toHaveAttribute("src", "/api/videos/v2/thumbnail");
  });

  it("renders all nine sort options in the dropdown", async () => {
    renderWithProviders(<BrowsePage />, { fetchImplementation: browseFetch() });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });
    const select = screen.getByLabelText("Sort videos");
    const options = select.querySelectorAll("option");
    expect(options.length).toBe(9);
    expect(screen.getByRole("option", { name: "Newest" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Top Rated" })).toBeInTheDocument();
  });

  it("changes the sort query param and resets to page 1 when sort changes", async () => {
    const { fetchSpy } = renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

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
    renderWithProviders(<BrowsePage />, {
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
                : [{ ...VIDEO_PAGE_ONE.videos[0], id: "v-page2", name: "page2.mp4" }],
          });
        }
        return jsonError(404, "unmocked");
      },
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await screen.findByText("page2.mp4");
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument();
  });

  it("uses a responsive grid with the spec'd breakpoints in the grid section", async () => {
    const { container } = renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });
    const gridSection = container.querySelector("#all-videos");
    const grid = gridSection!.querySelector(
      ".grid.grid-cols-2.sm\\:grid-cols-3.md\\:grid-cols-4.lg\\:grid-cols-5.xl\\:grid-cols-6",
    );
    expect(grid).not.toBeNull();
  });

  it("shows an error message when the videos request fails", async () => {
    renderWithProviders(<BrowsePage />, {
      fetchImplementation: (input) => {
        const url = String(input);
        if (url === "/api/connections") return jsonResponse([]);
        if (url.startsWith("/api/videos/folders")) return jsonResponse([]);
        if (url.startsWith("/api/videos")) return jsonError(500, "database is locked");
        return jsonError(404, "unmocked");
      },
    });

    expect(await screen.findByText(/Couldn't load videos/)).toBeInTheDocument();
  });

  // --- Empty states ---

  it("shows the scan-aware empty state when the library is empty", async () => {
    renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch({ videoPage: EMPTY_VIDEO_PAGE }),
    });

    expect(await screen.findByText("No videos yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect a provider" })).toHaveAttribute(
      "href",
      "/connections",
    );
  });

  it("shows the scanning message when a connection is mid-scan", async () => {
    renderWithProviders(<BrowsePage />, {
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

    expect(await screen.findByText("Scanning your cloud\u2026")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect a provider" })).not.toBeInTheDocument();
  });

  // --- Shelves ---

  it("renders the Recently Added shelf with a View All button", async () => {
    renderWithProviders(<BrowsePage />, { fetchImplementation: browseFetch() });

    // "Recently Added" appears as a shelf heading (level 2).
    // There are multiple h2 elements (hero title + "All Videos" + shelf titles).
    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });
    expect(screen.getByRole("heading", { name: "Recently Added" })).toBeInTheDocument();

    // View All button for Recently Added.
    const viewAllButtons = screen.getAllByRole("button", { name: "View All" });
    expect(viewAllButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("hides the Favorites shelf when owner has no favorites", async () => {
    renderWithProviders(<BrowsePage />, { fetchImplementation: browseFetch() });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });
    expect(screen.queryByRole("heading", { name: "Favorites" })).not.toBeInTheDocument();
  });

  it("shows the Favorites shelf when favorites exist", async () => {
    renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch({
        favorites: {
          videos: [{ ...VIDEO_PAGE_ONE.videos[1], is_favorite: true }],
          total: 1,
          page: 1,
          limit: 20,
        },
      }),
    });

    expect(await screen.findByRole("heading", { name: "Favorites" })).toBeInTheDocument();
  });

  it("renders provider shelves for connected providers", async () => {
    renderWithProviders(<BrowsePage />, {
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
        providerPages: {
          google_drive: {
            videos: [VIDEO_PAGE_ONE.videos[0]],
            total: 1,
            page: 1,
            limit: 20,
          },
        },
      }),
    });

    expect(await screen.findByRole("heading", { name: "Google Drive" })).toBeInTheDocument();
  });

  it("hides provider shelf when provider has no videos", async () => {
    renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch({
        connections: [
          {
            id: "c1",
            provider: "dropbox",
            provider_account_email: "u@example.com",
            connected_at: "2026-01-01T00:00:00Z",
            scan_status: "idle",
            last_scan_at: null,
            video_count: 0,
          },
        ],
        // providerPages defaults to empty → shelf hidden.
      }),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });
    expect(screen.queryByRole("heading", { name: "Dropbox" })).not.toBeInTheDocument();
  });

  it("renders folder shelves from folder enumeration", async () => {
    renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch({
        folders: [{ folder: "Movies", video_count: 5 }],
        folderPages: {
          Movies: {
            videos: [VIDEO_PAGE_ONE.videos[0]],
            total: 1,
            page: 1,
            limit: 20,
          },
        },
      }),
    });

    expect(await screen.findByRole("heading", { name: "Movies" })).toBeInTheDocument();
  });

  // --- View All ---

  it("View All on Favorites applies favorites filter to the grid section", async () => {
    const { container } = renderWithProviders(<BrowsePage />, {
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
    const favoritesHeading = await screen.findByRole("heading", { name: "Favorites" });

    // The Favorites shelf's View All is the button within the same section.
    const favoritesSection = favoritesHeading.closest("section")!;
    const viewAllBtn = within(favoritesSection).getByRole("button", { name: "View All" });

    fireEvent.click(viewAllBtn);

    // T10: the "Showing:" indicator was replaced by filter chips.
    // The Favorites chip should appear in the grid section.
    await waitFor(() => {
      const gridSection = container.querySelector("#all-videos");
      expect(within(gridSection as HTMLElement).getByText("Favorites")).toBeInTheDocument();
    });
  });

  // --- Search (T9) ---

  it("fires a search request after debounce when the user types", async () => {
    const { fetchSpy } = renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch({ searchResults: SEARCH_PAGE }),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

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
    const { fetchSpy } = renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch({ searchResults: SEARCH_PAGE }),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

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

  it("hides hero and shelves and shows search results header when searching", async () => {
    renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch({ searchResults: SEARCH_PAGE }),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

    fireEvent.change(screen.getByLabelText("Search videos"), {
      target: { value: "concert" },
    });

    // Wait for search results to appear.
    await waitFor(() => {
      expect(
        screen.getByText('Search results for \u201cconcert\u201d'),
      ).toBeInTheDocument();
    });

    // Wait for the search-result video to render in the grid. The grid uses
    // keepPreviousData so the old cards (cat.mp4) are briefly visible while
    // the new query resolves — we must wait for the new data before asserting
    // the old card is gone.
    expect(await screen.findByText("concert-footage.mp4")).toBeInTheDocument();

    // Hero heading is gone.
    expect(screen.queryByRole("heading", { name: "cat.mp4" })).not.toBeInTheDocument();
    // Shelves are gone.
    expect(screen.queryByRole("heading", { name: "Recently Added" })).not.toBeInTheDocument();
  });

  it("shows the search-specific empty state when results are empty", async () => {
    renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch({
        searchResults: EMPTY_VIDEO_PAGE,
      }),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

    fireEvent.change(screen.getByLabelText("Search videos"), {
      target: { value: "xyz" },
    });

    await waitFor(() => {
      expect(
        screen.getByText('No videos match \u201cxyz\u201d'),
      ).toBeInTheDocument();
    });
  });

  it("clears the search and returns to browse layout when clear button is clicked", async () => {
    renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch({ searchResults: SEARCH_PAGE }),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

    // Type and enter search mode.
    fireEvent.change(screen.getByLabelText("Search videos"), {
      target: { value: "concert" },
    });
    await waitFor(() => {
      expect(
        screen.getByText('Search results for \u201cconcert\u201d'),
      ).toBeInTheDocument();
    });

    // Click clear.
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    // Should return to browse layout (hero reappears).
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "All Videos" }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: /Search results/ })).not.toBeInTheDocument();
  });

  it("focuses the search bar when the / keyboard shortcut is pressed", async () => {
    renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

    const searchInput = screen.getByLabelText("Search videos");
    expect(searchInput).not.toHaveFocus();

    fireEvent.keyDown(window, { key: "/" });

    expect(searchInput).toHaveFocus();
  });

  it("does not trigger the shortcut when typing inside an input", async () => {
    renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

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
    const { fetchSpy } = renderWithProviders(<BrowsePage />, {
      initialEntries: ["/?provider=dropbox"],
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

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
    const { fetchSpy } = renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

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
    const { fetchSpy } = renderWithProviders(<BrowsePage />, {
      initialEntries: ["/?provider=google_drive"],
      fetchImplementation: browseFetch({ searchResults: SEARCH_PAGE }),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

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

  it("renders the FilterPanel toggle in the grid section header", async () => {
    const { container } = renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

    const gridSection = container.querySelector("#all-videos");
    const filterToggle = within(gridSection as HTMLElement).getByRole("button", {
      name: /Filters/,
    });
    expect(filterToggle).toBeInTheDocument();
    expect(filterToggle).toHaveAttribute("aria-expanded", "false");
  });

  it("expands the filter panel and shows provider options on click", async () => {
    renderWithProviders(<BrowsePage />, {
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

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

    const filterToggle = screen.getByRole("button", { name: /Filters/ });
    fireEvent.click(filterToggle);

    expect(filterToggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("group", { name: "Filter by provider" }),
    ).toBeInTheDocument();
  });

  it("applies a filter via the panel and sends the param in the grid query", async () => {
    const { fetchSpy } = renderWithProviders(<BrowsePage />, {
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

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

    // Open filter panel + click the duration preset.
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "< 5 min" }));

    // The grid query should include duration_min or duration_max.
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

  it("shows active-filter chips when a filter is applied via the panel", async () => {
    renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "HD+" }));

    // Close the panel so HD+ only appears as a chip (not also as a preset button).
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

    // HD+ chip should appear (visible even when panel is collapsed).
    expect(screen.getByText("HD+")).toBeInTheDocument();
    // Active count badge.
    expect(screen.getByLabelText(/1 active filter/)).toBeInTheDocument();
  });

  it("removes a filter when its chip is clicked", async () => {
    const { fetchSpy } = renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch(),
    });

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

    // Open panel, apply, then close panel so the text only appears as a chip.
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "FHD+" }));
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

    // Chip appears (only in chip strip now).
    expect(screen.getByText("FHD+")).toBeInTheDocument();

    // Click the chip to remove it.
    fireEvent.click(screen.getByText("FHD+"));

    // Chip gone.
    expect(screen.queryByText("FHD+")).not.toBeInTheDocument();

    // A subsequent grid query should NOT include min_height.
    await waitFor(() => {
      const recentGridCalls = fetchSpy.mock.calls.filter(
        ([url]) =>
          String(url).startsWith("/api/videos") &&
          !String(url).includes("limit=20") &&
          !String(url).includes("folders"),
      );
      // The most recent grid call should not have min_height.
      const lastGridCall = recentGridCalls[recentGridCalls.length - 1];
      expect(lastGridCall).toBeDefined();
      expect(String(lastGridCall[0])).not.toContain("min_height=");
    });
  });

  it("Clear all resets all filters", async () => {
    const { fetchSpy } = renderWithProviders(<BrowsePage />, {
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

    await screen.findByRole("heading", { level: 2, name: "cat.mp4" });

    // 3 active filters — verified via the badge (avoids text ambiguity with
    // poster-card ProviderBadges that also show "Google Drive").
    expect(screen.getByLabelText(/3 active filters/)).toBeInTheDocument();

    // Click Clear all.
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    // No active-count badge.
    expect(screen.queryByLabelText(/active filter/)).not.toBeInTheDocument();

    // Grid query should have no filter params.
    await waitFor(() => {
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      const url = String(lastCall[0]);
      if (url.startsWith("/api/videos") && !url.includes("limit=20") && !url.includes("folders")) {
        expect(url).not.toContain("provider=");
        expect(url).not.toContain("duration=");
        expect(url).not.toContain("resolution=");
      }
    });
  });

  it("View All on Favorites writes favorites filter to URL (deep-linkable)", async () => {
    const { container } = renderWithProviders(<BrowsePage />, {
      fetchImplementation: browseFetch({
        favorites: {
          videos: [{ ...VIDEO_PAGE_ONE.videos[1], is_favorite: true }],
          total: 1,
          page: 1,
          limit: 20,
        },
      }),
    });

    const favoritesHeading = await screen.findByRole("heading", { name: "Favorites" });
    const favoritesSection = favoritesHeading.closest("section")!;
    const viewAllBtn = within(favoritesSection).getByRole("button", { name: "View All" });

    fireEvent.click(viewAllBtn);

    // Favorites chip should appear in the grid section.
    await waitFor(() => {
      const gridSection = container.querySelector("#all-videos");
      expect(within(gridSection as HTMLElement).getByText("Favorites")).toBeInTheDocument();
    });
  });
});
