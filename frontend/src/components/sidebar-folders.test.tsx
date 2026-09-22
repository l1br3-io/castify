// SidebarFolders tests — the app sidebar's FOLDERS section, upgraded by
// the library-folders effort: the curated tree is primary (Unfiled
// pinned with its live count), the provider tree is a secondary "Cloud"
// toggle. The single mode rule lives here: curated selection writes
// `?folder=` and clears `?dir=`; provider selection writes `?dir=` and
// clears `?folder=`; stale `?folder=` deep links snap back to the
// curated root once the tree loads.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { SidebarFolders } from "./sidebar-folders";
import type { FolderNodeDto, LibraryTreeDto } from "../api/types";
import { renderWithProviders, jsonResponse } from "../test/utils";

/** Location readout — MemoryRouter never touches window.location, so
 *  URL assertions read the router's location through a probe. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

const PROVIDER_TREE: FolderNodeDto[] = [
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

const LIBRARY_TREE: LibraryTreeDto = {
  folders: [
    { id: "f-trip", parent_id: null, name: "Trip", position: 0, item_count: 3 },
    {
      id: "f-day1",
      parent_id: "f-trip",
      name: "Day 1",
      position: 0,
      item_count: 2,
    },
    { id: "f-other", parent_id: null, name: "Other", position: 1, item_count: 1 },
  ],
  unfiled_count: 7,
};

function bothTreesFetch(
  library: LibraryTreeDto = LIBRARY_TREE,
  provider: FolderNodeDto[] = PROVIDER_TREE,
) {
  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/library-folders/tree")) return jsonResponse(library);
    if (url.startsWith("/api/folders/tree")) return jsonResponse(provider);
    return jsonResponse({ message: "unmocked" }, 404);
  };
}

function renderSidebar(
  initialEntries: string[] = ["/"],
  fetchImplementation = bothTreesFetch(),
) {
  return renderWithProviders(
    <>
      <LocationProbe />
      <SidebarFolders />
    </>,
    {
      initialEntries,
      fetchImplementation,
    },
  );
}

const locationSearch = () => screen.getByTestId("location").textContent ?? "";

const selectButton = (treeitemName: RegExp) =>
  screen
    .getByRole("treeitem", { name: treeitemName })
    .querySelector<HTMLButtonElement>("button[data-tree-key]")!;

describe("SidebarFolders — curated primary", () => {
  it("renders the curated tree with the Unfiled node pinned first and its count", async () => {
    renderSidebar();

    const unfiled = await screen.findByRole("treeitem", { name: /Unfiled/ });
    expect(unfiled).toBeInTheDocument();
    expect(screen.getByText("7 items")).toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "Library folders" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Trip/ })).toBeInTheDocument();

    // Unfiled is the first treeitem in the curated tree.
    const curated = screen.getByRole("tree", { name: "Library folders" });
    const first = curated.querySelector("li[role='treeitem']");
    expect(first?.textContent).toContain("Unfiled");
  });

  it("nests curated children under their parents with cumulative counts", async () => {
    renderSidebar();
    await screen.findByRole("treeitem", { name: /Trip/ });

    fireEvent.click(screen.getByRole("button", { name: "Expand Trip" }));
    expect(screen.getByRole("treeitem", { name: /Day 1/ })).toBeInTheDocument();
    expect(screen.getByText("3 items")).toBeInTheDocument(); // Trip cumulative
  });

  it("selecting a curated folder sets ?folder= with no ?dir=", async () => {
    renderSidebar(["/?dir=" + encodeURIComponent("/Media")]);
    await screen.findByRole("treeitem", { name: /Trip/ });

    fireEvent.click(selectButton(/Trip/));

    await waitFor(() => {
      expect(locationSearch()).toContain("folder=f-trip");
      expect(locationSearch()).not.toContain("dir=");
    });
  });

  it("selecting Unfiled clears the folder param (curated root default)", async () => {
    renderSidebar(["/?folder=f-trip"]);
    await screen.findByRole("treeitem", { name: /Unfiled/ });

    fireEvent.click(selectButton(/Unfiled/));

    await waitFor(() => {
      expect(locationSearch()).not.toContain("folder=");
    });
  });

  it("a stale ?folder= deep link snaps back to the curated root once loaded", async () => {
    renderSidebar(["/?folder=f-deleted"]);
    await screen.findByRole("treeitem", { name: /Unfiled/ });

    await waitFor(() => {
      expect(locationSearch()).not.toContain("folder=");
    });
    expect(selectButton(/Unfiled/)).toHaveAttribute("aria-current");
  });

  it("empty curated tree still shows Unfiled and the New folder entry point", async () => {
    renderSidebar(["/"], bothTreesFetch({ folders: [], unfiled_count: 0 }));

    expect(await screen.findByRole("treeitem", { name: /Unfiled/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /new folder/i }),
    ).toBeInTheDocument();
  });
});

describe("SidebarFolders — provider secondary", () => {
  it("the Cloud section is collapsed by default and expands to the provider tree", async () => {
    renderSidebar();
    await screen.findByRole("treeitem", { name: /Trip/ });

    expect(screen.queryByRole("tree", { name: "Cloud folders" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /cloud/i }));
    expect(
      screen.getByRole("tree", { name: "Cloud folders" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Media/ })).toBeInTheDocument();
  });

  it("a provider deep link (?dir=) opens the Cloud section expanded", async () => {
    renderSidebar([`/?dir=${encodeURIComponent("/Media/Movies")}`]);

    expect(
      await screen.findByRole("tree", { name: "Cloud folders" }),
    ).toBeInTheDocument();
    expect(selectButton(/Movies/)).toHaveAttribute("aria-current");
  });

  it("selecting a provider folder sets ?dir= and clears ?folder=", async () => {
    renderSidebar(["/?folder=f-trip"]);
    await screen.findByRole("treeitem", { name: /Trip/ });

    fireEvent.click(screen.getByRole("button", { name: /cloud/i }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Media" }));
    fireEvent.click(selectButton(/Movies/));

    await waitFor(() => {
      expect(locationSearch()).toContain(
        `dir=${encodeURIComponent("/Media/Movies")}`,
      );
      expect(locationSearch()).not.toContain("folder=");
    });
  });

  it("an unknown ?dir= falls back to the provider root selection (FR-9.2)", async () => {
    renderSidebar([`/?dir=${encodeURIComponent("/nope/not/a/folder")}`]);

    await screen.findByRole("tree", { name: "Cloud folders" });
    await waitFor(() => {
      expect(selectButton(/\(Root\)/)).toHaveAttribute("aria-current");
    });
  });
});

// --- Sidebar drop targets (drag-and-drop task 003) ---
//
// Curated tree rows accept item drops (one batch move — the same
// mutation the organizer fires, `null` for the pinned Unfiled node);
// provider ("Cloud") rows are a different data domain and stay inert.

import { useDrag } from "./drag-context";
import type { DragPayload } from "../lib/drag-engine";
import { vi } from "vitest";

function mutationFetch(
  mutate: (input: RequestInfo | URL, init?: RequestInit) => Response,
) {
  return (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = String(input);
    if (url.startsWith("/api/library-folders/tree")) return jsonResponse(LIBRARY_TREE);
    if (url.startsWith("/api/folders/tree")) return jsonResponse(PROVIDER_TREE);
    return mutate(input, init);
  };
}

/** Arms a real drag through the public context surface. */
function DragSourceProbe({ payload }: { payload: DragPayload }) {
  const { beginDrag } = useDrag();
  return (
    <button
      type="button"
      data-testid="arm"
      onPointerDown={(e) => beginDrag({ x: e.clientX, y: e.clientY }, payload)}
    >
      arm
    </button>
  );
}

