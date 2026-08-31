// Share-creation dialog (task 012; mode toggle added by share-management
// task 003).
//
// The single share surface for both entry points: the watch page's
// "Share" action (one item, prefilled label = the video name) and the
// browse page's multi-select mode ("Share N items"). Both render
// `<ShareDialog videoIds={...} itemLabel={...} onClose={...}>` — the only
// difference is the ids array and the label.
//
// Two modes behind a toggle:
//
//   * "New share" (default) — the creation form below. Its state (title/
//     password/expiry) lives in this component, so switching modes and
//     back never drops what the user typed.
//   * "Add to existing" — a picker over the owner's *active* shares from
//     the cached `useShares()` (fetched only once this mode is opened).
//     Data model: the search box filters the active list by title
//     substring client-side (zero network requests); selecting a share
//     loads its members via `useShareItemsOwned(id)` to split the
//     dialog's `videoIds` into already-member (surfaced as "k of N
//     already in this share") vs fresh. Add POSTs exactly the fresh ids
//     in one `appendToShare` request — disabled while members load,
//     on error, or when nothing is new (k === N).
//
// Form contract (mirrors the server's `POST /api/shares` validation; the
// server remains the enforcer — this is UX, not security):
//   * title   — optional, trimmed, ≤200 chars (`maxLength` guards typing;
//               empty-after-trim is omitted from the body). The field is
//               prefilled with a generated name (`lib/share-names.ts`) on
//               open — once per mount, via the useState initializer, so
//               rerenders never fight the user's typing; the reroll button
//               replaces the value with a fresh draw; clearing it restores
//               the title-less body (server `DEFAULT_TITLE` backstop);
//   * password — optional, 8..=256 characters when non-empty;
//   * expiry  — preset select: 1 day / 7 days / 30 days / never. Presets
//               become an RFC3339 `expires_at` at submit time; "never"
//               omits the field entirely.
//
// Creation is exactly one POST per submit (`useMutation` + disabled
// submit while pending). On success the response's one-time token is
// rendered as an absolute link with a copy button and a "created once"
// warning (the server stores only a hash — a lost link is unrecoverable
// by design), and the link is persisted per-device in IndexedDB
// (`lib/share-links-db.ts`) so the Settings shares list can re-copy it
// later on this browser. The `shares` query is invalidated so that list
// reflects the new share on its next mount. Append succeeds straight to
// `onClose()` — the link was already handed out when the share was
// created; both the `shares` list and the share's members cache are
// invalidated/dropped so Settings and the manage page reflect the new
// members on their next mount.
//
// The dialog is a plain overlay (`fixed inset-0`), not a portal — the
// routes that host it have no clipping/stacking traps. Escape and
// backdrop clicks close only *before* a mutation lands; afterwards the
// link is on screen and dismissal is an explicit "Done", and mid-POST
// dismissal is blocked in both modes (a share changed behind a closed
// dialog leaves the user guessing whether it landed).

import {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  appendToShare,
  createShare,
  type CreatedShareDto,
  type ShareDto,
} from "../api/shares";
import { describeError } from "../lib/format";
import { generateShareName } from "../lib/share-names";
import { saveShareLink } from "../lib/share-links-db";
import {
  absoluteShareUrl,
  SHARES_QUERY_KEY,
  useShares,
} from "../hooks/use-shares";
import {
  shareItemsOwnedKey,
  useShareItemsOwned,
} from "../hooks/use-share-items";
import { CopyLinkButton } from "./copy-link-button";
import { Skeleton } from "./ui/skeleton";

/** Mirrors `MIN_PASSWORD_LEN` / `MAX_PASSWORD_LEN` (crates/api routes). */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;
/** Mirrors `MAX_TITLE_LEN` in `crates/api/src/routes/shares.rs`. */
const TITLE_MAX = 200;

const EXPIRY_PRESETS = [
  { value: "never", label: "Never" },
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
] as const;

type ExpiryPreset = (typeof EXPIRY_PRESETS)[number]["value"];

const MS_PER_DAY = 86_400_000;

/** Which side of the mode toggle is showing. */
type ShareDialogMode = "new" | "existing";

/** 8..=256 chars when non-empty — `null` means valid (incl. empty). */
function passwordError(password: string): string | null {
  const len = [...password].length;
  if (len === 0) return null;
  if (len < PASSWORD_MIN)
    return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (len > PASSWORD_MAX)
    return `Password must be at most ${PASSWORD_MAX} characters.`;
  return null;
}

