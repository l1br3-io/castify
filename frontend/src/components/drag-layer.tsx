// DragLayer (drag-and-drop task 001) — the portal ghost. While a drag
// is live it renders the manifest chip: a small raised pill in the mono
// data voice (`2 VIDEOS + 1 FILE`, `FOLDER — TRIP 2024`) following the
// pointer offset. The deliberate signature object of the interaction —
// not a translucent card clone.
//
// Position is this component's own state, seeded from the provider's
// last-seen pointer: the chip re-renders per move, nothing else does
// (the engine keeps positions out of its state for exactly this
// reason). Portaled to the body so no ancestor overflow or stacking
// context can clip it.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useDrag } from "./drag-context";
import { manifestLabel, type DragPoint } from "../lib/drag-engine";

/** The chip's standoff from the pointer — it rides beside the hand,
 *  never under it (the cursor must stay readable). */
const CURSOR_OFFSET_PX = 12;

export function DragLayer() {
  const { state, pointRef } = useDrag();
  const dragging = state.phase === "dragging";
  const [point, setPoint] = useState<DragPoint | null>(null);

  useEffect(() => {
    if (!dragging) {
      setPoint(null);
      return;
    }
    // Seed from the threshold-crossing position the provider already
    // saw — the chip mounts exactly where the drag began, then follows.
    setPoint(pointRef.current);
    const onPointerMove = (event: PointerEvent): void => {
      setPoint({ x: event.clientX, y: event.clientY });
    };
    window.addEventListener("pointermove", onPointerMove);
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [dragging, pointRef]);

  if (state.phase !== "dragging" || point === null) return null;

  return createPortal(
    <div
      data-testid="drag-layer"
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-50"
      style={{
        transform: `translate(${point.x + CURSOR_OFFSET_PX}px, ${
          point.y + CURSOR_OFFSET_PX
        }px)`,
      }}
    >
      <span
        data-testid="drag-manifest"
        className="inline-block whitespace-nowrap rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface-raised)] px-2.5 py-1 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--color-castify-text)] shadow-[var(--shadow-md)]"
      >
        {manifestLabel(state.payload)}
      </span>
    </div>,
    document.body,
  );
}
