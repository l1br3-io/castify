// ShareMoveDialog tests (share-folders task 007).
//
// The shared folder picker behind "Move" (folders in task 7, items in
// task 8): a "Share root" choice plus the folder tree indented by depth,
// with the moved folder's own subtree unpickable (client-side pre-check;
// the server's cycle/depth walk is the backstop).

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { ShareMoveDialog } from "./share-move-dialog";
import { renderWithProviders } from "../test/utils";
import type { ShareFolderDto } from "../api/types";

const FOLDERS: ShareFolderDto[] = [
  { id: "f-trip", parent_id: null, name: "Trip", position: 0 },
  { id: "f-night", parent_id: "f-trip", name: "Night", position: 0 },
  { id: "f-docs", parent_id: null, name: "Docs", position: 1 },
];

function renderMoveDialog(overrides: Partial<Parameters<typeof ShareMoveDialog>[0]> = {}) {
  const props = {
    title: 'Move "Trip"',
    folders: FOLDERS,
    onPick: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  renderWithProviders(<ShareMoveDialog {...props} />);
  return props;
}

describe("ShareMoveDialog", () => {
  it("offers Share root plus every folder, children indented under parents", () => {
    renderMoveDialog();

    expect(screen.getByRole("dialog", { name: /move "trip"/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share root" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Docs" })).toBeInTheDocument();

    // Night nests under Trip: rendered after it, indented one level
    // deeper than its parent.
    const trip = screen.getByRole("button", { name: "Trip" });
    const night = screen.getByRole("button", { name: "Night" });
    expect(
      trip.compareDocumentPosition(night) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(Number.parseFloat(night.style.paddingLeft)).toBeGreaterThan(
      Number.parseFloat(trip.style.paddingLeft),
    );
  });

  it("excludes the moved folder and its descendants; picking reports the target", () => {
    const props = renderMoveDialog({ excludeSubtreeOf: "f-trip" });

    expect(screen.queryByRole("button", { name: "Trip" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Night" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Docs" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    expect(props.onPick).toHaveBeenCalledWith("f-docs");
  });

  it("picking Share root reports null (the root scope)", () => {
    const props = renderMoveDialog();

    fireEvent.click(screen.getByRole("button", { name: "Share root" }));
    expect(props.onPick).toHaveBeenCalledWith(null);
  });

  it("cancel closes without picking", () => {
    const props = renderMoveDialog();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(props.onPick).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
