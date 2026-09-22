// Drag-engine tests (drag-and-drop task 001) — the pure reducer contract
// every later drag task builds on:
//   * idle → armed on pointer down; armed survives sub-threshold moves
//     (clicks/scroll unaffected) and crosses to dragging at ≥6px;
//   * carry computation — the grabbed card inside a selection carries
//     the whole selection, else just itself;
//   * target enter/leave transitions (stale leaves can't clear newer
//     targets);
//   * cancel paths — pointer up with no target, Escape — return to idle.
//
// Pure unit tests: actions in, state out, no DOM.

import { describe, expect, it } from "vitest";

import {
  DRAG_THRESHOLD_PX,
  carryPayload,
  dragReducer,
  manifestLabel,
  type DragItem,
  type DragPayload,
  type DragState,
} from "./drag-engine";

const ORIGIN = { x: 100, y: 100 };
const VIDEO_A: DragItem = { kind: "video", id: "v1" };
const VIDEO_B: DragItem = { kind: "video", id: "v2" };
const FILE_A: DragItem = { kind: "file", id: "f1" };

function armedWith(payload: DragPayload = { type: "items", items: [VIDEO_A] }): DragState {
  return dragReducer(
    { phase: "idle" },
    { type: "pointerDown", origin: ORIGIN, payload },
  );
}

function draggingWith(payload: DragPayload = { type: "items", items: [VIDEO_A] }): DragState {
  return dragReducer(armedWith(payload), {
    type: "pointerMove",
    point: { x: ORIGIN.x + DRAG_THRESHOLD_PX, y: ORIGIN.y },
  });
}

describe("dragReducer arming + threshold", () => {
  it("stays idle before any pointer down", () => {
    const state = dragReducer({ phase: "idle" }, {
      type: "pointerMove",
      point: ORIGIN,
    });
    expect(state.phase).toBe("idle");
  });

  it("arms on pointer down with the origin and payload", () => {
    const state = armedWith();
    expect(state).toEqual({
      phase: "armed",
      origin: ORIGIN,
      payload: { type: "items", items: [VIDEO_A] },
    });
  });

  it("stays armed below the hold threshold — a click, not a drag", () => {
    const state = dragReducer(armedWith(), {
      type: "pointerMove",
      point: { x: ORIGIN.x + DRAG_THRESHOLD_PX - 1, y: ORIGIN.y },
    });
    expect(state.phase).toBe("armed");
  });

  it("crosses to dragging at the threshold distance", () => {
    const state = dragReducer(armedWith(), {
      type: "pointerMove",
      point: { x: ORIGIN.x, y: ORIGIN.y + DRAG_THRESHOLD_PX },
    });
    expect(state.phase).toBe("dragging");
  });

  it("further moves keep the dragging state object untouched", () => {
    const dragging = draggingWith();
    const moved = dragReducer(dragging, { type: "pointerMove", point: { x: 400, y: 400 } });
    // Referential stability: position is NOT reducer state (the ghost
    // tracks it separately) — React bails out, no per-move re-renders.
    expect(moved).toBe(dragging);
  });

  it("pointer up while armed returns to idle — the click goes through", () => {
    const state = dragReducer(armedWith(), { type: "pointerUp" });
    expect(state.phase).toBe("idle");
  });
});

describe("dragReducer target tracking", () => {
  it("entering a target sets it while dragging", () => {
    const state = dragReducer(draggingWith(), { type: "targetEnter", target: "folder-1" });
    expect(state).toMatchObject({ phase: "dragging", over: "folder-1" });
  });

  it("entering a second target replaces the first", () => {
    let state = draggingWith();
    state = dragReducer(state, { type: "targetEnter", target: "folder-1" });
    state = dragReducer(state, { type: "targetEnter", target: "folder-2" });
    expect(state).toMatchObject({ over: "folder-2" });
  });

  it("leaving the current target clears it", () => {
    let state = draggingWith();
    state = dragReducer(state, { type: "targetEnter", target: "folder-1" });
    state = dragReducer(state, { type: "targetLeave", target: "folder-1" });
    expect(state).toMatchObject({ over: null });
  });

  it("a stale leave does not clear a newer target", () => {
    let state = draggingWith();
    state = dragReducer(state, { type: "targetEnter", target: "folder-1" });
    state = dragReducer(state, { type: "targetEnter", target: "folder-2" });
    state = dragReducer(state, { type: "targetLeave", target: "folder-1" });
    expect(state).toMatchObject({ over: "folder-2" });
  });

  it("target transitions are ignored while idle or armed", () => {
    const armed = dragReducer(armedWith(), { type: "targetEnter", target: "folder-1" });
    expect(armed.phase).toBe("armed");
    const idle = dragReducer({ phase: "idle" }, { type: "targetEnter", target: "folder-1" });
    expect(idle.phase).toBe("idle");
  });
});

describe("dragReducer cancel paths", () => {
  it("pointer up while dragging with no target returns to idle", () => {
    const state = dragReducer(draggingWith(), { type: "pointerUp" });
    expect(state.phase).toBe("idle");
  });

  it("pointer up while dragging over a target returns to idle (drop is the caller's side effect)", () => {
    let state = draggingWith();
    state = dragReducer(state, { type: "targetEnter", target: "folder-1" });
    state = dragReducer(state, { type: "pointerUp" });
    expect(state.phase).toBe("idle");
  });

  it("Escape cancels a dragging state to idle", () => {
    const state = dragReducer(draggingWith(), { type: "escape" });
    expect(state.phase).toBe("idle");
  });

  it("a second pointer down during a drag is ignored — the first payload stands", () => {
    let state = draggingWith();
    state = dragReducer(state, {
      type: "pointerDown",
      origin: ORIGIN,
      payload: { type: "folder", id: "folder-9", name: "Other" },
    });
    expect(state).toMatchObject({
      phase: "dragging",
      payload: { type: "items", items: [VIDEO_A] },
    });
  });
});

describe("carryPayload — the selection carry rule", () => {
  it("carries the whole selection when the grabbed card is in it", () => {
    const selection = [VIDEO_A, VIDEO_B, FILE_A];
    expect(carryPayload(VIDEO_B, selection)).toEqual({
      type: "items",
      items: [VIDEO_A, VIDEO_B, FILE_A],
    });
  });

  it("carries only the grabbed card when it is not in the selection", () => {
    const selection = [VIDEO_A, FILE_A];
    expect(carryPayload(VIDEO_B, selection)).toEqual({
      type: "items",
      items: [VIDEO_B],
    });
  });

  it("carries only the grabbed card with no selection", () => {
    expect(carryPayload(FILE_A)).toEqual({ type: "items", items: [FILE_A] });
  });
});

describe("manifestLabel — the chip copy", () => {
  it("singularizes one video", () => {
    expect(manifestLabel({ type: "items", items: [VIDEO_A] })).toBe("1 VIDEO");
  });

  it("pluralizes three files", () => {
    const items: DragItem[] = [
      { kind: "file", id: "f1" },
      { kind: "file", id: "f2" },
      { kind: "file", id: "f3" },
    ];
    expect(manifestLabel({ type: "items", items })).toBe("3 FILES");
  });

  it("summarizes a mixed selection", () => {
    const items = [VIDEO_A, VIDEO_B, FILE_A];
    expect(manifestLabel({ type: "items", items })).toBe("2 VIDEOS + 1 FILE");
  });

  it("names the folder in the data voice, uppercased", () => {
    expect(manifestLabel({ type: "folder", id: "folder-1", name: "Trip 2024" })).toBe(
      "FOLDER — TRIP 2024",
    );
  });
});
