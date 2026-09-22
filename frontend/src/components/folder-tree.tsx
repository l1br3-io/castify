// FolderTree — the organizer's folder spine (M9 FR-7.4, FR-10.2;
// generalized over node shape in the library-folders effort).
//
// Generic over `{ key, label, count, children }` so the curated tree
// (folder-id keys, cumulative item counts) and the provider tree (path
// keys, video/file counts) render through one component — adapters at
// the call site shape their DTOs into TreeNodes.
//
// Recursive ARIA tree: role="tree"/"treeitem"/"group", disclosure buttons
// with aria-expanded, arrow-key navigation per the WAI-ARIA tree pattern
// (Down/Up move between visible nodes, Right expands-or-descends,
// Left collapses-or-ascends, Home/End jump to first/last). Selection is
// caller-owned (`selectedKey` + `onSelect`) so the component stays
// router-free; the sidebar wires it to the URL params. Ancestors of the
// selected key auto-expand (deep links land with the node visible); user
// toggles are remembered for the session. No animation on expand —
// instant, reduced-motion-safe by default.

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import { useDrag } from "./drag-context";
import { useDropTarget } from "../hooks/use-drop-target";
import type { DragPayload } from "../lib/drag-engine";

/** A tree node in the generic rendering shape. `key` is unique within
 *  its tree (provider path or curated folder id); `count` is a
 *  preformatted string ("" hides the badge). `countValue` is the same
 *  count as a number — optional, set by trees that also serve as drop
 *  targets (the drag hover preview steps it to its post-drop value). */
export interface TreeNode {
  key: string;
  label: string;
  count: string;
  countValue?: number;
  children: TreeNode[];
}

/** Key-scoped drop handling (drag-and-drop effort): every row of a tree
 *  carrying this prop registers as a drop target. Trees without it (the
 *  provider "Cloud" tree) render plain rows — different data domain. */
export interface TreeDropTargets {
  canDrop: (key: string, payload: DragPayload) => boolean;
  onDrop: (key: string, payload: DragPayload) => void;
}

type FolderTreeProps = {
  nodes: TreeNode[];
  selectedKey: string;
  onSelect: (key: string) => void;
  /** Accessible name for the tree region (defaults to "Folders"). */
  ariaLabel?: string;
  /** Drag-and-drop (drag-and-drop effort): makes each row a drop
   *  target with count preview. Additive — absent keeps rows plain. */
  dropTargets?: TreeDropTargets;
};

/** Flatten the VISIBLE treeitems in visual order (keyboard nav domain). */
interface VisibleNode {
  node: TreeNode;
  depth: number;
  parentKey: string | null;
}

function flattenVisible(
  nodes: TreeNode[],
  depth: number,
  parentKey: string | null,
  expanded: Set<string>,
): VisibleNode[] {
  const out: VisibleNode[] = [];
  for (const node of nodes) {
    out.push({ node, depth, parentKey });
    if (node.children.length > 0 && expanded.has(node.key)) {
      out.push(...flattenVisible(node.children, depth + 1, node.key, expanded));
    }
  }
  return out;
}

/** Keys that must be expanded to reveal `key`: its ancestor chain plus
 *  the node itself (a selected branch shows its children, matching the
 *  pre-generalization path-prefix behavior). */
function revealChain(nodes: TreeNode[], key: string, chain: string[]): Set<string> | null {
  for (const node of nodes) {
    if (node.key === key) return new Set([...chain, node.key]);
    const found = revealChain(node.children, key, [...chain, node.key]);
    if (found !== null) return found;
  }
  return null;
}

function rowClassName(isSelected: boolean, dropHovered = false): string {
  return `flex min-w-0 flex-1 items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] ${
    isSelected
      ? "bg-[var(--color-castify-surface-raised)] font-semibold text-[var(--color-castify-text)] shadow-[inset_2px_0_0_var(--color-castify-accent)]"
      : dropHovered
        ? // Valid drop target, hovered: the tile treatment relocated to a
          // row — accent-subtle fill + the amber inset bar. Colors only,
          // never size — no layout shift mid-drag.
          "bg-[var(--color-castify-accent-subtle)] text-[var(--color-castify-text)] shadow-[inset_2px_0_0_var(--color-castify-accent)]"
        : "text-[var(--color-castify-muted)] hover:bg-[var(--color-castify-hover)] hover:text-[var(--color-castify-text)]"
  }`;
}

type RowButtonProps = {
  node: TreeNode;
  isSelected: boolean;
  onSelect: (key: string) => void;
};

/** The plain select button — provider trees and any tree without drop
 *  targets. No drag-context dependency. */
function PlainRowButton({ node, isSelected, onSelect }: RowButtonProps) {
  return (
    <button
      type="button"
      data-tree-key={node.key}
      onClick={() => onSelect(node.key)}
      aria-current={isSelected ? "true" : undefined}
      className={rowClassName(isSelected)}
    >
      <span className="truncate">{node.label}</span>
      {node.count && (
        <span className="flex-shrink-0 font-mono text-xs tabular-nums text-[var(--color-castify-muted)]">
          {node.count}
        </span>
      )}
    </button>
  );
}

/** The drag-aware select button (drag-and-drop task 003): registers as
 *  a drop target, previews the post-drop count in the mono badge while
 *  hovered, and hands the payload to the tree's key-scoped handler. */
