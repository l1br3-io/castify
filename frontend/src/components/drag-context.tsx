// DragContext (drag-and-drop task 001) — the provider that owns the
// active drag. It wires the pure engine (`lib/drag-engine.ts`) to the
// window, keeps a drop-target registry, and resolves drops on
// `endDrag()`. Drag state is React state, never URL, never server.
//
// Split of concerns:
//   * engine — pure transitions (armed/threshold/targets/cancel);
//   * provider — window listeners, the registry, drop side effects;
//   * layer — the ghost, position tracking included.
//
// Targets self-register (`registerTarget`) and receive the payload on
// drop; `canDrop` lets a target reject a payload (e.g. a folder onto
// its own descendant) so the engine never marks it as hovered.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

import {
  dragReducer,
  type DragPayload,
  type DragPoint,
  type DragState,
  type DropTargetId,
} from "../lib/drag-engine";

/** A registered drop target: optional payload gate + the drop handler. */
export interface DropTargetHandlers {
  /** Return false to reject the payload — the target never becomes the
   *  hovered drop target (invalid-target rejection before any drop). */
  canDrop?: (payload: DragPayload) => boolean;
  onDrop: (payload: DragPayload) => void;
}

interface DragContextValue {
  state: DragState;
  /** Arm a drag from a pointer down (the source card's onPointerDown). */
  beginDrag: (origin: DragPoint, payload: DragPayload) => void;
  /** Announce the hovered target — `null` clears it. Invalid or
   *  unregistered targets are rejected (previous hover cleared, nothing
   *  entered). */
  hoverTarget: (target: DropTargetId | null) => void;
  /** End the drag: pointer up or cancel. Resolves the drop — if a valid
   *  target is hovered, its `onDrop(payload)` fires — then resets. */
  endDrag: () => void;
  /** Register a drop target; returns its unregister (useEffect cleanup). */
  registerTarget: (id: DropTargetId, handlers: DropTargetHandlers) => () => void;
  /** The last seen pointer position — the ghost seeds itself from this on
   *  mount so it never renders at a stale offset. */
  pointRef: RefObject<DragPoint>;
}

const DragContext = createContext<DragContextValue | null>(null);

export function DragProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(dragReducer, { phase: "idle" } as DragState);

  // Mirrors for stable-callback: event listeners read the latest state
  // through refs instead of re-attaching per state change.
  const stateRef = useRef(state);
  stateRef.current = state;
  const registryRef = useRef(new Map<DropTargetId, DropTargetHandlers>());
  const pointRef = useRef<DragPoint>({ x: 0, y: 0 });

  const beginDrag = useCallback((origin: DragPoint, payload: DragPayload) => {
    dispatch({ type: "pointerDown", origin, payload });
  }, []);

  const hoverTarget = useCallback((target: DropTargetId | null) => {
    const current = stateRef.current;
    if (current.phase !== "dragging") return;
    if (target === null) {
      if (current.over !== null) dispatch({ type: "targetLeave", target: current.over });
      return;
    }
    const registered = registryRef.current.get(target);
    const isValid =
      registered !== undefined && (registered.canDrop?.(current.payload) ?? true);
    if (isValid) {
      dispatch({ type: "targetEnter", target });
    } else if (current.over !== null) {
      // Hovering an invalid target leaves the previous one — the payload
      // is over no valid target now.
      dispatch({ type: "targetLeave", target: current.over });
    }
  }, []);

  const endDrag = useCallback(() => {
    const current = stateRef.current;
    if (current.phase === "dragging" && current.over !== null) {
      registryRef.current.get(current.over)?.onDrop(current.payload);
    }
    dispatch({ type: "pointerUp" });
  }, []);

  const registerTarget = useCallback(
    (id: DropTargetId, handlers: DropTargetHandlers) => {
      registryRef.current.set(id, handlers);
      return () => {
        registryRef.current.delete(id);
      };
    },
    [],
  );

  // Window-level pointer plumbing while a press is active. The boolean
  // dependency attaches/detaches once per drag, not per state change.
  const isActive = state.phase !== "idle";
  useEffect(() => {
    if (!isActive) return;

    /** GOTCHA: no `setPointerCapture` here. Capturing on pointerdown
     *  would hijack every click and kill text selection inside cards —
     *  capture routes all subsequent pointer events to the source
     *  element, swallowing the default behaviors we must preserve below
     *  the threshold. Window listeners + the engine's threshold keep
     *  clicks and selection working; the press only becomes a drag
     *  after 6px of travel. */
    const onPointerMove = (event: PointerEvent): void => {
      pointRef.current = { x: event.clientX, y: event.clientY };
      dispatch({
        type: "pointerMove",
        point: { x: event.clientX, y: event.clientY },
      });
    };
    const onPointerUp = (): void => {
      endDrag();
    };
    // Touch scroll takeover: the browser cancels the pointer stream to
    // hand the gesture to scrolling — the drag ends, never drops.
    const onPointerCancel = (): void => {
      dispatch({ type: "escape" });
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dispatch({ type: "escape" });
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isActive, endDrag]);

  const value = useMemo(
    () => ({ state, beginDrag, hoverTarget, endDrag, registerTarget, pointRef }),
    [state, beginDrag, hoverTarget, endDrag, registerTarget],
  );

  return <DragContext.Provider value={value}>{children}</DragContext.Provider>;
}

export function useDrag(): DragContextValue {
  const context = useContext(DragContext);
  if (context === null) {
    throw new Error("useDrag must be used within a DragProvider");
  }
  return context;
}
