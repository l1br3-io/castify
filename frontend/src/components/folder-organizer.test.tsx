// FolderOrganizer tests (M9 task 013; curated pane added by the
// library-folders effort): the two-pane organizer — tree selection
// drives the contents pane; mixed kinds render with the right
// affordances (play on videos ONLY); chips filter; pagination walks
// pages; empty folders get an invitation, not a blank.
//
// MODE: the provider pane renders when `?dir=` is present (its tests
// boot with `/?dir=` — provider root); the curated pane is the default
// at "/", with its own suite below.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

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

    expect(await screen.findByRole("button", { name: /new folder/i })).toBeInTheDocument();
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
});
