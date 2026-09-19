// ShareItemMenu — the per-card kebab menu on the share manage page
// (share-manage-page task 004; task 017 rebuilds it on the ui/Menu
// primitive, which carries the whole a11y contract: labelled trigger with
// aria-expanded, ArrowUp/Down cycling, Escape with focus restore,
// outside-mousedown and scroll/resize dismissal, portal panel).
//
// Last-item guard: the caller passes canRemove=false for the final item;
// Remove renders disabled and the hint line explains why (the server
// enforces non-empty with a 400 — this is UX, not enforcement).

import { Link } from "react-router-dom";

import { MENU_ITEM_CLASS, Menu } from "./ui/menu";

/** Dark chip — the trigger rides PosterCard's thumbnail overlay. */
const TRIGGER_CLASS =
  "flex h-7 w-7 items-center justify-center rounded-[var(--radius-button)] " +
  "bg-black/60 text-white/80 transition hover:bg-black/80 hover:text-white " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]";

export function ShareItemMenu({
  videoName,
  videoHref,
  canRemove,
  removeHint,
  onMove,
  onRemove,
}: {
  videoName: string;
  videoHref: string;
  canRemove: boolean;
  removeHint?: string;
  /** Open the folder picker (share-folders task 008). Provided only on
   * active shares — a terminal share has nothing editable to move into. */
  onMove?: () => void;
  onRemove: () => void;
}) {
  return (
    <Menu
      label={`More actions for ${videoName}`}
      triggerClassName={TRIGGER_CLASS}
      trigger={
        <svg
          viewBox="0 0 16 16"
          className="h-4 w-4"
          fill="currentColor"
          aria-hidden
        >
          <circle cx="3" cy="8" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="13" cy="8" r="1.5" />
        </svg>
      }
    >
      {(close) => (
        <>
          <Link
            role="menuitem"
            to={videoHref}
            onClick={close}
            className={MENU_ITEM_CLASS}
          >
            Open
          </Link>
          {onMove && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                onMove();
              }}
              className={MENU_ITEM_CLASS}
            >
              Move to folder…
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            aria-disabled={!canRemove}
            disabled={!canRemove}
            title={canRemove ? undefined : removeHint}
            onClick={() => {
              if (!canRemove) return;
              close();
              onRemove();
            }}
            className={MENU_ITEM_CLASS}
          >
            Remove from share
          </button>
          {!canRemove && removeHint && (
            <p className="px-3 pb-1 pt-0.5 text-xs leading-snug opacity-60">
              {removeHint}
            </p>
          )}
        </>
      )}
    </Menu>
  );
}
