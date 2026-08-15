// FileCard + FileRow — non-video entries in the folder organizer (M9 FR-8.2).
//
// Affordance matrix, the core fix of this effort: non-media files get kind
// identity + a download action, and NEVER a play affordance — no play icon,
// no "Play …" aria-label, no hover overlay. Play is the video contract
// (`PosterCard`); these components are deliberately incapable of it.
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

function KindIcon({ kind, className }: { kind: FileKindKey; className: string }) {
  switch (kind) {
    case "audio":
      return <AudioIcon className={className} />;
    case "image":
      return <ImageIcon className={className} />;
    case "subtitle":
      return <SubtitleIcon className={className} />;
    case "document":
      return <DocIcon className={className} />;
    case "archive":
      return <ArchiveIcon className={className} />;
    default:
      return <FileIcon className={className} />;
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
      className="group relative flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-2 transition duration-150 ease-out hover:-translate-y-0.5 hover:border-[var(--color-castify-accent)]/40 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      aria-label={`${FILE_KIND_LABELS[file.kind]} file ${file.name}`}
    >
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] bg-[var(--color-castify-accent-subtle)] text-[var(--color-castify-muted)]">
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
      className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-3 py-2 transition hover:border-[var(--color-castify-accent)]/40"
      aria-label={`${FILE_KIND_LABELS[file.kind]} file ${file.name}`}
    >
      <KindIcon kind={file.kind} className="h-5 w-5 flex-shrink-0 text-[var(--color-castify-muted)]" />
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
