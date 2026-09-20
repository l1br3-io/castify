// FolderTile tests — the shared folder half of the browse grid,
// extracted from ShareFolderTile (library-folders task 006). One grid
// cell: folder glyph, name, child count, stretched link appending
// `?<searchParam>=<folderId>` — the accessibility contract mirrors
// PosterCard's stretched link (keyboard-focusable, descriptive label).

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { FolderTile } from "./folder-tile";
import { renderWithProviders } from "../test/utils";

function renderTile(count: number) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/share/:token"
        element={
          <FolderTile name="Trip" folderId="f1" to="/share/tok_abc" count={count} />
        }
      />
    </Routes>,
    { initialEntries: ["/share/tok_abc"] },
  );
}

describe("FolderTile", () => {
  it("links to the same route with the folder id in the search param", () => {
    renderTile(3);
    const link = screen.getByRole("link", { name: "Open folder Trip" });
    expect(link.getAttribute("href")).toBe("/share/tok_abc?folder=f1");
  });

  it("honors a custom search param name", () => {
    renderWithProviders(
      <Routes>
        <Route
          path="/lib"
          element={
            <FolderTile
              name="Trip"
              folderId="f1"
              to="/lib"
              searchParam="dest"
              count={1}
            />
          }
        />
      </Routes>,
      { initialEntries: ["/lib"] },
    );
    expect(screen.getByRole("link", { name: "Open folder Trip" }).getAttribute("href")).toBe(
      "/lib?dest=f1",
    );
  });

  it("shows the folder name and child count", () => {
    renderTile(3);
    expect(screen.getByText("Trip")).toBeInTheDocument();
    expect(screen.getByText("3 items")).toBeInTheDocument();
  });

  it("singularizes the count for one child", () => {
    renderTile(1);
    expect(screen.getByText("1 item")).toBeInTheDocument();
  });
});
