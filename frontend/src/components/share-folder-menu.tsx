// ShareFolderMenu (share-folders task 007) — the folder tile's kebab:
// Rename / Move / Delete. Built on the ui/Menu primitive with the same
// a11y contract as ShareItemMenu (labelled trigger, arrow cycling,
// Escape restore, outside-click dismissal). One callback per action; the
// menu closes on pick and the manage page owns the dialogs/mutations.

import { Menu, MENU_ITEM_CLASS } from "./ui/menu";

/** Dark chip — the trigger rides the tile's glyph well, matching
 * ShareItemMenu's placement on PosterCard thumbnails. */
const TRIGGER_CLASS =
  "flex h-7 w-7 items-center justify-center rounded-[var(--radius-button)] " +
  "bg-black/60 text-white/80 transition hover:bg-black/80 hover:text-white " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]";

export function ShareFolderMenu({
  folderName,
  onRename,
  onMove,
  onDelete,
}: {
  folderName: string;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <Menu
      label={`More actions for ${folderName}`}
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
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onRename();
            }}
            className={MENU_ITEM_CLASS}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onMove();
            }}
            className={MENU_ITEM_CLASS}
          >
            Move
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onDelete();
            }}
            className={MENU_ITEM_CLASS}
          >
            Delete
          </button>
        </>
      )}
    </Menu>
  );
}
