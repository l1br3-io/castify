// DragLayer tests (drag-and-drop task 001) — the portal ghost. The
// manifest chip is the interaction's one signature object: mono data
// voice, raised surface, cursor-offset position, mounted only while a
// drag is live.
//
// The probe component drives the context through its public surface
// (`beginDrag`) exactly like a real card would; window-level pointer
// events carry the drag, matching the provider's own listeners.

import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { DragLayer } from "./drag-layer";
import { DragProvider, useDrag } from "./drag-context";
import { renderWithProviders } from "../test/utils";
import type { DragPayload } from "../lib/drag-engine";

/** A stand-in card source: arms the engine on pointer down. */
function DragProbe({ payload }: { payload: DragPayload }) {
  const { beginDrag } = useDrag();
  return (
    <button
      type="button"
      onPointerDown={(e) => beginDrag({ x: e.clientX, y: e.clientY }, payload)}
    >
      grab
    </button>
  );
}

function renderDragScene(payload: DragPayload) {
  return renderWithProviders(
    <DragProvider>
      <DragProbe payload={payload} />
      <DragLayer />
    </DragProvider>,
  );
}

/** Pointer down at (100, 100) + the threshold-crossing move (106, 100). */
function startDrag(): void {
  fireEvent.pointerDown(screen.getByText("grab"), {
    clientX: 100,
    clientY: 100,
    button: 0,
  });
  fireEvent.pointerMove(window, { clientX: 106, clientY: 100 });
}

describe("DragLayer", () => {
  it("renders nothing while idle", () => {
    renderDragScene({ type: "items", items: [{ kind: "video", id: "v1" }] });
    expect(screen.queryByTestId("drag-manifest")).not.toBeInTheDocument();
  });

  it("renders nothing below the hold threshold — a click is not a drag", () => {
    renderDragScene({ type: "items", items: [{ kind: "video", id: "v1" }] });
    fireEvent.pointerDown(screen.getByText("grab"), {
      clientX: 100,
      clientY: 100,
      button: 0,
    });
    fireEvent.pointerMove(window, { clientX: 104, clientY: 100 });
    expect(screen.queryByTestId("drag-manifest")).not.toBeInTheDocument();
  });

  it("shows the manifest chip for a single item once dragging", () => {
    renderDragScene({ type: "items", items: [{ kind: "video", id: "v1" }] });
    startDrag();
    expect(screen.getByTestId("drag-manifest")).toHaveTextContent("1 VIDEO");
  });

  it("summarizes a mixed selection on the chip", () => {
    renderDragScene({
      type: "items",
      items: [
        { kind: "video", id: "v1" },
        { kind: "video", id: "v2" },
        { kind: "file", id: "f1" },
      ],
    });
    startDrag();
    expect(screen.getByTestId("drag-manifest")).toHaveTextContent("2 VIDEOS + 1 FILE");
  });

  it("names a folder payload on the chip", () => {
    renderDragScene({ type: "folder", id: "folder-1", name: "Trip 2024" });
    startDrag();
    expect(screen.getByTestId("drag-manifest")).toHaveTextContent("FOLDER — TRIP 2024");
  });

  it("ports the chip to the document body, outside the route tree", () => {
    const { container } = renderDragScene({
      type: "items",
      items: [{ kind: "file", id: "f1" }],
    });
    startDrag();
    const chip = screen.getByTestId("drag-manifest");
    expect(document.body).toContainElement(chip);
    expect(container).not.toContainElement(chip);
  });

  it("positions the chip at the pointer offset and follows it", () => {
    renderDragScene({ type: "items", items: [{ kind: "video", id: "v1" }] });
    startDrag();
    const layer = screen.getByTestId("drag-layer");
    // Seeded from the threshold-crossing move (106, 100) + the 12px offset.
    expect(layer.style.transform).toBe("translate(118px, 112px)");
    fireEvent.pointerMove(window, { clientX: 300, clientY: 200 });
    expect(layer.style.transform).toBe("translate(312px, 212px)");
  });

  it("unmounts the chip on pointer up (no target — cancelled)", () => {
    renderDragScene({ type: "items", items: [{ kind: "video", id: "v1" }] });
    startDrag();
    fireEvent.pointerUp(window);
    expect(screen.queryByTestId("drag-manifest")).not.toBeInTheDocument();
  });

  it("unmounts the chip on Escape", () => {
    renderDragScene({ type: "items", items: [{ kind: "video", id: "v1" }] });
    startDrag();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("drag-manifest")).not.toBeInTheDocument();
  });
});