export function ShareDialog({
  videoIds,
  itemLabel,
  onClose,
}: {
  /** 1..N catalog video ids in curation order (server preserves order). */
  videoIds: string[];
  /** What's being shared — the video name (watch page) or "N videos"
   * (browse multi-select). Rendered into the heading only. */
  itemLabel: string;
  onClose: () => void;
}) {
  // Lazy initializer = one draw per mount; rerenders (typing, expiry
  // changes, pending state) reuse the state, never redraw over the user.
  const [title, setTitle] = useState(() => generateShareName());
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState<ExpiryPreset>("never");
  const [created, setCreated] = useState<CreatedShareDto | null>(null);
  // Mode + picker state. The creation-form fields above deliberately live
  // here (not inside the form's JSX) so a mode round-trip unmounts nothing
  // — typed input survives.
  const [mode, setMode] = useState<ShareDialogMode>("new");
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerShareId, setPickerShareId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Picker list — observed always, fetched only in existing mode; the
  // shared key means a cached Settings list renders with zero requests.
  const shares = useShares(mode === "existing");
  // Members of the selected share — purely to split videoIds into
  // already-member vs fresh. Placeholder id + enabled gate while nothing
  // is selected, so no empty-id query ever fires.
  const members = useShareItemsOwned(
    pickerShareId ?? "",
    pickerShareId !== null,
  );

  const pwError = passwordError(password);

  // Picker derivations (pure — no state copies).
  const activeShares = (shares.data ?? []).filter(
    (s) => s.status === "active",
  );
  const query = pickerSearch.trim().toLowerCase();
  const matchingShares =
    query === ""
      ? activeShares
      : activeShares.filter((s) => s.title.toLowerCase().includes(query));
  // Selected share resolves through the *active* list: if a refetch drops
  // or kills the share mid-picking, the selection clears instead of
  // pointing at a dead row.
  const selectedShare =
    pickerShareId === null
      ? null
      : (activeShares.find((s) => s.id === pickerShareId) ?? null);
  const memberIds = new Set(members.data?.map((v) => v.id) ?? []);
  const alreadyCount = videoIds.filter((id) => memberIds.has(id)).length;
  const freshIds = videoIds.filter((id) => !memberIds.has(id));

  const create = useMutation({
    mutationFn: () =>
      createShare({
        video_ids: videoIds,
        ...(title.trim() !== "" ? { title: title.trim() } : {}),
        ...(password !== "" ? { password } : {}),
        ...(expiry !== "never"
          ? {
              expires_at: new Date(
                Date.now() + Number(expiry) * MS_PER_DAY,
              ).toISOString(),
            }
          : {}),
      }),
    onSuccess: (dto) => {
      // Per-device memory of the one-time link; failures degrade silently
      // (this browser just won't offer re-copy in Settings).
      void saveShareLink(dto.id, dto.share_url);
      // Settings list stays the server's view — invalidate, don't patch.
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY });
      setCreated(dto);
    },
  });

  // Exactly one POST per Add — the mutation carries its own target so
  // onSuccess knows which caches to fix without closure staleness.
  const append = useMutation({
    mutationFn: (target: { shareId: string; videoIds: string[] }) =>
      appendToShare(target.shareId, target.videoIds),
    onSuccess: (_result, target) => {
      // item_count changed — the server owns it, so the Settings list
      // refetches rather than being patched locally.
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY });
      // Drop the members entry (invalidate alone isn't enough — the
      // app-wide 30s staleTime would serve the pre-append list to the
      // next manage-page mount; same rationale as the edit dialog).
      queryClient.removeQueries({
        queryKey: shareItemsOwnedKey(target.shareId),
      });
      onClose();
    },
  });

  // Escape closes only pre-creation: once the link is on screen it must
  // be dismissed deliberately (Done), never by a stray keypress — and not
  // mid-POST either, in either mode (same guard as the backdrop below; a
  // share created or changed behind a closed dialog is recoverable only
  // via Settings).
  useEffect(() => {
    if (created) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !create.isPending && !append.isPending)
        onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [created, create.isPending, append.isPending, onClose]);

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    if (pwError !== null || create.isPending) return;
    create.mutate();
  }

  function handleAdd(): void {
    // Members must be loaded before anything can be posted — the fresh
    // split is what keeps the request one idempotent append, not an
    // accidental full-list POST.
    if (selectedShare === null || members.data === undefined) return;
    if (freshIds.length === 0 || append.isPending) return;
    append.mutate({ shareId: selectedShare.id, videoIds: freshIds });
  }

  function handleBackdropClick(): void {
    if (!created && !create.isPending && !append.isPending) onClose();
  }

  return (
    <div
      role="presentation"
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-6 shadow-xl"
      >
        {created ? (
          <CreatedView created={created} onDone={onClose} />
        ) : (
          <div className="space-y-4">
            <h2
              id="share-dialog-title"
              className="text-lg font-semibold tracking-tight"
            >
              Share {itemLabel}
            </h2>

            <div
              role="group"
              aria-label="Share mode"
              className="grid grid-cols-2 gap-1 rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] p-1"
            >
              <ModeToggleButton
                active={mode === "new"}
                onClick={() => setMode("new")}
              >
                New share
              </ModeToggleButton>
              <ModeToggleButton
                active={mode === "existing"}
                onClick={() => setMode("existing")}
              >
                Add to existing
              </ModeToggleButton>
            </div>

            {mode === "new" ? (
              <form onSubmit={handleSubmit} className="space-y-4">
                <p className="text-sm opacity-60">
                  Anyone with the link can watch{" "}
                  {videoIds.length === 1
                    ? "this video"
                    : `these ${videoIds.length} videos`}
                  {" "}without an account.
                </p>

                <div className="space-y-1 text-sm">
                  <label htmlFor="share-dialog-title-input" className="block opacity-70">
                    Title (optional)
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="share-dialog-title-input"
                      value={title}
                      maxLength={TITLE_MAX}
                      onChange={(e) => setTitle(e.target.value)}
                      className="min-w-0 flex-1 rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-canvas)] px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
                    />
                    {/* Reroll sits outside the label so its click targets the
                        button, not the input's label-forwarding. */}
                    <button
                      type="button"
                      aria-label="Reroll name"
                      onClick={() => setTitle(generateShareName())}
                      className="shrink-0 rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-3 py-2 text-sm transition hover:bg-[var(--color-castify-accent-subtle)]"
                    >
                      Reroll
                    </button>
                  </div>
                </div>

                <label className="block space-y-1 text-sm">
                  <span className="opacity-70">Password (optional)</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    aria-invalid={pwError !== null || undefined}
                    className="w-full rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-canvas)] px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)] aria-invalid:border-[var(--color-castify-accent-dim)]"
                  />
                  {pwError !== null && (
                    <p role="alert" className="text-xs text-[var(--color-castify-accent-dim)]">
                      {pwError}
                    </p>
                  )}
                </label>

                <label className="block space-y-1 text-sm">
                  <span className="opacity-70">Expires</span>
                  <select
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value as ExpiryPreset)}
                    className="w-full rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-canvas)] px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
                  >
                    {EXPIRY_PRESETS.map((preset) => (
                      <option key={preset.value} value={preset.value}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>

                {create.isError && (
                  <p role="alert" className="text-sm text-[var(--color-castify-accent-dim)]">
                    {describeError(create.error)}
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-4 py-2 text-sm transition hover:bg-[var(--color-castify-accent-subtle)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={pwError !== null || create.isPending}
                    className="rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 disabled:opacity-50"
                  >
                    {create.isPending ? "Creating…" : "Create share"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <input
                  type="search"
                  aria-label="Search shares"
                  placeholder="Search shares…"
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  className="w-full rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-canvas)] px-3 py-2 text-sm placeholder:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
                />

                {shares.isPending && (
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="h-10 w-full" />
                    ))}
                  </div>
                )}
                {shares.isError && (
                  <p role="alert" className="text-sm text-[var(--color-castify-accent-dim)]">
                    Couldn&apos;t load your shares:{" "}
                    {describeError(shares.error)}{" "}
                    <button
                      type="button"
                      onClick={() => void shares.refetch()}
                      className="underline"
                    >
                      Retry
                    </button>
                  </p>
                )}
                {shares.data !== undefined && matchingShares.length === 0 && (
                  <p className="text-sm opacity-60">
                    {activeShares.length === 0
                      ? "No active shares yet — create a new one instead."
                      : "No shares match."}
                  </p>
                )}

                <div className="max-h-56 space-y-1 overflow-y-auto">
                  {matchingShares.map((share) => (
                    <ShareOptionRow
                      key={share.id}
                      share={share}
                      selected={share.id === pickerShareId}
                      onSelect={() => setPickerShareId(share.id)}
                    />
                  ))}
                </div>

                {/* Selection panel — appears once a share is picked. The
                    Add button below stays disabled until the members
                    check lands, so the fresh/already split is always
                    server-truth. */}
                {selectedShare !== null && (
                  <div className="space-y-1 rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-3 py-2">
                    <p
                      className="truncate text-xs font-semibold uppercase tracking-wide text-[var(--color-castify-muted)]"
                      title={selectedShare.title}
                    >
                      {selectedShare.title}
                    </p>
                    {members.isPending && (
                      <p className="text-xs opacity-60">Checking members…</p>
                    )}
                    {members.isError && (
                      <p role="alert" className="text-xs text-[var(--color-castify-accent-dim)]">
                        Couldn&apos;t check this share&apos;s items:{" "}
                        {describeError(members.error)}{" "}
                        <button
                          type="button"
                          onClick={() => void members.refetch()}
                          className="underline"
                        >
                          Retry
                        </button>
                      </p>
                    )}
                    {members.data !== undefined && (
                      <p role="status" className="text-xs opacity-70">
                        {alreadyCount > 0
                          ? `${alreadyCount} of ${videoIds.length} already in this share${alreadyCount === videoIds.length ? " — nothing new to add." : "."}`
                          : `Not in this share yet — ${videoIds.length} ${videoIds.length === 1 ? "video" : "videos"} will be added.`}
                      </p>
                    )}
                  </div>
                )}

                {append.isError && (
                  <p role="alert" className="text-sm text-[var(--color-castify-accent-dim)]">
                    {describeError(append.error)}
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={append.isPending}
                    className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-4 py-2 text-sm transition hover:bg-[var(--color-castify-accent-subtle)] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleAdd}
                    disabled={
                      selectedShare === null ||
                      members.data === undefined ||
                      freshIds.length === 0 ||
                      append.isPending
                    }
                    className="rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 disabled:opacity-50"
                  >
                    {append.isPending ? "Adding…" : "Add to share"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** One segment of the mode toggle — `aria-pressed` carries the selected
 * state to screen readers (a segmented control, not two submits). */
function ModeToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-[calc(var(--radius-button)-2px)] px-3 py-1.5 text-sm font-medium transition ${
        active
          ? "bg-[var(--color-castify-accent)] text-[var(--color-castify-canvas)]"
          : "hover:bg-[var(--color-castify-accent-subtle)]"
      }`}
    >
      {children}
    </button>
  );
}

/** One picker row — the whole row is the button; its accessible name is
 * the title plus the item count ("Movie night 2 videos"). */
function ShareOptionRow({
  share,
  selected,
  onSelect,
}: {
  share: ShareDto;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex w-full items-center justify-between gap-2 rounded-[var(--radius-button)] border px-3 py-2 text-left text-sm transition ${
        selected
          ? "border-[var(--color-castify-accent)] bg-[var(--color-castify-accent-subtle)]"
          : "border-[var(--color-castify-rule)] hover:bg-[var(--color-castify-accent-subtle)]"
      }`}
    >
      <span className="truncate" title={share.title}>
        {share.title}
      </span>
      <span className="shrink-0 text-xs opacity-60">
        {share.item_count} {share.item_count === 1 ? "video" : "videos"}
      </span>
    </button>
  );
}

/** Post-creation view — the one-time link, copy, warning, Done. */
function CreatedView({
  created,
  onDone,
}: {
  created: CreatedShareDto;
  onDone: () => void;
}) {
  const absoluteUrl = absoluteShareUrl(created.share_url);
  return (
    <div className="space-y-4">
      <h2
        id="share-dialog-title"
        className="text-lg font-semibold tracking-tight"
      >
        Share link created
      </h2>
      <div className="space-y-2">
        <p className="break-all rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-canvas)] px-3 py-2 font-mono text-sm">
          {absoluteUrl}
        </p>
        <div>
          <CopyLinkButton linkPath={created.share_url} />
        </div>
      </div>
      <p role="status" className="text-sm text-[var(--color-castify-accent-dim)]">
        This link is shown only once — copy it now. It&apos;s saved on this
        device (Settings → Shares can copy it again here), but it can&apos;t
        be recovered anywhere else.
      </p>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onDone}
          className="rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90"
        >
          Done
        </button>
      </div>
    </div>
  );
}
