// Tests for the reorder hit-testing (drag-and-drop task 007) — pure
// geometry: a pointer over a band of item rects resolves to the
// insertion index between two neighbors. Fixtures cover the grid row,
// wrapped rows, the vertical list, and the too-far-away case.

import { describe, expect, it } from "vitest";

import { insertionIndex, type SlotRect } from "./reorder";

function rect(left: number, top: number, w: number, h: number): SlotRect {
  return { left, top, right: left + w, bottom: top + h };
}

/** A single grid row of 100×50 cards with 20px gaps, at (0,0). */
function gridRow(n: number): SlotRect[] {
  return Array.from({ length: n }, (_, i) => rect(i * 120, 0, 100, 50));
}

describe("insertionIndex", () => {
  it("empty band inserts at 0", () => {
    expect(insertionIndex([], { x: 40, y: 20 })).toBe(0);
  });

  it("a point left of the first card inserts before it", () => {
    expect(insertionIndex(gridRow(3), { x: 10, y: 25 })).toBe(0);
  });

  it("a point past the last card inserts after it", () => {
    expect(insertionIndex(gridRow(3), { x: 350, y: 25 })).toBe(3);
  });

  it("mid-band points resolve to the nearest gap", () => {
    // Row of 3 at x 0-100, 120-220, 240-340. Between cards 1 and 2.
    expect(insertionIndex(gridRow(3), { x: 115, y: 25 })).toBe(1);
    // Inside card 2's left half.
    expect(insertionIndex(gridRow(3), { x: 140, y: 25 })).toBe(1);
    // Inside card 2's right half.
    expect(insertionIndex(gridRow(3), { x: 210, y: 25 })).toBe(2);
  });

  it("wrapped rows: a point under the whole first row counts the row", () => {
    const rects = [...gridRow(3), ...gridRow(3).map((r) => rect(r.left, 120, r.right - r.left, 50))];
    // Directly below the first row, aligned with row-2 card 0.
    expect(insertionIndex(rects, { x: 40, y: 145 })).toBe(3);
    // Inside row-2 card 0's right half → 4.
    expect(insertionIndex(rects, { x: 80, y: 145 })).toBe(4);
  });

  it("a vertical list decides by row, not column", () => {
    const rows = Array.from({ length: 3 }, (_, i) => rect(0, i * 60, 600, 50));
    // Between rows 0 and 1, far to the right.
    expect(insertionIndex(rows, { x: 550, y: 58 })).toBe(1);
    // Inside row 2.
    expect(insertionIndex(rows, { x: 10, y: 140 })).toBe(2);
  });

  it("returns null beyond the proximity threshold", () => {
    expect(insertionIndex(gridRow(3), { x: 900, y: 900 })).toBeNull();
    // Just inside the threshold still resolves (nearest = last card,
    // below its row ⇒ after it).
    expect(insertionIndex(gridRow(3), { x: 260, y: 130 })).toBe(3);
  });
});
