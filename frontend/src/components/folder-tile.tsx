// FolderTile — the shared folder half of a browse grid
// (library-folders task 006), extracted from ShareFolderTile: one grid
// cell mirroring PosterCard's footprint — a 16:9 well with a folder
// glyph instead of a thumbnail, the name, and the direct child count —
// linking to the same route with `?<searchParam>=<folderId>`. One
// component, two consumers (share pages and the library organizer) —
// no forked siblings.
//
// The stretched `<Link>` mirrors PosterCard's accessibility contract:
// keyboard-focusable, descriptive `aria-label`, focus ring drawn around
// the whole tile via `focus-within:ring` on the article. Owner surfaces
// layer a `topRightSlot` kebab on the glyph well — same placement
// item menus take on PosterCard.

import { type ReactNode } from "react";
import { Link } from "react-router-dom";

import { FolderIcon } from "./icons";

type FolderTileProps = {
  name: string;
  /** Folder id appended as the search param's value. */
  folderId: string;
  /** Base route the tile navigates within — folder descent is pure URL
   *  state. */
  to: string;
  /** Search param carrying the folder id (default `folder`). */
  searchParam?: string;
  /** Direct children (subfolders + items) — the badge under the name. */
  count: number;
  /** Owner-only overlay: the folder's kebab menu. Renders above the
   *  stretched link so its controls stay clickable. */
  topRightSlot?: ReactNode;
  /** Drag-and-drop (drag-and-drop effort): spread drop-target pointer
   *  props onto the tile root. */
  onPointerEnter?: (event: React.PointerEvent) => void;
  onPointerLeave?: (event: React.PointerEvent) => void;
  /** Valid drop target hovered mid-drag: raw-amber border +
   *  accent-subtle fill on the glyph well. */
  dropHovered?: boolean;
  /** Post-drop count while hovered (`13 → 16` in the count badge);
   *  null/undefined renders the plain count. */
  countPreview?: number | null;
  /** Invalid target hovered mid-drag (folder onto its own subtree,
   *  depth cap): muted strike-through label + not-allowed cursor —
   *  deliberately no amber. */
  dropInvalid?: boolean;
  /** Drag source (drag-and-drop effort): pointer-down wiring for the
   *  tile (folder reparent drags). See PosterCard's `dragHandle`. */
  dragHandle?: {
    onPointerDown: (event: React.PointerEvent) => void;
    /** Marks the tile for the sibling-reorder hit-testing query. */
    reorderKey?: string;
  };
  /** Insertion caret for sibling reorder (task 007) — grid semantics:
   *  leading/trailing edges, 2px amber rule + eased gap. */
  reorderCaret?: "before" | "after";
};

export function FolderTile({
  name,
  folderId,
  to,
  searchParam = "folder",
  count,
  topRightSlot,
  onPointerEnter,
  onPointerLeave,
  dropHovered = false,
  countPreview = null,
  dropInvalid = false,
  dragHandle,
  reorderCaret,
}: FolderTileProps) {
  return (
    <article
      className={`group relative flex flex-col gap-2 transition-[margin] duration-150 ease-out motion-reduce:transition-none ${dropInvalid ? "cursor-not-allowed" : ""}`}
      onPointerDown={dragHandle?.onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      data-reorder-key={dragHandle?.reorderKey}
      style={{
        marginLeft: reorderCaret === "before" ? 14 : 0,
        marginRight: reorderCaret === "after" ? 14 : 0,
      }}
    >
      <Link
        to={{
          pathname: to,
          search: `?${searchParam}=${encodeURIComponent(folderId)}`,
        }}
        aria-label={`Open folder ${name}`}
        className="absolute inset-0 z-0 rounded-[var(--radius-card)] outline-none
                   focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]
                   focus-visible:ring-offset-2
                   focus-visible:ring-offset-[var(--color-castify-canvas)]"
      />
      <div
        className={`relative flex aspect-video items-center justify-center rounded-[var(--radius-card)]
                    border transition-colors
                    ${
                      dropHovered
                        ? "border-[var(--color-castify-accent)] bg-[var(--color-castify-accent-subtle)]"
                        : "border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] group-hover:border-[var(--color-castify-accent)] group-focus-within:border-[var(--color-castify-accent)]"
                    }
                    ${reorderCaret === "before" ? "shadow-[-2px_0_0_0_var(--color-castify-accent)]" : ""}
                    ${reorderCaret === "after" ? "shadow-[2px_0_0_0_var(--color-castify-accent)]" : ""}
                    text-[var(--color-castify-muted)]`}
      >
        <FolderIcon className="h-10 w-10" />
        {topRightSlot && <span className="absolute right-2 top-2 z-10">{topRightSlot}</span>}
      </div>
      <div className="flex flex-col gap-1">
        <h3
          className={`line-clamp-2 text-[13px] font-semibold leading-snug group-hover:underline group-focus-within:underline ${
            dropInvalid ? "line-through opacity-60" : ""
          }`}
          title={name}
        >
          {name}
        </h3>
        <p className="text-xs text-[var(--color-castify-muted)]">
          {countPreview !== null
            ? `${count} → ${countPreview} items`
            : `${count} ${count === 1 ? "item" : "items"}`}
        </p>
      </div>
    </article>
  );
}
