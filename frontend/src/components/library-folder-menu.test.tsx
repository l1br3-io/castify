// LibraryFolderMenu tests (library-folders task 008) — the curated
// folder tile's kebab. Only the actions the caller provides render;
// picking one closes the menu and fires the callback. The Unfiled tile
// carries just New folder; folder tiles carry Rename/Move/Delete.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LibraryFolderMenu } from "./library-folder-menu";
import { renderWithProviders } from "../test/utils";

describe("LibraryFolderMenu", () => {
  it("renders Rename / Move / Delete for a folder tile and fires the callback", () => {
    const onRename = vi.fn();
    const onMove = vi.fn();
    const onDelete = vi.fn();
    renderWithProviders(
      <LibraryFolderMenu
        label="Trip"
        onRename={onRename}
        onMove={onMove}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "More actions for Trip" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    expect(onRename).toHaveBeenCalledTimes(1);
    // Menu closed on pick — the other items are gone.
    expect(screen.queryByRole("menuitem", { name: "Move" })).not.toBeInTheDocument();
    expect(onMove).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("renders only the provided actions (Unfiled: New folder)", () => {
    const onNewFolder = vi.fn();
    renderWithProviders(
      <LibraryFolderMenu label="Unfiled" onNewFolder={onNewFolder} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "More actions for Unfiled" }));
    expect(screen.getByRole("menuitem", { name: "New folder" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "New folder" }));
    expect(onNewFolder).toHaveBeenCalledTimes(1);
  });
});
