// ShareSearchResults (share-search-ux task 003) — the shared chrome for
// whole-share search on both share surfaces: the count readout, the
// empty-state-with-clear, and the per-video folder-path label. The card
// grid itself stays page-owned (rendered as `children`): the public page
// renders read-only PosterCards while the manage page layers kebab menus
// and removal dimming — one chrome, two grids, no render-props coupling
// mutation UI into the recipient surface.
//
// Design (task 005): the readout is the app's instrument voice — IBM
// Plex Mono (the wordmark's face), muted, behind a small accent tick.
// The tick is the results-mode thread: on the manage page it picks up
// the accent border the toolbar rail shifts to while searching. Paths
// ride the same mono data voice.
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
  /** The active query (trimmed) — shown in the readout and empty state. */
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
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-3.5 w-[3px] shrink-0 rounded-full bg-[var(--color-castify-accent)]"
        />
        {/* A <p>, not a heading: the unlayered h1–h4 rule in index.css
            forces the display face over any utility, and a readout wants
            regular-weight mono anyway. The section's aria-label carries
            the structural role. */}
        <p className="font-mono text-xs tracking-wide text-[var(--color-castify-muted)]">
          {total} {total === 1 ? "result" : "results"} for “{query}”
        </p>
      </div>
      {children}
    </section>
  );
}

/** Where a search hit lives: folder names root → leaf (the tree module's
 * `folderPath`), or the share root itself for top-level videos. Rendered
 * under the card because PosterCard has no label slot — wrapping keeps
 * the card API untouched for every other caller. Mono carries the
 * readout voice from the count header into each card's location. */
export function ShareResultPathLabel({ path, rootLabel }: { path: string[]; rootLabel: string }) {
  const label = path.length > 0 ? path.join(" / ") : rootLabel;
  return (
    <p
      className="flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-castify-muted)]"
      title={label}
    >
      <FolderIcon className="h-3 w-3 shrink-0 opacity-70" />
      <span className="truncate">{label}</span>
    </p>
  );
}
