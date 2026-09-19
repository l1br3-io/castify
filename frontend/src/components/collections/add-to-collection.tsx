// Add-to-collection picker (library-collections task 010, spec F5 /
// user story 2): the per-video "add to collection" affordance.
//
// * `variant="card"` — kebab chip riding PosterCard's meta row (via
//   `menuSlot`); video-only by construction (FileCard never mounts it).
// * `variant="hero"` — labeled button beside the watch page's favorite
//   and rating controls.
//
// The listing query is lazy — it only fires once the menu is first
// opened (a browse grid renders dozens of cards; eager per-video
// membership queries would flood the API). Each row toggles membership
// with a checkmark for current members; "New collection…" creates a
// manual collection and adds the video in one flow.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addCollectionItem,
  collectionsQueryKeys,
  createCollection,
  fetchCollections,
  removeCollectionItem,
} from "../../api/collections";
import type { VideoSummaryDto } from "../../api/types";
import { Menu, MENU_ITEM_CLASS } from "../ui/menu";

const DARK_TRIGGER_CLASS =
  "flex h-7 w-7 items-center justify-center rounded-[var(--radius-button)] " +
  "text-[var(--color-castify-muted)] transition hover:bg-[var(--color-castify-accent-subtle)] " +
  "hover:text-[var(--color-castify-text)] focus:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-[var(--color-focus)]";

// Hero variant rides the watch page's personalization row next to the
// Share button — a labeled trigger in the same secondary family
// (Button secondary/sm: border + px-3 py-1.5 text-xs). Content-sized, so
// it grows with the label and the wrapping row keeps working at phone
// widths. (Regression: it used to inherit the Menu's fixed h-7 w-7
// kebab square, which the text label overflowed.)
const HERO_TRIGGER_CLASS =
  "inline-flex items-center rounded-[var(--radius-button)] " +
  "border border-[var(--color-castify-rule)] px-3 py-1.5 text-xs " +
  "font-semibold text-[var(--color-castify-text)] transition " +
  "hover:bg-[var(--color-castify-hover)] active:bg-[var(--color-castify-press)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)]";

type Props = {
  video: Pick<VideoSummaryDto, "id" | "name">;
  variant?: "card" | "hero";
};

export function AddToCollectionMenu({ video, variant = "card" }: Props) {
  // Lazy query gate: flipped by the first interaction with the menu.
  const [opened, setOpened] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const queryClient = useQueryClient();

  const collections = useQuery({
    queryKey: collectionsQueryKeys.byVideo(video.id),
    queryFn: () => fetchCollections({ videoId: video.id }),
    enabled: opened,
  });

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: collectionsQueryKeys.all });
  }

  const toggle = useMutation({
    mutationFn: ({
      collectionId,
      isMember,
    }: {
      collectionId: string;
      isMember: boolean;
    }) =>
      isMember
        ? removeCollectionItem(collectionId, video.id)
        : addCollectionItem(collectionId, video.id),
    onSettled: invalidate,
  });

  const createAndAdd = useMutation({
    mutationFn: async (name: string) => {
      const collection = await createCollection(name);
      await addCollectionItem(collection.id, video.id);
      return collection;
    },
    onSettled: () => {
      setNewName("");
      setCreating(false);
      invalidate();
    },
  });

  return (
    <div onClickCapture={() => setOpened(true)}>
      <Menu
        label={`Add ${video.name} to collection`}
        triggerClassName={
          variant === "card" ? DARK_TRIGGER_CLASS : HERO_TRIGGER_CLASS
        }
        trigger={
          variant === "hero" ? (
            // Responsive label: the full phrase on ≥sm, a compact
            // "Collection" on phones so the watch page's action row wraps
            // cleanly instead of overflowing. The Menu's aria-label keeps
            // the full action name either way.
            <span className="whitespace-nowrap">
              ＋{" "}
              <span className="hidden sm:inline">Add to collection</span>
              <span className="sm:hidden">Collection</span>
            </span>
          ) : (
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
          )
        }
      >
        {(close) => (
          <>
            {collections.isPending && (
              <p className="px-3 py-1.5 text-sm opacity-60">Loading…</p>
            )}
            {collections.isError && (
              <p className="px-3 py-1.5 text-sm opacity-60">
                Couldn't load collections.
              </p>
            )}
            {collections.data?.length === 0 && !creating && (
              <p className="px-3 py-1.5 text-sm opacity-60">
                No collections yet.
              </p>
            )}
            {collections.data?.map((collection) => {
              const isMember = collection.contains_video === true;
              return (
                <button
                  key={collection.id}
                  type="button"
                  role="menuitem"
                  disabled={toggle.isPending}
                  aria-checked={isMember}
                  onClick={() =>
                    toggle.mutate({ collectionId: collection.id, isMember })
                  }
                  className={MENU_ITEM_CLASS}
                >
                  <span aria-hidden className="mr-2 inline-block w-4">
                    {isMember ? "✓" : ""}
                  </span>
                  {collection.name}
                </button>
              );
            })}

            {creating ? (
              <form
                className="flex items-center gap-1 px-2 py-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = newName.trim();
                  if (name !== "") createAndAdd.mutate(name);
                }}
              >
                <input
                  aria-label="New collection name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Collection name"
                  className="min-w-0 flex-1 rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-canvas)] px-2 py-1 text-sm"
                />
                <button
                  type="submit"
                  disabled={newName.trim() === "" || createAndAdd.isPending}
                  className="rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-2 py-1 text-sm font-medium disabled:opacity-50"
                >
                  Create
                </button>
              </form>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => setCreating(true)}
                className={MENU_ITEM_CLASS}
              >
                New collection…
              </button>
            )}
            {createAndAdd.isSuccess && (
              <p className="px-3 pb-1 pt-0.5 text-xs opacity-60">Added.</p>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={close}
              className={MENU_ITEM_CLASS}
            >
              Done
            </button>
          </>
        )}
      </Menu>
    </div>
  );
}
