// Reorder hit-testing (drag-and-drop task 007) — pure geometry, no DOM.
// A pointer over a band of item rects resolves to the insertion index
// between two neighbors (0..rects.length), or null when the pointer is
// too far from the band to mean anything.
//
// Resolution: the NEAREST rect by center distance wins; within that
// rect's row band the point's x decides before/after, otherwise its y
// does (wrapped grid rows and vertical lists both fall out of the same
// rule). The dragged items' rects are excluded by the caller — the
// caret indexes the remaining neighbors.

/** One item's viewport rect (getBoundingClientRect shape). */
export interface SlotRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Beyond this distance from the nearest rect the pointer means no
 *  insertion — the drag is heading somewhere else (a folder tile, the
 *  sidebar, out of the band). */
const PROXIMITY_LIMIT_PX = 120;

export function insertionIndex(
  rects: SlotRect[],
  point: { x: number; y: number },
): number | null {
  if (rects.length === 0) return 0;

  // Nearest by edge distance (a pointer far right of a wide list row is
  // still ON that row; a center metric would misjudge it).
  let nearest = 0;
  let nearestDist = Infinity;
  rects.forEach((rect, i) => {
    const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
    const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
    const dist = Math.hypot(dx, dy);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = i;
    }
  });
  if (nearestDist > PROXIMITY_LIMIT_PX) {
    return null;
  }

  const rect = rects[nearest]!;
  const midX = (rect.left + rect.right) / 2;
  const midY = (rect.top + rect.bottom) / 2;
  // Same visual row → x decides; a different row → y decides (the
  // pointer means "before/after that whole row").
  const before =
    point.y >= rect.top && point.y <= rect.bottom
      ? point.x < midX
      : point.y < midY;
  return before ? nearest : nearest + 1;
}
