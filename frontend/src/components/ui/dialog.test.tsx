// Dialog — controlled modal (ui/README.md § Dialog): role=dialog +
// aria-modal, labelled by `title`, focus trapped inside while open, Escape
// and backdrop click close (unless closeable={false}), focus restored to
// the element that was focused before open.

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "./dialog";

function Harness({
  onClose,
  closeable,
  title = "Share cat.mp4",
}: {
  onClose?: () => void;
  closeable?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <Dialog
        open={open}
        onClose={onClose ?? (() => setOpen(false))}
        title={title}
        closeable={closeable}
      >
        <label>
          Share name
          <input />
        </label>
        <button type="button">Cancel</button>
      </Dialog>
    </div>
  );
}

describe("Dialog", () => {
  it("renders role=dialog + aria-modal, labelled by the title", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const dialog = screen.getByRole("dialog", { name: "Share cat.mp4" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("moves initial focus to the first focusable element", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Share name"));
  });

  it("traps Tab focus inside the panel", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    // Tab from the last focusable wraps to the first
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Tab",
      bubbles: true,
    });
    expect(document.activeElement).toBe(screen.getByLabelText("Share name"));
  });

  it("closes on Escape via onClose", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores focus to the previously focused element after close", () => {
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen((o) => !o)}>
            Toggle
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="D">
            <button type="button">Inside</button>
          </Dialog>
        </div>
      );
    }
    render(<Toggle />);
    // jsdom doesn't focus on click; browsers do — focus the opener the
    // way a real activation would before opening.
    const opener = screen.getByRole("button", { name: "Toggle" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on backdrop click", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps closeable={false} dialogs open on Escape and backdrop", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} closeable={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
