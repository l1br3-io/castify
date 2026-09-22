import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ViewToggle } from "./view-toggle";

// ViewToggle (library-list-view task 002): a two-segment keycap control.
// Controlled component — mode + onModeChange; surfaces wire it to
// useViewMode. Icon-only segments carry aria-labels; aria-pressed marks
// the active one.

function renderToggle(mode: "grid" | "list", onModeChange = vi.fn()) {
  render(<ViewToggle mode={mode} onModeChange={onModeChange} />);
  return {
    grid: screen.getByRole("button", { name: "Grid view" }),
    list: screen.getByRole("button", { name: "List view" }),
    onModeChange,
  };
}

describe("ViewToggle", () => {
  it("renders both segments with accessible names", () => {
    const { grid, list } = renderToggle("grid");
    expect(grid).toBeInTheDocument();
    expect(list).toBeInTheDocument();
  });

  it("marks the active segment via aria-pressed", () => {
    const { grid, list } = renderToggle("list");
    expect(list).toHaveAttribute("aria-pressed", "true");
    expect(grid).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking the inactive segment reports that mode", () => {
    const { list, onModeChange } = renderToggle("grid");
    fireEvent.click(list);
    expect(onModeChange).toHaveBeenCalledWith("list");
  });

  it("clicking the active segment is a no-op", () => {
    const { grid, onModeChange } = renderToggle("grid");
    fireEvent.click(grid);
    expect(onModeChange).not.toHaveBeenCalled();
  });
});