function DroppableRowButton({
  node,
  isSelected,
  onSelect,
  dropTargets,
}: RowButtonProps & { dropTargets: TreeDropTargets }) {
  const { state } = useDrag();
  const { isDropHovered, dropProps } = useDropTarget(`tree:${node.key}`, {
    canDrop: (payload) => dropTargets.canDrop(node.key, payload),
    onDrop: (payload) => dropTargets.onDrop(node.key, payload),
  });
  const preview =
    isDropHovered &&
    state.phase === "dragging" &&
    state.payload.type === "items" &&
    node.countValue !== undefined
      ? `${node.countValue} → ${node.countValue + state.payload.items.length} items`
      : null;

  return (
    <button
      type="button"
      data-tree-key={node.key}
      onClick={() => onSelect(node.key)}
      onPointerEnter={dropProps.onPointerEnter}
      onPointerLeave={dropProps.onPointerLeave}
      aria-current={isSelected ? "true" : undefined}
      className={rowClassName(isSelected, isDropHovered)}
    >
      <span className="truncate">{node.label}</span>
      {(preview ?? node.count) && (
        <span className="flex-shrink-0 font-mono text-xs tabular-nums text-[var(--color-castify-muted)]">
          {preview ?? node.count}
        </span>
      )}
    </button>
  );
}

export function FolderTree({
  nodes,
  selectedKey,
  onSelect,
  ariaLabel = "Folders",
  dropTargets,
}: FolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Auto-expand the chain down to the selected key so deep links land
  // with the node (and its children) visible. User toggles for other
  // branches survive.
  useEffect(() => {
    if (selectedKey === "") return;
    const chain = revealChain(nodes, selectedKey, []);
    if (chain === null) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const key of chain) next.add(key);
      // Skip when nothing changed to avoid looping on every selection.
      if (next.size === prev.size && [...next].every((k) => prev.has(k))) {
        return prev;
      }
      return next;
    });
    // `nodes` is reconstructed per render by callers; keying the effect
    // on the identity of the auto-expand target, not the tree, keeps
    // this from re-running on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  function toggle(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const visible = useMemo(
    () => flattenVisible(nodes, 0, null, expanded),
    [nodes, expanded],
  );

  function handleTreeKeyDown(event: KeyboardEvent<HTMLElement>): void {
    const items = visible;
    // Resolve the focused treeitem even when focus sits on its disclosure
    // button (which carries no data-tree-key): walk up to the enclosing
    // treeitem, then back down to its key button. Falls back to -1 (before
    // first) when focus is on the tree itself.
    const focusedKey = document.activeElement
      ?.closest('[role="treeitem"]')
      ?.querySelector<HTMLElement>("[data-tree-key]")
      ?.getAttribute("data-tree-key");
    const currentIndex = items.findIndex((v) => v.node.key === focusedKey);

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = items[Math.min(currentIndex + 1, items.length - 1)];
        focusKey(next?.node.key);
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        const prev = items[Math.max(currentIndex - 1, 0)];
        focusKey(prev?.node.key);
        break;
      }
      case "ArrowRight": {
        event.preventDefault();
        const current = items[currentIndex];
        if (!current) return;
        if (current.node.children.length > 0 && !expanded.has(current.node.key)) {
          toggle(current.node.key);
        } else if (current.node.children.length > 0) {
          focusKey(items[currentIndex + 1]?.node.key);
        }
        break;
      }
      case "ArrowLeft": {
        event.preventDefault();
        const current = items[currentIndex];
        if (!current) return;
        if (current.node.children.length > 0 && expanded.has(current.node.key)) {
          toggle(current.node.key);
        } else if (current.parentKey !== null) {
          focusKey(current.parentKey);
        }
        break;
      }
      case "Home": {
        event.preventDefault();
        focusKey(items[0]?.node.key);
        break;
      }
      case "End": {
        event.preventDefault();
        focusKey(items[items.length - 1]?.node.key);
        break;
      }
    }
  }

  function focusKey(key: string | undefined): void {
    if (key === undefined) return;
    const el = document.querySelector<HTMLElement>(
      `[data-tree-key="${CSS.escape(key)}"]`,
    );
    el?.focus();
  }

  return (
    <ul role="tree" aria-label={ariaLabel} onKeyDown={handleTreeKeyDown}>
      {visible.map(({ node, depth }) => {
        const hasChildren = node.children.length > 0;
        const isExpanded = expanded.has(node.key);
        const isSelected = node.key === selectedKey;

        return (
          <li
            role="treeitem"
            key={node.key || "(root)"}
            aria-expanded={hasChildren ? isExpanded : undefined}
          >
            <div
              className="flex items-center gap-1"
              style={{ paddingLeft: `${depth * 1.0}rem` }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  onClick={() => toggle(node.key)}
                  aria-expanded={isExpanded}
                  aria-label={
                    isExpanded ? `Collapse ${node.label}` : `Expand ${node.label}`
                  }
                  className="h-5 w-5 flex-shrink-0 rounded text-[var(--color-castify-muted)] transition hover:bg-[var(--color-castify-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
                >
                  {isExpanded ? "▾" : "▸"}
                </button>
              ) : (
                <span className="h-5 w-5 flex-shrink-0" aria-hidden />
              )}
              {dropTargets ? (
                <DroppableRowButton
                  node={node}
                  isSelected={isSelected}
                  onSelect={onSelect}
                  dropTargets={dropTargets}
                />
              ) : (
                <PlainRowButton node={node} isSelected={isSelected} onSelect={onSelect} />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
