// Share manage page (share-manage-page task 003) — the owner-facing detail
// route at `/settings/shares/:id`.
//
// Two-read composition, no new endpoints:
//   * meta   — `useShares()` (the Settings list query, already cached) with
//     a find-by-id; there is no single-share GET, and the list is the
//     server-owned source for status/expiry.
//   * members — `useShareItemsOwned` (the one-shot tree payload). Serves
//     terminal shares too: read-only history, same as the edit dialog's GET.
//
// Browse parity (share-folders task 006): the page renders the same tree
// the recipient landing renders — folder tiles first, then the level's
// videos, `?folder=` descent, breadcrumbs — via the shared `share-tree`
// helpers and `ShareFolderTile`. The owner's additions on top are
// management: per-card item menus (remove/undo rides the PUT until task
// 008), the add-items dialog, and whole-share search (share-search-ux
// task 004): `?q=` overlays `?folder=` with the recipient page's results
// view — count header, folder-path labels, matching folder tiles. Search
// stays render-only: removal targets, undo indices, and the last-item
// guard all read the unfiltered payload, and New folder is disabled
// while searching (spec OQ1 default) since "the current level" is the
// share root in results view.
//
// State machine mirrors the recipient landing (`share.tsx`): pending →
// skeleton, list error → ErrorState retry, unknown id after load →
// not-found card. Terminal shares render the tree with a read-only note —
// removal/add affordances are active-share-only; the server would 409 any
// edit anyway.
//
// Cards reuse `PosterCard` with the owner scope (session-gated thumbnails,
// `/watch/:id` links) — this page is the owner's mirror of what recipients
// see, plus management on top.

import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { PosterCard } from "../components/poster-card";
import { SearchBar } from "../components/search-bar";
import { ShareEditDialog } from "../components/share-edit-dialog";
import { ShareFolderMenu } from "../components/share-folder-menu";
import { FolderTile } from "../components/folder-tile";
import { ShareItemMenu } from "../components/share-item-menu";
import { FolderPickerDialog } from "../components/folder-picker-dialog";
import { ShareResultPathLabel, ShareSearchResults } from "../components/share-search-results";
import { StatusBadge } from "../components/status-badge";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Field, Input } from "../components/ui/field";
import { Skeleton } from "../components/ui/skeleton";
import { SkeletonGrid } from "../components/ui/skeleton-grid";
import {
  appendToShare,
  createShareFolder,
  deleteShareFolder,
  moveShareItem,
  removeShareItem,
  updateShareFolder,
  type ShareDto,
} from "../api/shares";
import type { ShareFolderDto, VideoSummaryDto } from "../api/types";
import { buildShareTree, searchTree, type ShareTreeItem } from "../lib/share-tree";
import { describeError, formatDate } from "../lib/format";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { shareItemsOwnedKey, useShareItemsOwned } from "../hooks/use-share-items";
import { SHARES_QUERY_KEY, useShares } from "../hooks/use-shares";
import { useToast } from "../hooks/use-toast";

/** Undo window — the spec's 5 seconds (info default is 4s). */
const UNDO_TTL_MS = 5000;

/** Last-item guard copy (task 004; server enforces non-empty with 400). */
const LAST_ITEM_HINT =
  "A share needs at least one item — revoke the share instead.";

/** Matches the dialog + browse SearchBar debounce — one filter per pause.
 * The filter itself is client-side (no fetch): members are already loaded. */
const SEARCH_DEBOUNCE_MS = 300;

export function ShareManagePage() {
  const { id } = useParams<{ id: string }>();
  const shares = useShares();
  const share =
    shares.data?.find((s) => s.id === id) ?? null;

  if (shares.isPending) {
    return (
      <section className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-40" />
        <SkeletonGrid />
      </section>
    );
  }

  if (shares.isError) {
    return (
      <section className="space-y-4">
        <ErrorState
          title="Couldn't load this share."
          body={describeError(shares.error)}
          onRetry={() => void shares.refetch()}
        />
      </section>
    );
  }

  if (!share) {
    return (
      <section className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
        <EmptyState
          title="This share doesn't exist."
          body="It may have been created on another device — the list below is everything on this server."
        />
        <div className="mt-4 text-center">
          <Link
            to="/shares"
            className="text-sm text-[var(--color-castify-accent-strong)] hover:underline"
          >
            Back to shares
          </Link>
        </div>
      </section>
    );
  }

  return <ShareDetail share={share} />;
}

