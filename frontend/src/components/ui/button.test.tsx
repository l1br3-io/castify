// Button primitive — state matrix contract (ui/README.md § Button).
// Variants are asserted by their token-based marker classes because the
// class list IS the contract here; behavior is asserted through the DOM.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button";

describe("Button", () => {
  it("renders a button with its accessible name", () => {
    render(<Button>Save changes</Button>);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("fires onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each([
    ["primary", "bg-[var(--color-castify-accent)]"],
    ["secondary", "border-[var(--color-castify-rule)]"],
    ["ghost", "text-[var(--color-castify-muted)]"],
    ["destructive", "text-[var(--color-danger)]"],
  ] as const)("%s variant carries its token styling", (variant, marker) => {
    render(<Button variant={variant}>Go</Button>);
    expect(screen.getByRole("button").className).toContain(marker);
  });

  it("defaults to the primary variant", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button").className).toContain(
      "bg-[var(--color-castify-accent)]",
    );
  });

  it("marks pending state with aria-busy and disables the button", () => {
    render(<Button pending>Saving</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
  });

  it("renders the disabled state without removing it from the a11y tree", () => {
    render(<Button disabled>Locked</Button>);
    const button = screen.getByRole("button", { name: "Locked" });
    expect(button).toBeDisabled();
    expect(button.className).toContain("disabled:opacity-50");
  });

  it("styles a visible keyboard focus (no pointer-only states)", () => {
    render(<Button>Focusable</Button>);
    const className = screen.getByRole("button").className;
    expect(className).toContain("focus-visible:ring-2");
    expect(className).toContain("focus-visible:ring-[var(--color-focus)]");
  });

  it("merges caller classes with the primitive's own", () => {
    render(<Button className="w-full">Wide</Button>);
    expect(screen.getByRole("button").className).toContain("w-full");
  });
});
