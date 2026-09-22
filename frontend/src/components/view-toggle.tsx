// ViewToggle — the grid/list segmented control (library-list-view task
// 002). Mounted in an owning surface's header row beside its other
// controls; the surface wires it to `useViewMode` (controlled — no hook
// inside, so it stays testable in isolation).
//
// Keycap styling joins the app's chip language: the active segment wears
// `keycap-active`, the inactive `keycap-inactive` with its hover; the two
// segments read as one control through a shared rounded frame (the
// share-dialog's toggle-group pattern). Icon-only segments carry
// aria-labels — the glyphs are decorative to a screen reader, the labels
// are the contract.

import { type ReactNode } from "react";

import { LibraryIcon, ListIcon } from "./icons";
import type { ViewMode } from "../hooks/use-view-mode";

type ViewToggleProps = {
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
};

function Segment({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={active ? undefined : onClick}
      className={`flex h-8 min-w-8 items-center justify-center px-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)] motion-reduce:transition-none ${
        active ? "keycap keycap-active" : "keycap keycap-inactive"
      }`}
    >
      <span aria-hidden className="h-4 w-4">
        {children}
      </span>
    </button>
  );
}

export function ViewToggle({ mode, onModeChange }: ViewToggleProps) {
  return (
    <div
      role="group"
      aria-label="View"
      className="flex overflow-hidden rounded-[var(--radius-button)] border border-[var(--color-castify-rule)]"
    >
      <Segment
        label="Grid view"
        active={mode === "grid"}
        onClick={() => onModeChange("grid")}
      >
        <LibraryIcon className="h-4 w-4" />
      </Segment>
      <Segment
        label="List view"
        active={mode === "list"}
        onClick={() => onModeChange("list")}
      >
        <ListIcon className="h-4 w-4" />
      </Segment>
    </div>
  );
}
