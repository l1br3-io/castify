// `usePlaybackTracking` — resume-on-load + periodic/event progress saves
// for the watch page (PRD FR-9). Consumed by `VideoPlayer` in `watch.tsx`.
//
// Per `docs/data-storage-principles.md`, all progress data lives in
// IndexedDB — zero server requests during playback. The server's
// `POST /progress` endpoint and `playback_progress` table stay dormant.
//
// Resume position comes from IndexedDB (read async on mount). The hook
// waits for that read before setting up event listeners, so the
// `loadedmetadata` seek uses the saved value.
//
// Progress is written to IndexedDB every 10s and on `pause` / `seeked` /
// `ended`. When playback crosses 95% of duration, `completed` is set to
// `true` (dropping the video off a future continue-watching shelf). A
// position-delta check skips writes when playback hasn't advanced ≥5s,
// eliminating I/O while paused or stalled.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  getProgress,
  saveProgressEntry,
  type ProgressEntry,
} from "../lib/player-db";
import type { VideoDetailDto } from "../api/types";

/** Seconds below which resume is skipped (FR-9.1: position > 30). */
const RESUME_THRESHOLD_SECONDS = 30;
/** Interval between IndexedDB progress writes during playback. Local I/O
 *  is cheap enough that 10s granularity keeps worst-case progress loss
 *  small without flooding the database. */
const SAVE_INTERVAL_MS = 10_000;
/** Minimum position change (seconds) to warrant a write. Paused/stalled
 *  playback produces no I/O — the interval ticks but `doSave` is a no-op
 *  when `currentTime` hasn't moved since the last write. */
const MIN_SAVE_DELTA_SECONDS = 5;
/** Playback fraction at which the video is auto-marked completed. */
const COMPLETION_FRACTION = 0.95;
/** How long the resume toast stays visible before auto-dismissing. */
const RESUME_TOAST_MS = 5000;

export interface PlaybackTracking {
  /** Whether the "Resume from X:XX?" toast should render. */
  showResume: boolean;
  /** The position being resumed from (for the toast label). */
  resumePosition: number;
  /** Seek to 0 and dismiss the resume toast. */
  startFromBeginning: () => void;
  /** Dismiss the resume toast without changing position. */
  dismissResume: () => void;
  /**
   * Fire a one-shot progress save with the current `currentTime`. Used by
   * the watch page's queue-skip handler (T11) so mid-playback skips don't
   * lose up to 10s of progress (the periodic interval's worst-case lag).
   * Safe to call any time the `<video>` is mounted; no-op without a ref.
   * The position-delta check still applies, so calling this when playback
   * hasn't advanced since the last save is a no-op.
   */
  saveNow: () => void;
}

