// `useDropTarget` (drag-and-drop task 002) — the one hook every drop
// target wears. It registers the target with the drag context, derives
// the hovered state, and hands back the pointer props that announce
// hover while a drag is live.
//
// Hover semantics: pointerenter/leave (React synthetic — correct with
// nested elements, unlike raw over/out). `hoverTarget` no-ops outside a
// drag, so plain hovers never touch the engine.
//
// Handlers go through a ref so callers can pass fresh closures (the
// mutation hooks change identity per render) without re-registering —
// the registry entry is created once per target id.

import { useEffect, useRef } from "react";

import { useDrag, type DropTargetHandlers } from "../components/drag-context";
import type { DropTargetId } from "../lib/drag-engine";

export function useDropTarget(id: DropTargetId, handlers: DropTargetHandlers) {
  const { state, hoverTarget, registerTarget } = useDrag();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(
    () =>
      registerTarget(id, {
        canDrop: (payload) => handlersRef.current.canDrop?.(payload) ?? true,
        onDrop: (payload) => handlersRef.current.onDrop(payload),
      }),
    [id, registerTarget],
  );

  const isDragActive = state.phase === "dragging";
  const isDropHovered = isDragActive && state.over === id;

  return {
    isDragActive,
    isDropHovered,
    /** Spread onto the target's root element. */
    dropProps: {
      onPointerEnter: () => hoverTarget(id),
      onPointerLeave: () => hoverTarget(null),
    },
  };
}
