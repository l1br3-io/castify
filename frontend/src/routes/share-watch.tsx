// Share watch page (sharing task 010) — the recipient's player
// at `/share/:token/watch/:videoId`, fully public (no session, no
// AppLayout).
//
// Reuses the owner player stack unchanged — `useStreamUrl` (with the share
// scope from task 008's URL seam), `useHlsStream`, `useLibassSubtitles`,
// `usePlaybackTracking`, `PlayerControls` — passing `{ kind: "share",
// token }` so every Castify-served URL (stream, poster, subtitle track,
// transcode master) roots under `/api/share/{token}/...`.
//
// There is no share-scoped detail endpoint by design (the recipient API
// stops at items + mirrors), so the page composes the `VideoDetailDto` the
// player stack expects from two share-scoped fetches:
//
//   GET items    → member summaries → find by :videoId (also proves
//                  membership before any byte-fetching starts)
//   GET subtitles→ sidecar tracks
//   duration_seconds is derived from duration_ms (the owner detail route
//   computes the same field server-side).
//
// Owner-only affordances are hidden, not gated: no favorite/rating, no
// queue skips or auto-advance (share PosterCards never seed router queue
// state), no download fallback (spec v1 line: no recipient download
// endpoints), and stream errors never render the Reconnect card — a
// recipient cannot re-grant the owner's OAuth tokens, so reauth-shaped
// errors collapse into the generic stream-error card.
//
// Progress/prefs keep flowing to IndexedDB via `usePlaybackTracking` —
// the same `player-db` store the owner player uses — so a recipient gets
// resume behavior on their device with zero server writes during playback
// (`docs/data-storage-principles.md` rule #1/#2).

import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { DedupBadge, ProviderBadge } from "../components/badges";
import { PlayerControls } from "../components/player-controls";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Skeleton } from "../components/ui/skeleton";
import { ApiError } from "../api/client";
import { fetchShareItems } from "../api/shares";
import {
  fetchSubtitles,
  subtitleTrackUrl,
  thumbnailUrl,
  type AccessScope,
} from "../api/videos";
import { useHlsStream } from "../hooks/use-hls-stream";
import { useLibassSubtitles } from "../hooks/use-libass-subtitles";
import { usePlaybackTracking } from "../hooks/use-playback-tracking";
import { useInvalidateStreamUrl, useStreamUrl } from "../hooks/use-stream-url";
import type { VideoDetailDto, VideoSummaryDto } from "../api/types";
import {
  containerLabel,
  formatDuration,
  formatSize,
  formatTime,
  resolutionBucket,
} from "../lib/format";
import { isAssFormat, isImageFamily } from "../lib/subtitles";
import { otherProviders } from "../lib/video";
import { SharedChrome } from "../components/shared-chrome";

/**
 * Probe whether the browser can natively play the given MIME type.
 * Duplicated from `watch.tsx` (module-private there) rather than refactoring
 * the owner page — task 010 keeps `watch.tsx` untouched. Returns `true` when
 * `mime` is null (optimistic — the `onError` path catches failed decodes).
 */
function canPlay(mime: string | null): boolean {
  if (mime === null) return true;
  return document.createElement("video").canPlayType(mime) !== "";
}

/**
 * Append `?burn_subtitles={trackId}` to the transcode master playlist URL.
 * Duplicated from `watch.tsx` for the same untouched-owner-page reason.
 * String concatenation (not `new URL()`) preserves relative share-scoped
 * master URLs exactly as the stream-url response served them.
 */
