// Video list: unified deduplicated catalog across all connected providers.
//
// Renders from `GET /api/videos` via `useVideos`. Each card shows the video
// name, a provider badge, size, duration, and resolution. When a video exists
// in multiple providers (dedup group), a badge lists the additional sources.
//
// State:
//   * `sort` + `page` are local `useState` (no URL sync — same convention as
//     the connections page). Changing sort resets to page 1.
//   * `keepPreviousData` on the query keeps the current page visible while the
//     next loads, so pagination feels instant.
//
// The empty state ("No videos yet") is distinct from the home page's first-run
// guide: this component only renders when at least one connection exists (the
// home page gates on that). Zero videos with a connection means the scan
// hasn't found anything yet (or the provider has no videos).

import { useState } from "react";
import { Link } from "react-router-dom";

import { useVideos } from "../hooks/use-videos";
import { useConnections } from "../hooks/use-connections";
import { ApiError } from "../api/client";
import {
  PROVIDER_LABELS,
  VIDEO_SORT_LABELS,
  type ProviderKey,
  type VideoSortKey,
  type VideoSummaryDto,
} from "../api/types";

const SORT_OPTIONS: VideoSortKey[] = ["date-desc", "name", "size"];

export function VideoList() {
  const [sort, setSort] = useState<VideoSortKey>("date-desc");
  const [page, setPage] = useState(1);

  const videos = useVideos({ page, sort });

  function handleSortChange(value: VideoSortKey): void {
    setSort(value);
    setPage(1);
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Your library</h1>
          <p className="mt-2 opacity-70">
            All your cloud videos, unified and deduplicated.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="opacity-60">Sort</span>
          <select
            aria-label="Sort videos"
            value={sort}
            onChange={(e) => handleSortChange(e.target.value as VideoSortKey)}
            className="rounded-md border border-white/15 bg-[var(--color-castify-surface)] px-3 py-1.5 text-sm transition hover:bg-white/5 focus:outline-none focus:ring-1 focus:ring-[var(--color-castify-accent)]"
          >
            {SORT_OPTIONS.map((key) => (
              <option key={key} value={key}>
                {VIDEO_SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <VideoListBody videos={videos} page={page} onPageChange={setPage} />
    </section>
  );
}

interface VideoListBodyProps {
  videos: ReturnType<typeof useVideos>;
  page: number;
  onPageChange: (page: number) => void;
}

function VideoListBody({ videos, page, onPageChange }: VideoListBodyProps) {
  if (videos.isLoading) {
    return <LoadingSkeleton />;
  }
  if (videos.isError) {
    return (
      <p className="text-red-400">
        Couldn't load videos. {describeError(videos.error)}
      </p>
    );
  }

  const data = videos.data;
  if (!data || data.videos.length === 0) {
    return <EmptyState />;
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.limit));

  return (
    <div className="space-y-4">
      <p className="text-sm opacity-60">
        {data.total} {data.total === 1 ? "video" : "videos"}
      </p>
      <div className="grid gap-3">
        {data.videos.map((video) => (
          <VideoCard key={video.id} video={video} />
        ))}
      </div>
      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={onPageChange}
          isFetching={videos.isFetching}
        />
      )}
    </div>
  );
}

function VideoCard({ video }: { video: VideoSummaryDto }) {
  const otherProviders = video.sources
    .map((s) => s.provider)
    .filter((p) => p !== video.provider);

  return (
    <article className="flex items-center gap-4 rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-4 transition hover:border-white/20">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="font-medium truncate">{video.name}</h2>
          <ProviderBadge provider={video.provider} />
          {otherProviders.length > 0 && <DedupBadge providers={otherProviders} />}
        </div>
        <p className="mt-1 text-sm opacity-60">
          {[
            formatSize(video.size_bytes),
            video.duration_ms !== null && formatDuration(video.duration_ms),
            video.width !== null &&
              video.height !== null &&
              formatResolution(video.width, video.height),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
    </article>
  );
}

function ProviderBadge({ provider }: { provider: ProviderKey }) {
  return (
    <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium opacity-80">
      {PROVIDER_LABELS[provider] ?? provider}
    </span>
  );
}

function DedupBadge({ providers }: { providers: ProviderKey[] }) {
  const labels = providers.map((p) => PROVIDER_LABELS[p] ?? p).join(", ");
  return (
    <span
      className="rounded-full bg-[var(--color-castify-accent)]/20 px-2 py-0.5 text-xs font-medium text-[var(--color-castify-accent)]"
      title="This video appears in multiple providers"
    >
      Also in: {labels}
    </span>
  );
}

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  isFetching: boolean;
}

function Pagination({ page, totalPages, onPageChange, isFetching }: PaginationProps) {
  return (
    <div className="flex items-center justify-between gap-4 pt-2">
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1 || isFetching}
        className="rounded-md border border-white/15 px-4 py-2 text-sm transition hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        Previous
      </button>
      <span className="text-sm opacity-60">
        Page {page} of {totalPages}
        {isFetching ? " · loading…" : ""}
      </span>
      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages || isFetching}
        className="rounded-md border border-white/15 px-4 py-2 text-sm transition hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        Next
      </button>
    </div>
  );
}

function EmptyState() {
  const connections = useConnections();
  const isScanning =
    connections.data?.some((c) => c.scan_status === "scanning") ?? false;

  return (
    <div className="rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-8 text-center">
      <p className="text-lg font-medium">
        {isScanning ? "Scanning your cloud…" : "No videos yet"}
      </p>
      <p className="mt-2 text-sm opacity-60">
        {isScanning
          ? "Videos will appear here as the scan progresses."
          : "Connect a cloud provider to populate your library."}
      </p>
      {!isScanning && (
        <Link
          to="/connections"
          className="mt-4 inline-block rounded-md bg-[var(--color-castify-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90"
        >
          Connect a provider
        </Link>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-4"
        >
          <div className="flex-1 space-y-2">
            <div className="h-4 w-2/3 rounded bg-white/10" />
            <div className="h-3 w-1/3 rounded bg-white/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatResolution(width: number, height: number): string {
  return `${width}\u00d7${height}`;
}
