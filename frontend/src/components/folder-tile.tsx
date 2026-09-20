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
};

export function FolderTile({
  name,
  folderId,
  to,
  searchParam = "folder",
  count,
  topRightSlot,
}: FolderTileProps) {
  return (
    <article className="group relative flex flex-col gap-2">
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
        className="relative flex aspect-video items-center justify-center rounded-[var(--radius-card)]
                   border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)]
                   text-[var(--color-castify-muted)] transition-colors
                   group-hover:border-[var(--color-castify-accent)]
                   group-focus-within:border-[var(--color-castify-accent)]"
      >
        <FolderIcon className="h-10 w-10" />
        {topRightSlot && <span className="absolute right-2 top-2 z-10">{topRightSlot}</span>}
      </div>
      <div className="flex flex-col gap-1">
        <h3
          className="line-clamp-2 text-[13px] font-semibold leading-snug group-hover:underline group-focus-within:underline"
          title={name}
        >
          {name}
        </h3>
        <p className="text-xs text-[var(--color-castify-muted)]">
          {count} {count === 1 ? "item" : "items"}
        </p>
      </div>
    </article>
  );
}
