// LibraryFolderMenu (library-folders task 008) — the curated folder
// tile's kebab, sibling of ShareFolderMenu: built on the ui/Menu
// primitive with the same a11y contract (labelled trigger, arrow
// cycling, Escape restore, outside-click dismissal). One callback per
// action and only the actions provided render — folder tiles carry
// Rename / Move / Delete, the pinned Unfiled tile carries New folder.
// The menu closes on pick; the organizer owns the dialogs/mutations.

import { Menu, MENU_ITEM_CLASS } from "./ui/menu";

/** Dark chip — the trigger rides the tile's glyph well, matching
 *  ShareFolderMenu's placement on PosterCard-style tiles. */
const TRIGGER_CLASS =
  "flex h-7 w-7 items-center justify-center rounded-[var(--radius-button)] " +
  "bg-black/60 text-white/80 transition hover:bg-black/80 hover:text-white " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]";

export function LibraryFolderMenu({
  label,
  onNewFolder,
  onRename,
  onMove,
  onDelete,
}: {
  /** The tile's accessible name (folder name or "Unfiled"). */
  label: string;
  onNewFolder?: () => void;
  onRename?: () => void;
  onMove?: () => void;
  onDelete?: () => void;
}) {
  const actions: Array<{ name: string; run: () => void }> = [];
  if (onNewFolder !== undefined) actions.push({ name: "New folder", run: onNewFolder });
  if (onRename !== undefined) actions.push({ name: "Rename", run: onRename });
  if (onMove !== undefined) actions.push({ name: "Move", run: onMove });
  if (onDelete !== undefined) actions.push({ name: "Delete", run: onDelete });

  return (
    <Menu
      label={`More actions for ${label}`}
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
          {actions.map((action) => (
            <button
              key={action.name}
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                action.run();
              }}
              className={MENU_ITEM_CLASS}
            >
              {action.name}
            </button>
          ))}
        </>
      )}
    </Menu>
  );
}
