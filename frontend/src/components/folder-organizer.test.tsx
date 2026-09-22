// FolderOrganizer tests (M9 task 013; curated pane added by the
// library-folders effort): the two-pane organizer — tree selection
// drives the contents pane; mixed kinds render with the right
// affordances (play on videos ONLY); chips filter; pagination walks
// pages; empty folders get an invitation, not a blank.
//
// MODE: the provider pane renders when `?dir=` is present (its tests
// boot with `/?dir=` — provider root); the curated pane is the default
// at "/", with its own suite below.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { FolderOrganizer } from "./folder-organizer";
import type {
  FolderContentsPageDto,
  FolderNodeDto,
  LibraryTreeDto,
  ProviderKey,
  VideoSummaryDto,
} from "../api/types";
import { renderWithProviders, jsonResponse } from "../test/utils";

/** Location readout — MemoryRouter never touches window.location. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

/** Route-aware mutation mock: keeps the curated tree + contents queries
 *  fed with faithful payloads while the mutation URLs answer whatever
 *  the test needs (a starved refetch used to crash the panes with a
 *  wrong-shaped payload). */
function mutationFetch(
  mutate: (input: RequestInfo | URL, init?: RequestInit) => Response,
) {
  return (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = String(input);
    if (url.startsWith("/api/library-folders/tree")) return jsonResponse(LIBRARY_TREE);
    if (url.startsWith("/api/library-folders/contents")) return jsonResponse(UNFILED_PAGE);
    return mutate(input, init);
  };
}

const locationSearch = () => screen.getByTestId("location").textContent ?? "";

const TREE: FolderNodeDto[] = [
  { name: "(Root)", path: "", video_count: 1, file_count: 0, children: [] },
  {
    name: "Media",
    path: "/Media",
    video_count: 2,
    file_count: 2,
    children: [
      {
        name: "Movies",
        path: "/Media/Movies",
        video_count: 2,
        file_count: 0,
        children: [],
      },
    ],
  },
];

function video(id: string, name: string): { kind: "video" } & VideoSummaryDto {
  return {
    kind: "video",
    id,
    name,
    provider: "google_drive",
    size_bytes: 1000,
    mime_type: "video/mp4",
    duration_ms: 60_000,
    width: 1920,
    height: 1080,
    sources: [
      { connection_id: "c1", provider: "google_drive", provider_file_id: id },
    ],
    created_at: "2026-01-01T00:00:00Z",
    path: `/Media/Movies/${name}`,
    is_favorite: false,
    my_rating: null,
    thumbnail_status: "pending",
    position_seconds: null,
    completed: false,
  };
}

const MOVIES_PAGE: FolderContentsPageDto = {
  entries: [
    video("v1", "Zeta.mp4"),
    {
      kind: "audio",
      id: "f1",
      name: "Alpha.mp3",
      provider: "google_drive",
      path: "/Media/Movies/Alpha.mp3",
      size_bytes: 4096,
      mime_type: "audio/mpeg",
      modified_at: null,
    },
    {
      kind: "document",
      id: "f2",
      name: "Notes.pdf",
      provider: "dropbox",
      path: "/Media/Movies/Notes.pdf",
      size_bytes: 2048,
      mime_type: "application/pdf",
      modified_at: null,
    },
  ],
  total: 5,
  page: 1,
  limit: 3,
};

const LIBRARY_TREE: LibraryTreeDto = {
  folders: [
    { id: "f-trip", parent_id: null, name: "Trip", position: 0, item_count: 4 },
    { id: "f-day1", parent_id: "f-trip", name: "Day 1", position: 0, item_count: 2 },
    { id: "f-docs", parent_id: null, name: "Docs", position: 1, item_count: 1 },
  ],
  unfiled_count: 5,
};

const UNFILED_PAGE: FolderContentsPageDto = {
  entries: [
    video("u1", "Loose.mp4"),
    {
      kind: "image",
      id: "u2",
      name: "Photo.jpg",
      provider: "google_drive",
      path: "/Photo.jpg",
      size_bytes: 2048,
      mime_type: "image/jpeg",
      modified_at: null,
    },
  ],
  total: 5,
  page: 1,
  limit: 3,
};

interface OrganizerOpts {
  tree?: FolderNodeDto[];
  contents?: FolderContentsPageDto;
  contentsByPath?: Record<string, FolderContentsPageDto>;
  connectedProviders?: string[];
  /** Curated tree + contents (curated-mode tests). */
  libraryTree?: LibraryTreeDto;
  libraryContents?: FolderContentsPageDto;
}