function appendBurnParam(baseUrl: string, trackId: string): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}burn_subtitles=${encodeURIComponent(trackId)}`;
}

/**
 * Membership-loss detector for share-scope mirror fetches. Every mirror
 * guards through `authorize_share_item`, which answers 404 for a
 * non-member — deliberately indistinguishable from an unknown video id
 * (a valid token must not probe the catalog, mutable-share-list plan /
 * task 004's denial proof). Both mirror queries on this page are gated on
 * the items list having already resolved the video as a member, so a 404
 * arriving after that point means the owner removed the video from the
 * share while the recipient had the page open. The page is share-scoped
 * by construction, so no extra scope check is needed here.
 */
function isMembershipLoss(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 404;
}

export function ShareWatchPage() {
  const { token, videoId } = useParams<{ token: string; videoId: string }>();
  const scope: AccessScope | undefined =
    token !== undefined ? { kind: "share", token } : undefined;

  // Same query key as the landing page — navigating from the grid is a
  // cache hit (zero extra requests). `staleTime: Infinity` + `retry:
  // false` match the landing page's no-polling discipline.
  const items = useQuery({
    queryKey: ["share", token, "items"],
    queryFn: () => fetchShareItems(token!),
    enabled: token !== undefined,
    retry: false,
    staleTime: Infinity,
  });

  // Membership lookup over the tree payload (share-folders task 004):
  // the video summary rides in `.items`, each carrying its `folder_id` —
  // placement is irrelevant here, membership is the only gate.
  const video: VideoSummaryDto | undefined =
    videoId !== undefined
      ? items.data?.items.find((item) => item.id === videoId)
      : undefined;

  // Sidecar tracks via the share mirror. Gated on membership so a
  // non-member id never fetches anything.
  const subtitles = useQuery({
    queryKey: ["share", token, "videos", videoId, "subtitles"],
    queryFn: () => fetchSubtitles(videoId!, scope!),
    enabled: video !== undefined,
    retry: false,
    staleTime: Infinity,
  });

  // Strategy resolution through the share mirror. `id` stays undefined
  // until membership resolves — the hook's `enabled: !!id` gate then keeps
  // non-members from ever hitting the stream-url mirror.
  const streamUrlQuery = useStreamUrl(
    video !== undefined ? videoId : undefined,
    scope,
  );

  if (items.isPending) {
    return (
      <SharedChrome dark>
      <div className="mx-auto max-w-5xl space-y-4">
        <BackToShare token={token} />
        <WatchSkeleton />
      </div>
    </SharedChrome>
    );
  }

  if (items.isError) {
    const status = items.error instanceof ApiError ? items.error.status : null;
    if (status === 401) {
      // Not unlocked (direct link, or the 24h unlock cookie lapsed). The
      // gate lives on the landing page — send the recipient there rather
      // than duplicating the password form on the player.
      return (
        <SharedChrome dark>
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
          <div className="space-y-4 text-center">
            <EmptyState
              title="This share is protected by a password."
              body="Open the share page and enter the password to watch."
            />
            <Link
              to={`/share/${encodeURIComponent(token as string)}`}
              className="inline-block rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-5 py-2 text-sm font-semibold text-[var(--color-on-accent)] transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-canvas)]"
            >
              Go to the share page
            </Link>
          </div>
        </div>
    </SharedChrome>
      );
    }
    if (status === 410 || status === 404) {
      return (
        <SharedChrome dark>
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
          <EmptyState
            title={
              status === 410
                ? "This share is no longer available."
                : "This share doesn't exist."
            }
            body={
              status === 410
                ? "The link expired or was revoked by whoever shared it."
                : "Double-check the link, or ask whoever sent it for a new one."
            }
          />
        </div>
    </SharedChrome>
      );
    }
    return (
      <SharedChrome dark>
      <div className="mx-auto max-w-5xl">
        <ErrorState
          title="Couldn't load this share."
          body="Something went wrong fetching the shared videos."
          onRetry={() => void items.refetch()}
        />
      </div>
    </SharedChrome>
    );
  }

  // Membership check against the authoritative items list — the mirrors
  // would reject a non-member id anyway, but failing fast (before any
  // byte-fetching) is cheaper and gives honest copy.
  if (video === undefined || videoId === undefined) {
    return (
      <SharedChrome dark>
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
        <div className="space-y-4 text-center">
          <EmptyState
            title="This video isn't part of the share."
            body="It may have been removed, or the link is off."
          />
          <Link
            to={`/share/${encodeURIComponent(token as string)}`}
            className="inline-block rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-5 py-2 text-sm font-semibold text-[var(--color-on-accent)] transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-canvas)]"
          >
            Go to the share page
          </Link>
        </div>
      </div>
    </SharedChrome>
    );
  }

  if (subtitles.isPending) {
    return (
      <SharedChrome dark>
      <div className="mx-auto max-w-5xl space-y-4">
        <BackToShare token={token} />
        <WatchSkeleton />
      </div>
    </SharedChrome>
    );
  }

  if (subtitles.isError) {
    if (isMembershipLoss(subtitles.error)) {
      return <ShareVideoRemoved token={token} />;
    }
    return (
      <SharedChrome dark>
      <div className="mx-auto max-w-5xl">
        <ErrorState
          title="Couldn't load this share."
          body="Something went wrong fetching the shared videos."
          onRetry={() => void subtitles.refetch()}
        />
      </div>
    </SharedChrome>
    );
  }

  // Compose the detail the player stack expects. The items endpoint's
  // personalization fields are neutral by construction (owner
  // favorites/ratings/progress never cross the share boundary).
  const detail: VideoDetailDto = {
    ...video,
    duration_seconds:
      video.duration_ms !== null ? video.duration_ms / 1000 : null,
    subtitle_tracks: subtitles.data,
  };

  const strategy = streamUrlQuery.data?.strategy;

  // Stream errors collapse into the generic card — including reauth-shaped
  // ones. The owner's Reconnect flow is meaningless to a recipient (it
  // needs the owner's session to re-grant OAuth tokens), so the share page
  // deliberately does NOT branch on `isReauthLikelyError` the way
  // `watch.tsx` does. Membership loss (404) is the one exception — it
  // gets the dedicated terminal card above.
  if (streamUrlQuery.error) {
    if (isMembershipLoss(streamUrlQuery.error)) {
      return <ShareVideoRemoved token={token} />;
    }
    return (
      <SharedChrome dark>
      <div className="mx-auto max-w-5xl space-y-4">
        <BackToShare token={token} />
        <ShareStreamError video={detail} scope={scope!} />
      </div>
    </SharedChrome>
    );
  }

  if (strategy === "transcode" || canPlay(video.mime_type)) {
    return (
      <SharedChrome dark>
      <div className="mx-auto max-w-5xl space-y-4">
        <BackToShare token={token} />
        <ShareVideoPlayer video={detail} scope={scope!} streamUrlQuery={streamUrlQuery} />
      </div>
    </SharedChrome>
    );
  }

  if (streamUrlQuery.isLoading) {
    return (
      <SharedChrome dark>
      <div className="mx-auto max-w-5xl space-y-4">
        <BackToShare token={token} />
        <WatchSkeleton />
      </div>
    </SharedChrome>
    );
  }

  return (
    <SharedChrome dark>
      <div className="mx-auto max-w-5xl space-y-4">
      <BackToShare token={token} />
      <ShareUnsupportedFormat video={detail} />
    </div>
    </SharedChrome>
  );
}

