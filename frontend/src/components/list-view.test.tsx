import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ListView, type ListViewRow } from "./list-view";

// ListView (library-list-view task 003): the shared slate-row table.
// Contract under test: row model → semantic table, sortable headers only
// where a sortKey exists (the organizer passes none), the name cell is the
// real link (keyboard path), selection swaps in a checkbox and hides
// action slots, and column metadata (mono/numeric/className) shapes the
// ledger treatment. The name link is a router Link (queue state) — tests
// wrap in MemoryRouter.

function renderView(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function makeRow(overrides: Partial<ListViewRow> = {}): ListViewRow {
  return {
    id: "v1",
    name: "Concert tape.mov",
    href: "/watch/v1",
    columns: [
      { key: "duration", label: "Duration", value: "12:34", mono: true },
      {
        key: "size",
        label: "Size",
        value: "8.2 GB",
        mono: true,
        numeric: true,
        className: "hidden lg:table-cell",
      },
    ],
    ...overrides,
  };
}

describe("ListView", () => {
  it("renders each row's name as a link and its column values", () => {
    renderView(<ListView rows={[makeRow()]} ariaLabel="Videos" />);
    const link = screen.getByRole("link", { name: "Concert tape.mov" });
    expect(link).toHaveAttribute("href", "/watch/v1");
    expect(screen.getByText("12:34")).toBeInTheDocument();
    expect(screen.getByText("8.2 GB")).toBeInTheDocument();
  });

  it("renders column headers display-only when no sort is passed", () => {
    renderView(<ListView rows={[makeRow()]} ariaLabel="Videos" />);
    // Organizer case: plain <th>s, no buttons anywhere in the header.
    expect(screen.queryByRole("button", { name: /name|duration/i })).toBeNull();
    expect(
      screen.getByRole("columnheader", { name: "Duration" }),
    ).toBeInTheDocument();
  });

  it("sortable headers fire onSort and carry aria-sort on the active column", () => {
    const onSort = vi.fn();
    renderView(
      <ListView
        rows={[makeRow({
          columns: [{ key: "size", label: "Size", value: "8.2 GB", sortKey: "size-asc" }],
        })]}
        ariaLabel="Videos"
        nameSortKey="name"
        sort={{ activeKey: "name", direction: "asc", onSort }}
      />,
    );
    // Name header (via nameSortKey) is the active ascending column.
    expect(screen.getByRole("columnheader", { name: /^Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(onSort).toHaveBeenCalledWith("name");

    // A column with a sortKey is a button header; without one stays plain.
    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    expect(onSort).toHaveBeenCalledWith("size-asc");
  });

  it("reflects descending aria-sort on the active data column", () => {
    renderView(
      <ListView
        rows={[makeRow({
          columns: [{ key: "size", label: "Size", value: "8.2 GB", sortKey: "size" }],
        })]}
        ariaLabel="Videos"
        sort={{ activeKey: "size", direction: "desc", onSort: () => {} }}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Size" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("selection mode swaps the leading cell to a checkbox and hides action slots", () => {
    const onToggle = vi.fn();
    renderView(
      <ListView
        rows={[makeRow({
          menuSlot: <button type="button">Menu</button>,
          favoriteSlot: <button type="button">Fav</button>,
        })]}
        ariaLabel="Videos"
        selection={{ isSelected: () => true, onToggle }}
      />,
    );
    const checkbox = screen.getByRole("checkbox", {
      name: "Select Concert tape.mov",
    });
    expect(checkbox).toBeChecked();
    expect(screen.queryByText("Menu")).toBeNull();
    expect(screen.queryByText("Fav")).toBeNull();

    // Checkbox and row click each toggle exactly once.
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Concert tape.mov"));
    expect(onToggle).toHaveBeenCalledTimes(2);
    // No navigation in select mode — the name renders without a link.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders a kind icon frame when the row has no thumbnail", () => {
    renderView(
      <ListView
        rows={[makeRow({
          id: "f1",
          name: "notes.txt",
          href: undefined,
          kindIcon: <span data-testid="doc-icon" />,
          columns: [],
        })]}
        ariaLabel="Files"
      />,
    );
    expect(screen.getByTestId("doc-icon")).toBeInTheDocument();
    // No href → no link; the name renders as plain text.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("marks the current-location row with aria-current", () => {
    renderView(
      <ListView
        rows={[makeRow({ name: "Unfiled", href: undefined, current: true, columns: [] })]}
        ariaLabel="Folders"
      />,
    );
    expect(screen.getByText("Unfiled")).toHaveAttribute("aria-current", "page");
  });

  it("applies column className to both the header and body cells", () => {
    renderView(
      <ListView
        rows={[makeRow({
          columns: [{ key: "size", label: "Size", value: "8.2 GB", className: "hidden lg:table-cell" }],
        })]}
        ariaLabel="Videos"
      />,
    );
    expect(
      screen.getByRole("columnheader", { name: "Size" }).className,
    ).toContain("hidden");
    expect(screen.getByText("8.2 GB").closest("td")?.className).toContain("hidden");
  });

  it("labels the table for screen readers", () => {
    renderView(<ListView rows={[makeRow()]} ariaLabel="All videos" />);
    expect(
      screen.getByRole("table", { name: "All videos" }),
    ).toBeInTheDocument();
  });
});