const PAYLOAD: DragPayload = {
  type: "items",
  items: [{ kind: "video", id: "v9" }],
};

function renderSidebarWithDrag(initialEntries: string[] = ["/"]) {
  return renderWithProviders(
    <>
      <LocationProbe />
      <DragSourceProbe payload={PAYLOAD} />
      <SidebarFolders />
    </>,
    {
      initialEntries,
      fetchImplementation: mutationFetch(() => jsonResponse({ message: "unmocked" }, 404)),
    },
  );
}

function armDrag(): void {
  fireEvent.pointerDown(screen.getByTestId("arm"), {
    clientX: 100,
    clientY: 100,
    button: 0,
  });
  fireEvent.pointerMove(window, { clientX: 120, clientY: 110 });
}

describe("SidebarFolders — drop targets", () => {
  it("a drop on a curated row fires one batch move to that folder", async () => {
    renderSidebarWithDrag();
    await screen.findByRole("treeitem", { name: /Trip/ });

    armDrag();
    fireEvent.pointerOver(selectButton(/Trip/));

    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.pointerUp(window);

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        (c) => String(c[0]) === "/api/library-folders/items",
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String((patches[0]![1] as RequestInit).body))).toEqual({
        items: [{ kind: "video", id: "v9" }],
        folder_id: "f-trip",
      });
    });
    expect(await screen.findByText("Moved to Trip")).toBeInTheDocument();
  });

  it("a drop on the pinned Unfiled row moves with folder_id null", async () => {
    renderSidebarWithDrag();
    await screen.findByRole("treeitem", { name: /Unfiled/ });

    armDrag();
    fireEvent.pointerOver(selectButton(/Unfiled/));

    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.pointerUp(window);

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        (c) => String(c[0]) === "/api/library-folders/items",
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String((patches[0]![1] as RequestInit).body))).toEqual({
        items: [{ kind: "video", id: "v9" }],
        folder_id: null,
      });
    });
  });

  it("previews the row count during hover and cancels on leave", async () => {
    renderSidebarWithDrag();
    await screen.findByRole("treeitem", { name: /Trip/ });

    armDrag();
    fireEvent.pointerOver(selectButton(/Trip/));
    expect(screen.getByText("3 → 4 items")).toBeInTheDocument();
    fireEvent.pointerOut(selectButton(/Trip/));
    expect(screen.getByText("3 items")).toBeInTheDocument();
    fireEvent.pointerUp(window);
  });

  it("provider (Cloud) rows are not drop targets", async () => {
    renderSidebarWithDrag(["/?dir="]);
    // The provider deep link auto-opens the Cloud section.
    await screen.findByRole("treeitem", { name: /Media/ });

    armDrag();
    fireEvent.pointerOver(selectButton(/Media/));

    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.pointerUp(window);

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.filter((c) => String(c[0]) === "/api/library-folders/items"),
      ).toHaveLength(0),
    );
  });
});

