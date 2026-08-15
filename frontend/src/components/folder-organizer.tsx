// FolderOrganizer — the two-pane spine of the M9 home page (FR-7.4).
//
//   ┌ FOLDERS (sidebar, lg+) │ <folder name>     [All · Drive · …] [name filter]
//   │ ▾ Media                │ ┌────┐┌────┐ + list rows (documents etc.)
//   │   ▸ Movies             │ │ ▶  ││ ♪  │
//   └────────────────────────┴ └────┘└────┘ [Previous | Page N of M | Next]
//
// Left: `FolderTree` (selection = `?dir=`, owned by the parent via
// `useFolderDir`). Right: `useFolderContents(dir)` — videos render as the
// existing `PosterCard` (play → `/watch/:id`, queue = this page's videos);
// audio/image render as `FileCard` tiles; document/archive/subtitle/other
// as `FileRow` list rows. The provider chip row filters the pane (replaces
// the old By Provider shelves); the name filter is a plain contains (the
// pane's own concern — global search stays video-scoped).
//
// File/kind filters (FR-5.2's `kind`) are wired through the hook params;
// no UI yet — the chips row is provider-scoped v1.

import { useState } from "react";

import { FileCard, FileRow } from "./file-card";
import { FolderTree } from "./folder-tree";
import { PosterCard } from "./poster-card";
import { FavoriteToggle } from "./favorite-toggle";
import { PROVIDER_LABELS, type FileEntryDto, type FolderEntryDto, type ProviderKey } from "../api/types";
import { useFolderContents } from "../hooks/use-folder-contents";
import { useFolderTree } from "../hooks/use-folder-tree";
import { useFolderDir } from "../hooks/use-folder-dir";
import { describeError } from "../lib/format";
import { Skeleton } from "./ui/skeleton";
import { ErrorState } from "./ui/error-state";

type FolderOrganizerProps = {
  /** Connected providers, in display order — drives the chip row. */
  connectedProviders: ProviderKey[];
};

const LIST_ROW_KINDS = new Set(["document", "archive", "subtitle", "other"]);

/** Type guard: entries rendered as dense list rows (see LIST_ROW_KINDS). */
function isListRowEntry(entry: FolderEntryDto): entry is FileEntryDto {
  return entry.kind !== "video" && LIST_ROW_KINDS.has(entry.kind);
}