export function usePlaybackTracking(
  videoRef: React.RefObject<HTMLVideoElement>,
  video: VideoDetailDto,
): PlaybackTracking {
  const [showResume, setShowResume] = useState(false);
  const [resumePosition, setResumePosition] = useState(0);

  // Latest media state, kept in refs so handlers read fresh values without
  // re-subscribing.
  const latestTimeRef = useRef(0);
  const latestDurationRef = useRef<number | null>(video.duration_seconds);

  // Resume position loaded from IndexedDB. `null` = not yet loaded; the
  // main effect waits for this to become non-null before activating.
  const [savedProgress, setSavedProgress] = useState<ProgressEntry | null | undefined>(undefined);

  // Last position we persisted. The interval + event handlers compare
  // against this to skip redundant writes when playback is paused/stalled.
  const lastSavedPositionRef = useRef<number>(0);

  // --- Load saved progress from IndexedDB when the video changes ---
  useEffect(() => {
    setSavedProgress(undefined); // loading
    let cancelled = false;
    void getProgress(video.id).then((entry) => {
      if (!cancelled) setSavedProgress(entry);
    });
    return () => {
      cancelled = true;
    };
  }, [video.id]);

  const doSave = useCallback(
    (forceCompleted?: boolean) => {
      const videoEl = videoRef.current;
      if (!videoEl) return;
      const duration = Number.isFinite(videoEl.duration)
        ? videoEl.duration
        : (latestDurationRef.current ?? null);
      const position = videoEl.currentTime;
      // Skip when the position hasn't meaningfully advanced since the last
      // write. Eliminates redundant I/O while paused, stalled, or between
      // tight seek+pause sequences. Forced writes (e.g. `ended` → completed)
      // always go through.
      if (
        forceCompleted === undefined &&
        Math.abs(position - lastSavedPositionRef.current) <
          MIN_SAVE_DELTA_SECONDS
      ) {
        return;
      }
      const completed =
        forceCompleted ??
        (duration !== null &&
          duration > 0 &&
          position / duration >= COMPLETION_FRACTION);
      lastSavedPositionRef.current = position;
      const entry: ProgressEntry = {
        videoId: video.id,
        positionSeconds: position,
        durationSeconds: duration,
        completed,
        updatedAt: Date.now(),
        // Denormalized metadata for a future continue-watching shelf:
        videoName: video.name,
        videoDurationMs: video.duration_ms,
        thumbnailStatus: video.thumbnail_status,
        height: video.height,
        provider: video.provider,
      };
      void saveProgressEntry(entry);
    },
    [video, videoRef],
  );

  // --- Resume seek + event listeners + periodic interval ---
  // Re-initializes when the video changes (T11 queue skip changes videoId).
  // Waits for `savedProgress` to load from IndexedDB before activating.
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (savedProgress === undefined) return; // still loading

    latestDurationRef.current = video.duration_seconds;
    lastSavedPositionRef.current = savedProgress?.positionSeconds ?? 0;

    const shouldResume =
      savedProgress !== null &&
      savedProgress.positionSeconds > RESUME_THRESHOLD_SECONDS &&
      !savedProgress.completed;

    const seekForResume = () => {
      if (!shouldResume) return;
      const dur = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
      // Clamp to duration in case the video was trimmed since last watch.
      const target =
        dur > 0
          ? Math.min(savedProgress!.positionSeconds, dur)
          : savedProgress!.positionSeconds;
      videoEl.currentTime = target;
      setResumePosition(target);
      setShowResume(true);
    };

    // Resume as soon as metadata is available (setting currentTime before
    // HAVE_METADATA may be dropped by some browsers).
    const onLoadedMetadata = () => {
      seekForResume();
    };
    // If metadata already loaded (fast cache hit), seek immediately.
    if (videoEl.readyState >= HTMLMediaElement.HAVE_METADATA) {
      seekForResume();
    }

    const onTimeUpdate = () => {
      latestTimeRef.current = videoEl.currentTime;
      if (Number.isFinite(videoEl.duration)) {
        latestDurationRef.current = videoEl.duration;
      }
    };
    const onPause = () => doSave();
    const onSeeked = () => doSave();
    const onEnded = () => doSave(true);

    videoEl.addEventListener("loadedmetadata", onLoadedMetadata);
    videoEl.addEventListener("timeupdate", onTimeUpdate);
    videoEl.addEventListener("pause", onPause);
    videoEl.addEventListener("seeked", onSeeked);
    videoEl.addEventListener("ended", onEnded);

    const interval = window.setInterval(() => doSave(), SAVE_INTERVAL_MS);

    // Page-unload save. Fire-and-forget IndexedDB write — browsers
    // typically complete short IDB transactions during pagehide. Worst
    // case the last interval write (≤10s old) covers it.
    const onPageHide = () => {
      doSave();
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      videoEl.removeEventListener("loadedmetadata", onLoadedMetadata);
      videoEl.removeEventListener("timeupdate", onTimeUpdate);
      videoEl.removeEventListener("pause", onPause);
      videoEl.removeEventListener("seeked", onSeeked);
      videoEl.removeEventListener("ended", onEnded);
      window.clearInterval(interval);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [videoRef, video, savedProgress, doSave]);

  // --- Resume toast auto-dismiss (5s) ---
  useEffect(() => {
    if (!showResume) return;
    const timer = window.setTimeout(
      () => setShowResume(false),
      RESUME_TOAST_MS,
    );
    return () => window.clearTimeout(timer);
  }, [showResume]);

  const startFromBeginning = useCallback(() => {
    const videoEl = videoRef.current;
    if (videoEl) videoEl.currentTime = 0;
    setShowResume(false);
  }, [videoRef]);

  const dismissResume = useCallback(() => setShowResume(false), []);

  return {
    showResume,
    resumePosition,
    startFromBeginning,
    dismissResume,
    saveNow: doSave,
  };
}
