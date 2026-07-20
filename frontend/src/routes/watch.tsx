// Watch page — M3 T7 player shell, T8 custom controls.
//
// Fetches `GET /api/videos/{id}` for full video metadata, renders a
// `<video>` element sourcing from the stream endpoint. Subtitle sidecars
// (detected at scan time) are wired as `<track>` elements whose `.mode` the
// custom PlayerControls toggles (no native `controls` / no `default` track).
// Unsupported formats (detected via `canPlayType` probe) show a download
// link instead. Loading, error, and not-found states are handled.
//
// The VideoInfo section reuses the M2 personalization controls (FavoriteToggle
// + RatingStars in `hero` variant) and the badge components for visual
// consistency with the browse page. `VideoDetailDto` is structurally
// compatible with the `VideoSummaryDto` prop type both expect.
//
// T10 adds resume-on-load + periodic/event progress tracking (consuming
// `usePlaybackTracking`). T11 adds the ephemeral queue: skip prev/next
// controls (PlayerControls), 5s auto-advance countdown overlay
// (`useAutoAdvance`), and an UpNext panel below VideoInfo. Queue state
// comes from `location.state.queue` (set by PosterCard / HeroShowcase /
// Shelf click navigation in T7) — direct URL access or reload starts with
// no queue (FR-10.5).

import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { FavoriteToggle } from "../components/favorite-toggle";
import { RatingStars } from "../components/rating-stars";
import { DedupBadge, ProviderBadge } from "../components/badges";
import { PlayerControls } from "../components/player-controls";
import { UpNext } from "../components/up-next";
import { useAutoAdvance } from "../hooks/use-auto-advance";
import { usePlaybackTracking } from "../hooks/use-playback-tracking";
import { useQueue } from "../hooks/use-queue";
import {
  isReauthRequiredError,
  streamUrlQueryKey,
  useInvalidateStreamUrl,
  useStreamUrl,
} from "../hooks/use-stream-url";
import { useVideoDetail } from "../hooks/use-video-detail";
import {
  describeError,
  formatDuration,
  formatResolution,
  formatSize,
  formatTime,
  resolutionBucket,
} from "../lib/format";
import { otherProviders } from "../lib/video";
import { downloadUrl, subtitleTrackUrl } from "../api/videos";
import { PROVIDER_LABELS, type ProviderKey, type VideoDetailDto } from "../api/types";

/**
 * Probe whether the browser can natively play the given MIME type.
 * Returns `true` if playable or if `mime` is null (optimistic — fallback to
 * `onError` if the browser can't actually decode the content).
 */
function canPlay(mime: string | null): boolean {
  if (mime === null) return true;
  return document.createElement("video").canPlayType(mime) !== "";
}

export function WatchPage() {
  const { id } = useParams<{ id: string }>();
  const query = useVideoDetail(id);

  if (query.isError) {
    const isNotFound =
      query.error instanceof Error &&
      "status" in query.error &&
      (query.error as { status: number }).status === 404;
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-bold">
          {isNotFound ? "Video not found" : "Something went wrong"}
        </h1>
        <p className="text-sm opacity-60">
          {isNotFound
            ? "The video you're looking for doesn't exist."
            : describeError(query.error)}
        </p>
        <Link
          to="/"
          className="rounded-md bg-[var(--color-castify-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90"
        >
          Back to browse
        </Link>
      </div>
    );
  }

  if (query.isLoading || !query.data) {
    return <WatchSkeleton />;
  }

  const video = query.data;

  if (canPlay(video.mime_type)) {
    return <VideoPlayer video={video} />;
  }
  return <UnsupportedFormat video={video} />;
}

// ---------------------------------------------------------------------------
// Video player (native `<video>` element)
// ---------------------------------------------------------------------------

