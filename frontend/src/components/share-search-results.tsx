// ShareSearchResults (share-search-ux task 003) — the shared chrome for
// whole-share search on both share surfaces: the count header, the
// empty-state-with-clear, and the per-video folder-path label. The card
// grid itself stays page-owned (rendered as `children`): the public page
// renders read-only PosterCards while the manage page layers kebab menus
// and removal dimming — one chrome, two grids, no render-props coupling
// mutation UI into the recipient surface.
//
// Matching folder tiles are rendered by the pages via ShareFolderTile
// directly; its link shape (`?folder=<id>`, query dropped) implements
// the spec's OQ2 default — a folder hit browse-intos the folder with
// the search cleared.

import { type ReactNode } from "react";

import type { ShareSearchResults as ShareSearchResultsData } from "../lib/share-tree";
import { EmptyState } from "./ui/empty-state";
import { FolderIcon } from "./icons";

type ShareSearchResultsProps = {
  /** The active query (trimmed) — shown in the header and empty state. */
  query: string;
  results: ShareSearchResultsData;
  /** Clears the query — the empty state's action and the pages' shared
   * clear behavior (input + URL together, not debounced). */
  onClear: () => void;
  /** The page-owned results grid. */
  children: ReactNode;
};

export function ShareSearchResults({ query, results, onClear, children }: ShareSearchResultsProps) {
  const total = results.folders.length + results.videos.length;

  if (total === 0) {
    return (
      <section aria-label={`Search results for ${query}`}>
        <EmptyState
          title={`No results for “${query}”.`}
          body="Check the spelling, or browse the folders instead."
          onAction={onClear}
          actionLabel="Clear search"
        />
      </section>
    );
  }

  return (
    <section aria-label={`Search results for ${query}`} className="space-y-4">
      <h2 className="text-sm font-medium text-[var(--color-castify-muted)]">
        {total} {total === 1 ? "result" : "results"} for “{query}”
      </h2>
      {children}
    </section>
  );
}

/** Where a search hit lives: folder names root → leaf (the tree module's
 * `folderPath`), or the share root itself for top-level videos. Rendered
 * under the card because PosterCard has no label slot — wrapping keeps
 * the card API untouched for every other caller. */
export function ShareResultPathLabel({ path, rootLabel }: { path: string[]; rootLabel: string }) {
  const label = path.length > 0 ? path.join(" / ") : rootLabel;
  return (
    <p className="flex items-center gap-1.5 text-xs text-[var(--color-castify-muted)]" title={label}>
      <FolderIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </p>
  );
}