function ShareDetail({ share }: { share: ShareDto }) {
  const items = useShareItemsOwned(share.id);
  const queryClient = useQueryClient();
  const toast = useToast();

  // Item removal (share-folders task 008) is the granular DELETE and
  // undo is an append — one item, one request, no list computation. The
  // old PUT-era machinery (a `pendingRemovals` set spanning the
  // stale-cache window, `freshMembers` deduping against in-flight
  // refetches, undo splicing into the freshest id list) is deliberately
  // gone: a single-item DELETE has no list to compute from stale state,
  // so there is no resurrect race to guard and no splice index to get
  // right. The mutation's own pending state dims the card.
  //
  // Undo restores membership only: the append lands the item back at the
  // share root, not its former folder (spec resolved question 3) — the
  // toast never promised placement, and none is restored.
  const lastToastId = useRef<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  /** Item ops change `item_count` (unlike folder ops), so removal/undo
   * invalidate the shares list too — the Settings row refetches its
   * count from the server, no local patching. */
  function invalidateMemberQueries(): Promise<void> {
    void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY });
    return queryClient.invalidateQueries({
      queryKey: shareItemsOwnedKey(share.id),
    });
  }

  async function undoRemoval(video: VideoSummaryDto): Promise<void> {
    try {
      await appendToShare(share.id, [video.id]);
      await invalidateMemberQueries();
    } catch {
      toast.error("Couldn't restore the item. Reload the page and try again.");
    }
  }

  function pushUndoToast(video: VideoSummaryDto): void {
    if (lastToastId.current !== null) {
      toast.dismiss(lastToastId.current);
    }
    lastToastId.current = toast.info(`Removed '${video.name}'`, {
      ttlMs: UNDO_TTL_MS,
      action: {
        label: "Undo",
        onAction: () => void undoRemoval(video),
      },
    });
  }

  const remove = useMutation({
    mutationFn: ({ video }: { video: VideoSummaryDto }) =>
      removeShareItem(share.id, video.id),
    onMutate: () => setRemoveError(null),
    onSuccess: async (_data, { video }) => {
      // Await before offering Undo (same ordering as ever): the undo's
      // append must land against a membership that already reflects the
      // removal, and the toast should describe the refetched truth.
      await invalidateMemberQueries();
      pushUndoToast(video);
    },
    onError: (error: unknown) => {
      setRemoveError(describeError(error));
    },
  });

  function handleRemove(video: VideoSummaryDto): void {
    remove.mutate({ video });
  }

  // Item move (task 008): the shared picker PATCHes placement; the tree
  // payload refetches (item_count can't change — folders are
  // organization, placement is presentation).
  const [movingVideo, setMovingVideo] = useState<ShareTreeItem | null>(null);
  const moveItem = useMutation({
    mutationFn: ({ video, target }: { video: ShareTreeItem; target: string | null }) =>
      moveShareItem(share.id, video.id, { folder_id: target }),
    onSuccess: async () => {
      await invalidateTree();
      setMovingVideo(null);
    },
  });

  const count = items.data?.items.length ?? share.item_count;
  const canRemoveItems = (items.data?.items.length ?? 0) > 1;

  // Whole-share search (share-search-ux task 004) — same wiring as the
  // recipient page: `?q=` overlays `?folder=` in the URL, so search is
  // deep-linkable and clearing returns to the folder level. Filtering is
  // render-only over the loaded payload — removal targets and the
  // last-item guard above read the unfiltered `items.data`.
  const [searchParams, setSearchParams] = useSearchParams();
  const query = (searchParams.get("q") ?? "").trim();
  const isSearching = query !== "";
  const [raw, setRaw] = useState(query);
  const debounced = useDebouncedValue(raw, SEARCH_DEBOUNCE_MS);
  const [isAdding, setIsAdding] = useState(false);

  useEffect(() => {
    const current = searchParams.get("q") ?? "";
    if (debounced === current) return;
    const params = new URLSearchParams(searchParams);
    if (debounced === "") params.delete("q");
    else params.set("q", debounced);
    setSearchParams(params, { replace: true });
    // Deps are deliberately `[debounced]` alone (TopbarSearch pattern):
    // the write must fire only for a settled input change, never for a
    // URL mutation from elsewhere (folder tiles, clear action, back/
    // forward) — otherwise the stale debounced value would restore `q`
    // right after the navigation dropped it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  // URL → input: deep links, back/forward, and clears stay in sync.
  useEffect(() => {
    setRaw(searchParams.get("q") ?? "");
  }, [searchParams]);

  function handleClearSearch(): void {
    setRaw("");
    const params = new URLSearchParams(searchParams);
    params.delete("q");
    setSearchParams(params, { replace: true });
  }

  // Tree browse (task 006) — computed before the mutations so they can
  // close over the current scope (`folderId`). The index rebuilds only
  // when the payload identity changes (a refetch), never per render.
  const tree = useMemo(
    () => (items.data ? buildShareTree(items.data) : null),
    [items.data],
  );
  const folderId = tree?.resolveFolderId(searchParams.get("folder")) ?? null;
  const results = useMemo(
    () => (isSearching && tree ? searchTree(tree, query) : null),
    [tree, query, isSearching],
  );

  // Folder CRUD dialog slot (task 007) — one modal at a time; the
  // dialogs below render from this state.
  const [folderDialog, setFolderDialog] = useState<
    | { kind: "create" }
    | { kind: "rename"; folder: ShareFolderDto }
    | { kind: "move"; folder: ShareFolderDto }
    | { kind: "delete"; folder: ShareFolderDto }
    | null
  >(null);

  /** Folder mutations invalidate the tree payload only: folders are pure
   * organization, so `item_count` (SHARES_QUERY_KEY) cannot change — no
   * create/rename/reparent/delete ever adds or removes a `share_items`
   * row. The server owns the tree; no optimistic patches. */
  function invalidateTree(): Promise<void> {
    return queryClient.invalidateQueries({
      queryKey: shareItemsOwnedKey(share.id),
    });
  }

  // Create lands in the level the owner is looking at (`folderId`).
  const createFolder = useMutation({
    mutationFn: (name: string) =>
      createShareFolder(share.id, { name, parent_id: folderId }),
    onSuccess: async () => {
      await invalidateTree();
      setFolderDialog(null);
    },
  });

  const renameFolder = useMutation({
    mutationFn: ({ folder, name }: { folder: ShareFolderDto; name: string }) =>
      updateShareFolder(share.id, folder.id, { name }),
    onSuccess: async () => {
      await invalidateTree();
      setFolderDialog(null);
    },
  });

  const moveFolder = useMutation({
    mutationFn: ({ folder, target }: { folder: ShareFolderDto; target: string | null }) =>
      updateShareFolder(share.id, folder.id, { parent_id: target }),
    onSuccess: async () => {
      await invalidateTree();
      setFolderDialog(null);
    },
  });

  const deleteFolder = useMutation({
    mutationFn: (folder: ShareFolderDto) => deleteShareFolder(share.id, folder.id),
    onSuccess: async () => {
      await invalidateTree();
      setFolderDialog(null);
    },
  });

  // Task 006: tree browse over the wrapped payload — the same helpers
  // and tile the recipient landing uses, so the owner preview is exact.
  const levelFolders = tree?.childFolders(folderId) ?? [];
  const levelVideos = tree?.childItems(folderId) ?? [];
  const crumbs = folderId === null ? [] : tree?.breadcrumbs(folderId) ?? [];
  const basePath = `/settings/shares/${share.id}`;
  const nothingVisible = levelFolders.length === 0 && levelVideos.length === 0;

  return (
    <section className="space-y-4">
      <div>
        <Link
          to="/shares"
          className="text-sm text-[var(--color-castify-accent-strong)] hover:underline"
        >
          ← Back to shares
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{share.title}</h1>
          <StatusBadge status={share.status} />
        </div>
        <p className="mt-1 text-sm text-[var(--color-castify-muted)]">
          {count} {count === 1 ? "item" : "items"} · created{" "}
          {formatDate(share.created_at)}
          {share.expires_at ? ` · expires ${formatDate(share.expires_at)}` : ""}
        </p>
        {share.status !== "active" && (
          <p className="mt-1 text-sm text-[var(--color-castify-muted)]">
            This share is {share.status === "revoked" ? "revoked" : "expired"} —
            its link is no longer available. The list below is read-only.
          </p>
        )}
      </div>

      {items.isPending && <SkeletonGrid />}

      {items.isError && (
        <ErrorState
          title="Couldn't load this share's items."
          body={describeError(items.error)}
          onRetry={() => void items.refetch()}
        />
      )}

      {/* Unreachable while the server enforces non-empty lists — kept so
          the page degrades sanely if that ever changes. */}
      {items.data && items.data.items.length === 0 && (
        <EmptyState
          title="Nothing in this share."
          body="Add items to make the link useful."
        />
      )}

      {items.data && items.data.items.length > 0 && (
        <>
          {/* The curation rail (design pass, task 005): one bordered unit
              instead of loose floating controls. Search is the primary
              affordance — flexible width, left; actions cluster right on
              the app's button primitives. The accent border in results
              mode is the mode thread the results readout picks up; it's
              a color shift only, per the app's motion budget. */}
          <div
            className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-card)] border bg-[var(--color-castify-surface)] p-3 transition-colors ${
              isSearching
                ? "border-[var(--color-castify-accent)]"
                : "border-[var(--color-castify-rule)]"
            }`}
          >
            <div className="w-full min-w-0 sm:w-auto sm:flex-1">
              <SearchBar
                value={raw}
                onChange={setRaw}
                label="Search this share"
                placeholder="Find a video…"
              />
            </div>
            {share.status === "active" && (
              <div className="flex items-center gap-2 sm:shrink-0">
                <Button
                  variant="secondary"
                  disabled={isSearching}
                  aria-describedby={isSearching ? "new-folder-search-hint" : undefined}
                  onClick={() => setFolderDialog({ kind: "create" })}
                >
                  New folder
                </Button>
                <Button variant="primary" onClick={() => setIsAdding(true)}>
                  Add items
                </Button>
              </div>
            )}
            {isSearching && share.status === "active" && (
              <p
                id="new-folder-search-hint"
                className="basis-full text-xs text-[var(--color-castify-muted)]"
              >
                Clear search to create a folder — folders land in the level you're browsing.
              </p>
            )}
          </div>
          {results !== null ? (
            <ShareSearchResults query={query} results={results} onClear={handleClearSearch}>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {results.folders.map((folder) => (
                  <FolderTile
                    key={folder.id}
                    name={folder.name}
                    folderId={folder.id}
                    to={basePath}
                    count={tree?.childCount(folder.id) ?? 0}
                    topRightSlot={
                      share.status === "active" ? (
                        <ShareFolderMenu
                          folderName={folder.name}
                          onRename={() => setFolderDialog({ kind: "rename", folder })}
                          onMove={() => setFolderDialog({ kind: "move", folder })}
                          onDelete={() => setFolderDialog({ kind: "delete", folder })}
                        />
                      ) : undefined
                    }
                  />
                ))}
                {results.videos.map((video) => {
                  // With two removals in flight this dims only the latest's
                  // card (mutation.variables holds one) — cosmetic only; the
                  // DELETEs are independent single-item requests.
                  const isRemoving =
                    remove.isPending && remove.variables?.video.id === video.id;
                  return (
                    <div
                      key={video.id}
                      className={`flex flex-col gap-2 transition-opacity ${isRemoving ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <PosterCard
                        video={video}
                        href={`/watch/${encodeURIComponent(video.id)}`}
                        topRightSlot={
                          share.status === "active" ? (
                            <ShareItemMenu
                              videoName={video.name}
                              videoHref={`/watch/${encodeURIComponent(video.id)}`}
                              canRemove={canRemoveItems}
                              removeHint={LAST_ITEM_HINT}
                              onMove={() => setMovingVideo(video)}
                              onRemove={() => handleRemove(video)}
                            />
                          ) : undefined
                        }
                      />
                      <ShareResultPathLabel path={video.folderPath} rootLabel={share.title} />
                    </div>
                  );
                })}
              </div>
            </ShareSearchResults>
          ) : (
            <>
              {crumbs.length > 0 && (
                <nav aria-label="Folders">
                  <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-[var(--color-castify-muted)]">
                    <li>
                      <Link
                        to={{ pathname: basePath, search: "" }}
                        className="hover:text-[var(--color-castify-accent)] hover:underline"
                      >
                        {share.title}
                      </Link>
                    </li>
                    {crumbs.map((crumb, index) => (
                      <li key={crumb.id} className="flex items-center gap-1.5">
                        <span aria-hidden>/</span>
                        {index === crumbs.length - 1 ? (
                          <span aria-current="page" className="text-[var(--color-castify-foreground)]">
                            {crumb.name}
                          </span>
                        ) : (
                          <Link
                            to={{ pathname: basePath, search: `?folder=${encodeURIComponent(crumb.id)}` }}
                            className="hover:text-[var(--color-castify-accent)] hover:underline"
                          >
                            {crumb.name}
                          </Link>
                        )}
                      </li>
                    ))}
                  </ol>
                </nav>
              )}
              {nothingVisible && (
                <EmptyState
                  title="This folder is empty."
                  body="Nothing was placed in this folder."
                />
              )}
              {!nothingVisible && (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                  {levelFolders.map((folder) => (
                    <FolderTile
                      key={folder.id}
                      name={folder.name}
                      folderId={folder.id}
                      to={basePath}
                      count={tree?.childCount(folder.id) ?? 0}
                      topRightSlot={
                        share.status === "active" ? (
                          <ShareFolderMenu
                            folderName={folder.name}
                            onRename={() => setFolderDialog({ kind: "rename", folder })}
                            onMove={() => setFolderDialog({ kind: "move", folder })}
                            onDelete={() => setFolderDialog({ kind: "delete", folder })}
                          />
                        ) : undefined
                      }
                    />
                  ))}
                  {levelVideos.map((video) => {
                    // With two removals in flight this dims only the latest's
                    // card (mutation.variables holds one) — cosmetic only; the
                    // DELETEs are independent single-item requests.
                    const isRemoving =
                      remove.isPending && remove.variables?.video.id === video.id;
                    return (
                      <div
                        key={video.id}
                        className={`transition-opacity ${isRemoving ? "pointer-events-none opacity-50" : ""}`}
                      >
                        <PosterCard
                          video={video}
                          href={`/watch/${encodeURIComponent(video.id)}`}
                          topRightSlot={
                            share.status === "active" ? (
                              <ShareItemMenu
                                videoName={video.name}
                                videoHref={`/watch/${encodeURIComponent(video.id)}`}
                                canRemove={canRemoveItems}
                                removeHint={LAST_ITEM_HINT}
                                onMove={() => setMovingVideo(video)}
                                onRemove={() => handleRemove(video)}
                              />
                            ) : undefined
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}

      {isAdding && (
        <ShareEditDialog share={share} onClose={() => setIsAdding(false)} />
      )}

      {folderDialog?.kind === "create" && (
        <FolderNameDialog
          title="New folder"
          initialName=""
          pending={createFolder.isPending}
          error={createFolder.isError ? describeError(createFolder.error) : undefined}
          onSubmit={(name) => createFolder.mutate(name)}
          onClose={() => setFolderDialog(null)}
        />
      )}

      {folderDialog?.kind === "rename" && (
        <FolderNameDialog
          title={`Rename "${folderDialog.folder.name}"`}
          initialName={folderDialog.folder.name}
          pending={renameFolder.isPending}
          error={renameFolder.isError ? describeError(renameFolder.error) : undefined}
          onSubmit={(name) =>
            renameFolder.mutate({ folder: folderDialog.folder, name })
          }
          onClose={() => setFolderDialog(null)}
        />
      )}

      {folderDialog?.kind === "move" && (
        <FolderPickerDialog
          title={`Move "${folderDialog.folder.name}"`}
          rootLabel="Share root"
          folders={items.data?.folders ?? []}
          excludeSubtreeOf={folderDialog.folder.id}
          currentFolderId={folderDialog.folder.parent_id}
          pending={moveFolder.isPending}
          onPick={(target) =>
            moveFolder.mutate({ folder: folderDialog.folder, target })
          }
          onClose={() => setFolderDialog(null)}
        />
      )}

      {movingVideo && (
        <FolderPickerDialog
          title={`Move "${movingVideo.name}"`}
          rootLabel="Share root"
          folders={items.data?.folders ?? []}
          currentFolderId={movingVideo.folder_id}
          pending={moveItem.isPending}
          onPick={(target) => moveItem.mutate({ video: movingVideo, target })}
          onClose={() => setMovingVideo(null)}
        />
      )}

      {folderDialog?.kind === "delete" && (
        <Dialog
          open
          onClose={() => setFolderDialog(null)}
          closeable={!deleteFolder.isPending}
          title={`Delete "${folderDialog.folder.name}"?`}
        >
          <div className="space-y-4">
            <p className="text-sm text-[var(--color-castify-muted)]">
              Videos and subfolders in it move to the top level — nothing
              leaves the share.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setFolderDialog(null)}
                disabled={deleteFolder.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={() => deleteFolder.mutate(folderDialog.folder)}
                pending={deleteFolder.isPending}
              >
                Delete
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {remove.isError && removeError && (
        <p
          role="alert"
          aria-label="Couldn't remove"
          className="text-sm text-[var(--color-castify-accent-dim)]"
        >
          Couldn&apos;t remove this item: {removeError}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Folder name dialog (task 007) — one shape for New folder and Rename.
// ---------------------------------------------------------------------------

// Client-side empty/whitespace pre-check mirrors the server's 400 (same
// rule, friendlier timing); every other rejection (duplicate sibling
// name 409, oversize 400) surfaces inline from the server's message.
function FolderNameDialog({
  title,
  initialName,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  initialName: string;
  pending: boolean;
  error?: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    if (trimmed === "" || pending) return;
    onSubmit(trimmed);
  }

  return (
    <Dialog open onClose={onClose} closeable={!pending} title={title}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field
          label="Folder name"
          error={trimmed === "" && name !== "" ? "Name can't be only whitespace." : error}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={trimmed === ""} pending={pending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

