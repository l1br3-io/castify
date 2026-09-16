// Tooltip — shows on hover AND keyboard focus, hides on blur/Escape, and
// is disabled entirely on hover-less (touch) pointers via CSS
// (ui/README.md § Tooltip). The canonical use: explaining a disabled
// action (trigger rendered with aria-disabled, not disabled, so it stays
// focusable and the reason is reachable).

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Tooltip } from "./tooltip";

describe("Tooltip", () => {
  it("shows on hover and wires aria-describedby", () => {
    render(
      <Tooltip content="Connect the provider first">
        <button type="button" aria-disabled>
          Remove
        </button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Remove" });
    fireEvent.mouseEnter(trigger);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Connect the provider first");
    expect(trigger.getAttribute("aria-describedby")).toBe(tip.id);
  });

  it("shows on keyboard focus", () => {
    render(
      <Tooltip content="Connect the provider first">
        <button type="button">Remove</button>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("hides on blur", () => {
    render(
      <Tooltip content="Reason">
        <button type="button">Remove</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button");
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.blur(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("hides on Escape while focused", () => {
    render(
      <Tooltip content="Reason">
        <button type="button">Remove</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button");
    fireEvent.focus(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("hides on mouse leave", () => {
    render(
      <Tooltip content="Reason">
        <button type="button">Remove</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button");
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("renders nothing on hover-less (touch) pointers", () => {
    render(
      <Tooltip content="Reason">
        <button type="button">Remove</button>
      </Tooltip>,
    );
    // The bubble carries the hover-none guard class — on touch-only
    // pointers CSS removes it regardless of component state.
    const trigger = screen.getByRole("button");
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("tooltip").className).toContain("[@media(hover:none)]:hidden");
  });
});
