// FileCard + FileRow — non-video entries in the folder organizer (M9 FR-8.2).
//
// Affordance matrix, the core fix of this effort: non-media files get kind
// identity + a download action, and NEVER a play affordance — no play icon,
// no "Play …" aria-label, no hover overlay. Play is the video contract
// (`PosterCard`); these components are deliberately incapable of it.
//
// The matrix is also *visible* (identity pass task 005): every entry wears
// its kind taxonomy — a 4px hue tab (top edge of the card's icon tile,
// left edge of the row) plus a glyph tinted the same hue, both fed by the
// `--color-kind-*` tokens (Task 001). Kind color appears only as icon tint
// + 4px bar — never as a large fill — so the taxonomy reads at a glance
// without shouting. Per the effort's motion budget, hovers shift borders
// only; no lifts.
//
// Two presentations:
//   * FileCard — tile for grid neighbors (sits beside PosterCards in the
//     contents pane; used for audio + image): kind icon on a quiet surface,
//     name (2-line clamp), size.
//   * FileRow — dense list row for document/archive/subtitle/other: icon,
//     name, size · date, trailing download link.
//
// Download is a plain <a href={fileDownloadUrl(id)}> — real navigation, the
// session cookie rides along, and the server sets
// Content-Disposition: attachment.

import { FILE_KIND_LABELS, type FileEntryDto, type FileKindKey } from "../api/types";
import { fileDownloadUrl } from "../api/folders";
import { formatSize } from "../lib/format";
import {
  ArchiveIcon,
  AudioIcon,
  DocIcon,
  FileIcon,
  ImageIcon,
  SubtitleIcon,
} from "./icons";

// Kind → hue utilities. Static literal strings (one per kind) so the
// Tailwind scanner emits every arbitrary value; per-theme resolution comes
// free from the `--color-kind-*` token cascade (dark/light, Task 001).
const KIND_HUES: Record<FileKindKey, { icon: string; tab: string }> = {
  audio: { icon: "text-[var(--color-kind-audio)]", tab: "bg-[var(--color-kind-audio)]" },
  image: { icon: "text-[var(--color-kind-image)]", tab: "bg-[var(--color-kind-image)]" },
  subtitle: { icon: "text-[var(--color-kind-subtitle)]", tab: "bg-[var(--color-kind-subtitle)]" },
  document: { icon: "text-[var(--color-kind-document)]", tab: "bg-[var(--color-kind-document)]" },
  archive: { icon: "text-[var(--color-kind-archive)]", tab: "bg-[var(--color-kind-archive)]" },
  other: { icon: "text-[var(--color-kind-other)]", tab: "bg-[var(--color-kind-other)]" },
};

function KindIcon({ kind, className }: { kind: FileKindKey; className: string }) {
  const classes = `${KIND_HUES[kind].icon} ${className}`;
  switch (kind) {
    case "audio":
      return <AudioIcon className={classes} />;
    case "image":
      return <ImageIcon className={classes} />;
    case "subtitle":
      return <SubtitleIcon className={classes} />;
    case "document":
      return <DocIcon className={classes} />;
    case "archive":
      return <ArchiveIcon className={classes} />;
    default:
      return <FileIcon className={classes} />;
  }
}

function downloadHref(id: string): string {
  return fileDownloadUrl(id);
}

function formatModifiedDate(iso: string | null): string {
  if (!iso) return "";
  const year = new Date(iso).getFullYear();
  return Number.isFinite(year) ? String(year) : "";
}

export function FileCard({ file }: { file: FileEntryDto }) {
  return (
    <article
      className="group relative flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-2 transition duration-150 ease-out hover:border-[var(--color-castify-accent)]/40 motion-reduce:transition-none"
      aria-label={`${FILE_KIND_LABELS[file.kind]} file ${file.name}`}
    >
      <div className="relative flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] bg-[var(--color-castify-accent-subtle)] text-[var(--color-castify-muted)]">
        {/* 4px kind-hue tab across the top edge of the icon tile. */}
        <span
          aria-hidden
          className={`absolute inset-x-0 top-0 h-1 rounded-t-[var(--radius-card)] ${KIND_HUES[file.kind].tab}`}
        />
        <KindIcon kind={file.kind} className="h-10 w-10" />
        <span className="text-xs font-medium uppercase tracking-wide">
          {FILE_KIND_LABELS[file.kind]}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-1 pb-1">
        <h3 className="line-clamp-2 text-sm font-medium leading-tight" title={file.name}>
          {file.name}
        </h3>
        <div className="flex items-center justify-between gap-2 text-xs text-[var(--color-castify-muted)]">
          <span>{formatSize(file.size_bytes)}</span>
          <a
            href={downloadHref(file.id)}
            className="rounded-[var(--radius-button)] px-2 py-1 font-semibold text-[var(--color-castify-accent)] transition hover:bg-[var(--color-castify-accent-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-castify-accent)]"
            aria-label={`Download ${file.name}`}
            download
          >
            Download
          </a>
        </div>
      </div>
    </article>
  );
}

export function FileRow({ file }: { file: FileEntryDto }) {
  const modified = formatModifiedDate(file.modified_at);
  return (
    <div
      className="relative flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-3 py-2 transition hover:border-[var(--color-castify-accent)]/40"
      aria-label={`${FILE_KIND_LABELS[file.kind]} file ${file.name}`}
    >
      {/* 4px kind-hue tab down the left edge — the row's take on the
          card's top tab, same hue language. */}
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-1 rounded-l-[var(--radius-card)] ${KIND_HUES[file.kind].tab}`}
      />
      <KindIcon kind={file.kind} className="h-5 w-5 flex-shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={file.name}>
        {file.name}
      </span>
      <span className="hidden flex-shrink-0 text-xs text-[var(--color-castify-muted)] sm:inline">
        {[formatSize(file.size_bytes), modified].filter(Boolean).join(" · ")}
      </span>
      <a
        href={downloadHref(file.id)}
        className="flex-shrink-0 rounded-[var(--radius-button)] px-2.5 py-1 text-xs font-semibold text-[var(--color-castify-accent)] transition hover:bg-[var(--color-castify-accent-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-castify-accent)]"
        aria-label={`Download ${file.name}`}
        download
      >
        Download
      </a>
    </div>
  );
}
