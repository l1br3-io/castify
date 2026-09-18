// SidebarFolders tests — the app sidebar's FOLDERS section (the design's
// frame interior). Tree selection drives `?dir=`; an unknown `?dir=`
// (stale bookmark, hand-edited URL) falls back to the root listing once
// the tree loads (FR-9.2).

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SidebarFolders } from "./sidebar-folders";
import type { FolderNodeDto } from "../api/types";
import { renderWithProviders, jsonResponse } from "../test/utils";

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

function foldersFetch(tree: FolderNodeDto[] = TREE) {
  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/folders/tree")) return jsonResponse(tree);
    return jsonResponse({ message: "unmocked" }, 404);
  };
}

function renderSidebarFolders(initialEntries: string[] = ["/"]) {
  return renderWithProviders(<SidebarFolders />, {
    initialEntries,
    fetchImplementation: foldersFetch(),
  });
}

describe("SidebarFolders", () => {
  it("renders the folder tree with counts", async () => {
    renderSidebarFolders();

    expect(
      await screen.findByRole("treeitem", { name: /Media/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "Folders" })).toBeInTheDocument();
  });

  it("selecting a tree node writes the ?dir= param", async () => {
    renderSidebarFolders();
    await screen.findByRole("treeitem", { name: /Media/ });

    fireEvent.click(screen.getByRole("button", { name: "Expand Media" }));
    const moviesSelect = screen
      .getByRole("treeitem", { name: /Movies/ })
      .querySelector<HTMLButtonElement>("button[data-tree-path]")!;
    fireEvent.click(moviesSelect);

    await waitFor(() => {
      expect(
        document.querySelector<HTMLElement>("[data-tree-path='/Media/Movies']"),
      ).toHaveAttribute("aria-current");
    });
  });

  // FR-9.2: a ?dir= naming no known folder falls back to the root listing
  // once the tree loads — the tree rejects the bogus path.
  it("falls back to the root selection when ?dir= is unknown", async () => {
    renderSidebarFolders([`/?dir=${encodeURIComponent("/nope/not/a/folder")}`]);

    await waitFor(() => {
      expect(
        document.querySelector<HTMLElement>("[data-tree-path='']"),
      ).toHaveAttribute("aria-current");
    });
  });
});
