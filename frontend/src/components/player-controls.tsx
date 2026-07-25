// PlayerControls — custom Tailwind video controls overlay (M3 T8).
//
// Replaces the native `<video controls>` attribute on the watch page. Drives
// the underlying `<video>` element imperatively through the `videoRef` the
// parent attaches; mirrors media state into React via event listeners so the
// icons/time reflect playback. The parent's `containerRef` scopes fullscreen
// and provides the mousemove surface for auto-hide.
//
// Scope: this component owns the control surface only. T9 added playback
// speed + global keyboard shortcuts; T10 adds resume seek + progress tracking;
// T11 adds queue skip controls.

import { useEffect, useRef, useState } from "react";

import {
  FullscreenEnterIcon,
  FullscreenExitIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  SubtitlesIcon,
  VolumeHighIcon,
  VolumeMuteIcon,
} from "./icons";
import { formatTime } from "../lib/format";
import {
  getGlobalPrefs,
  getSubtitlePref,
  saveGlobalPrefs,
  saveSubtitlePref,
} from "../lib/player-db";
import type { SubtitleTrackDto } from "../api/types";
import type { HlsLevel } from "../hooks/use-hls-stream";

type PlayerControlsProps = {
  videoRef: React.RefObject<HTMLVideoElement>;
  containerRef: React.RefObject<HTMLDivElement>;
  subtitleTracks: SubtitleTrackDto[];
  /** Video ID used to key per-video subtitle preferences in IndexedDB. */
  videoId: string;
  /**
   * Optional queue skip controls (M3 T11). When `onPrev`/`onNext` are both
   * omitted, no skip buttons render. When provided, the buttons flank the
   * play/pause button (prev | play | next — YouTube pattern) and reflect
   * their `hasPrev`/`hasNext` disabled state. The watch page passes these
   * only when an ephemeral queue exists (PRD FR-10.2 / FR-10.5).
   */
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  /**
   * Optional HLS variant ladder + manual override (M7 T12). When `levels`
   * is non-empty, the controls render a quality menu (Auto + each rung)
   * and a resolution badge next to the time display. Omit for non-transcode
   * strategies (direct/proxy/cached) where ABR doesn't apply.
   */
  levels?: HlsLevel[];
  /** Active level index, or -1 for Auto. `null` until hls.js reports one. */
  currentLevel?: number | null;
  onLevelChange?: (level: number) => void;
};

