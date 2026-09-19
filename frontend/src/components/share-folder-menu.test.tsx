// ShareFolderMenu tests (share-folders task 007).
//
// The folder tile's kebab: Rename / Move / Delete, one callback each,
// closing the menu on pick — same a11y contract as ShareItemMenu.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { ShareFolderMenu } from "./share-folder-menu";
import { renderWithProviders } from "../test/utils";

function renderMenu(overrides: Partial<Parameters<typeof ShareFolderMenu>[0]> = {}) {
  const props = {
    folderName: "Trip",
    onRename: vi.fn(),
    onMove: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  renderWithProviders(<ShareFolderMenu {...props} />);
  return props;
}

describe("ShareFolderMenu", () => {
  it("offers Rename, Move, and Delete, each firing its callback", () => {
    const props = renderMenu();

    fireEvent.click(screen.getByRole("button", { name: /more actions for trip/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    expect(props.onRename).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /more actions for trip/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^move$/i }));
    expect(props.onMove).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /more actions for trip/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("closes the menu after an action", () => {
    renderMenu();

    fireEvent.click(screen.getByRole("button", { name: /more actions for trip/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));

    expect(screen.queryByRole("menuitem", { name: /^move$/i })).not.toBeInTheDocument();
  });
});