// ---------------------------------------------------------------------------
// Back link — recipients get no AppLayout nav, so the page needs its own
// way back to the share grid.
// ---------------------------------------------------------------------------

function BackToShare({ token }: { token: string | undefined }) {
  if (token === undefined) return null;
  return (
    <Link
      to={`/share/${encodeURIComponent(token)}`}
      className="inline-block text-sm text-[var(--color-castify-muted)] underline-offset-4 transition hover:text-white hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)]"
    >
      ← Back to share
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Removed from share — terminal card for membership loss (a 404 from a
// share-scope mirror after the items list already proved membership; see
// `isMembershipLoss`). Same shape as the page's other terminal states:
// centered, a link back to the grid, and deliberately no retry/reconnect
// affordance — the state can only change on the owner's side.
// ---------------------------------------------------------------------------

function ShareVideoRemoved({ token }: { token: string | undefined }) {
  return (
    <SharedChrome dark>
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
      <div className="space-y-4 text-center">
        <EmptyState
          title="This video is no longer available in this share"
          body="Whoever shared it removed this video from the list."
        />
        <Link
          to={`/share/${encodeURIComponent(token as string)}`}
          className="inline-block rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-5 py-2 text-sm font-semibold text-[var(--color-on-accent)] transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-canvas)]"
        >
          Go to the share page
        </Link>
      </div>
    </div>
    </SharedChrome>
  );
}

// ---------------------------------------------------------------------------
// Video player (share variant)
// ---------------------------------------------------------------------------

function ShareVideoPlayer({
  video,
  scope,
  streamUrlQuery,
}: {
  video: VideoDetailDto;
  scope: AccessScope;
  streamUrlQuery: ReturnType<typeof useStreamUrl>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasError, setHasError] = useState(false);

  // Active subtitle mirror + transcode burn-in — same ownership rules as
  // the owner VideoPlayer (PlayerControls owns the selection; this mirrors
  // it to route ASS to libass and burn-ins to the master URL param).
  const [activeSubtitle, setActiveSubtitle] = useState(-1);
  const [burnSubtitleId, setBurnSubtitleId] = useState<string | null>(null);

  const invalidateStreamUrl = useInvalidateStreamUrl();
  const isTranscode = streamUrlQuery.data?.strategy === "transcode";

  // Single direct-CDN URL-expiry retry, reset per video — mirrors the
  // owner player's recovery path.
  const retriedStreamUrlRef = useRef(false);
  useEffect(() => {
    retriedStreamUrlRef.current = false;
  }, [video.id]);

  const tracking = usePlaybackTracking(videoRef, video);

  function handleActiveSubtitleChange(index: number) {
    setActiveSubtitle(index);
    if (index < 0 || !isImageFamily(video.subtitle_tracks[index])) {
      setBurnSubtitleId(null);
    }
  }

  const baseUrl = isTranscode ? streamUrlQuery.data?.url : undefined;
  const masterUrl =
    baseUrl !== undefined && burnSubtitleId !== null
      ? appendBurnParam(baseUrl, burnSubtitleId)
      : baseUrl;
  const hlsStream = useHlsStream(videoRef, masterUrl, {
    onError: () => setHasError(true),
  });

  const activeSubtitleTrack =
    activeSubtitle >= 0 ? video.subtitle_tracks[activeSubtitle] : null;
  const assUrl =
    activeSubtitleTrack && isAssFormat(activeSubtitleTrack.format)
      ? subtitleTrackUrl(video.id, activeSubtitleTrack.id, scope)
      : undefined;
  useLibassSubtitles(videoRef, canvasRef, assUrl);

  function handleVideoError() {
    if (isTranscode) {
      setHasError(true);
      return;
    }
    const strategy = streamUrlQuery.data?.strategy;
    if (strategy === "direct" && !retriedStreamUrlRef.current) {
      retriedStreamUrlRef.current = true;
      invalidateStreamUrl(video.id, scope);
      return;
    }
    setHasError(true);
  }

  if (hasError) {
    return <ShareUnsupportedFormat video={video} />;
  }

  const posterUrl = thumbnailUrl(video.id, scope);
  const src = isTranscode ? undefined : streamUrlQuery.data?.url;
  const isStreamLoading = !src && !isTranscode;
  const isHlsLoading = isTranscode && !hlsStream.isReady;

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
          ref={videoRef}
          className="block w-full"
        >
          {video.subtitle_tracks
            .filter((track) => !isAssFormat(track.format))
            .map((track) => (
              <track
                key={track.id}
                kind="subtitles"
                src={subtitleTrackUrl(video.id, track.id, scope)}
                srcLang={track.language ?? undefined}
                label={track.language ?? "Unknown"}
              />
            ))}
        </video>
        {assUrl && (
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-10"
          />
        )}
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
        {isHlsLoading && (
          <div
            role="status"
            aria-label="Starting transcode stream"
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4"
          >
            <div className="flex flex-col items-center gap-3 text-white">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
              <p className="text-sm text-white/80">Transcoding…</p>
            </div>
          </div>
        )}
        <PlayerControls
          videoRef={videoRef}
          containerRef={containerRef}
          subtitleTracks={video.subtitle_tracks}
          videoId={video.id}
          onActiveSubtitleChange={handleActiveSubtitleChange}
          levels={isTranscode ? hlsStream.levels : undefined}
          currentLevel={isTranscode ? hlsStream.currentLevel : undefined}
          onLevelChange={
            isTranscode
              ? (level: number) => hlsStream.setCurrentLevel(level)
              : undefined
          }
          isTranscode={isTranscode}
          onConfirmBurnSubtitle={(trackId) => setBurnSubtitleId(trackId)}
        />
      </div>
      <ShareVideoInfo video={video} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unsupported format — share variant (no download fallback)
// ---------------------------------------------------------------------------

function ShareUnsupportedFormat({ video }: { video: VideoDetailDto }) {
  return (
    <div className="space-y-4">
      <ErrorState
        title="This format can't be played in-browser"
        body="Shared videos stream only — there's no download fallback. If it keeps failing, whoever shared this video may need to check their library."
      />
      <ShareVideoInfo video={video} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stream URL error — share variant (no reconnect flow, no owner copy)
// ---------------------------------------------------------------------------

function ShareStreamError({
  video,
  scope,
}: {
  video: VideoDetailDto;
  scope: AccessScope;
}) {
  const invalidateStreamUrl = useInvalidateStreamUrl();
  return (
    <div className="space-y-4">
      <ErrorState
        title="Couldn't load this video"
        body="Something went wrong fetching the stream. If it keeps failing, whoever shared this video may need to reconnect their cloud account."
        onRetry={() => invalidateStreamUrl(video.id, scope)}
      />
      <ShareVideoInfo video={video} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Video metadata (share variant — no favorite/rating controls)
// ---------------------------------------------------------------------------

function ShareVideoInfo({ video }: { video: VideoDetailDto }) {
  const others = otherProviders(video);
  const container = containerLabel(video.mime_type);
  const resBucket = resolutionBucket(video.height);

  return (
    <div className="space-y-3">
      <h1 className="text-2xl">{video.name}</h1>
      <div className="flex flex-wrap items-center gap-2">
        <ProviderBadge provider={video.provider} />
        {others.length > 0 && <DedupBadge providers={others} />}
        {container && <span className="keycap">{container}</span>}
        {resBucket && <span className="keycap">{resBucket}</span>}
      </div>
      <p className="figure text-sm text-[var(--color-castify-muted)]">
        {video.duration_ms !== null && `${formatDuration(video.duration_ms)} · `}
        {formatSize(video.size_bytes)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function WatchSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="aspect-video w-full" />
      <div className="space-y-2">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
    </div>
  );
}
