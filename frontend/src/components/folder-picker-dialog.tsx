// FolderPickerDialog — the shared folder picker behind "Move"
// (library-folders task 006), extracted from ShareMoveDialog. One
// component, two consumers: share pages pass the share's folders with
// `rootLabel="Share root"`, the library organizer passes the curated
// tree with `rootLabel="Unfiled"`. Behavior is frozen from the share
// original.
//
// Renders the whole folder tree (DFS from root, indented by depth) plus
// the root choice; a pick reports the target scope (`null` = root).
// When moving a folder, the caller passes `excludeSubtreeOf` so the
// folder's own subtree is unpickable — a client-side pre-check for the
// obvious cycle; the server's cycle/depth walk remains the enforcement.

import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

/** The minimal folder shape the picker walks — shared by share folders
 *  and curated library folders. */
export interface PickerFolder {
  id: string;
  parent_id: string | null;
  name: string;
  position: number;
}

type FolderPickerDialogProps = {
  /** Dialog heading, e.g. `Move "Trip"` — names the thing being moved. */
  title: string;
  /** Label for the root choice — "Share root" or "Unfiled". */
  rootLabel: string;
  /** The full flat folder list (the tree payload's `folders`). */
  folders: PickerFolder[];
  /** Folder id whose subtree is unpickable (self + descendants). */
  excludeSubtreeOf?: string;
  /** The mover's current scope: that choice renders disabled with a
   * "current" marker — re-picking it is a no-op, so it isn't offered. */
  currentFolderId?: string | null;
  /** Pending state for the driving mutation (disables picks). */
  pending?: boolean;
  onPick: (target: string | null) => void;
  onClose: () => void;
};

/** Depth-first walk from the root, skipping the excluded subtree.
 * `depth` starts at 0 for root-level folders (root choice is separate). */
function walkTree(
  folders: PickerFolder[],
  excludeSubtreeOf: string | undefined,
): Array<{ folder: PickerFolder; depth: number }> {
  const byParent = new Map<string | null, PickerFolder[]>();
  for (const folder of folders) {
    const siblings = byParent.get(folder.parent_id) ?? [];
    siblings.push(folder);
    byParent.set(folder.parent_id, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.position - b.position);
  }

  const rows: Array<{ folder: PickerFolder; depth: number }> = [];
  const visit = (parentId: string | null, depth: number): void => {
    for (const folder of byParent.get(parentId) ?? []) {
      if (folder.id === excludeSubtreeOf) continue;
      rows.push({ folder, depth });
      visit(folder.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

const CHOICE_CLASS =
  "block w-full rounded-[var(--radius-button)] px-3 py-2 text-left text-sm transition " +
  "hover:bg-[var(--color-castify-accent-subtle)] focus:outline-none " +
  "focus-visible:bg-[var(--color-castify-accent-subtle)] disabled:cursor-not-allowed disabled:opacity-50";

export function FolderPickerDialog({
  title,
  rootLabel,
  folders,
  excludeSubtreeOf,
  currentFolderId,
  pending = false,
  onPick,
  onClose,
}: FolderPickerDialogProps) {
  const rows = walkTree(folders, excludeSubtreeOf);
  // `currentFolderId` is optional: undefined = caller doesn't track a
  // current scope (no marker); null = the mover currently sits at root.
  const rootIsCurrent = currentFolderId === null;

  return (
    <Dialog open onClose={onClose} title={title}>
      <div className="flex min-h-0 w-full flex-col gap-4">
        {/* Immediate actions, not a select-then-confirm — each row is a
            plain button; the tree structure lives in the indentation. */}
        <div
          aria-label="Destination"
          className="max-h-80 space-y-1 overflow-y-auto pr-1"
        >
          <button
            type="button"
            disabled={pending || rootIsCurrent}
            onClick={() => onPick(null)}
            className={CHOICE_CLASS}
          >
            {rootLabel}
            {rootIsCurrent ? " · current" : ""}
          </button>
          {rows.map(({ folder, depth }) => {
            const isCurrent = folder.id === currentFolderId;
            return (
              <button
                key={folder.id}
                type="button"
                disabled={pending || isCurrent}
                onClick={() => onPick(folder.id)}
                className={CHOICE_CLASS}
                style={{ paddingLeft: 12 + depth * 16 }}
              >
                {folder.name}
                {isCurrent ? " · current" : ""}
              </button>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
