// Menu — WAI-ARIA APG menu pattern (ui/README.md § Menu): trigger announces
// haspopup/expanded, opening moves focus to the first item, arrows cycle,
// Escape closes and restores focus to the trigger, click-outside dismisses.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Menu, MenuItem } from "./menu";

function renderMenu(onSelect: () => void = () => {}) {
  return render(
    <div>
      <button type="button">outside</button>
      <Menu label="Actions for cat.mp4">
        <MenuItem onSelect={onSelect}>Open</MenuItem>
        <MenuItem onSelect={onSelect}>Remove from share</MenuItem>
      </Menu>
    </div>,
  );
}

describe("Menu", () => {
  it("announces the trigger with haspopup/expanded and opens on click", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Actions for cat.mp4" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Actions for cat.mp4" })).toBeInTheDocument();
  });

  it("caps the panel at the viewport width so long items wrap, not overflow", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Actions for cat.mp4" }));
    // min-w keeps the panel readable; the max-w cap keeps it on-screen
    // at phone widths even with long item labels (items wrap inside).
    expect(screen.getByRole("menu", { name: "Actions for cat.mp4" })).toHaveClass(
      "max-w-[calc(100vw-2rem)]",
    );
  });

  it("moves focus to the first item on open", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Actions for cat.mp4" }));
    expect(document.activeElement).toHaveTextContent("Open");
  });

  it("cycles focus with ArrowDown/ArrowUp, wrapping at the ends", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Actions for cat.mp4" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    // open landed on "Open"
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toHaveTextContent("Remove from share");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toHaveTextContent("Open"); // wrapped
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toHaveTextContent("Remove from share");
    void trigger;
  });

  it("closes on Escape and restores focus to the trigger", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Actions for cat.mp4" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on click outside", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Actions for cat.mp4" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("runs the item's onSelect and closes", () => {
    const onSelect = vi.fn();
    renderMenu(onSelect);
    fireEvent.click(screen.getByRole("button", { name: "Actions for cat.mp4" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from share" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("marks disabled items and skips them in arrow navigation", () => {
    render(
      <Menu label="Actions">
        <MenuItem onSelect={() => {}} disabled>
          Remove from share
        </MenuItem>
        <MenuItem onSelect={() => {}}>Open</MenuItem>
      </Menu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const disabled = screen.getByRole("menuitem", { name: "Remove from share" });
    expect(disabled).toBeDisabled();
    // open focused first *enabled* item ("Open"), not the disabled one
    expect(document.activeElement).toHaveTextContent("Open");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(document.activeElement).toHaveTextContent("Open");
  });
});
