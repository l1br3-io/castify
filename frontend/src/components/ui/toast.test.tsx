// ToastProvider/useToast tests (share-manage-page task 001).
//
// The undo toast needed three additive capabilities on the existing
// system: an action button, a per-push TTL override, and programmatic
// dismissal via a returned id. These tests pin all three plus the
// unchanged defaults (success/info 4s auto-dismiss, error sticky).
//
// The harness renders buttons that drive the real `useToast()` api the
// way production code does — no context faking, no implementation access.

import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";

import { useToast } from "../../hooks/use-toast";
import { renderWithProviders } from "../../test/utils";

// The id of the most recent push, captured by the harness so a test can
// drive `dismiss(id)` through the same code path production uses.
let lastId: number | null = null;
const undoSpy = vi.fn();

function ToastHarness() {
  const toast = useToast();
  return (
    <div>
      <button type="button" onClick={() => (lastId = toast.success("Saved"))}>
        push-success
      </button>
      <button
        type="button"
        onClick={() =>
          (lastId = toast.info("Removed 'cat.mp4'", {
            ttlMs: 6000,
            action: { label: "Undo", onAction: undoSpy },
          }))
        }
      >
        push-info-undo
      </button>
      <button type="button" onClick={() => (lastId = toast.error("boom"))}>
        push-error
      </button>
      <button
        type="button"
        onClick={() => {
          if (lastId !== null) toast.dismiss(lastId);
        }}
      >
        dismiss-last
      </button>
    </div>
  );
}

function setup() {
  lastId = null;
  undoSpy.mockClear();
  return renderWithProviders(<ToastHarness />);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastProvider", () => {
  it("renders an action button whose click invokes onAction and dismisses the toast", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "push-info-undo" }));

    expect(screen.getByText("Removed 'cat.mp4'")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Removed 'cat.mp4'")).not.toBeInTheDocument();
  });

  it("keeps an action toast alive at 4s and auto-dismisses it at the custom 6s ttl", () => {
    vi.useFakeTimers();
    setup();
    fireEvent.click(screen.getByRole("button", { name: "push-info-undo" }));

    act(() => vi.advanceTimersByTime(4000));
    expect(screen.getByText("Removed 'cat.mp4'")).toBeInTheDocument();
    // Undo dies with the toast — the window is the ttl.
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByText("Removed 'cat.mp4'")).not.toBeInTheDocument();
  });

  it("exposes push-returned ids and dismiss(id) removes only that toast", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "push-success" }));
    const successId = lastId;
    fireEvent.click(screen.getByRole("button", { name: "push-error" }));
    const errorId = lastId;

    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(successId).not.toBe(errorId);

    const dismissButton = screen.getByRole("button", { name: "dismiss-last" });
    // dismiss-last fires on the error id (most recent push).
    fireEvent.click(dismissButton);
    expect(screen.queryByText("boom")).not.toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("keeps the default 4s auto-dismiss for success and sticky errors", () => {
    vi.useFakeTimers();
    setup();
    fireEvent.click(screen.getByRole("button", { name: "push-success" }));
    fireEvent.click(screen.getByRole("button", { name: "push-error" }));

    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    // error is sticky — still up long after any ttl.
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("preserves status/alert roles by variant", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "push-info-undo" }));
    fireEvent.click(screen.getByRole("button", { name: "push-error" }));

    expect(screen.getByRole("status")).toHaveTextContent("Removed 'cat.mp4'");
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
  });
});