function VideoPlayer({ video }: { video: VideoDetailDto }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasError, setHasError] = useState(false);
  const [showEndOfQueue, setShowEndOfQueue] = useState(false);

  // Resolve where to fetch video bytes: a direct CDN URL (all providers —
  // OneDrive/Dropbox issue natively, Google Drive via `?alt=media` redirect-
  // follow) or our /stream proxy (fallback). See T12 — direct CDN streaming.
  const streamUrlQuery = useStreamUrl(video.id);
  const invalidateStreamUrl = useInvalidateStreamUrl();
  // CDN URL expiry retry guard. Resets when the video id changes (queue skip)
  // — direct CDN URLs are short-lived (~1hr), and an `<video>` error after
  // that window should trigger one re-fetch of /stream-url before degrading
  // to the unsupported-format fallback. The ref persists across renders but
  // resets via the effect below.
  const retriedStreamUrlRef = useRef(false);
  useEffect(() => {
    retriedStreamUrlRef.current = false;
  }, [video.id]);

  // Reauth-required short-circuit. Surfaced before rendering the `<video>`
  // so the user sees a single clear path forward (reconnect on the
  // Connections page) rather than a confusing `invalid_grant` 502.
  const reauthError = isReauthRequiredError(streamUrlQuery.error)
    ? streamUrlQuery.error
    : null;

  const tracking = usePlaybackTracking(videoRef, video);

  const queue = useQueue();

  // Skip handlers — fire a one-shot progress save first so mid-playback
  // skips don't lose up to 60s (the periodic interval's worst-case lag),
  // then navigate. Auto-advance also goes through `goToNext` so the queue
  // state propagates to the new entry.
  function handlePrev() {
    tracking.saveNow();
    queue.goToPrev();
  }
  function handleNext() {
    tracking.saveNow();
    queue.goToNext();
  }

  const autoAdvance = useAutoAdvance(
    videoRef,
    video.id,
    queue.hasNext,
    handleNext,
  );

  // When the video ends and there's no next, show a brief "End of queue"
  // overlay (plan T11: "show 'End of queue' message"). The `ended` listener
  // is independent of `usePlaybackTracking` (which saves progress) and
  // `useAutoAdvance` (which only acts when `hasNext`).
  function handleEndedEndOfQueue() {
    if (!queue.hasNext && queue.hasQueue) setShowEndOfQueue(true);
  }

  // `<video>` error handler. For direct-CDN strategy, a 410/403 mid-stream
  // means the short-lived URL expired — refresh once by invalidating the
  // /stream-url query (TanStack re-fetches, React swaps `<video src>` to
  // the fresh URL, Range requests resume from currentTime). For proxy
  // strategy or after one retry, fall back to UnsupportedFormat.
  function handleVideoError() {
    const strategy = streamUrlQuery.data?.strategy;
    if (strategy === "direct" && !retriedStreamUrlRef.current) {
      retriedStreamUrlRef.current = true;
      invalidateStreamUrl(video.id);
      return;
    }
    setHasError(true);
  }

  if (reauthError) {
    return (
      <ReconnectProvider
        video={video}
        provider={
          // The backend surfaces the dead connection's provider in the
          // structured error body; fall back to the video's own provider
          // (they're the same in practice — the connection that owns the
          // video is the one whose token is dead).
          (reauthError.body as { provider?: ProviderKey } | null)?.provider ??
          video.provider
        }
      />
    );
  }

  // `/stream-url` errored for a reason other than reauth-required (network
  // blip, 500, transient Drive failure). TanStack has already retried per
  // the hook's policy; if we land here, the user needs to act. Surfacing
  // this state explicitly prevents the bug where the `<video>` rendered
  // with `src={undefined}` left Play as a no-op that threw
  // "NotSupportedError: The element has no supported sources."
  if (streamUrlQuery.error) {
    return <StreamUrlError video={video} error={streamUrlQuery.error} />;
  }

  if (hasError) {
    return <UnsupportedFormat video={video} />;
  }

  const posterUrl = `/api/videos/${encodeURIComponent(video.id)}/thumbnail`;
  // While /stream-url resolves (first paint), `src` is undefined — the
  // `<video>` shows the poster with no playable source. We render a
  // "Preparing" overlay so the user knows playback is starting shortly;
  // without it, the poster looks like a finished render and pressing Play
  // throws "no supported sources" before the URL has landed.
  const src = streamUrlQuery.data?.url;
  const isStreamLoading = !src;

  return (
    <div className="space-y-4">
      <div
        ref={containerRef}
        className="relative w-full overflow-hidden rounded-lg bg-black"
      >
        <video
          preload="metadata"
          poster={posterUrl}
          src={src}
          onError={handleVideoError}
          onEnded={handleEndedEndOfQueue}
          ref={videoRef}
          className="block w-full"
        >
          {video.subtitle_tracks.map((track) => (
            <track
              key={track.id}
              kind="subtitles"
              src={subtitleTrackUrl(video.id, track.id)}
              srcLang={track.language ?? undefined}
              label={track.language ?? "Unknown"}
            />
          ))}
        </video>
        {tracking.showResume && (
          <div
            role="status"
            className="absolute left-3 top-3 z-20 flex items-center gap-3 rounded-lg border border-white/10 bg-[var(--color-castify-surface)]/95 px-4 py-2.5 text-sm text-white shadow-lg backdrop-blur"
          >
            <span>
              Resume from{" "}
              <span className="font-semibold tabular-nums">
                {formatTime(tracking.resumePosition)}
              </span>
              ?
            </span>
            <button
              type="button"
              onClick={tracking.startFromBeginning}
              className="rounded bg-white/10 px-2.5 py-1 text-xs font-medium transition hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              Start from beginning
            </button>
            <button
              type="button"
              onClick={tracking.dismissResume}
              aria-label="Dismiss"
              className="rounded p-1 text-white/60 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              ✕
            </button>
          </div>
        )}
        {autoAdvance.counting && (
          <div
            role="status"
            aria-label="Auto-advance countdown"
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4"
          >
            <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-5 text-center text-white shadow-xl">
              <p className="text-sm uppercase tracking-wide text-white/60">
                Up next in
              </p>
              <p className="text-4xl font-bold tabular-nums">
                {autoAdvance.secondsLeft}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={autoAdvance.playNextNow}
                  className="rounded-md bg-[var(--color-castify-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  Play next now
                </button>
                <button
                  type="button"
                  onClick={autoAdvance.cancelCountdown}
                  className="rounded-md border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
        {showEndOfQueue && (
          <div
            role="status"
            aria-label="End of queue"
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4"
          >
            <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-5 text-center text-white shadow-xl">
              <p className="text-lg font-semibold">End of queue</p>
              <p className="text-sm text-white/60">
                You&apos;ve reached the end of the queue.
              </p>
              <div className="mt-2 flex gap-2">
                <Link
                  to="/"
                  className="rounded-md bg-[var(--color-castify-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  Back to browse
                </Link>
                <button
                  type="button"
                  onClick={() => setShowEndOfQueue(false)}
                  className="rounded-md border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}
        {isStreamLoading && (
          <div
            role="status"
            aria-label="Preparing video"
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4"
          >
            <div className="flex flex-col items-center gap-3 text-white">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
              <p className="text-sm text-white/80">Preparing your video…</p>
            </div>
          </div>
        )}
        <PlayerControls
          videoRef={videoRef}
          containerRef={containerRef}
          subtitleTracks={video.subtitle_tracks}
          videoId={video.id}
          onPrev={queue.hasQueue ? handlePrev : undefined}
          onNext={queue.hasQueue ? handleNext : undefined}
          hasPrev={queue.hasPrev}
          hasNext={queue.hasNext}
        />
      </div>
      <VideoInfo video={video} />
      {queue.hasQueue && queue.currentIndex >= 0 && (
        <UpNext
          queue={queue.queue}
          currentIndex={queue.currentIndex}
          onSelect={(id) => {
            tracking.saveNow();
            queue.goToIndex(queue.queue.indexOf(id));
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unsupported format — download fallback
// ---------------------------------------------------------------------------

function UnsupportedFormat({ video }: { video: VideoDetailDto }) {
  return (
    <div className="space-y-4">
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-4 rounded-lg border border-white/10 bg-[var(--color-castify-surface)]">
        <div className="text-4xl">🎬</div>
        <p className="text-lg font-medium">
          This format can&apos;t be played in-browser
        </p>
        <a
          href={downloadUrl(video.id)}
          className="rounded-md bg-[var(--color-castify-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90"
          download
        >
          Download {video.name}
        </a>
      </div>
      <VideoInfo video={video} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stream URL error — the /stream-url lookup itself failed (non-reauth)
// ---------------------------------------------------------------------------

/**
 * Shown when `useStreamUrl` errored for a reason other than reauth-required
 * — typically a network blip, a 502 from a transient Drive failure, or a
 * 5xx from our own backend. TanStack has already retried per the hook's
 * policy; landing here means the user needs to act. The metadata still
 * loaded (otherwise the parent's loading skeleton would still be showing),
 * so we render `VideoInfo` for context — same pattern as `UnsupportedFormat`.
 *
 * A manual "Try again" button is the lightest-weight recovery: it bypasses
 * TanStack's retry-by-refetch-on-focus and lets the user re-trigger the
 * load on demand.
 */
function StreamUrlError({
  video,
  error,
}: {
  video: VideoDetailDto;
  error: unknown;
}) {
  const queryClient = useQueryClient();
  return (
    <div className="space-y-4">
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-4 rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-6 text-center">
        <div className="text-4xl">⚠️</div>
        <p className="text-lg font-medium">Couldn&apos;t load this video</p>
        <p className="max-w-md text-sm opacity-70">{describeError(error)}</p>
        <button
          type="button"
          onClick={() =>
            queryClient.invalidateQueries({
              queryKey: streamUrlQueryKey(video.id),
            })
          }
          className="rounded-md bg-[var(--color-castify-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          Try again
        </button>
      </div>
      <VideoInfo video={video} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider re-authentication — the OAuth refresh token expired/revoked
// ---------------------------------------------------------------------------

/**
 * Shown when `/stream-url` returns `401 code: "reauth_required"`. This is
 * terminal for the connection — playback can't recover until the user
 * re-grants access on the Connections page. We mirror the recovery path
 * already documented in `docs/providers.md` and keep the message
 * actionable rather than surfacing the raw `invalid_grant` text.
 *
 * The video metadata still loads from our local DB (so the title and
 * favorite/rating controls render normally); only provider-side byte
 * access is blocked. `VideoInfo` is included for the same reason.
 */
function ReconnectProvider({
  video,
  provider,
}: {
  video: VideoDetailDto;
  provider: ProviderKey;
}) {
  const label = PROVIDER_LABELS[provider] ?? provider;
  return (
    <div className="space-y-4">
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-4 rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-6 text-center">
        <div className="text-4xl">🔌</div>
        <h2 className="text-lg font-medium">
          Reconnect {label} to play this video
        </h2>
        <p className="max-w-md text-sm opacity-70">
          {label}&apos;s authorization has expired or was revoked. Castify
          can&apos;t stream until you reconnect the account — your library
          stays intact.
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Link
            to="/connections"
            className="rounded-md bg-[var(--color-castify-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            Go to Connections
          </Link>
          <Link
            to="/"
            className="rounded-md border border-white/15 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            Back to browse
          </Link>
        </div>
      </div>
      <VideoInfo video={video} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Video metadata (title, duration, resolution, provider)
// ---------------------------------------------------------------------------

function VideoInfo({ video }: { video: VideoDetailDto }) {
  const resBucket = resolutionBucket(video.height);
  const others = otherProviders(video);

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold tracking-tight">{video.name}</h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/60">
        {video.duration_ms !== null && (
          <span>{formatDuration(video.duration_ms)}</span>
        )}
        {video.width !== null && video.height !== null && (
          <>
            {video.duration_ms !== null && <span aria-hidden>·</span>}
            <span>{formatResolution(video.width, video.height)}</span>
          </>
        )}
        <span aria-hidden>·</span>
        <span>{formatSize(video.size_bytes)}</span>
        {resBucket !== null && (
          <>
            <span aria-hidden>·</span>
            <span>{resBucket}</span>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ProviderBadge provider={video.provider} />
        {others.length > 0 && <DedupBadge providers={others} />}
      </div>
      {/* Personalization controls — hero variant. `VideoDetailDto` is a
          structural superset of `VideoSummaryDto`, so both controls accept
          it without adapter code. */}
      <div className="flex flex-wrap items-center gap-4 pt-1">
        <FavoriteToggle video={video} variant="hero" />
        <RatingStars video={video} variant="hero" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function WatchSkeleton() {
  return (
    <div className="space-y-4">
      <div className="aspect-video w-full animate-pulse rounded-lg bg-[var(--color-castify-surface)]" />
      <div className="space-y-2">
        <div className="h-6 w-64 rounded bg-white/10" />
        <div className="h-4 w-48 rounded bg-white/5" />
      </div>
    </div>
  );
}
