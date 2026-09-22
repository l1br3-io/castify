// Collection detail page (library-collections task 008, spec F5): the
// ordered member grid for one collection, mounted at
// `/collections/:id` inside the app shell.
//
// * Play-all rides the existing ephemeral watch queue: a link to the
//   first member carrying `{ queue }` in router state — the same
//   mechanism PosterCard/Shelf use (M3 T11), so no new player plumbing.
// * Rename is an inline two-step (Edit → Save) — time groups are
//   auto-titled but editable (spec open question 4).
// * Delete is confirm-first via the shared Dialog; on success the page
//   navigates back to the library.

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import type { CollectionKind } from "../../api/types";
import { PROVIDER_LABELS } from "../../api/types";
import { FavoriteToggle } from "../favorite-toggle";
import { PosterCard } from "../poster-card";
import { ListView, type ListViewRow } from "../list-view";
import { ViewToggle } from "../view-toggle";
import { RatingStars } from "../rating-stars";
import { ShareDialog } from "../share-dialog";
import { Dialog } from "../ui/dialog";
import { EmptyState } from "../ui/empty-state";
import { ErrorState } from "../ui/error-state";
import { SkeletonGrid } from "../ui/skeleton-grid";
import { buttonClasses } from "../ui/button-classes";
import {
  useCollection,
  useDeleteCollection,
  useRenameCollection,
} from "../../hooks/use-collections";
import { useViewMode } from "../../hooks/use-view-mode";
import { formatDate, formatDuration, formatSize } from "../../lib/format";

const KIND_LABELS: Record<CollectionKind, string> = {
  show: "Series",
  movie: "Movie",
  time: "Time group",
  manual: "Collection",
};

export function CollectionDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const collection = useCollection(id);
  const rename = useRenameCollection();
  const remove = useDeleteCollection();

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Per-device presentation (library-list-view task 006).
  const [viewMode, setViewMode] = useViewMode();

  if (collection.isPending) {
    return <SkeletonGrid count={8} />;
  }
  if (collection.isError) {
    return (
      <ErrorState
        title="Couldn't load this collection."
        onRetry={() => void collection.refetch()}
      />
    );
  }

  const { name, kind, members } = collection.data;
  const queue = members.map((m) => m.id);
  const countLabel = members.length === 1 ? "1 video" : `${members.length} videos`;

  function submitRename(): void {
    const trimmed = nameDraft.trim();
    if (trimmed === "" || trimmed === name) {
      setEditingName(false);
      return;
    }
    rename.mutate(
      { id, name: trimmed },
      {
        onSettled: () => setEditingName(false),
      },
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link
            to="/"
            className="text-sm text-[var(--color-castify-accent-strong)] transition hover:opacity-80"
          >
            ← Library
          </Link>
          {editingName ? (
            <div className="flex items-center gap-2">
              <input
                aria-label="Collection name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitRename();
                  if (e.key === "Escape") setEditingName(false);
                }}
                className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-canvas)] px-2 py-1 text-xl"
                autoFocus
              />
              <button
                type="button"
                onClick={submitRename}
                className={buttonClasses("primary", "sm")}
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditingName(false)}
                className={buttonClasses("ghost", "sm")}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <h1 className="text-2xl">{name}</h1>
              <button
                type="button"
                onClick={() => {
                  setNameDraft(name);
                  setEditingName(true);
                }}
                className={buttonClasses("ghost", "sm")}
              >
                Rename
              </button>
            </div>
          )}
          <p className="text-sm text-[var(--color-castify-muted)]">
            {`${KIND_LABELS[kind]} · ${countLabel}`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <ViewToggle mode={viewMode} onModeChange={setViewMode} />
          {members.length > 0 && (
            <Link
              to={`/watch/${members[0].id}`}
              state={{ queue }}
              className={buttonClasses("primary", "sm")}
            >
              Play all
            </Link>
          )}
          {/* Visible-but-disabled when empty (unlike Play all's
              conditional render) so removing the last member doesn't
              shift the header layout. */}
          <button
            type="button"
            disabled={members.length === 0}
            title={
              members.length === 0
                ? "Empty collections can't be shared"
                : undefined
            }
            onClick={() => setShareOpen(true)}
            className={buttonClasses("secondary", "sm")}
          >
            Share
          </button>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className={buttonClasses("destructive", "sm")}
          >
            Delete
          </button>
        </div>
      </div>

      {members.length === 0 ? (
        <EmptyState
          title="This collection is empty"
          body="Add videos from any browse card or the watch page."
          onAction={() => navigate("/")}
          actionLabel="Back to library"
        />
      ) : viewMode === "list" ? (
        // List mode (library-list-view task 006): the browse column set —
        // Name · Duration · Size · Provider · Added. Rating stays a card
        // affordance (the watch page owns full ratings).
        <ListView
          ariaLabel="Collection members"
          rows={members.map(
            (video): ListViewRow => ({
              id: video.id,
              name: video.name,
              href: `/watch/${video.id}`,
              linkState: { queue },
              thumbnail: { video },
              columns: [
                {
                  key: "duration",
                  label: "Duration",
                  mono: true,
                  value:
                    video.duration_ms !== null
                      ? formatDuration(video.duration_ms)
                      : "—",
                },
                {
                  key: "size",
                  label: "Size",
                  mono: true,
                  numeric: true,
                  className: "hidden md:table-cell",
                  value: formatSize(video.size_bytes),
                },
                {
                  key: "provider",
                  label: "Provider",
                  className: "hidden xl:table-cell",
                  value: PROVIDER_LABELS[video.provider] ?? video.provider,
                },
                {
                  key: "added",
                  label: "Added",
                  mono: true,
                  className: "hidden lg:table-cell",
                  value: formatDate(video.created_at),
                },
              ],
              favoriteSlot: <FavoriteToggle video={video} />,
            }),
          )}
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {members.map((video) => (
            <PosterCard
              key={video.id}
              video={video}
              href={`/watch/${video.id}`}
              queue={queue}
              topRightSlot={<FavoriteToggle video={video} />}
              ratingSlot={<RatingStars video={video} />}
            />
          ))}
        </div>
      )}

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Delete collection"
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className={buttonClasses("ghost")}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() =>
                remove.mutate(id, {
                  onSuccess: () => void navigate("/"),
                })
              }
              className={buttonClasses("destructive")}
            >
              Yes, delete
            </button>
          </>
        }
      >
        <p className="text-sm text-[var(--color-castify-muted)]">
          Delete &ldquo;{name}&rdquo;? The collection and its member list are
          removed — your videos stay in the library.
        </p>
      </Dialog>

      {shareOpen && (
        <ShareDialog
          videoIds={queue}
          itemLabel={name}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}
