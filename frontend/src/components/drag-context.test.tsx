// DragContext tests (drag-and-drop task 001) — the provider's public
// contract: window-level pointer plumbing, the drop-target registry,
// and drop resolution on `endDrag`. The reducer's own transitions are
// pinned in `lib/drag-engine.test.ts`; these tests cover the wiring
// around it.
//
//   * threshold + pointer up → idle, no drop (click passthrough);
//   * drag → hoverTarget → endDrag fires the hovered target's onDrop
//     with the exact payload, exactly once;
//   * canDrop=false (or an unregistered id) never becomes the drop
//     target — invalid-target rejection;
//   * Escape cancels; a later endDrag is a no-op.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { DragProvider, useDrag } from "./drag-context";
import type { DragPayload } from "../lib/drag-engine";
import { renderWithProviders } from "../test/utils";

const PAYLOAD: DragPayload = {
  type: "items",
  items: [
    { kind: "video", id: "v1" },
    { kind: "file", id: "f1" },
  ],
};

/** Drives the context through its full public surface. */
function DragProbe({
  payload,
  hover,
}: {
  payload: DragPayload;
  hover: string | null;
}) {
  const { beginDrag, hoverTarget } = useDrag();
  return (
    <>
      <button
        type="button"
        data-testid="grab"
        onPointerDown={(e) => beginDrag({ x: e.clientX, y: e.clientY }, payload)}
      />
      <button type="button" data-testid="hover" onClick={() => hoverTarget(hover)}>
        hover
      </button>
    </>
  );
}

/** Arms + crosses the threshold — the drag is live. */
function startDrag(): void {
  fireEvent.pointerDown(screen.getByTestId("grab"), {
    clientX: 100,
    clientY: 100,
    button: 0,
  });
  fireEvent.pointerMove(window, { clientX: 110, clientY: 100 });
}

describe("DragContext drop resolution", () => {
  it("fires the hovered target's onDrop once with the exact payload", () => {
    const onDrop = vi.fn();
    function DropTargetProbe() {
      const { registerTarget } = useDrag();
      registerTarget("folder-1", { onDrop });
      return null;
    }
    renderWithProviders(
      <DragProvider>
        <DropTargetProbe />
        <DragProbe payload={PAYLOAD} hover="folder-1" />
      </DragProvider>,
    );
    startDrag();
    fireEvent.click(screen.getByTestId("hover"));
    fireEvent.pointerUp(window);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(PAYLOAD);
  });

  it("does not drop when the pointer never crossed the threshold", () => {
    const onDrop = vi.fn();
    function DropTargetProbe() {
      const { registerTarget } = useDrag();
      registerTarget("folder-1", { onDrop });
      return null;
    }
    renderWithProviders(
      <DragProvider>
        <DropTargetProbe />
        <DragProbe payload={PAYLOAD} hover="folder-1" />
      </DragProvider>,
    );
    fireEvent.pointerDown(screen.getByTestId("grab"), {
      clientX: 100,
      clientY: 100,
      button: 0,
    });
    fireEvent.pointerMove(window, { clientX: 103, clientY: 100 });
    fireEvent.pointerUp(window);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("rejects a target whose canDrop returns false — no drop fires", () => {
    const onDrop = vi.fn();
    function InvalidTargetProbe() {
      const { registerTarget } = useDrag();
      registerTarget("folder-1", { canDrop: () => false, onDrop });
      return null;
    }
    renderWithProviders(
      <DragProvider>
        <InvalidTargetProbe />
        <DragProbe payload={PAYLOAD} hover="folder-1" />
      </DragProvider>,
    );
    startDrag();
    fireEvent.click(screen.getByTestId("hover"));
    fireEvent.pointerUp(window);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("treats an unregistered target id as invalid", () => {
    const onDrop = vi.fn();
    function DropTargetProbe() {
      const { registerTarget } = useDrag();
      registerTarget("folder-1", { onDrop });
      return null;
    }
    renderWithProviders(
      <DragProvider>
        <DropTargetProbe />
        <DragProbe payload={PAYLOAD} hover="folder-unknown" />
      </DragProvider>,
    );
    startDrag();
    fireEvent.click(screen.getByTestId("hover"));
    fireEvent.pointerUp(window);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("Escape cancels the drag; the later pointer up drops nothing", () => {
    const onDrop = vi.fn();
    function DropTargetProbe() {
      const { registerTarget } = useDrag();
      registerTarget("folder-1", { onDrop });
      return null;
    }
    renderWithProviders(
      <DragProvider>
        <DropTargetProbe />
        <DragProbe payload={PAYLOAD} hover="folder-1" />
      </DragProvider>,
    );
    startDrag();
    fireEvent.click(screen.getByTestId("hover"));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("clears the hovered target on hoverTarget(null)", () => {
    const onDrop = vi.fn();
    function HoverNullProbe() {
      const { registerTarget, hoverTarget } = useDrag();
      registerTarget("folder-1", { onDrop });
      return (
        <button
          type="button"
          data-testid="hover-null"
          onClick={() => hoverTarget(null)}
        />
      );
    }
    renderWithProviders(
      <DragProvider>
        <HoverNullProbe />
        <DragProbe payload={PAYLOAD} hover="folder-1" />
      </DragProvider>,
    );
    startDrag();
    fireEvent.click(screen.getByTestId("hover"));
    fireEvent.click(screen.getByTestId("hover-null"));
    fireEvent.pointerUp(window);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