export function FolderOrganizer({ connectedProviders }: FolderOrganizerProps) {
  const [dir, setDir] = useFolderDir();
  const tree = useFolderTree();
  const [page, setPage] = useState(1);
  const [providerFilter, setProviderFilter] = useState<string | undefined>();
  const [nameQuery, setNameQuery] = useState("");

  const contents = useFolderContents({
    path: dir,
    page,
    provider: providerFilter,
    q: nameQuery || undefined,
  });

  const folderName = dir === "" ? "(Root)" : dir === "(Unsorted)" ? "(Unsorted)" : dir.split("/").filter(Boolean).pop() ?? dir;

  function handleSelect(path: string): void {
    setDir(path);
    setPage(1);
  }

  function handleChip(value: string | undefined): void {
    setProviderFilter(value);
    setPage(1);
  }

  return (
    <section aria-label="Folder organizer" className="flex flex-col gap-4 lg:flex-row">
      {/* Tree sidebar — full-width pane below lg gets breadcrumbs in task 014. */}
      <div className="hidden w-64 flex-shrink-0 lg:block">
        <div className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto pr-2">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-castify-muted)]">
            Folders
          </h2>
          {tree.isLoading && <Skeleton className="h-40 w-full" />}
          {tree.isError && (
            <p className="text-sm text-[var(--color-castify-muted)]">
              Couldn't load folders.
            </p>
          )}
          {tree.data && (
            <FolderTree nodes={tree.data} selectedPath={dir} onSelect={handleSelect} />
          )}
        </div>
      </div>

      {/* Contents pane */}
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            className="text-xl font-semibold tracking-tight"
            data-testid="contents-path"
            title={dir}
          >
            {folderName}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {/* Provider chips (replaces the old By Provider shelves). */}
            <div role="group" aria-label="Filter by provider" className="flex flex-wrap gap-1">
              <button
                type="button"
                aria-pressed={providerFilter === undefined}
                onClick={() => handleChip(undefined)}
                className={`rounded-[var(--radius-pill)] border px-3 py-1 text-xs font-medium transition ${
                  providerFilter === undefined
                    ? "border-[var(--color-castify-accent)] bg-[var(--color-castify-accent-subtle)] text-[var(--color-castify-accent)]"
                    : "border-[var(--color-castify-rule)] text-[var(--color-castify-muted)] hover:border-[var(--color-castify-accent)]/40"
                }`}
              >
                All
              </button>
              {connectedProviders.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  aria-pressed={providerFilter === provider}
                  onClick={() => handleChip(provider)}
                  className={`rounded-[var(--radius-pill)] border px-3 py-1 text-xs font-medium transition ${
                    providerFilter === provider
                      ? "border-[var(--color-castify-accent)] bg-[var(--color-castify-accent-subtle)] text-[var(--color-castify-accent)]"
                      : "border-[var(--color-castify-rule)] text-[var(--color-castify-muted)] hover:border-[var(--color-castify-accent)]/40"
                  }`}
                >
                  {PROVIDER_LABELS[provider]}
                </button>
              ))}
            </div>
            {/* Name filter — the pane's own contains-filter (no FTS). */}
            <input
              type="search"
              aria-label="Filter by name"
              placeholder="Filter by name"
              value={nameQuery}
              onChange={(e) => {
                setNameQuery(e.target.value);
                setPage(1);
              }}
              className="w-44 rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-3 py-1.5 text-sm placeholder:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
            />
          </div>
        </div>

        {contents.isLoading && <Skeleton className="h-48 w-full" />}
        {contents.isError && (
          <ErrorState
            title="Couldn't load this folder."
            body={describeError(contents.error)}
            onRetry={() => contents.refetch()}
          />
        )}
        {contents.data && contents.data.entries.length === 0 && (
          <p className="rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-4 py-6 text-center text-sm text-[var(--color-castify-muted)]">
            This folder is empty.
          </p>
        )}
        {contents.data && contents.data.entries.length > 0 && (
          <>
            {/* Grid children: videos + tile files; list kinds render as rows
                below (a mixed grid breaks on wildly different card heights). */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
              {contents.data.entries
                .filter((e) => e.kind === "video" || e.kind === "audio" || e.kind === "image")
                .map((entry) =>
                  entry.kind === "video" ? (
                    <PosterCard
                      key={entry.id}
                      video={entry}
                      href={`/watch/${entry.id}`}
                      queue={contents.data!.entries
                        .filter((v) => v.kind === "video")
                        .map((v) => v.id)}
                      topRightSlot={<FavoriteToggle video={entry} />}
                    />
                  ) : (
                    <FileCard key={entry.id} file={entry} />
                  ),
                )}
            </div>
            {/* List children: documents/archives/subtitles/other. */}
            <div className="space-y-2">
              {contents.data.entries.filter(isListRowEntry).map((entry) => (
                <FileRow key={entry.id} file={entry} />
              ))}
            </div>

            {contents.data.total > contents.data.limit && (
              <div className="flex items-center justify-between gap-4 pt-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-4 py-2 text-sm transition hover:bg-[var(--color-castify-accent-subtle)] disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-sm text-[var(--color-castify-muted)]">
                  Page {page} of {Math.max(1, Math.ceil(contents.data.total / contents.data.limit))}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page >= Math.ceil(contents.data.total / contents.data.limit)}
                  className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-4 py-2 text-sm transition hover:bg-[var(--color-castify-accent-subtle)] disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
