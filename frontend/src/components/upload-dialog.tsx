// UploadDialog + UploadLayer + queue panel (drag-and-drop task 012).
//
// The flow: OS files land on the window (veil) → this dialog names the
// batch, picks the connection + provider folder path → confirm hands
// the batch to the queue hook → the panel tracks per-file progress
// (mono percent, size), cancel, and retry. Copy holds the verb: the
// button that says *Upload 2 files* toasts *Uploaded 2 files*.

import { useMemo, useState, type ReactNode } from "react";

import { PROVIDER_LABELS, type ProviderKey } from "../api/types";
import { useConnections } from "../hooks/use-connections";
import { useFolderTree } from "../hooks/use-folder-tree";
import { formatSize } from "../lib/format";
import { useUploadQueue } from "../hooks/use-upload-queue";
import { useToast } from "../hooks/use-toast";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";
import { UploadVeil } from "./upload-veil";

/** The destination picked for a dropped batch. */
export interface UploadDestination {
  connectionId: string;
  dir: string;
}

/**
 * Destination picker for a dropped batch: the file list, the
 * connections (chips), and the provider folder path (mono input,
 * seeded with the catalog's known top-level folders as suggestions).
 */
export function UploadDialog({
  files,
  onConfirm,
  onClose,
}: {
  files: File[];
  onConfirm: (destination: UploadDestination) => void;
  onClose: () => void;
}) {
  const connections = useConnections();
  const tree = useFolderTree();
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [dir, setDir] = useState("");

  const active = connections.data ?? [];
  const selected = connectionId ?? active[0]?.id ?? null;

  const suggestions = useMemo(
    () =>
      (tree.data ?? [])
        .filter((node) => node.path !== "" && node.path !== "(Unsorted)")
        .map((node) => node.path),
    [tree.data],
  );

  const uploadLabel = `Upload ${files.length} ${files.length === 1 ? "file" : "files"}`;

  return (
    <Dialog open onClose={onClose} title="Upload files">
      <div className="space-y-4">
        <ul className="space-y-1" aria-label="Files to upload">
          {files.map((file) => (
            <li
              key={`${file.name}-${file.size}`}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="truncate" title={file.name}>
                {file.name}
              </span>
              <span className="flex-shrink-0 font-mono text-xs text-[var(--color-castify-muted)]">
                {formatSize(file.size)}
              </span>
            </li>
          ))}
        </ul>

        <div className="space-y-2">
          <p className="eyebrow">Connection</p>
          {connections.isLoading && <Skeleton className="h-8 w-full" />}
          {connections.isError && (
            <p className="text-sm text-[var(--color-castify-muted)]">
              Couldn't load connections.
            </p>
          )}
          {active.length === 0 && !connections.isLoading && (
            <p className="text-sm text-[var(--color-castify-muted)]">
              Connect a cloud provider first — uploads need a destination.
            </p>
          )}
          <div role="radiogroup" aria-label="Upload destination" className="flex flex-wrap gap-1">
            {active.map((connection) => (
              <button
                key={connection.id}
                type="button"
                role="radio"
                aria-checked={selected === connection.id}
                onClick={() => setConnectionId(connection.id)}
                className={`keycap transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)] ${
                  selected === connection.id ? "keycap-active" : "keycap-inactive"
                }`}
              >
                {connection.provider_account_email ??
                  (PROVIDER_LABELS[connection.provider as ProviderKey] ??
                    connection.provider)}
              </button>
            ))}
          </div>
        </div>

        <label className="block space-y-1.5">
          <span className="eyebrow">Folder path</span>
          <input
            type="search"
            list="upload-folder-suggestions"
            value={dir}
            onChange={(event) => setDir(event.target.value)}
            placeholder="/ (connection root)"
            aria-label="Destination folder path"
            className="w-full rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-3 py-1.5 font-mono text-sm placeholder:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
          />
          <datalist id="upload-folder-suggestions">
            {suggestions.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
          <span className="block text-xs text-[var(--color-castify-muted)]">
            The provider folder the files land in — the catalog picks them up
            as Unfiled after the scan.
          </span>
        </label>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={selected === null}
          onClick={() => {
            if (selected !== null) {
              onConfirm({ connectionId: selected, dir: dir.trim() });
            }
          }}
        >
          {uploadLabel}
        </Button>
      </div>
    </Dialog>
  );
}

/** One queue row: name, mono progress, size, cancel/retry. */
function QueueRow({
  name,
  size,
  status,
  progress,
  error,
  onCancel,
  onRetry,
}: {
  name: string;
  size: number;
  status: string;
  progress: { loaded: number; total: number } | null;
  error: string | null;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const percent =
    status === "done"
      ? 100
      : progress !== null && progress.total > 0
        ? Math.round((progress.loaded / progress.total) * 100)
        : 0;
  return (
    <li className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="min-w-0 truncate" title={name}>
        {name}
      </span>
      <span className="flex flex-shrink-0 items-baseline gap-3">
        {status === "error" ? (
          <>
            <span className="max-w-56 truncate text-xs text-[var(--color-castify-danger,inherit)]" title={error ?? undefined}>
              {error}
            </span>
            <button
              type="button"
              onClick={onRetry}
              className="rounded-[var(--radius-button)] px-2 py-0.5 text-xs font-semibold text-[var(--color-castify-accent)] transition hover:bg-[var(--color-castify-accent-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)]"
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <span className="font-mono text-xs tabular-nums text-[var(--color-castify-muted)]">
              {status === "cancelled"
                ? "cancelled"
                : status === "done"
                  ? `${formatSize(size)} · done`
                  : `${percent}% · ${formatSize(size)}`}
            </span>
            {(status === "queued" || status === "uploading") && (
              <button
                type="button"
                onClick={onCancel}
                className="rounded-[var(--radius-button)] px-2 py-0.5 text-xs font-semibold text-[var(--color-castify-muted)] transition hover:text-[var(--color-castify-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)]"
              >
                Cancel
              </button>
            )}
          </>
        )}
      </span>
    </li>
  );
}

/** The floating queue panel — mounts when a batch exists. */
export function UploadQueuePanel({
  queue,
}: {
  queue: ReturnType<typeof useUploadQueue>;
}) {
  if (queue.entries.length === 0) return null;
  const settled = queue.entries.every(
    (entry) =>
      entry.status === "done" ||
      entry.status === "error" ||
      entry.status === "cancelled",
  );
  const done = queue.entries.filter((entry) => entry.status === "done").length;
  const allGood = done === queue.entries.length;

  return (
    <section
      aria-label="Upload queue"
      className="fixed bottom-4 right-4 z-[60] w-80 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-3 shadow-[var(--shadow-md)]"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {settled
            ? allGood
              ? `Uploaded ${done} ${done === 1 ? "file" : "files"}`
              : `Uploads — ${done}/${queue.entries.length} done`
            : `Uploading — ${done}/${queue.entries.length} done`}
        </h3>
        {settled ? (
          <button
            type="button"
            onClick={queue.dismiss}
            className="rounded-[var(--radius-button)] px-2 py-0.5 text-xs text-[var(--color-castify-muted)] transition hover:text-[var(--color-castify-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)]"
          >
            Dismiss
          </button>
        ) : (
          <button
            type="button"
            onClick={queue.cancelAll}
            className="rounded-[var(--radius-button)] px-2 py-0.5 text-xs text-[var(--color-castify-muted)] transition hover:text-[var(--color-castify-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-castify-accent)]"
          >
            Cancel all
          </button>
        )}
      </div>
      <ul className="mt-1 divide-y divide-[var(--color-castify-rule)]">
        {queue.entries.map((entry) => (
          <QueueRow
            key={entry.key}
            name={entry.file.name}
            size={entry.file.size}
            status={entry.status}
            progress={entry.progress}
            error={entry.error}
            onCancel={() => queue.cancelOne(entry.key)}
            onRetry={() => queue.retry(entry.key)}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * The global upload surface: veil (any route) → destination dialog →
 * sequential queue panel. Mounts once in the app layout.
 */
export function UploadLayer(): ReactNode {
  const [pending, setPending] = useState<File[] | null>(null);
  const queue = useUploadQueue();
  const toast = useToast();

  return (
    <>
      <UploadVeil onFiles={setPending} />
      {pending !== null && (
        <UploadDialog
          files={pending}
          onClose={() => setPending(null)}
          onConfirm={(destination) => {
            queue.start(pending, destination.connectionId, destination.dir);
            setPending(null);
            toast.info(
              `Uploading ${pending.length} ${pending.length === 1 ? "file" : "files"} — they land in Unfiled after the scan.`,
            );
          }}
        />
      )}
      <UploadQueuePanel queue={queue} />
    </>
  );
}
