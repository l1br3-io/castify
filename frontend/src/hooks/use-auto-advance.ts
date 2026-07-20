// `useAutoAdvance` — auto-advance countdown overlay for the watch page
// (PRD FR-10.3 + plan T11).
//
// Watches the `<video>` `ended` event independently of `usePlaybackTracking`
// (which handles the same `ended` event to save progress with
// `completed: true`). When the video ends AND there's a next queue entry,
// a 5-second countdown starts. At zero, the hook fires `onAdvance`. The
// caller also exposes "Play next now" (immediate advance) and "Cancel"
// (dismiss the countdown — the user can replay or navigate manually).
//
// The countdown is paused/reset when the video id changes (queue skip) or
// the component unmounts. If the user replays the same video (currentTime
// seeks back from the end), the countdown is cancelled automatically by
// the `seeked`/`play` event so playback can resume without the overlay
// re-appearing.

import { useCallback, useEffect, useRef, useState } from "react";

/** Countdown duration in seconds (matches plan T11: "5-second countdown"). */
const COUNTDOWN_SECONDS = 5;

export interface UseAutoAdvance {
  /** Whether the countdown overlay should render. */
  counting: boolean;
  /** Seconds remaining (5..0). When 0 is reached, `onAdvance` fires. */
  secondsLeft: number;
  /** Fire `onAdvance` immediately and stop the countdown. */
  playNextNow: () => void;
  /** Stop the countdown without advancing (the user dismissed it). */
  cancelCountdown: () => void;
}

export function useAutoAdvance(
  videoRef: React.RefObject<HTMLVideoElement>,
  videoId: string,
  hasNext: boolean,
  onAdvance: () => void,
): UseAutoAdvance {
  const [counting, setCounting] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);

  // Hold the latest `hasNext` + `onAdvance` in refs so the `ended` listener
  // — subscribed once per video — reads fresh values without re-binding.
  const hasNextRef = useRef(hasNext);
  useEffect(() => {
    hasNextRef.current = hasNext;
  }, [hasNext]);
  const onAdvanceRef = useRef(onAdvance);
  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  // Mirror `counting` into a ref so the once-subscribed listener can read
  // the latest state without re-binding.
  const countingRef = useRef(false);
  useEffect(() => {
    countingRef.current = counting;
  }, [counting]);

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTick = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const cancelCountdown = useCallback(() => {
    clearTick();
    setCounting(false);
    setSecondsLeft(COUNTDOWN_SECONDS);
  }, [clearTick]);

  const startCountdown = useCallback(() => {
    clearTick();
    // Closure-captured counter so we can call `onAdvance` synchronously when
    // the counter reaches zero — no `setTimeout(0)` deferral (which is
    // tricky to flush deterministically under fake timers + act()).
    let remaining = COUNTDOWN_SECONDS;
    setSecondsLeft(remaining);
    setCounting(true);
    tickRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearTick();
        setCounting(false);
        setSecondsLeft(COUNTDOWN_SECONDS);
        onAdvanceRef.current();
      } else {
        setSecondsLeft(remaining);
      }
    }, 1000);
  }, [clearTick]);

  const playNextNow = useCallback(() => {
    clearTick();
    setCounting(false);
    setSecondsLeft(COUNTDOWN_SECONDS);
    onAdvanceRef.current();
  }, [clearTick]);

  // --- `ended` listener: start countdown when the video ends with a next ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onEnded = () => {
      if (!hasNextRef.current) return;
      startCountdown();
    };
    // User resumed playback (replay, seek-before-end) — cancel any active
    // countdown so the overlay doesn't linger over fresh playback.
    const cancelIfActive = () => {
      if (countingRef.current) cancelCountdown();
    };
    const onPlay = cancelIfActive;
    const onSeeked = cancelIfActive;
    const onPause = cancelIfActive;

    video.addEventListener("ended", onEnded);
    video.addEventListener("play", onPlay);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("pause", onPause);

    return () => {
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("pause", onPause);
      clearTick();
    };
    // `videoId` in deps ensures re-bind when the queue skips to a new video.
  }, [videoRef, videoId, cancelCountdown, startCountdown, clearTick]);

  // --- Video id changed (queue skip) — clear any leftover countdown ---
  useEffect(() => {
    setCounting(false);
    setSecondsLeft(COUNTDOWN_SECONDS);
    clearTick();
  }, [videoId, clearTick]);

  // --- Queue ran out mid-countdown — cancel ---
  useEffect(() => {
    if (!hasNext && counting) cancelCountdown();
  }, [hasNext, counting, cancelCountdown]);

  return { counting, secondsLeft, playNextNow, cancelCountdown };
}
