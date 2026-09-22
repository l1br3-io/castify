// The drag engine (drag-and-drop task 001) — a pure pointer-drag state
// machine. No DOM in here: actions in, state out. The provider
// (`drag-context.tsx`) owns the window listeners and side effects; this
// module owns the transitions every drag task builds on.
//
//   idle ──pointerDown──▶ armed ──move ≥ DRAG_THRESHOLD_PX──▶ dragging ──pointerUp/escape──▶ idle
//                          │
//                          └──pointerUp──▶ idle            (a click, not a drag)
//
// Design rules:
//   * The threshold separates click from drag — pointer positions are
//     compared with squared distance (no sqrt in a hot path).
//   * `dragging` carries no pointer position. Position is high-frequency
//     pointer data; the reducer stays referentially stable for moves
//     that don't change phase or target, so `useReducer` bails out and
//     no consumer re-renders per pixel. The ghost tracks position itself
//     (`drag-layer.tsx`).
//   * Target leaves are id-matched: a stale leave (raced with a newer
//     enter) can never clear the current target.

/** A pointer position in viewport coordinates. */
export type DragPoint = { x: number; y: number };

/** One carried item — structurally the batch-move wire type
 *  (`LibraryMoveItem`), kept local so the engine has no API imports. */
export type DragItem = { kind: "video" | "file"; id: string };

/** What the hand carries: items (single or the whole selection) or one
 *  folder being reparented. */
export type DragPayload =
  | { type: "items"; items: DragItem[] }
  | { type: "folder"; id: string; name: string };

/** Registry key for a drop target (e.g. `folder:<id>`, `unfiled`). */
export type DropTargetId = string;

export type DragState =
  | { phase: "idle" }
  | { phase: "armed"; origin: DragPoint; payload: DragPayload }
  | { phase: "dragging"; payload: DragPayload; over: DropTargetId | null };

export type DragAction =
  | { type: "pointerDown"; origin: DragPoint; payload: DragPayload }
  | { type: "pointerMove"; point: DragPoint }
  | { type: "pointerUp" }
  | { type: "escape" }
  | { type: "targetEnter"; target: DropTargetId }
  | { type: "targetLeave"; target: DropTargetId };

/** Movement required before an armed press becomes a drag — clicks and
 *  small scroll-jitter taps never start one. */
export const DRAG_THRESHOLD_PX = 6;

function distanceSq(a: DragPoint, b: DragPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function dragReducer(state: DragState, action: DragAction): DragState {
  switch (action.type) {
    case "pointerDown":
      // A press during an active drag is stray (multi-touch second
      // finger) — the first payload stands.
      if (state.phase !== "idle") return state;
      return { phase: "armed", origin: action.origin, payload: action.payload };

    case "pointerMove":
      if (state.phase === "armed") {
        const thresholdSq = DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX;
        return distanceSq(action.point, state.origin) >= thresholdSq
          ? { phase: "dragging", payload: state.payload, over: null }
          : state;
      }
      // Dragging: position is not state (see module header).
      return state;

    case "pointerUp":
      // Both armed (click) and dragging (drop or cancel) end here. Drop
      // resolution is the provider's side effect — the reducer never fires
      // handlers.
      return { phase: "idle" };

    case "escape":
      return { phase: "idle" };

    case "targetEnter":
      if (state.phase !== "dragging") return state;
      return { ...state, over: action.target };

    case "targetLeave":
      if (state.phase !== "dragging") return state;
      return state.over === action.target ? { ...state, over: null } : state;
  }
}

/**
 * The selection carry rule: grabbing a card that is part of the current
 * selection carries the whole selection (in selection order); grabbing
 * an unselected card carries just that card.
 */
export function carryPayload(
  grabbed: DragItem,
  selection?: readonly DragItem[],
): { type: "items"; items: DragItem[] } {
  const inSelection = selection?.some(
    (item) => item.id === grabbed.id && item.kind === grabbed.kind,
  );
  return {
    type: "items",
    items: inSelection && selection ? [...selection] : [grabbed],
  };
}

/** Noun with the mono plural: `1 VIDEO`, `3 FILES`. */
function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "S"}`;
}

/**
 * The manifest chip's copy — the data voice. Items payloads summarize
 * their kind mix (`2 VIDEOS + 1 FILE`); a folder payload names itself
 * (`FOLDER — TRIP 2024`).
 */
export function manifestLabel(payload: DragPayload): string {
  if (payload.type === "folder") {
    return `FOLDER — ${payload.name.toUpperCase()}`;
  }
  const videos = payload.items.filter((item) => item.kind === "video").length;
  const files = payload.items.length - videos;
  if (videos > 0 && files > 0) {
    return `${countLabel(videos, "VIDEO")} + ${countLabel(files, "FILE")}`;
  }
  return videos > 0 ? countLabel(videos, "VIDEO") : countLabel(files, "FILE");
}
