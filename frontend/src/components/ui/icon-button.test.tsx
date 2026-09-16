// IconButton primitive — accessible name is required (a bare icon button
// is an a11y bug), target ≥ 24×24 CSS px, keyboard focus visible.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IconButton } from "./icon-button";

describe("IconButton", () => {
  it("names the button via the required label prop", () => {
    render(<IconButton label="Play video">▶</IconButton>);
    expect(screen.getByRole("button", { name: "Play video" })).toBeInTheDocument();
  });

  it("keeps the icon content aria-hidden so the label is the single name", () => {
    render(<IconButton label="Play video">▶</IconButton>);
    const button = screen.getByRole("button", { name: "Play video" });
    expect(button.firstChild).toHaveAttribute("aria-hidden", "true");
  });

  it("meets the ≥24px target floor", () => {
    render(<IconButton label="Play">▶</IconButton>);
    // size-9 = 36px — comfortably above the 24px minimum.
    expect(screen.getByRole("button").className).toContain("size-9");
  });

  it("fires onClick", () => {
    const onClick = vi.fn();
    render(
      <IconButton label="Close" onClick={onClick}>
        ✕
      </IconButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("marks pending state with aria-busy and disables", () => {
    render(
      <IconButton label="Saving" pending>
        ★
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Saving" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
  });

  it("styles a visible keyboard focus", () => {
    render(<IconButton label="Play">▶</IconButton>);
    const className = screen.getByRole("button").className;
    expect(className).toContain("focus-visible:ring-2");
    expect(className).toContain("focus-visible:ring-[var(--color-focus)]");
  });
});
