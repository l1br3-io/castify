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
