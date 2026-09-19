// Suggestion review (library-collections task 009, spec F2/F5): the
// post-scan notification over browse.
//
// * One-line notification banner — the library page stays quiet; the
//   backlog itself lives behind the "Review" button in a modal dialog.
// * Self-fetching; renders nothing while empty/failed — browse stays
//   exactly as it was for users without suggestions.
// * Per-row Accept/Dismiss in the dialog with optimistic removal and
//   rollback — a failed action keeps the row and surfaces a Retry.
// * Accept also invalidates the collections list so the collections rail
//   picks up the new collection immediately.
// * "Later" snoozes against the staging regeneration timestamp: the
//   newest `created_at` is stored in localStorage and the banner stays
//   hidden until a later scan stages newer groups. Nothing ever enters
//   browse without acceptance — the panel is informational.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  acceptCollectionSuggestion,
  collectionsQueryKeys,
  dismissCollectionSuggestion,
  fetchCollectionSuggestions,
} from "../../api/collections";
import type {
  CollectionKind,
  CollectionSuggestionDto,
} from "../../api/types";
import { Thumbnail } from "../thumbnail";
import { Button } from "../ui/button";
import { buttonClasses } from "../ui/button-classes";
import { Dialog } from "../ui/dialog";

const KIND_LABELS: Record<CollectionKind, string> = {
  show: "Series",
  movie: "Movie",
  time: "Time group",
  manual: "Collection",
};

/** Rows shown before "Show more" expands the list (spec F2: don't dump a
 * backlog on first-run users). */
const COLLAPSED_ROWS = 3;
/** Preview members requested per group (posters for the card). */
const PREVIEW_MEMBERS = 6;
const SNOOZE_KEY = "castify.suggestions.snoozedThrough";

export function SuggestionPanel() {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Snooze state is read once at mount and written on "Later";
  // the local copy is what hides the banner (localStorage only
  // persists the decision across reloads).
  const [snoozedThrough, setSnoozedThrough] = useState<string | null>(() =>
    localStorage.getItem(SNOOZE_KEY),
  );
  const suggestions = useQuery({
    queryKey: collectionsQueryKeys.suggestions,
    queryFn: () => fetchCollectionSuggestions({ preview: PREVIEW_MEMBERS }),
  });

  const groups = suggestions.data;
  const hasGroups = !!groups && groups.length > 0;
  // Hidden when empty — unless the dialog is mid-review and the last row
  // was just acted on (closing the modal on the user would be jarring;
  // "Done" dismisses it and the banner is gone on the next render).
  if (!hasGroups && !open) return null;

  // Snooze gate: hidden while no group is newer than what the user
  // already chose to review later.
  const newest =
    groups && groups.length > 0
      ? groups.reduce(
          (max, g) => (g.created_at > max ? g.created_at : max),
          groups[0].created_at,
        )
      : "";
  if (snoozedThrough !== null && newest <= snoozedThrough && !open)
    return null;

  const visible = expanded ? groups : groups?.slice(0, COLLAPSED_ROWS);
  const hiddenCount = (groups?.length ?? 0) - COLLAPSED_ROWS;
  const countLabel =
    groups?.length === 1
      ? "1 suggested collection"
      : `${groups?.length ?? 0} suggested collections`;

  return (
    <>
      <section
        aria-label="Review suggestions"
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-4 py-3"
      >
        <p className="text-sm">
          <span className="font-medium">{countLabel} ready to review.</span>{" "}
          <span className="text-[var(--color-castify-muted)]">
            Found by your scans — nothing is added until you accept.
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" onClick={() => setOpen(true)}>
            Review
          </Button>
          <button
            type="button"
            onClick={() => {
              localStorage.setItem(SNOOZE_KEY, newest);
              setSnoozedThrough(newest);
            }}
            className={buttonClasses("ghost", "sm")}
          >
            Later
          </button>
        </div>
      </section>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Review suggestions"
        wide
        footer={
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Done
          </Button>
        }
      >
        {hasGroups ? (
          <>
            <ul className="space-y-3">
              {visible?.map((group) => (
                <SuggestionRow key={group.id} group={group} />
              ))}
            </ul>
            {!expanded && hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className={buttonClasses("ghost", "sm")}
              >
                Show more ({hiddenCount})
              </button>
            )}
          </>
        ) : (
          <p className="text-sm text-[var(--color-castify-muted)]">
            All caught up — accepted collections are in your library.
          </p>
        )}
      </Dialog>
    </>
  );
}

function SuggestionRow({ group }: { group: CollectionSuggestionDto }) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<"accept" | "dismiss" | null>(
    null,
  );

  // Optimistic removal from the suggestions cache; rollback on error so
  // the row (and the user's decision) survives a failed request.
  function removeOptimistically(id: string) {
    queryClient.setQueryData<CollectionSuggestionDto[]>(
      collectionsQueryKeys.suggestions,
      (current) => current?.filter((g) => g.id !== id) ?? current,
    );
  }

  const accept = useMutation({
    mutationFn: () => acceptCollectionSuggestion(group.id),
    onMutate: () => {
      setActionError(null);
      removeOptimistically(group.id);
    },
    onError: () => setActionError("accept"),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: collectionsQueryKeys.suggestions,
      });
      void queryClient.invalidateQueries({
        queryKey: collectionsQueryKeys.all,
      });
    },
  });

  const dismiss = useMutation({
    mutationFn: () => dismissCollectionSuggestion(group.id),
    onMutate: () => {
      setActionError(null);
      removeOptimistically(group.id);
    },
    onError: () => setActionError("dismiss"),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: collectionsQueryKeys.suggestions,
      });
    },
  });

  const countLabel =
    group.member_count === 1 ? "1 video" : `${group.member_count} videos`;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] p-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex shrink-0">
          {group.members.slice(0, 4).map((video) => (
            <div
              key={video.id}
              className="-ml-4 h-12 w-20 overflow-hidden rounded border border-[var(--color-castify-rule)] first:ml-0"
            >
              <Thumbnail video={video} />
            </div>
          ))}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{group.title}</p>
          <p className="text-xs text-[var(--color-castify-muted)]">
            {`${KIND_LABELS[group.kind]} · ${countLabel}`}
          </p>
          {actionError && (
            <p role="alert" className="text-xs text-[var(--color-danger)]">
              {`Couldn't ${actionError} — `}
              <button
                type="button"
                className="underline"
                onClick={() =>
                  actionError === "accept" ? accept.mutate() : dismiss.mutate()
                }
              >
                Retry
              </button>
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          aria-label={`Accept ${group.title}`}
          disabled={accept.isPending || dismiss.isPending}
          onClick={() => accept.mutate()}
          className={buttonClasses("primary", "sm")}
        >
          Accept
        </button>
        <button
          type="button"
          aria-label={`Dismiss ${group.title}`}
          disabled={accept.isPending || dismiss.isPending}
          onClick={() => dismiss.mutate()}
          className={buttonClasses("ghost", "sm")}
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}
