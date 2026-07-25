// `useHlsStream` — attach an HLS master playlist to a `<video>` element via
// hls.js (M7 T10).
//
// Safari has native HLS support — `video.canPlayType("application/vnd.apple.mpegurl")`
// returns `"maybe"` or `"probably"`, and the browser handles ABR itself. We
// just set `video.src = masterUrl` and let Safari do its thing.
//
// Other browsers (Chrome, Firefox, Edge) need hls.js. We dynamically import
// it so the main bundle doesn't pay the cost for users who never hit a
// transcode path. The hook owns the `Hls` instance lifecycle: created on
// mount, destroyed on unmount or when the master URL changes.
//
// The hook surfaces:
//   - `levels`: the variant ladder hls.js parsed from the master playlist.
//     Each entry has `height` (e.g. 720) and `attrs.RESOLUTION` for UI badges.
//   - `currentLevel`: the active variant index, or -1 for "Auto" (hls.js's
//     ABR logic picks based on observed bandwidth). Updates via the
//     `LEVEL_SWITCHED` event.
//   - `setCurrentLevel`: manual override. -1 restores Auto.
//
// Errors are surfaced via the `onError` callback. The hook recovers once
// internally via `Hls.recoverMediaError()` before delegating to the caller
// (matching the single-retry pattern used for direct-CDN URL expiry in
// `use-stream-url.ts`).

import { useEffect, useRef, useState } from "react";

// Type-only import so the static bundle doesn't pull hls.js in. The runtime
// import happens via dynamic `import("hls.js")` inside the effect.
import type Hls from "hls.js";

export interface HlsLevel {
  height: number;
  bitrate: number;
  attrs: { RESOLUTION?: string; CODECS?: string };
}

export interface UseHlsStreamOptions {
  /** Called when hls.js emits a fatal error after the internal one-shot recovery. */
  onError?: () => void;
}

export interface UseHlsStreamResult {
  levels: HlsLevel[];
  /** Active level index, or -1 for Auto. `null` until hls.js reports a level. */
  currentLevel: number | null;
  /** Set the active level. Pass -1 for Auto (hls.js ABR). */
  setCurrentLevel: (level: number) => void;
  /** True until hls.js reports it's ready (manifest parsed, levels known). */
  isReady: boolean;
}

/**
 * Attach a master playlist URL to a `<video>` element. Returns a state
 * snapshot (`levels`, `currentLevel`, `isReady`) and a `setCurrentLevel`
 * mutator for manual variant override.
 *
 * Caller is responsible for rendering the `<video>` element and passing
 * its ref. The hook does NOT set `video.src` for non-Safari browsers —
 * hls.js attaches via `attachMedia(video)` and feeds segments through
 * `MediaSource`/`SourceBuffer`. For Safari native HLS, the hook sets
 * `video.src = masterUrl` directly.
 */
export function useHlsStream(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  masterUrl: string | undefined,
  options: UseHlsStreamOptions = {},
): UseHlsStreamResult {
  const [levels, setLevels] = useState<HlsLevel[]>([]);
  const [currentLevel, setCurrentLevelState] = useState<number | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Hold the Hls instance across renders. Ref so the cleanup closure can
  // destroy it without re-running the effect.
  const hlsRef = useRef<Hls | null>(null);
  // Recover-once guard, matching the direct-CDN retry pattern.
  const recoveredRef = useRef(false);
  // Track the onError callback so effect can capture the latest without
  // re-subscribing when the caller passes a new closure.
  const onErrorRef = useRef(options.onError);
  useEffect(() => {
    onErrorRef.current = options.onError;
  });

  useEffect(() => {
    if (!masterUrl) return;
    const video = videoRef.current;
    if (!video) return;

    recoveredRef.current = false;
    setIsReady(false);
    setLevels([]);
    setCurrentLevelState(null);

    // Safari + iOS Chrome masquerading as Safari → native HLS.
    const canNativeHls = video.canPlayType("application/vnd.apple.mpegurl") !== "";
    if (canNativeHls) {
      video.src = masterUrl;
      // Native HLS doesn't surface per-level events consistently across
      // Safari versions; the UI shows "Auto" only and the user relies on
      // Safari's own ABR.
      setIsReady(true);
      return;
    }

    let cancelled = false;
    let hls: Hls | null = null;

    (async () => {
      try {
        const mod = await import("hls.js");
        if (cancelled) return;
        const HlsCtor = mod.default;
        if (!HlsCtor.isSupported()) {
          // Browser lacks MediaSource — caller's onError will surface this
          // (the UnsupportedFormat fallback in VideoPlayer handles it).
          onErrorRef.current?.();
          return;
        }
        hls = new HlsCtor({
          // Conservative default: assume 1 Mbps starting bandwidth so hls.js
          // picks a mid-rung variant instead of the smallest. PRD FR-5.1.
          // (hls.js 1.6 calls this `abrEwmaDefaultEstimate`, in bits/sec.)
          abrEwmaDefaultEstimate: 1_000_000,
          // Don't auto-pick a level taller than the visible player — wastes
          // bandwidth for pixels the user can't see.
          capLevelToPlayerSize: true,
        });
        hlsRef.current = hls;
        hls.attachMedia(video);
        hls.loadSource(masterUrl);

        hls.on(HlsCtor.Events.MANIFEST_PARSED, (_evt, data) => {
          if (cancelled) return;
          const parsed: HlsLevel[] = (data.levels ?? []).map((l) => ({
            height: l.height ?? 0,
            bitrate: l.bitrate ?? 0,
            attrs: {
              RESOLUTION: l.attrs?.RESOLUTION,
              CODECS: l.attrs?.CODECS,
            },
          }));
          setLevels(parsed);
          setIsReady(true);
        });

        hls.on(HlsCtor.Events.LEVEL_SWITCHED, (_evt, data) => {
          if (cancelled) return;
          setCurrentLevelState(data.level);
        });

        hls.on(HlsCtor.Events.ERROR, (_evt, data) => {
          if (cancelled || !data.fatal) return;
          if (!recoveredRef.current) {
            recoveredRef.current = true;
            // For media errors, recoverMediaError resets the demuxer pipeline
            // and lets hls.js re-fetch the offending segment. For network
            // errors, startLoad kicks the loader again. Both are idempotent.
            if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) {
              hls?.recoverMediaError();
              return;
            }
            if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) {
              hls?.startLoad();
              return;
            }
          }
          // Unrecoverable — surface to caller (typically the UnsupportedFormat
          // fallback in VideoPlayer).
          onErrorRef.current?.();
        });
      } catch {
        // Dynamic import failure (network blocked, bundle corrupt) — surface.
        if (!cancelled) onErrorRef.current?.();
      }
    })();

    return () => {
      cancelled = true;
      if (hls) {
        hls.destroy();
        hlsRef.current = null;
      }
    };
  }, [masterUrl, videoRef]);

  const setCurrentLevel = (level: number) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = level;
      // Don't update state here — the LEVEL_SWITCHED event will fire and
      // update it. This keeps the UI in sync with what hls.js actually did.
    } else if (currentLevel !== null) {
      // Native HLS (Safari) — manual override isn't supported. Just reflect
      // Auto.
      setCurrentLevelState(level < 0 ? null : level);
    }
  };

  return {
    levels,
    currentLevel,
    setCurrentLevel,
    isReady,
  };
}
