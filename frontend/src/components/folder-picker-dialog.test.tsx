// FolderPickerDialog tests — the shared folder picker behind "Move",
// extracted from ShareMoveDialog (library-folders task 006). The root
// choice label is a prop ("Share root" on share pages, "Unfiled" in the
// library organizer); everything else — depth-indented tree, subtree
// exclusion, current-scope marker, pending semantics — is frozen
// behavior from the share original.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { FolderPickerDialog } from "./folder-picker-dialog";
import { renderWithProviders } from "../test/utils";

const FOLDERS = [
  { id: "f-trip", parent_id: null, name: "Trip", position: 0 },
  { id: "f-night", parent_id: "f-trip", name: "Night", position: 0 },
  { id: "f-docs", parent_id: null, name: "Docs", position: 1 },
];

function renderPicker(overrides: Partial<Parameters<typeof FolderPickerDialog>[0]> = {}) {
  const props = {
    title: 'Move "Trip"',
    rootLabel: "Share root",
    folders: FOLDERS,
    onPick: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  renderWithProviders(<FolderPickerDialog {...props} />);
  return props;
}

describe("FolderPickerDialog", () => {
  it("offers the root choice plus every folder, children indented under parents", () => {
    renderPicker();

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

  it("renders the caller's root label (Unfiled for the library)", () => {
    renderPicker({ rootLabel: "Unfiled" });
    expect(screen.getByRole("button", { name: "Unfiled" })).toBeInTheDocument();
  });

  it("excludes the moved folder and its descendants; picking reports the target", () => {
    const props = renderPicker({ excludeSubtreeOf: "f-trip" });

    expect(screen.queryByRole("button", { name: "Trip" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Night" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Docs" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    expect(props.onPick).toHaveBeenCalledWith("f-docs");
  });

  it("picking the root choice reports null (the root scope)", () => {
    const props = renderPicker();

    fireEvent.click(screen.getByRole("button", { name: "Share root" }));
    expect(props.onPick).toHaveBeenCalledWith(null);
  });

  it("marks the current scope and disables it", () => {
    renderPicker({ currentFolderId: "f-docs" });

    const docs = screen.getByRole("button", { name: /Docs · current/ });
    expect(docs).toBeDisabled();
  });

  it("pending disables every choice", () => {
    renderPicker({ pending: true });

    expect(screen.getByRole("button", { name: "Share root" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Trip" })).toBeDisabled();
  });

  it("cancel closes without picking", () => {
    const props = renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(props.onPick).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