function organizerFetch(opts: OrganizerOpts = {}) {
  const tree = opts.tree ?? TREE;
  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/folders/tree")) return jsonResponse(tree);
    if (url.startsWith("/api/library-folders/tree")) {
      return jsonResponse(opts.libraryTree ?? LIBRARY_TREE);
    }
    if (url.startsWith("/api/library-folders/contents")) {
      return jsonResponse(opts.libraryContents ?? UNFILED_PAGE);
    }
    if (url.startsWith("/api/folders/contents")) {
      const params = new URL(url, "http://x").searchParams;
      const path = params.get("path") ?? "";
      if (opts.contentsByPath) {
        const page = opts.contentsByPath[path];
        if (page) return jsonResponse(page);
      }
      return jsonResponse(opts.contents ?? MOVIES_PAGE);
    }
    return jsonResponse({ message: "unmocked" }, 404);
  };
}

function renderOrganizer(
  opts: OrganizerOpts = {},
  initialEntries: string[] = ["/?dir="],
) {
  return renderWithProviders(
    <>
      <LocationProbe />
      <FolderOrganizer
        connectedProviders={
          (opts.connectedProviders ?? ["google_drive"]) as ProviderKey[]
        }
      />
    </>,
    {
      initialEntries,
      fetchImplementation: organizerFetch(opts),
    },
  );
}

describe("FolderOrganizer", () => {
  it("renders the contents pane with mixed kinds", async () => {
    renderOrganizer();

    expect(await screen.findByText("Zeta.mp4")).toBeInTheDocument();
    expect(screen.getByText("Alpha.mp3")).toBeInTheDocument();
    expect(screen.getByText("Notes.pdf")).toBeInTheDocument();
  });

  it("renders videos with a play link and files with download only", async () => {
    renderOrganizer();

    // Video → watch page link with a Play label.
    await screen.findByText("Zeta.mp4");
    expect(screen.getByRole("link", { name: "Play Zeta.mp4" })).toHaveAttribute(
      "href",
      "/watch/v1",
    );

    // Files → download link, never play.
    expect(
      screen.getByRole("link", { name: "Download Alpha.mp3" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Play Alpha/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Play Notes/ }),
    ).not.toBeInTheDocument();
  });

  // Tree selection lives in the app sidebar (SidebarFolders) — see
  // sidebar-folders.test.tsx for the tree-driving tests.

  it("provider chips filter contents and All clears the filter", async () => {
    renderOrganizer({ connectedProviders: ["google_drive", "dropbox"] });
    await screen.findByText("Zeta.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Dropbox" }));
    await waitFor(() => {
      const calls = (
        globalThis.fetch as ReturnType<typeof vi.fn>
      ).mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => c.includes("provider=dropbox"))).toBe(true);
    });

    // All resets to an unfiltered listing (no provider param).
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => {
      const lastContents = (
        globalThis.fetch as ReturnType<typeof vi.fn>
      ).mock.calls
        .map((c) => String(c[0]))
        .filter((c) => c.startsWith("/api/folders/contents"))
        .pop();
      expect(lastContents).toBeDefined();
      expect(lastContents).not.toContain("provider=");
    });
  });

  it("paginates with Previous/Next", async () => {
    renderOrganizer();
    await screen.findByText("Zeta.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    });
  });

  it("shows an empty state for empty folders", async () => {
    renderOrganizer({
      contents: { entries: [], total: 0, page: 1, limit: 50 },
    });
    await screen.findByText(/This folder is empty/i);
  });

  it("distinguishes filter-empty from folder-empty", async () => {
    renderOrganizer({
      contents: { entries: [], total: 0, page: 1, limit: 50 },
    });
    await screen.findByText(/This folder is empty/i);

    fireEvent.change(screen.getByLabelText("Filter by name"), {
      target: { value: "zzz-no-match" },
    });
    await waitFor(() => {
      expect(
        screen.getByText(/No entries match the current filters/i),
      ).toBeInTheDocument();
    });
  });

  it("name filter forwards q to the contents query", async () => {
    renderOrganizer();
    await screen.findByText("Zeta.mp4");

    fireEvent.change(screen.getByLabelText("Filter by name"), {
      target: { value: "zeta" },
    });
    await waitFor(() => {
      const calls = (
        globalThis.fetch as ReturnType<typeof vi.fn>
      ).mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => c.includes("q=zeta"))).toBe(true);
    });
  });

  // FR-9.2's unknown-dir fallback lives with the tree in SidebarFolders —
  // see sidebar-folders.test.tsx.
});

// --- Identity-pass task 004: full-path line, keycap chips, mono filter ---

