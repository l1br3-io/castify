// Share-creation dialog (task 012).
//
// The single creation surface for both entry points: the watch page's
// "Share" action (one item, prefilled label = the video name) and the
// browse page's multi-select mode ("Share N items"). Both render
// `<ShareDialog videoIds={...} itemLabel={...} onClose={...}>` — the only
// difference is the ids array and the label.
//
// Form contract (mirrors the server's `POST /api/shares` validation; the
// server remains the enforcer — this is UX, not security):
//   * title   — optional, trimmed, ≤200 chars (`maxLength` guards typing;
//               empty-after-trim is omitted from the body);
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
// reflects the new share on its next mount.
//
// The dialog is a plain overlay (`fixed inset-0`), not a portal — the
// routes that host it have no clipping/stacking traps. Escape and
// backdrop clicks close only *before* creation; afterwards the link is
// on screen and dismissal is an explicit "Done" so it can't be lost by
// an accidental click.

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createShare, type CreatedShareDto } from "../api/shares";
import { describeError } from "../lib/format";
import { saveShareLink } from "../lib/share-links-db";
import { absoluteShareUrl, SHARES_QUERY_KEY } from "../hooks/use-shares";
import { CopyLinkButton } from "./copy-link-button";

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
  const [title, setTitle] = useState("");
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState<ExpiryPreset>("never");
  const [created, setCreated] = useState<CreatedShareDto | null>(null);
  const queryClient = useQueryClient();

  const pwError = passwordError(password);

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

  // Escape closes only pre-creation: once the link is on screen it must
  // be dismissed deliberately (Done), never by a stray keypress — and not
  // mid-POST either (same guard as the backdrop below; a share created
  // behind a closed dialog is recoverable only via Settings).
  useEffect(() => {
    if (created) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !create.isPending) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [created, create.isPending, onClose]);

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    if (pwError !== null || create.isPending) return;
    create.mutate();
  }

  function handleBackdropClick(): void {
    if (!created && !create.isPending) onClose();
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
          <form onSubmit={handleSubmit} className="space-y-4">
            <h2
              id="share-dialog-title"
              className="text-lg font-semibold tracking-tight"
            >
              Share {itemLabel}
            </h2>
            <p className="text-sm opacity-60">
              Anyone with the link can watch{" "}
              {videoIds.length === 1
                ? "this video"
                : `these ${videoIds.length} videos`}
              {" "}without an account.
            </p>

            <label className="block space-y-1 text-sm">
              <span className="opacity-70">Title (optional)</span>
              <input
                value={title}
                maxLength={TITLE_MAX}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-canvas)] px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
              />
            </label>

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
        )}
      </div>
    </div>
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
