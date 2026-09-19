// ShareFolderTile (share-folders task 005) — the folder half of the share
// browse grid. Serves the recipient landing page and (task 006) the owner
// manage page: one grid cell mirroring PosterCard's footprint — a 16:9
// well with a folder glyph instead of a thumbnail, the name, and the
// direct child count — linking to the same route with `?folder=<id>`.
//
// The stretched `<Link>` mirrors PosterCard's accessibility contract:
// keyboard-focusable, descriptive `aria-label`, focus ring drawn around
// the whole tile via `focus-within:ring` on the article.

import { Link } from "react-router-dom";

import type { ShareFolderDto } from "../api/types";
import { FolderIcon } from "./icons";

type ShareFolderTileProps = {
  folder: ShareFolderDto;
  /** Base route the tile navigates within — the search param is
   * appended (`?folder=<id>`), so folder descent is pure URL state. */
  to: string;
  /** Direct children (subfolders + videos) — the badge under the name. */
  count: number;
};

export function ShareFolderTile({ folder, to, count }: ShareFolderTileProps) {
  return (
    <article className="group relative flex flex-col gap-2">
      <Link
        to={{ pathname: to, search: `?folder=${encodeURIComponent(folder.id)}` }}
        aria-label={`Open folder ${folder.name}`}
        className="absolute inset-0 z-0 rounded-[var(--radius-card)] outline-none
                   focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]
                   focus-visible:ring-offset-2
                   focus-visible:ring-offset-[var(--color-castify-canvas)]"
      />
      <div
        className="flex aspect-video items-center justify-center rounded-[var(--radius-card)]
                   border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)]
                   text-[var(--color-castify-muted)] transition-colors
                   group-hover:border-[var(--color-castify-accent)]
                   group-focus-within:border-[var(--color-castify-accent)]"
      >
        <FolderIcon className="h-10 w-10" />
      </div>
      <div className="flex flex-col gap-1">
        <h3
          className="line-clamp-2 text-[13px] font-semibold leading-snug group-hover:underline group-focus-within:underline"
          title={folder.name}
        >
          {folder.name}
        </h3>
        <p className="text-xs text-[var(--color-castify-muted)]">
          {count} {count === 1 ? "item" : "items"}
        </p>
      </div>
    </article>
  );
}