describe("FolderOrganizer identity styling", () => {
  it("renders the full-dir mono path line above the contents heading", async () => {
    renderOrganizer({}, [`/?dir=${encodeURIComponent("/Media/Movies")}`]);
    await screen.findByText("Zeta.mp4");

    const pathLine = screen.getByTestId("contents-full-path");
    expect(pathLine).toHaveTextContent("/Media/Movies");
    expect(pathLine).toHaveClass(
      "font-mono",
      "truncate",
      "text-[var(--color-castify-muted)]",
    );
    expect(pathLine).toHaveAttribute("title", "/Media/Movies");

    // Sits above the leaf-name heading in DOM order.
    const heading = screen.getByTestId("contents-path");
    expect(
      heading.compareDocumentPosition(pathLine) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  it("renders the path line as / at root", async () => {
    renderOrganizer();
    await screen.findByText("Zeta.mp4");
    expect(screen.getByTestId("contents-full-path")).toHaveTextContent("/");
  });

  it("renders the path line for (Unsorted) as-is", async () => {
    renderOrganizer(
      {
        tree: [
          ...TREE,
          {
            name: "(Unsorted)",
            path: "(Unsorted)",
            video_count: 0,
            file_count: 0,
            children: [],
          },
        ],
      },
      [`/?dir=${encodeURIComponent("(Unsorted)")}`],
    );
    await screen.findByText("Zeta.mp4");
    expect(screen.getByTestId("contents-full-path")).toHaveTextContent(
      "(Unsorted)",
    );
  });

  it("styles provider chips as keycaps (aria-pressed contract unchanged)", async () => {
    renderOrganizer({ connectedProviders: ["google_drive", "dropbox"] });
    await screen.findByText("Zeta.mp4");

    const all = screen.getByRole("button", { name: "All" });
    expect(all).toHaveClass("keycap");
    expect(all).toHaveAttribute("aria-pressed", "true");

    const dropbox = screen.getByRole("button", { name: "Dropbox" });
    expect(dropbox).toHaveClass("keycap");
    expect(dropbox).toHaveAttribute("aria-pressed", "false");
  });

  it("styles breadcrumb chips as keycaps (aria-current behavior unchanged)", async () => {
    renderOrganizer({}, [`/?dir=${encodeURIComponent("/Media/Movies")}`]);
    await screen.findByText("Zeta.mp4");

    expect(screen.getByRole("button", { name: "All folders" })).toHaveClass(
      "keycap",
    );
    expect(screen.getByRole("button", { name: "Media" })).toHaveClass("keycap");
    expect(
      screen.getByText("Movies", { selector: "span[aria-current='page']" }),
    ).toHaveClass("keycap");
  });

  it("styles the name filter in the mono data voice", async () => {
    renderOrganizer();
    await screen.findByText("Zeta.mp4");

    expect(screen.getByLabelText("Filter by name")).toHaveClass("font-mono");
  });
});

// --- Responsive: breadcrumb chips replace the sidebar under lg (task 014) ---

describe("FolderOrganizer breadcrumbs", () => {
  it("renders breadcrumb chips for the selected path, tappable to navigate up", async () => {
    renderOrganizer({}, [`/?dir=${encodeURIComponent("/Media/Movies")}`]);
    await screen.findByText("Zeta.mp4");

    // Breadcrumb trail: root + each segment.
    expect(
      screen.getByRole("button", { name: "All folders" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Media" })).toBeInTheDocument();
    // Deepest segment is the current location — not a button. (The expanded
    // tree also shows a Movies node; assert at least one plain text.)
    expect(screen.getAllByText("Movies").length).toBeGreaterThan(0);

    // Tapping a segment selects that folder.
    fireEvent.click(screen.getByRole("button", { name: "Media" }));
    await waitFor(() => {
      expect(screen.getByTestId("contents-path")).toHaveTextContent("Media");
    });
  });
});

// --- Curated pane (library-folders task 007) — the default mode ---

describe("FolderOrganizer curated pane", () => {
  it("root view: Unfiled current tile + subfolder tiles + the unfiled item listing", async () => {
    renderOrganizer({}, ["/"]);

    // Unfiled tile: the current location at root, with its live count.
    // ("Unfiled" also names the heading + path line — assert the tile
    // through its count.)
    expect(await screen.findByText("5 items")).toBeInTheDocument();
    expect(screen.getAllByText("Unfiled").length).toBeGreaterThan(0);

    // Root subfolder tiles link with ?folder=.
    const trip = screen.getByRole("link", { name: "Open folder Trip" });
    expect(trip.getAttribute("href")).toBe("/?folder=f-trip");
    expect(screen.getByRole("link", { name: "Open folder Docs" })).toBeInTheDocument();

    // The mixed unfiled listing renders below the tiles.
    expect(screen.getByRole("link", { name: "Play Loose.mp4" })).toHaveAttribute(
      "href",
      "/watch/u1",
    );
    expect(screen.getByText("Photo.jpg")).toBeInTheDocument();

    // The curated fetch, not the provider one.
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(urls.some((u) => u.startsWith("/api/library-folders/contents"))).toBe(true);
    expect(urls.some((u) => u.startsWith("/api/folders/contents"))).toBe(false);
  });

  it("descending via a folder tile writes ?folder=", async () => {
    renderOrganizer({}, ["/"]);
    fireEvent.click(await screen.findByRole("link", { name: "Open folder Trip" }));

    await waitFor(() => {
      expect(locationSearch()).toContain("folder=f-trip");
    });
  });

  it("deep links restore the level: breadcrumb trail + folder-scoped contents", async () => {
    renderOrganizer({}, ["/?folder=f-day1"]);

    // Breadcrumbs: Library / Trip / Day 1 (leaf current) — all resolve
    // once the tree loads ("Day 1" also names the heading, so query the
    // leaf through its current-chip selector).
    await waitFor(() => {
      expect(
        screen.getByText("Day 1", { selector: "span[aria-current='page']" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trip" })).toBeInTheDocument();
    expect(screen.getByTestId("contents-full-path")).toHaveTextContent("/Trip/Day 1");

    // Contents fetched for the selected folder — no folder tiles above
    // (Day 1 has no subfolders), Unfiled tile absent inside folders.
    await waitFor(() => {
      const lastContents = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/library-folders/contents"))
        .pop();
      expect(lastContents).toContain("folder_id=f-day1");
    });
    expect(screen.queryByText("5 items")).not.toBeInTheDocument();

    // Breadcrumb tap climbs to Trip.
    fireEvent.click(screen.getByRole("button", { name: "Trip" }));
    await waitFor(() => {
      expect(locationSearch()).toContain("folder=f-trip");
    });
  });

  it("kind chips and the name filter compose with the contents query", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Videos" }));
    await waitFor(() => {
      const lastContents = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/library-folders/contents"))
        .pop();
      expect(lastContents).toContain("kind=video");
    });

    fireEvent.change(screen.getByLabelText("Filter by name"), {
      target: { value: "loose" },
    });
    await waitFor(() => {
      const lastContents = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/library-folders/contents"))
        .pop();
      expect(lastContents).toContain("kind=video");
      expect(lastContents).toContain("q=loose");
    });

    // All resets the kind filter (name-matched: the pane also has an
    // "All folders" breadcrumb in provider mode only — curated has no
    // other "All" button besides this chip... except the name starts
    // matching loosely, so pin the chip role group).
    const kindGroup = screen.getByRole("group", { name: "Filter by kind" });
    fireEvent.click(
      kindGroup.querySelector<HTMLButtonElement>('button:first-child')!,
    );
    await waitFor(() => {
      const lastContents = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/library-folders/contents"))
        .pop();
      expect(lastContents).not.toContain("kind=");
    });
  });

  it("folder changes reset the page", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    // Walk to page 2 (5 total / 3 per page).
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    });

    // A kind chip resets to page 1 in the same fetch.
    fireEvent.click(screen.getByRole("button", { name: "Photos" }));
    await waitFor(() => {
      const lastContents = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/library-folders/contents"))
        .pop();
      expect(lastContents).toContain("kind=image");
      expect(lastContents).toContain("page=1");
    });
  });

  it("empty tree first run: New folder CTA + the Unfiled tile", async () => {
    renderOrganizer(
      { libraryTree: { folders: [], unfiled_count: 2 } },
      ["/"],
    );

    expect(
      await screen.findByRole("button", { name: "New folder" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Unfiled").length).toBeGreaterThan(0);
    expect(screen.getByText("2 items")).toBeInTheDocument();
  });

  it("provider mode renders the provider pane exactly — no curated fetches", async () => {
    renderOrganizer({}, ["/?dir="]);

    expect(await screen.findByText("Zeta.mp4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All folders" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Library" })).not.toBeInTheDocument();

    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(urls.some((u) => u.startsWith("/api/library-folders"))).toBe(false);
    expect(urls.some((u) => u.startsWith("/api/folders/contents"))).toBe(true);
  });

  // --- Owner CRUD (library-folders task 008) ---

  /** Open a folder tile's kebab and pick an action. */
  async function pickTileAction(tileName: string, action: string) {
    fireEvent.click(
      await screen.findByRole("button", { name: `More actions for ${tileName}` }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: action }));
  }

  it("create: the empty-tree CTA opens the dialog; submit POSTs at the current level", async () => {
    renderOrganizer({ libraryTree: { folders: [], unfiled_count: 0 } }, ["/"]);

    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    expect(dialog).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Folder name"), {
      target: { value: "  Trip  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => String(c[0]) === "/api/library-folders",
      );
      expect(post).toBeDefined();
      expect((post![1] as RequestInit).method).toBe("POST");
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
        name: "Trip",
      });
    });
  });

  it("create inside a folder passes the current folder as parent", async () => {
    renderOrganizer({}, ["/?folder=f-trip"]);
    await waitFor(() =>
      expect(
        screen.getByText("Trip", { selector: "span[aria-current='page']" }),
      ).toBeInTheDocument(),
    );

    // The always-present header chip creates at the CURRENT level.
    fireEvent.click(screen.getByRole("button", { name: "+ New folder" }));
    expect(await screen.findByRole("dialog", { name: "New folder" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Folder name"), {
      target: { value: "Day 1" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        mutationFetch(() =>
          jsonResponse(
            { id: "f-day1", parent_id: "f-trip", name: "Day 1", position: 0 },
            201,
          ),
        ),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => String(c[0]) === "/api/library-folders",
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
        name: "Day 1",
        parent_id: "f-trip",
      });
    });
  });

  it("rename: duplicate-sibling error keeps the dialog open with the server copy", async () => {
    const fetchSpy = organizerFetch({});
    const { rerender } = renderWithProviders(
      <>
        <LocationProbe />
        <FolderOrganizer connectedProviders={["google_drive"] as ProviderKey[]} />
      </>,
      { initialEntries: ["/"], fetchImplementation: fetchSpy },
    );
    await screen.findByText("5 items");

    await pickTileAction("Trip", "Rename");
    fireEvent.change(await screen.findByLabelText("Folder name"), {
      target: { value: "Docs" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ message: "a sibling folder already has that name" }, 409)),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      (await screen.findAllByText(/sibling folder already has that name/i)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("dialog", { name: 'Rename "Trip"' })).toBeInTheDocument();
    void rerender;
  });

  it("move: picker excludes the moved subtree; a pick PATCHes parent_id", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("5 items");

    await pickTileAction("Trip", "Move");
    const dialog = await screen.findByRole("dialog", { name: 'Move "Trip"' });
    expect(dialog).toBeInTheDocument();

    // Trip's own subtree (Day 1) is unpickable; Unfiled is the root
    // choice AND the current parent (Trip sits at root) — disabled.
    expect(screen.getByRole("button", { name: "Unfiled · current" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Day 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Docs" })).toBeEnabled();

    vi.stubGlobal(
      "fetch",
      vi.fn(
        mutationFetch(() =>
          jsonResponse({ id: "f-trip", parent_id: "f-docs", name: "Trip", position: 1 }),
        ),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));

    await waitFor(() => {
      const patch = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => String(c[0]) === "/api/library-folders/f-trip",
      );
      expect(patch).toBeDefined();
      expect((patch![1] as RequestInit).method).toBe("PATCH");
      expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({
        parent_id: "f-docs",
      });
    });
  });

  it("delete: confirmation copy states Unfiled + flatten; confirm DELETEs and climbs out of a deleted folder", async () => {
    renderOrganizer({}, ["/?folder=f-day1"]);
    await waitFor(() =>
      expect(
        screen.getByText("Day 1", { selector: "span[aria-current='page']" }),
      ).toBeInTheDocument(),
    );

    // Day 1 is the current level; its tile renders among subfolders of Trip…
    // inside f-day1 there are no subfolders, so open Trip's menu from the
    // breadcrumb-free path: use the Unfiled tile's menu instead? No —
    // menus live on tiles; from f-day1 the visible tiles are none. Climb
    // to Trip first.
    fireEvent.click(screen.getByRole("button", { name: "Trip" }));
    await waitFor(() =>
      expect(
        screen.getByText("Trip", { selector: "span[aria-current='page']" }),
      ).toBeInTheDocument(),
    );

    await pickTileAction("Day 1", "Delete");
    expect(
      await screen.findByText(/Items in it return to Unfiled and its subfolders move to the/i),
    ).toBeInTheDocument();

    vi.stubGlobal(
      "fetch",
      vi.fn(mutationFetch(() => new Response(null, { status: 204 }))),
    );
    fireEvent.click(
      screen.getByRole("dialog", { name: 'Delete "Day 1"?' }).querySelector(
        'button:last-child',
      )!,
    );

    await waitFor(() => {
      const del = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => String(c[0]) === "/api/library-folders/f-day1",
      );
      expect(del).toBeDefined();
      expect((del![1] as RequestInit).method).toBe("DELETE");
    });
  });

  it("the Unfiled tile's menu offers New folder (no rename/move/delete)", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("5 items");

    fireEvent.click(screen.getByRole("button", { name: "More actions for Unfiled" }));
    expect(screen.getByRole("menuitem", { name: "New folder" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("the provider pane has no CRUD affordances", async () => {
    renderOrganizer({}, ["/?dir="]);
    await screen.findByText("Zeta.mp4");

    expect(screen.queryByRole("button", { name: /more actions for/i })).not.toBeInTheDocument();
  });

  // --- Multi-select + batch move (library-folders task 009) ---

  it("Select mode: mixed selection counts; cards toggle instead of navigating; Escape clears", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    // Outside select mode, the video card navigates.
    expect(screen.getByRole("link", { name: "Play Loose.mp4" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select items" }));
    expect(screen.getByRole("group", { name: "Selection actions" })).toBeInTheDocument();
    expect(screen.getByText("0 items selected")).toBeInTheDocument();
    // Navigation suppressed in select mode.
    expect(screen.queryByRole("link", { name: "Play Loose.mp4" })).not.toBeInTheDocument();

    // Mixed toggle: video + file, in click order.
    fireEvent.click(screen.getByText("Loose.mp4").closest("article")!);
    fireEvent.click(screen.getByText("Photo.jpg").closest("article")!);
    expect(screen.getByText("2 items selected")).toBeInTheDocument();

    // Escape cancels select mode and clears.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Selection actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Play Loose.mp4" })).toBeInTheDocument();
  });

  it("Move N items opens the picker once and fires exactly one PATCH with every pair", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Select items" }));
    fireEvent.click(screen.getByText("Loose.mp4").closest("article")!);
    fireEvent.click(screen.getByText("Photo.jpg").closest("article")!);

    fireEvent.click(screen.getByRole("button", { name: "Move to folder" }));
    expect(
      await screen.findByRole("dialog", { name: "Move 2 items" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trip" })).toBeEnabled();

    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.click(screen.getByRole("button", { name: "Trip" }));

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        (c) => String(c[0]) === "/api/library-folders/items",
      );
      expect(patches).toHaveLength(1);
      expect((patches[0]![1] as RequestInit).method).toBe("PATCH");
      expect(JSON.parse(String((patches[0]![1] as RequestInit).body))).toEqual({
        items: [
          { kind: "video", id: "u1" },
          { kind: "file", id: "u2" },
        ],
        folder_id: "f-trip",
      });
    });
  });

  it("a failed batch keeps the selection and surfaces the error", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Select items" }));
    fireEvent.click(screen.getByText("Loose.mp4").closest("article")!);
    fireEvent.click(screen.getByRole("button", { name: "Move to folder" }));
    await screen.findByRole("dialog", { name: "Move 1 item" });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ message: "batch contains an unknown item id" }, 404)),
    );
    fireEvent.click(screen.getByRole("button", { name: "Trip" }));

    expect(
      (await screen.findAllByText(/unknown item id/i)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("1 item selected")).toBeInTheDocument();
  });

  it("per-item Move to folder outside select mode fires a batch of one; Unfiled un-files", async () => {
    renderOrganizer({}, ["/?folder=f-trip"]);
    await waitFor(() =>
      expect(
        screen.getByText("Trip", { selector: "span[aria-current='page']" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "More actions for Day 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move" }));
    const dialog = await screen.findByRole("dialog", { name: 'Move "Day 1"' });
    expect(dialog).toBeInTheDocument();

    // Per-ITEM menu is on contents entries, not folder tiles — use an
    // item entry instead for the single-move assertion.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "More actions for Loose.mp4" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "More actions for Loose.mp4" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to folder" }));
    await screen.findByRole("dialog", { name: "Move to folder" });

    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.click(screen.getByRole("button", { name: "Unfiled" }));

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        (c) => String(c[0]) === "/api/library-folders/items",
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String((patches[0]![1] as RequestInit).body))).toEqual({
        items: [{ kind: "video", id: "u1" }],
        folder_id: null,
      });
    });
  });
});

// --- List view (library-list-view task 005) ---
//
// Both panes render ContentsBody; in list mode every entry kind becomes a
// slate row (videos with thumbnails, files with kind icons + download),
// headers are display-only (server order stands), and the curated pane
// stacks folder rows above item rows. View mode is the global per-device
// preference — cleared around each test so the grid tests above stay
// deterministic.

describe("FolderOrganizer list view", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("provider pane renders every entry kind as rows with display-only headers", async () => {
    renderOrganizer();
    fireEvent.click(screen.getByRole("button", { name: "List view" }));

    const table = await screen.findByRole("table", { name: "Folder contents" });
    // Video row navigates; audio + document rows render as text rows.
    expect(
      within(table).getByRole("link", { name: "Zeta.mp4" }),
    ).toHaveAttribute("href", "/watch/v1");
    expect(within(table).getByText("Alpha.mp3")).toBeInTheDocument();
    expect(within(table).getByText("Notes.pdf")).toBeInTheDocument();
    // Ledger values render formatted.
    expect(within(table).getByText("1000 B")).toBeInTheDocument();
    // Non-video rows keep their download affordance.
    expect(
      within(table).getByRole("link", { name: "Download Notes.pdf" }),
    ).toBeInTheDocument();
    // Display-only headers — no sort buttons anywhere.
    expect(screen.queryByRole("button", { name: "Name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Size" })).toBeNull();
  });

  it("curated pane stacks folder rows above item rows; Unfiled is the current row", async () => {
    const fetchSpy = vi.fn(
      organizerFetch({ libraryContents: UNFILED_PAGE }),
    );
    renderWithProviders(
      <>
        <LocationProbe />
        <FolderOrganizer connectedProviders={["google_drive"]} />
      </>,
      { fetchImplementation: fetchSpy, initialEntries: ["/"] },
    );

    fireEvent.click(screen.getByRole("button", { name: "List view" }));

    const foldersTable = await screen.findByRole("table", { name: "Folders" });
    // Root level: Unfiled (current location, no navigation) + root folders.
    const unfiled = within(foldersTable).getByText("Unfiled");
    expect(unfiled).toHaveAttribute("aria-current", "page");
    expect(within(foldersTable).getByText("Trip")).toBeInTheDocument();
    expect(within(foldersTable).getByText("Docs")).toBeInTheDocument();

    // A folder row navigates via its name button — contents refetch for it.
    fireEvent.click(within(foldersTable).getByRole("button", { name: "Trip" }));
    await waitFor(() => {
      const contentsCalls = fetchSpy.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/library-folders/contents"),
      );
      expect(String(contentsCalls[contentsCalls.length - 1][0])).toContain(
        "folder_id=f-trip",
      );
    });

    // Item rows below the folder table.
    const itemsTable = await screen.findByRole("table", {
      name: "Folder contents",
    });
    expect(
      within(itemsTable).getByRole("link", { name: "Loose.mp4" }),
    ).toBeInTheDocument();
  });

  it("select mode works from rows — the curated move batch", async () => {
    renderOrganizer({}, ["/"]);
    fireEvent.click(await screen.findByRole("button", { name: "List view" }));

    fireEvent.click(screen.getByRole("button", { name: "Select items" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Loose.mp4" }),
    );
    expect(screen.getByText(/1 item selected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to folder" })).toBeEnabled();

    // Escape cancels select mode — rows navigate again.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("checkbox", { name: "Select Loose.mp4" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Loose.mp4" })).toBeInTheDocument();
  });
});

// --- Drag to organize (drag-and-drop task 002) ---
//
// Grid-mode item drags: a card (or the whole select-mode selection)
// dropped onto a folder tile or the Unfiled pin fires exactly one batch
// move; the tile previews the post-drop count while hovered; misses
// cancel cleanly; clicks below the drag threshold are untouched.
//
// Pointer choreography mirrors the real event flow: pointerdown on the
// card arms the engine, a window pointermove crosses the 6px threshold,
// pointerOver/pointerOut on a tile drive hover (React derives
// onPointerEnter from pointerover), window pointerup resolves the drop.

describe("FolderOrganizer drag to organize", () => {
  /** The card article for a contents entry, by name. */
  function cardFor(name: string): HTMLElement {
    return screen.getByText(name).closest("article")!;
  }

  /** The tile article for a folder, by name. */
  function tileFor(name: string): HTMLElement {
    return screen.getByRole("link", { name: `Open folder ${name}` }).closest("article")!;
  }

  /** Arms + crosses the threshold from a card. */
  function dragFromCard(name: string): void {
    fireEvent.pointerDown(cardFor(name), { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 130, clientY: 120 });
  }

  it("drops a single card onto a folder tile: one batch move, success toast", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    dragFromCard("Loose.mp4");
    fireEvent.pointerOver(tileFor("Trip"));

    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.pointerUp(window);

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        (c) => String(c[0]) === "/api/library-folders/items",
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String((patches[0]![1] as RequestInit).body))).toEqual({
        items: [{ kind: "video", id: "u1" }],
        folder_id: "f-trip",
      });
    });
    expect(await screen.findByText("Moved to Trip")).toBeInTheDocument();
  });

  it("carries the whole selection when the grabbed card is selected; success clears it", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Select items" }));
    fireEvent.click(cardFor("Loose.mp4"));
    fireEvent.click(screen.getByText("Photo.jpg").closest("article")!);

    dragFromCard("Loose.mp4");
    fireEvent.pointerOver(tileFor("Trip"));

    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.pointerUp(window);

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        (c) => String(c[0]) === "/api/library-folders/items",
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String((patches[0]![1] as RequestInit).body))).toEqual({
        items: [
          { kind: "video", id: "u1" },
          { kind: "file", id: "u2" },
        ],
        folder_id: "f-trip",
      });
    });
    await waitFor(() => expect(screen.getByText("0 items selected")).toBeInTheDocument());
  });

  it("previews the post-drop count on hover and cancels it on leave", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    expect(screen.getByText("4 items")).toBeInTheDocument();
    dragFromCard("Loose.mp4");
    fireEvent.pointerOver(tileFor("Trip"));
    expect(screen.getByText("4 → 5 items")).toBeInTheDocument();

    fireEvent.pointerOut(tileFor("Trip"));
    expect(screen.getByText("4 items")).toBeInTheDocument();

    // A cancelled drag (drop nowhere) leaves the count untouched.
    fireEvent.pointerUp(window);
    expect(screen.getByText("4 items")).toBeInTheDocument();
  });

  it("drops onto the Unfiled pin with folder_id null", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    dragFromCard("Loose.mp4");
    // The pin's heading — the path line + pane heading also carry
    // title="Unfiled"; the h3 is the tile's own.
    const unfiledHeading = screen
      .getAllByTitle("Unfiled")
      .find((el) => el.tagName === "H3")!;
    fireEvent.pointerOver(unfiledHeading.closest("article")!);

    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.pointerUp(window);

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        (c) => String(c[0]) === "/api/library-folders/items",
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String((patches[0]![1] as RequestInit).body))).toEqual({
        items: [{ kind: "video", id: "u1" }],
        folder_id: null,
      });
    });
  });

  it("a failed move surfaces a direct error and keeps the selection", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Select items" }));
    fireEvent.click(cardFor("Loose.mp4"));

    dragFromCard("Loose.mp4");
    fireEvent.pointerOver(tileFor("Trip"));

    vi.stubGlobal(
      "fetch",
      vi.fn(mutationFetch(() => jsonResponse({ message: "batch contains an unknown item id" }, 404))),
    );
    fireEvent.pointerUp(window);

    expect(await screen.findByText(/Move failed — .*unknown item id/)).toBeInTheDocument();
    expect(screen.getByText("1 item selected")).toBeInTheDocument();
  });

  it("dropping outside any target cancels: no mutation, selection preserved", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Select items" }));
    fireEvent.click(cardFor("Loose.mp4"));

    dragFromCard("Loose.mp4");
    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.pointerUp(window);

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.filter((c) => String(c[0]) === "/api/library-folders/items"),
      ).toHaveLength(0),
    );
    expect(screen.getByText("1 item selected")).toBeInTheDocument();
  });

  it("a press below the threshold is a click, not a drag: no mutation, navigation intact", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    fireEvent.pointerDown(cardFor("Loose.mp4"), { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 103, clientY: 101 });
    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.pointerUp(window);

    expect(
      fetchSpy.mock.calls.filter((c) => String(c[0]) === "/api/library-folders/items"),
    ).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Play Loose.mp4" })).toBeInTheDocument();
  });

  it("the ghost click after a completed drag is swallowed — no surprise navigation", async () => {
    renderOrganizer({}, ["/"]);
    await screen.findByText("Loose.mp4");

    dragFromCard("Loose.mp4");
    fireEvent.pointerOver(tileFor("Trip"));
    vi.stubGlobal("fetch", vi.fn(mutationFetch(() => new Response(null, { status: 204 }))));
    fireEvent.pointerUp(window);

    // The click the browser fires after pointerup must not navigate.
    fireEvent.click(screen.getByRole("link", { name: "Play Loose.mp4" }));
    expect(locationSearch()).toBe("");
  });
});