// --- Folder reparent drops on curated rows (drag-and-drop task 004) ---
//
// A folder payload over a curated row: legal → one reparent PATCH; the
// row inside the dragged folder's own subtree → invalid state
// (strike-through label), refused client-side with no request.

describe("SidebarFolders — folder reparent drops", () => {
  const FOLDER_PAYLOAD: DragPayload = {
    type: "folder",
    id: "f-trip",
    name: "Trip 2024",
  };

  function renderFolderDrag() {
    return renderWithProviders(
      <>
        <LocationProbe />
        <DragSourceProbe payload={FOLDER_PAYLOAD} />
        <SidebarFolders />
      </>,
      {
        initialEntries: ["/"],
        fetchImplementation: mutationFetch(() => jsonResponse({ message: "unmocked" }, 404)),
      },
    );
  }

  it("a folder drop on a legal row fires one reparent PATCH", async () => {
    renderFolderDrag();
    await screen.findByRole("treeitem", { name: /Other/ });

    fireEvent.pointerDown(screen.getByTestId("arm"), {
      clientX: 100,
      clientY: 100,
      button: 0,
    });
    fireEvent.pointerMove(window, { clientX: 120, clientY: 110 });
    fireEvent.pointerOver(selectButton(/Other/));

    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.pointerUp(window);

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        (c) => String(c[0]) === "/api/library-folders/f-trip",
      );
      expect(patches).toHaveLength(1);
      expect((patches[0]![1] as RequestInit).method).toBe("PATCH");
      expect(JSON.parse(String((patches[0]![1] as RequestInit).body))).toEqual({
        parent_id: "f-other",
      });
    });
    expect(await screen.findByText("Moved to Other")).toBeInTheDocument();
  });

  it("a folder over its own descendant row renders the invalid state and drops nothing", async () => {
    renderFolderDrag();
    await screen.findByRole("treeitem", { name: /Trip/ });

    // Reveal Day 1 (expand Trip), then drag Trip over its own child.
    fireEvent.click(
      screen.getByRole("treeitem", { name: /Trip/ }).querySelector("button")!,
    );
    await screen.findByRole("treeitem", { name: /Day 1/ });

    fireEvent.pointerDown(screen.getByTestId("arm"), {
      clientX: 100,
      clientY: 100,
      button: 0,
    });
    fireEvent.pointerMove(window, { clientX: 120, clientY: 110 });
    fireEvent.pointerOver(selectButton(/Day 1/));

    // Invalid state: strike-through on the row label, count untouched.
    expect(screen.getByText("Day 1").className).toContain("line-through");
    expect(screen.getByText("2 items")).toBeInTheDocument();

    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.pointerUp(window);

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.filter((c) => String(c[0]) === "/api/library-folders/f-trip"),
      ).toHaveLength(0),
    );
  });

  it("a folder over the Unfiled row reparents to the root (parent_id null)", async () => {
    renderFolderDrag();
    await screen.findByRole("treeitem", { name: /Unfiled/ });

    fireEvent.pointerDown(screen.getByTestId("arm"), {
      clientX: 100,
      clientY: 100,
      button: 0,
    });
    fireEvent.pointerMove(window, { clientX: 120, clientY: 110 });
    fireEvent.pointerOver(selectButton(/Unfiled/));

    const fetchSpy = vi.fn(mutationFetch(() => new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    fireEvent.pointerUp(window);

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        (c) => String(c[0]) === "/api/library-folders/f-trip",
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String((patches[0]![1] as RequestInit).body))).toEqual({
        parent_id: null,
      });
    });
  });
});
