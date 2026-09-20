// LibraryItemMenu (library-folders task 009) — the per-item kebab in
// the curated contents listing: "Move to folder" (a single move is the
// degenerate batch of one). Same ui/Menu a11y contract as the folder
// kebab; hidden in select mode, where clicks toggle selection instead.

import { Menu, MENU_ITEM_CLASS } from "./ui/menu";

const TRIGGER_CLASS =
  "flex h-7 w-7 items-center justify-center rounded-[var(--radius-button)] " +
  "bg-black/50 text-white/80 transition hover:bg-black/70 hover:text-white " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]";

export function LibraryItemMenu({
  itemName,
  onMove,
}: {
  itemName: string;
  onMove: () => void;
}) {
  return (
    <Menu
      label={`More actions for ${itemName}`}
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
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            onMove();
          }}
          className={MENU_ITEM_CLASS}
        >
          Move to folder
        </button>
      )}
    </Menu>
  );
}
