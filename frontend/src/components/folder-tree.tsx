// FolderTree — the organizer's folder spine (M9 FR-7.4, FR-10.2).
//
// Recursive ARIA tree: role="tree"/"treeitem"/"group", disclosure buttons
// with aria-expanded, arrow-key navigation per the WAI-ARIA tree pattern
// (Down/Up move between visible nodes, Right expands-or-descends,
// Left collapses-or-ascends, Home/End jump to first/last). Selection is
// caller-owned (`selectedPath` + `onSelect`) so the component stays
// router-free; browse.tsx wires it to `useFolderDir`. Ancestors of the
// selected path auto-expand (deep links land with the node visible); user
// toggles are remembered for the session. No animation on expand —
// instant, reduced-motion-safe by default.
//
// Counts display "N videos · M files" per node (cumulative, server-computed).

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import type { FolderNodeDto } from "../api/types";

type FolderTreeProps = {
  nodes: FolderNodeDto[];
  selectedPath: string;
  onSelect: (path: string) => void;
};

/** Flatten the VISIBLE treeitems in visual order (keyboard nav domain). */
interface VisibleNode {
  node: FolderNodeDto;
  depth: number;
  parentPath: string | null;
}

function flattenVisible(
  nodes: FolderNodeDto[],
  depth: number,
  parentPath: string | null,
  expanded: Set<string>,
): VisibleNode[] {
  const out: VisibleNode[] = [];
  for (const node of nodes) {
    out.push({ node, depth, parentPath });
    if (node.children.length > 0 && expanded.has(node.path)) {
      out.push(
        ...flattenVisible(node.children, depth + 1, node.path, expanded),
      );
    }
  }
  return out;
}

export function FolderTree({ nodes, selectedPath, onSelect }: FolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Auto-expand ancestors of the selected path so deep links land with the
  // node visible. User toggles for other branches survive.
  useEffect(() => {
    if (selectedPath === "") return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const segments = selectedPath.split("/").filter(Boolean);
      let acc = "";
      for (const segment of segments) {
        acc += `/${segment}`;
        next.add(acc);
      }
      // Skip when nothing changed to avoid looping on every selection.
      if (next.size === prev.size && [...next].every((p) => prev.has(p))) {
        return prev;
      }
      return next;
    });
  }, [selectedPath]);

  function toggle(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
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
    // button (which carries no data-tree-path): walk up to the enclosing
    // treeitem, then back down to its path button. Falls back to -1 (before
    // first) when focus is on the tree itself.
    const focusedPath = document.activeElement
      ?.closest('[role="treeitem"]')
      ?.querySelector<HTMLElement>("[data-tree-path]")
      ?.getAttribute("data-tree-path");
    const currentIndex = items.findIndex((v) => v.node.path === focusedPath);

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = items[Math.min(currentIndex + 1, items.length - 1)];
        focusPath(next?.node.path);
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        const prev = items[Math.max(currentIndex - 1, 0)];
        focusPath(prev?.node.path);
        break;
      }
      case "ArrowRight": {
        event.preventDefault();
        const current = items[currentIndex];
        if (!current) return;
        if (
          current.node.children.length > 0 &&
          !expanded.has(current.node.path)
        ) {
          toggle(current.node.path);
        } else if (current.node.children.length > 0) {
          focusPath(items[currentIndex + 1]?.node.path);
        }
        break;
      }
      case "ArrowLeft": {
        event.preventDefault();
        const current = items[currentIndex];
        if (!current) return;
        if (
          current.node.children.length > 0 &&
          expanded.has(current.node.path)
        ) {
          toggle(current.node.path);
        } else if (current.parentPath !== null) {
          focusPath(current.parentPath);
        }
        break;
      }
      case "Home": {
        event.preventDefault();
        focusPath(items[0]?.node.path);
        break;
      }
      case "End": {
        event.preventDefault();
        focusPath(items[items.length - 1]?.node.path);
        break;
      }
    }
  }

  function focusPath(path: string | undefined): void {
    if (path === undefined) return;
    const el = document.querySelector<HTMLElement>(
      `[data-tree-path="${CSS.escape(path)}"]`,
    );
    el?.focus();
  }

  return (
    <ul role="tree" aria-label="Folders" onKeyDown={handleTreeKeyDown}>
      {visible.map(({ node, depth }) => {
        const hasChildren = node.children.length > 0;
        const isExpanded = expanded.has(node.path);
        const isSelected = node.path === selectedPath;
        const counts = [
          node.video_count > 0 ? `${node.video_count} videos` : null,
          node.file_count > 0 ? `${node.file_count} files` : null,
        ]
          .filter(Boolean)
          .join(" · ");

        return (
          <li
            role="treeitem"
            key={node.path || "(root)"}
            aria-expanded={hasChildren ? isExpanded : undefined}
          >
            <div
              className="flex items-center gap-1"
              style={{ paddingLeft: `${depth * 1.0}rem` }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  onClick={() => toggle(node.path)}
                  aria-expanded={isExpanded}
                  aria-label={
                    isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`
                  }
                  className="h-5 w-5 flex-shrink-0 rounded text-[var(--color-castify-muted)] transition hover:bg-[var(--color-castify-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
                >
                  {isExpanded ? "▾" : "▸"}
                </button>
              ) : (
                <span className="h-5 w-5 flex-shrink-0" aria-hidden />
              )}
              <button
                type="button"
                data-tree-path={node.path}
                onClick={() => onSelect(node.path)}
                aria-current={isSelected ? "true" : undefined}
                className={`flex min-w-0 flex-1 items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] ${
                  isSelected
                    ? "bg-[var(--color-castify-surface-raised)] font-semibold text-[var(--color-castify-text)] shadow-[inset_2px_0_0_var(--color-castify-accent)]"
                    : "text-[var(--color-castify-muted)] hover:bg-[var(--color-castify-hover)] hover:text-[var(--color-castify-text)]"
                }`}
              >
                <span className="truncate">{node.name}</span>
                {counts && (
                  <span className="flex-shrink-0 font-mono text-xs tabular-nums text-[var(--color-castify-muted)]">
                    {counts}
                  </span>
                )}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
