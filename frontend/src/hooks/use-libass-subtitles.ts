// `useLibassSubtitles` — render ASS/SSA subtitles in the browser via jassub
// (a WASM + WebGL libass wrapper), lazy-loaded only when an ASS track is
// selected (Task 004).
//
// Native `<track>` elements strip ASS styling down to plain text — they have
// no concept of positioning, fonts, effects, or karaoke. This hook owns the
// jassub instance lifecycle: when the caller passes a non-undefined
// `assUrl`, it dynamic-imports jassub (so the ~500 KB chunk never loads for
// users on SRT/VTT-only videos), constructs a `JASSUB` bound to the `<video>`
// and a caller-provided `<canvas>` overlay, and lets jassub drive the render
// loop (it syncs to the video via `requestVideoFrameCallback` and resizes
// the canvas via a `ResizeObserver`).
//
// Reliability (NFR): if the dynamic import rejects (chunk failed to download,
// WASM unsupported) or the constructor throws, the hook logs a warning,
// surfaces `status: "error"`, and leaves the `<video>` untouched. Playback
// continues with no subtitle and no unhandled rejection. Selecting "Off" (the
// caller passes `assUrl = undefined`) destroys the instance and the canvas.

import { useEffect, useState } from "react";

// Type-only import so the static bundle never pulls jassub in. The runtime
// import happens via dynamic `import("jassub")` inside the effect.
import type JASSUB from "jassub";

export type LibassStatus = "idle" | "loading" | "ready" | "error";

export interface UseLibassSubtitlesResult {
  status: LibassStatus;
}

/**
 * Attach a jassub ASS/SSA renderer to a `<video>` + `<canvas>` overlay.
 *
 * Pass `assUrl = undefined` when no ASS track is active — the hook stays idle
 * and loads nothing. Pass the subtitle track URL
 * (`/api/videos/{id}/subtitles/{track_id}`, served `text/plain` by Task 003)
 * to initialize; pass `undefined` again (e.g. the user selected "Off") to
 * tear down. Switching directly between two ASS URLs destroys the old
 * instance and creates a fresh one.
 *
 * The caller owns both refs and renders the `<canvas>` (conditionally, over
 * the `<video>`) so React controls the overlay's presence in the DOM.
 */
export function useLibassSubtitles(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  assUrl: string | undefined,
): UseLibassSubtitlesResult {
  const [status, setStatus] = useState<LibassStatus>("idle");

  useEffect(() => {
    if (!assUrl) {
      setStatus("idle");
      return;
    }
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    let cancelled = false;
    let instance: JASSUB | null = null;
    setStatus("loading");

    (async () => {
      try {
        // Dynamic import → jassub lands in its own bundle chunk, never the
        // main entry. The promise rejects if the chunk fails to load.
        const mod = await import("jassub");
        if (cancelled) return;
        const JassubCtor = mod.default;
        instance = new JassubCtor({ video, canvas, subUrl: assUrl });
        await instance.ready;
        if (cancelled) return;
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        // Load failure (chunk/WASM) or constructor throw — degrade
        // gracefully. Subtitle off, playback continues, no unhandled
        // rejection. Warn so the failure is diagnosable in the console.
        console.warn("Failed to initialize libass subtitle renderer", err);
        setStatus("error");
      }
    })();

    return () => {
      // Cancel the in-flight init and tear down a live instance. `instance`
      // is the local binding shared with the async body above; once it is
      // assigned, the cleanup closure sees the latest value.
      cancelled = true;
      const live = instance;
      instance = null;
      if (live) {
        // destroy() returns a Promise but React expects a synchronous
        // cleanup — fire and forget. jassub's destroy is idempotent.
        try {
          void live.destroy();
        } catch {
          /* already tearing down */
        }
      }
    };
  }, [assUrl, videoRef, canvasRef]);

  return { status };
}
