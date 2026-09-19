// ShareFolderTile tests (share-folders task 005).
//
// The tile is the folder half of the browse grid: one grid cell, a
// folder glyph, the name, the child count, and a stretched link to the
// same route with `?folder=<id>` — the accessibility contract mirrors
// PosterCard's stretched link (keyboard-focusable, descriptive label).

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { ShareFolderTile } from "./share-folder-tile";
import { renderWithProviders } from "../test/utils";
import type { ShareFolderDto } from "../api/types";

const folder: ShareFolderDto = {
  id: "f1",
  parent_id: null,
  name: "Trip",
  position: 0,
};

function renderTile(count: number) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/share/:token"
        element={<ShareFolderTile folder={folder} to="/share/tok_abc" count={count} />}
      />
    </Routes>,
    { initialEntries: ["/share/tok_abc"] },
  );
}

describe("ShareFolderTile", () => {
  it("links to the same route with the folder id in the search param", () => {
    renderTile(3);
    const link = screen.getByRole("link", { name: "Open folder Trip" });
    expect(link.getAttribute("href")).toBe("/share/tok_abc?folder=f1");
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