/** Inactivity delay before controls hide during playback. */
const AUTO_HIDE_MS = 3000;
/** Seconds the focused seek-slider arrow keys jump (ARIA role=slider step). */
const SEEK_STEP_SECONDS = 5;
/** Seconds the global seek shortcuts (←/→, j/l) jump. */
const SHORTCUT_SEEK_SECONDS = 10;
/** Volume step applied by the ↑/↓ shortcuts. */
const SHORTCUT_VOLUME_STEP = 0.05;
/** Available playback rates (FR-8.5). */
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export function PlayerControls({
  videoRef,
  containerRef,
  subtitleTracks,
  videoId,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
  levels,
  currentLevel,
  onLevelChange,
}: PlayerControlsProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [activeSubtitle, setActiveSubtitle] = useState(-1);
  const [subtitlesOpen, setSubtitlesOpen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // `isPlaying` is also kept in a ref so the auto-hide timer (created once on
  // mount) can read the latest play state without re-subscribing.
  const isPlayingRef = useRef(false);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // `showShortcuts` is mirrored into a ref for the same reason: the global
  // keydown listener (subscribed once) reads it to suspend media shortcuts
  // while the help overlay is open.
  const showShortcutsRef = useRef(false);
  useEffect(() => {
    showShortcutsRef.current = showShortcuts;
  }, [showShortcuts]);

  // --- Sync media state from the <video> element via event listeners ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const readBuffered = () => {
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1));
      }
    };
    const onPlay = () => {
      setIsPlaying(true);
      setIsBuffering(false);
    };
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onDurationChange = () =>
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    const onProgress = () => readBuffered();
    const onVolumeChange = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => setIsBuffering(false);
    const onRateChange = () => setPlaybackRate(video.playbackRate);

    // Seed state from the already-mounted element.
    setIsPlaying(!video.paused);
    setCurrentTime(video.currentTime);
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    setVolume(video.volume);
    setMuted(video.muted);
    setPlaybackRate(video.playbackRate);
    readBuffered();

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("loadedmetadata", onDurationChange);
    video.addEventListener("progress", onProgress);
    video.addEventListener("volumechange", onVolumeChange);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("ratechange", onRateChange);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("loadedmetadata", onDurationChange);
      video.removeEventListener("progress", onProgress);
      video.removeEventListener("volumechange", onVolumeChange);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("ratechange", onRateChange);
    };
  }, [videoRef]);

  // --- Restore player preferences from IndexedDB on mount ---
  // Volume, mute, and playback speed are global (same across videos).
  // Subtitle track selection is per-video. Restoring these means the user's
  // last-used settings carry across page reloads — zero server involvement.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    void (async () => {
      const [prefs, subtitleId] = await Promise.all([
        getGlobalPrefs(),
        getSubtitlePref(videoId),
      ]);
      if (cancelled) return;
      if (prefs) {
        video.volume = prefs.volume;
        video.muted = prefs.muted;
        video.playbackRate = prefs.playbackRate;
      }
      if (subtitleId) {
        const idx = subtitleTracks.findIndex((t) => t.id === subtitleId);
        if (idx >= 0) setActiveSubtitle(idx);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoRef, videoId, subtitleTracks]);

  // --- Persist global prefs (debounced) ---
  // Fires when volume/mute/speed change; debounced 300ms so dragging the
  // volume slider doesn't spam IndexedDB writes.
  const prefsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (prefsSaveTimer.current) clearTimeout(prefsSaveTimer.current);
    prefsSaveTimer.current = setTimeout(() => {
      void saveGlobalPrefs({ volume, muted, playbackRate });
    }, 300);
    return () => {
      if (prefsSaveTimer.current) clearTimeout(prefsSaveTimer.current);
    };
  }, [volume, muted, playbackRate]);

  // --- Fullscreen state sync ---
  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [containerRef]);

  // --- Auto-hide: reveal on activity, hide after AUTO_HIDE_MS while playing ---
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const reveal = () => {
      setControlsVisible(true);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (isPlayingRef.current) setControlsVisible(false);
      }, AUTO_HIDE_MS);
    };
    const onMouseMove = () => reveal();
    const onKeyDown = () => reveal();
    container.addEventListener("mousemove", onMouseMove);
    container.addEventListener("keydown", onKeyDown);
    reveal();
    return () => {
      container.removeEventListener("mousemove", onMouseMove);
      container.removeEventListener("keydown", onKeyDown);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [containerRef]);

  // Pausing always reveals controls (never auto-hides while paused).
  useEffect(() => {
    if (!isPlaying) setControlsVisible(true);
  }, [isPlaying]);

  // Keep controls (and the OS cursor) visible while the shortcuts overlay is
  // open so the user can read it and click its close affordance.
  useEffect(() => {
    if (showShortcuts) setControlsVisible(true);
  }, [showShortcuts]);

  // Hide the OS cursor over the container when controls are hidden. Done via
  // the DOM style API because the container is parent-owned and a dynamically
  // toggled Tailwind `cursor-none` class wouldn't be present in the JIT build.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.style.cursor = controlsVisible ? "" : "none";
  }, [controlsVisible, containerRef]);

  // --- Subtitle track mode application ---
  // `<track>` elements live in `video.textTracks` (order matches subtitleTracks
  // as rendered by the parent). Mode "hidden" loads a track without displaying;
  // "showing" displays it. The native `default` attribute is NOT used — custom
  // controls drive mode explicitly (T8 removed `default` from the <track>s).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tracks = video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = i === activeSubtitle ? "showing" : "hidden";
    }
  }, [activeSubtitle, videoRef, subtitleTracks]);

  // --- Popover click-outside (subtitles + speed + quality menus share one listener) ---
  const subtitleMenuRef = useRef<HTMLDivElement>(null);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const qualityMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!subtitlesOpen && !speedOpen && !qualityOpen) return;
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        subtitlesOpen &&
        subtitleMenuRef.current &&
        !subtitleMenuRef.current.contains(target)
      ) {
        setSubtitlesOpen(false);
      }
      if (
        speedOpen &&
        speedMenuRef.current &&
        !speedMenuRef.current.contains(target)
      ) {
        setSpeedOpen(false);
      }
      if (
        qualityOpen &&
        qualityMenuRef.current &&
        !qualityMenuRef.current.contains(target)
      ) {
        setQualityOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [subtitlesOpen, speedOpen, qualityOpen]);

  // --- Handlers ---
  //
  // `video.play()` returns a Promise that rejects if the element has no
  // playable source — which can happen transiently while `/stream-url` is
  // still resolving (the parent renders this component before `src` lands)
  // or after an error path leaves `src` undefined. Without a `.catch()` the
  // rejection bubbles to the console as "Uncaught (in promise)
  // NotSupportedError: The element has no supported sources" — confusing
  // noise that looks like a real crash. Swallowing it is correct: if `src`
  // was empty because of a transient loading state, playback will start
  // automatically once `src` lands (the browser fires `play` then); if it
  // was a real error, the parent's `onError` handler surfaces it via the
  // `UnsupportedFormat` fallback.
  function safePlay(video: HTMLVideoElement) {
    void video.play().catch((err: unknown) => {
      // AbortError is benign — the user pressed play/pause quickly. All
      // other rejections are silenced here for the reason above; if the
      // state is genuinely broken, `onError` on the `<video>` will fire
      // and the parent will swap to the fallback UI.
      if (err instanceof DOMException && err.name === "AbortError") return;
    });
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      safePlay(video);
    } else {
      video.pause();
    }
  }

  const seekBarRef = useRef<HTMLDivElement>(null);
  const [scrubbing, setScrubbing] = useState(false);

  function seekFromClientX(clientX: number) {
    const video = videoRef.current;
    const bar = seekBarRef.current;
    if (
      !video ||
      !bar ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0
    )
      return;
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    setCurrentTime(video.currentTime);
  }

  // Pointer capture lets drag continue outside the bar; guard with try/catch
  // because some environments (jsdom) don't implement it.
  function onScrubberPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    setScrubbing(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture unsupported — drag stays within bounds */
    }
    seekFromClientX(e.clientX);
  }
  function onScrubberPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbing) return;
    seekFromClientX(e.clientX);
  }
  function onScrubberPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbing) return;
    setScrubbing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  }
  function onScrubberKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    if (e.key === "ArrowLeft") {
      video.currentTime = Math.max(0, video.currentTime - SEEK_STEP_SECONDS);
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      video.currentTime = Math.min(
        video.duration,
        video.currentTime + SEEK_STEP_SECONDS,
      );
      e.preventDefault();
    }
  }

  function onVolumeInput(e: React.ChangeEvent<HTMLInputElement>) {
    const video = videoRef.current;
    if (!video) return;
    const v = Number(e.target.value);
    video.volume = v;
    if (v > 0 && video.muted) video.muted = false;
  }
  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void containerRef.current?.requestFullscreen();
    }
  }

  function selectSubtitle(index: number) {
    setActiveSubtitle(index);
    setSubtitlesOpen(false);
    // Persist per-video subtitle selection (null for "Off").
    const track = index >= 0 ? subtitleTracks[index] : null;
    void saveSubtitlePref(videoId, track?.id ?? null);
  }

  function selectSpeed(rate: number) {
    const video = videoRef.current;
    if (video) video.playbackRate = rate;
    setPlaybackRate(rate);
    setSpeedOpen(false);
  }

  // --- Global keyboard shortcuts (T9) ---
  // Subscribed once on mount; reads refs / live DOM state so it never goes
  // stale without re-subscribing. Suppressed inside form fields and while a
  // modifier key is held (same pattern as the M2 `/` search shortcut).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      // While the help overlay is open, only `?` (toggle) and Escape (close)
      // are honored — reading the help shouldn't drive playback.
      if (showShortcutsRef.current && e.key !== "?" && e.key !== "Escape") {
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      // Defer arrow seeking to the focused seek slider's own (±5s) handler —
      // a role=slider must answer arrows with its step (a11y convention).
      const isSlider =
        el instanceof Element && el.getAttribute("role") === "slider";
      switch (e.key) {
        case " ":
        case "Spacebar": // legacy IE key
          // Let a focused <button> activate natively (avoids double-toggle and
          // preserves screen-reader expectations for button activation).
          if (el && el.tagName === "BUTTON") return;
          e.preventDefault();
          if (video.paused) safePlay(video);
          else video.pause();
          break;
        case "ArrowLeft":
          if (isSlider) return;
          e.preventDefault();
          video.currentTime = Math.max(
            0,
            video.currentTime - SHORTCUT_SEEK_SECONDS,
          );
          setCurrentTime(video.currentTime);
          break;
        case "ArrowRight":
          if (isSlider) return;
          e.preventDefault();
          if (Number.isFinite(video.duration)) {
            video.currentTime = Math.min(
              video.duration,
              video.currentTime + SHORTCUT_SEEK_SECONDS,
            );
            setCurrentTime(video.currentTime);
          }
          break;
        case "j":
        case "J":
          e.preventDefault();
          video.currentTime = Math.max(
            0,
            video.currentTime - SHORTCUT_SEEK_SECONDS,
          );
          setCurrentTime(video.currentTime);
          break;
        case "l":
        case "L":
          e.preventDefault();
          if (Number.isFinite(video.duration)) {
            video.currentTime = Math.min(
              video.duration,
              video.currentTime + SHORTCUT_SEEK_SECONDS,
            );
            setCurrentTime(video.currentTime);
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          video.volume = Math.min(1, video.volume + SHORTCUT_VOLUME_STEP);
          if (video.muted) video.muted = false;
          break;
        case "ArrowDown":
          e.preventDefault();
          video.volume = Math.max(0, video.volume - SHORTCUT_VOLUME_STEP);
          break;
        case "f":
        case "F":
          e.preventDefault();
          if (document.fullscreenElement) void document.exitFullscreen();
          else void containerRef.current?.requestFullscreen();
          break;
        case "m":
        case "M":
          e.preventDefault();
          video.muted = !video.muted;
          break;
        case "?":
          e.preventDefault();
          setShowShortcuts((v) => !v);
          break;
        case "Escape":
          setShowShortcuts(false);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [videoRef, containerRef]);

  // --- Derived ---
  const playRatio = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const bufferedRatio = duration > 0 ? Math.min(1, buffered / duration) : 0;

  return (
    <>
      {/* Buffering spinner — centered, shown on `waiting`, hidden on `playing`.
          Rendered outside the control bar so it stays visible when controls
          auto-hide. */}
      {isBuffering && (
        <div
          role="status"
          aria-label="Buffering"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-white/30 border-t-white" />
        </div>
      )}

      {/* Control bar */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-3 pt-10 transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {/* Seek bar */}
        <div
          ref={seekBarRef}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={duration > 0 ? Math.floor(duration) : 0}
          aria-valuenow={Math.floor(currentTime)}
          aria-valuetext={formatTime(currentTime)}
          onPointerDown={onScrubberPointerDown}
          onPointerMove={onScrubberPointerMove}
          onPointerUp={onScrubberPointerUp}
          onKeyDown={onScrubberKeyDown}
          className="group relative mb-2 h-3 cursor-pointer touch-none focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-white/20">
            {/* buffered */}
            <div
              className="absolute h-full rounded-full bg-white/30"
              style={{ width: `${bufferedRatio * 100}%` }}
            />
            {/* played */}
            <div
              className="absolute h-full rounded-full bg-[var(--color-castify-accent)]"
              style={{ width: `${playRatio * 100}%` }}
            />
          </div>
          {/* thumb */}
          <div
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            style={{ left: `${playRatio * 100}%` }}
          />
        </div>

        {/* Buttons row */}
        <div className="flex items-center gap-2 text-white">
          {onPrev && (
            <button
              type="button"
              onClick={onPrev}
              disabled={!hasPrev}
              aria-label="Previous video"
              className="rounded p-1.5 transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <PrevIcon className="h-5 w-5" />
            </button>
          )}

          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
            aria-pressed={isPlaying}
            className="rounded p-1.5 transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            {isPlaying ? (
              <PauseIcon className="h-6 w-6" />
            ) : (
              <PlayIcon className="h-6 w-6" />
            )}
          </button>

          {onNext && (
            <button
              type="button"
              onClick={onNext}
              disabled={!hasNext}
              aria-label="Next video"
              className="rounded p-1.5 transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <NextIcon className="h-5 w-5" />
            </button>
          )}

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
              aria-pressed={muted}
              className="rounded p-1.5 transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              {muted || volume === 0 ? (
                <VolumeMuteIcon className="h-5 w-5" />
              ) : (
                <VolumeHighIcon className="h-5 w-5" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={onVolumeInput}
              aria-label="Volume"
              className="h-1 w-20 cursor-pointer accent-[var(--color-castify-accent)]"
            />
          </div>

          <span className="ml-1 text-xs tabular-nums text-white/90">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          {levels && levels.length > 0 && (
            <span
              className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-white/90"
              aria-label={`Current quality ${
                (currentLevel ?? -1) < 0
                  ? "Auto"
                  : `${levels[currentLevel ?? 0]?.height ?? "?"}p`
              }`}
            >
              {(currentLevel ?? -1) < 0
                ? "Auto"
                : `${levels[currentLevel ?? 0]?.height ?? "?"}p`}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            {levels && levels.length > 0 && onLevelChange && (
              <div ref={qualityMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setQualityOpen((v) => !v)}
                  aria-label="Quality"
                  aria-haspopup="menu"
                  aria-expanded={qualityOpen}
                  className={`min-w-[2.25rem] rounded px-1.5 py-1.5 text-xs font-semibold uppercase tracking-wide transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                    (currentLevel ?? -1) >= 0
                      ? "text-[var(--color-castify-accent)]"
                      : ""
                  }`}
                >
                  {(currentLevel ?? -1) < 0
                    ? "Auto"
                    : `${levels[currentLevel ?? 0]?.height ?? "?"}p`}
                </button>
                {qualityOpen && (
                  <ul
                    role="menu"
                    className="absolute bottom-full right-0 mb-2 min-w-32 overflow-hidden rounded-md border border-white/10 bg-[var(--color-castify-surface)] py-1 text-sm shadow-lg"
                  >
                    <QualityMenuItem
                      label="Auto"
                      selected={(currentLevel ?? -1) < 0}
                      onSelect={() => {
                        onLevelChange(-1);
                        setQualityOpen(false);
                      }}
                    />
                    {levels.map((l, i) => (
                      <QualityMenuItem
                        key={`${l.height}-${i}`}
                        label={l.height > 0 ? `${l.height}p` : "Unknown"}
                        selected={currentLevel === i}
                        onSelect={() => {
                          onLevelChange(i);
                          setQualityOpen(false);
                        }}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div ref={speedMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setSpeedOpen((v) => !v)}
                aria-label={`Playback speed ${playbackRate}×`}
                aria-haspopup="menu"
                aria-expanded={speedOpen}
                className={`min-w-[2.25rem] rounded px-1.5 py-1.5 text-xs font-semibold tabular-nums transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                  playbackRate !== 1 ? "text-[var(--color-castify-accent)]" : ""
                }`}
              >
                {playbackRate}×
              </button>
              {speedOpen && (
                <ul
                  role="menu"
                  className="absolute bottom-full right-0 mb-2 min-w-32 overflow-hidden rounded-md border border-white/10 bg-[var(--color-castify-surface)] py-1 text-sm shadow-lg"
                >
                  {PLAYBACK_RATES.map((rate) => (
                    <SpeedMenuItem
                      key={rate}
                      rate={rate}
                      selected={playbackRate === rate}
                      onSelect={() => selectSpeed(rate)}
                    />
                  ))}
                </ul>
              )}
            </div>

            {subtitleTracks.length > 0 && (
              <div ref={subtitleMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setSubtitlesOpen((v) => !v)}
                  aria-label="Subtitles"
                  aria-haspopup="menu"
                  aria-expanded={subtitlesOpen}
                  className={`rounded p-1.5 transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                    activeSubtitle >= 0
                      ? "text-[var(--color-castify-accent)]"
                      : ""
                  }`}
                >
                  <SubtitlesIcon className="h-5 w-5" />
                </button>
                {subtitlesOpen && (
                  <ul
                    role="menu"
                    className="absolute bottom-full right-0 mb-2 min-w-40 overflow-hidden rounded-md border border-white/10 bg-[var(--color-castify-surface)] py-1 text-sm shadow-lg"
                  >
                    <SubtitleMenuItem
                      label="Off"
                      selected={activeSubtitle === -1}
                      onSelect={() => selectSubtitle(-1)}
                    />
                    {subtitleTracks.map((track, i) => (
                      <SubtitleMenuItem
                        key={track.id}
                        label={track.language ?? "Unknown"}
                        selected={activeSubtitle === i}
                        onSelect={() => selectSubtitle(i)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              aria-pressed={isFullscreen}
              className="rounded p-1.5 transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              {isFullscreen ? (
                <FullscreenExitIcon className="h-5 w-5" />
              ) : (
                <FullscreenEnterIcon className="h-5 w-5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Keyboard shortcuts help overlay (T9). Toggled by `?`, closed by
          `?` / Escape / ✕ / backdrop click. The keydown handler suspends
          other shortcuts while this is open. */}
      {showShortcuts && (
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          onClick={() => setShowShortcuts(false)}
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-5 text-white shadow-xl"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-white/70">
                Keyboard shortcuts
              </h2>
              <button
                type="button"
                onClick={() => setShowShortcuts(false)}
                aria-label="Close shortcuts"
                className="rounded p-1 text-white/60 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                ✕
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-5 gap-y-2 text-sm">
              <ShortcutsRow keys={["Space"]} desc="Play / Pause" />
              <ShortcutsRow keys={["←", "→"]} desc="Seek -10s / +10s" />
              <ShortcutsRow keys={["J", "L"]} desc="Seek -10s / +10s" />
              <ShortcutsRow keys={["↑", "↓"]} desc="Volume up / down" />
              <ShortcutsRow keys={["F"]} desc="Fullscreen" />
              <ShortcutsRow keys={["M"]} desc="Mute" />
              <ShortcutsRow keys={["?"]} desc="Show / hide this help" />
            </dl>
          </div>
        </div>
      )}
    </>
  );
}

function SubtitleMenuItem({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        onClick={onSelect}
        className={`block w-full px-3 py-1.5 text-left transition hover:bg-white/10 ${
          selected ? "text-[var(--color-castify-accent)]" : "text-white"
        }`}
      >
        {label}
      </button>
    </li>
  );
}

function SpeedMenuItem({
  rate,
  selected,
  onSelect,
}: {
  rate: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        onClick={onSelect}
        className={`block w-full px-3 py-1.5 text-left tabular-nums transition hover:bg-white/10 ${
          selected ? "text-[var(--color-castify-accent)]" : "text-white"
        }`}
      >
        {rate}×
      </button>
    </li>
  );
}

function QualityMenuItem({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        onClick={onSelect}
        className={`block w-full px-3 py-1.5 text-left uppercase tracking-wide transition hover:bg-white/10 ${
          selected ? "text-[var(--color-castify-accent)]" : "text-white"
        }`}
      >
        {label}
      </button>
    </li>
  );
}

function ShortcutsRow({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <>
      <dt className="flex items-center gap-1">
        {keys.map((k) => (
          <kbd
            key={k}
            className="rounded border border-white/20 bg-white/5 px-1.5 py-0.5 text-xs font-semibold"
          >
            {k}
          </kbd>
        ))}
      </dt>
      <dd className="text-white/70">{desc}</dd>
    </>
  );
}
