import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, act } from "@testing-library/react";
import { useRef } from "react";

import { PlayerControls } from "./player-controls";
import type { SubtitleTrackDto } from "../api/types";

// Mock IndexedDB layer — jsdom has no IndexedDB. Returns empty prefs so
// the player defaults to volume=1, unmuted, rate=1.
vi.mock("../lib/player-db", () => ({
  getGlobalPrefs: vi.fn().mockResolvedValue(null),
  getSubtitlePref: vi.fn().mockResolvedValue(null),
  saveGlobalPrefs: vi.fn().mockResolvedValue(undefined),
  saveSubtitlePref: vi.fn().mockResolvedValue(undefined),
}));

// --- Harness: a container + <video> (with optional <track> children) +
//     PlayerControls, mirroring how routes/watch.tsx composes them. ---
function Harness({
  subtitleTracks = [],
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
}: {
  subtitleTracks?: SubtitleTrackDto[];
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={containerRef}
      data-testid="container"
      style={{ width: 400, position: "relative" }}
    >
      <video ref={videoRef} data-testid="video">
        {subtitleTracks.map((t) => (
          <track
            key={t.id}
            kind="subtitles"
            srcLang={t.language ?? undefined}
            label={t.language ?? "Unknown"}
          />
        ))}
      </video>
      <PlayerControls
        videoRef={videoRef}
        containerRef={containerRef}
        subtitleTracks={subtitleTracks}
        videoId="v1"
        onPrev={onPrev}
        onNext={onNext}
        hasPrev={hasPrev}
        hasNext={hasNext}
      />
    </div>
  );
}

/** Force a readonly media property on the rendered element (jsdom returns
 *  NaN/null defaults for `duration` etc.). */
function setProp(el: Element, prop: string, value: unknown) {
  Object.defineProperty(el, prop, {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  // Clear any per-test document.fullscreenElement override.
  delete (document as { fullscreenElement?: Element | null }).fullscreenElement;
});

describe("PlayerControls", () => {
  describe("play / pause", () => {
    it("clicking Play calls video.play() and flips the icon to Pause", () => {
      const playSpy = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);

      render(<Harness />);
      const video = screen.getByTestId("video");

      const playBtn = screen.getByRole("button", { name: "Play" });
      fireEvent.click(playBtn);
      expect(playSpy).toHaveBeenCalledTimes(1);

      // The browser fires 'play' once playback starts.
      fireEvent(video, new Event("play"));
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    });

    it("clicking Pause calls video.pause() and flips the icon back to Play", () => {
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      const pauseSpy = vi
        .spyOn(HTMLMediaElement.prototype, "pause")
        .mockImplementation(() => {});

      render(<Harness />);
      const video = screen.getByTestId("video");

      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      // Sync the `paused` property + 'play' event (jsdom doesn't change the
      // property on event dispatch; a real browser sets paused=false first).
      setProp(video, "paused", false);
      fireEvent(video, new Event("play"));

      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      expect(pauseSpy).toHaveBeenCalledTimes(1);

      setProp(video, "paused", true);
      fireEvent(video, new Event("pause"));
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    });
  });

  describe("seek scrubber", () => {
    it("arrow keys move currentTime by 5s and clamp at the bounds", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");
      setProp(video, "duration", 120);
      fireEvent(video, new Event("durationchange"));

      const slider = screen.getByRole("slider", { name: "Seek" });

      fireEvent.keyDown(slider, { key: "ArrowRight" });
      expect((video as HTMLVideoElement).currentTime).toBe(5);

      fireEvent.keyDown(slider, { key: "ArrowRight" });
      expect((video as HTMLVideoElement).currentTime).toBe(10);

      fireEvent.keyDown(slider, { key: "ArrowLeft" });
      expect((video as HTMLVideoElement).currentTime).toBe(5);
    });

    it("arrow left does not seek below 0", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");
      setProp(video, "duration", 120);
      fireEvent(video, new Event("durationchange"));

      const slider = screen.getByRole("slider", { name: "Seek" });
      fireEvent.keyDown(slider, { key: "ArrowLeft" });
      expect((video as HTMLVideoElement).currentTime).toBe(0);
    });

    it("pointer down on the bar seeks proportionally to the click X", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");
      setProp(video, "duration", 120);
      fireEvent(video, new Event("durationchange"));

      const slider = screen.getByRole("slider", { name: "Seek" });
      vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
        left: 0,
        width: 200,
        right: 200,
        top: 0,
        bottom: 12,
        height: 12,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);

      fireEvent.pointerDown(slider, { clientX: 100, pointerId: 1 });
      expect((video as HTMLVideoElement).currentTime).toBeCloseTo(60, 5);
    });
  });

  describe("volume", () => {
    it("the volume slider sets video.volume", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");
      const slider = screen.getByRole("slider", { name: "Volume" });

      fireEvent.change(slider, { target: { value: "0.5" } });
      expect((video as HTMLVideoElement).volume).toBe(0.5);
    });

    it("raising volume above 0 unmutes", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");
      // jsdom fires `volumechange` synchronously on this assignment (which our
      // listener turns into a setState), so wrap it in act.
      act(() => {
        (video as HTMLVideoElement).muted = true;
      });

      const slider = screen.getByRole("slider", { name: "Volume" });
      fireEvent.change(slider, { target: { value: "0.5" } });
      expect((video as HTMLVideoElement).muted).toBe(false);
    });

    it("the mute button toggles video.muted and the icon label", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");

      fireEvent.click(screen.getByRole("button", { name: "Mute" }));
      expect((video as HTMLVideoElement).muted).toBe(true);

      fireEvent(video, new Event("volumechange"));
      expect(
        screen.getByRole("button", { name: "Unmute" }),
      ).toBeInTheDocument();
    });
  });

  describe("fullscreen", () => {
    it("requests fullscreen on the container, then exits", () => {
      const fsSpy = vi
        .spyOn(Element.prototype, "requestFullscreen")
        .mockResolvedValue(undefined);
      const exitSpy = vi
        .spyOn(Document.prototype, "exitFullscreen")
        .mockResolvedValue(undefined);

      render(<Harness />);
      const container = screen.getByTestId("container");

      fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
      expect(fsSpy).toHaveBeenCalledTimes(1);
      expect(fsSpy.mock.instances[0]).toBe(container);

      // Simulate browser entering fullscreen on the container.
      Object.defineProperty(document, "fullscreenElement", {
        value: container,
        configurable: true,
      });
      fireEvent(document, new Event("fullscreenchange"));
      expect(
        screen.getByRole("button", { name: "Exit fullscreen" }),
      ).toBeInTheDocument();

      // Exit.
      fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
      expect(exitSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("subtitles", () => {
    const TRACKS: SubtitleTrackDto[] = [
      { id: "s1", language: "en", filename: "a.en.vtt", format: "vtt", format_family: "text", embedded_track_id: null },
      { id: "s2", language: "es", filename: "a.es.srt", format: "srt", format_family: "text", embedded_track_id: null },
    ];

    it("hides the subtitles button when there are no tracks", () => {
      render(<Harness />);
      expect(
        screen.queryByRole("button", { name: "Subtitles" }),
      ).not.toBeInTheDocument();
    });

    it("lists Off + languages, and selecting one marks it checked", () => {
      render(<Harness subtitleTracks={TRACKS} />);

      fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      // Default selection is "Off" (activeSubtitle = -1).
      expect(
        screen.getByRole("menuitemradio", { name: "Off" }),
      ).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("menuitemradio", { name: "en" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      expect(screen.getByRole("menuitemradio", { name: "es" })).toHaveAttribute(
        "aria-checked",
        "false",
      );

      fireEvent.click(screen.getByRole("menuitemradio", { name: "en" }));
      // Selecting closes the menu.
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();

      // Re-open and verify selection persisted.
      fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      expect(screen.getByRole("menuitemradio", { name: "en" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(
        screen.getByRole("menuitemradio", { name: "Off" }),
      ).toHaveAttribute("aria-checked", "false");
      expect(screen.getByRole("menuitemradio", { name: "es" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });

    it("'Off' clears the active selection", () => {
      render(<Harness subtitleTracks={TRACKS} />);
      fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "es" }));
      fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      expect(screen.getByRole("menuitemradio", { name: "es" })).toHaveAttribute(
        "aria-checked",
        "true",
      );

      fireEvent.click(screen.getByRole("menuitemradio", { name: "Off" }));
      fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      expect(
        screen.getByRole("menuitemradio", { name: "Off" }),
      ).toHaveAttribute("aria-checked", "true");
    });

    it("clicking outside the menu closes it", () => {
      render(<Harness subtitleTracks={TRACKS} />);
      fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      expect(screen.getByRole("menu")).toBeInTheDocument();

      // A mousedown outside the menu (on the body) closes it.
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    // jsdom doesn't materialize TextTrack objects from <track> children, so
    // the tests above assert menu ARIA state as a proxy. The two tests below
    // stub video.textTracks directly to verify the PlayerControls effect
    // actually flips track.mode (the plan's literal AC: "selecting a language
    // shows that track; 'Off' hides all").
    function stubTextTracks(video: HTMLElement, n: number) {
      const tracks = Array.from({ length: n }, () => ({ mode: "disabled" }));
      Object.defineProperty(video, "textTracks", {
        value: tracks,
        configurable: true,
      });
      return tracks;
    }

    it("selecting a language sets that track's mode to 'showing' and others to 'hidden'", () => {
      render(<Harness subtitleTracks={TRACKS} />);
      const video = screen.getByTestId("video");
      const tracks = stubTextTracks(video, TRACKS.length);

      fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "en" }));

      expect(tracks[0].mode).toBe("showing");
      expect(tracks[1].mode).toBe("hidden");
    });

    it("'Off' sets all tracks to 'hidden'", () => {
      render(<Harness subtitleTracks={TRACKS} />);
      const video = screen.getByTestId("video");
      const tracks = stubTextTracks(video, TRACKS.length);

      // Select a language first.
      fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "es" }));
      expect(tracks[1].mode).toBe("showing");

      // Re-open and switch to Off.
      fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Off" }));

      expect(tracks[0].mode).toBe("hidden");
      expect(tracks[1].mode).toBe("hidden");
    });
  });

  describe("buffering indicator", () => {
    it("shows the spinner on 'waiting' and hides it on 'playing'", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");

      expect(screen.queryByRole("status")).not.toBeInTheDocument();

      fireEvent(video, new Event("waiting"));
      expect(
        screen.getByRole("status", { name: "Buffering" }),
      ).toBeInTheDocument();

      fireEvent(video, new Event("playing"));
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });

  describe("auto-hide", () => {
    it("hides controls after 3s while playing, reveals on mousemove, stays visible while paused", () => {
      vi.useFakeTimers();
      try {
        render(<Harness />);
        const container = screen.getByTestId("container");
        const video = screen.getByTestId("video");

        // Playing.
        act(() => {
          fireEvent(video, new Event("play"));
        });
        expect(container.style.cursor).toBe("");

        // 3s of inactivity → controls hide (cursor none).
        act(() => {
          vi.advanceTimersByTime(3000);
        });
        expect(container.style.cursor).toBe("none");

        // Activity reveals again.
        act(() => {
          fireEvent.mouseMove(container);
        });
        expect(container.style.cursor).toBe("");

        // Pausing forces controls visible even after inactivity.
        act(() => {
          fireEvent(video, new Event("pause"));
        });
        act(() => {
          vi.advanceTimersByTime(3000);
        });
        expect(container.style.cursor).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("playback speed", () => {
    it("renders the default rate (1×) and lists all six rates with the current checked", () => {
      render(<Harness />);
      // Default playbackRate is 1 (jsdom + seeded state).
      expect(
        screen.getByRole("button", { name: "Playback speed 1×" }),
      ).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "Playback speed 1×" }),
      );
      expect(screen.getByRole("menuitemradio", { name: "1×" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(
        screen.getByRole("menuitemradio", { name: "0.5×" }),
      ).toHaveAttribute("aria-checked", "false");
      expect(screen.getByRole("menuitemradio", { name: "2×" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      // Six rates present.
      expect(screen.getAllByRole("menuitemradio")).toHaveLength(6);
    });

    it("selecting a rate sets video.playbackRate, updates the label, and closes the menu", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");

      fireEvent.click(
        screen.getByRole("button", { name: "Playback speed 1×" }),
      );
      fireEvent.click(screen.getByRole("menuitemradio", { name: "1.5×" }));

      expect((video as HTMLVideoElement).playbackRate).toBe(1.5);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Playback speed 1.5×" }),
      ).toBeInTheDocument();
    });

    it("clicking outside the speed menu closes it", () => {
      render(<Harness />);
      fireEvent.click(
        screen.getByRole("button", { name: "Playback speed 1×" }),
      );
      expect(screen.getByRole("menu")).toBeInTheDocument();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("syncs the label when the video fires ratechange", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");
      setProp(video, "playbackRate", 2);
      fireEvent(video, new Event("ratechange"));
      expect(
        screen.getByRole("button", { name: "Playback speed 2×" }),
      ).toBeInTheDocument();
    });
  });

  describe("keyboard shortcuts", () => {
    it("space toggles play and pause", () => {
      const playSpy = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      const pauseSpy = vi
        .spyOn(HTMLMediaElement.prototype, "pause")
        .mockImplementation(() => {});

      render(<Harness />);
      const video = screen.getByTestId("video");

      fireEvent.keyDown(document.body, { key: " " });
      expect(playSpy).toHaveBeenCalledTimes(1);

      setProp(video, "paused", false);
      fireEvent.keyDown(document.body, { key: " " });
      expect(pauseSpy).toHaveBeenCalledTimes(1);
    });

    it("←/→ seek by 10s and clamp at the bounds", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");
      setProp(video, "duration", 120);
      fireEvent(video, new Event("durationchange"));

      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect((video as HTMLVideoElement).currentTime).toBe(10);
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect((video as HTMLVideoElement).currentTime).toBe(20);
      fireEvent.keyDown(document.body, { key: "ArrowLeft" });
      expect((video as HTMLVideoElement).currentTime).toBe(10);

      // Clamp at 0.
      fireEvent.keyDown(document.body, { key: "ArrowLeft" });
      fireEvent.keyDown(document.body, { key: "ArrowLeft" });
      expect((video as HTMLVideoElement).currentTime).toBe(0);
    });

    it("j/l seek by 10s (and uppercase works under caps/shift)", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");
      setProp(video, "duration", 120);
      fireEvent(video, new Event("durationchange"));

      fireEvent.keyDown(document.body, { key: "l" });
      expect((video as HTMLVideoElement).currentTime).toBe(10);
      fireEvent.keyDown(document.body, { key: "L" });
      expect((video as HTMLVideoElement).currentTime).toBe(20);
      fireEvent.keyDown(document.body, { key: "j" });
      expect((video as HTMLVideoElement).currentTime).toBe(10);
      fireEvent.keyDown(document.body, { key: "J" });
      expect((video as HTMLVideoElement).currentTime).toBe(0);
    });

    it("↑/↓ adjust volume by 5%, clamp at 0, and ↑ unmutes", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");
      act(() => {
        (video as HTMLVideoElement).volume = 0.5;
      });

      fireEvent.keyDown(document.body, { key: "ArrowUp" });
      expect((video as HTMLVideoElement).volume).toBeCloseTo(0.55, 5);

      fireEvent.keyDown(document.body, { key: "ArrowDown" });
      expect((video as HTMLVideoElement).volume).toBeCloseTo(0.5, 5);

      act(() => {
        (video as HTMLVideoElement).volume = 0.02;
      });
      fireEvent.keyDown(document.body, { key: "ArrowDown" });
      expect((video as HTMLVideoElement).volume).toBe(0);

      act(() => {
        (video as HTMLVideoElement).muted = true;
      });
      fireEvent.keyDown(document.body, { key: "ArrowUp" });
      expect((video as HTMLVideoElement).muted).toBe(false);
    });

    it("m toggles mute", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");
      expect((video as HTMLVideoElement).muted).toBe(false);
      fireEvent.keyDown(document.body, { key: "m" });
      expect((video as HTMLVideoElement).muted).toBe(true);
      fireEvent.keyDown(document.body, { key: "m" });
      expect((video as HTMLVideoElement).muted).toBe(false);
    });

    it("f toggles fullscreen on the container", () => {
      const fsSpy = vi
        .spyOn(Element.prototype, "requestFullscreen")
        .mockResolvedValue(undefined);
      const exitSpy = vi
        .spyOn(Document.prototype, "exitFullscreen")
        .mockResolvedValue(undefined);

      render(<Harness />);
      const container = screen.getByTestId("container");

      fireEvent.keyDown(document.body, { key: "f" });
      expect(fsSpy).toHaveBeenCalledTimes(1);
      expect(fsSpy.mock.instances[0]).toBe(container);

      Object.defineProperty(document, "fullscreenElement", {
        value: container,
        configurable: true,
      });
      fireEvent(document, new Event("fullscreenchange"));

      fireEvent.keyDown(document.body, { key: "f" });
      expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    it("arrows defer to the focused seek slider (±5s, not ±10s)", () => {
      render(<Harness />);
      const video = screen.getByTestId("video");
      setProp(video, "duration", 120);
      fireEvent(video, new Event("durationchange"));

      const slider = screen.getByRole("slider", { name: "Seek" });
      fireEvent.keyDown(slider, { key: "ArrowRight" });
      expect((video as HTMLVideoElement).currentTime).toBe(5);
      fireEvent.keyDown(slider, { key: "ArrowLeft" });
      expect((video as HTMLVideoElement).currentTime).toBe(0);
    });

    it("space does not double-toggle when a control button is focused", () => {
      const playSpy = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      render(<Harness />);
      const playBtn = screen.getByRole("button", { name: "Play" });

      playBtn.focus();
      fireEvent.keyDown(playBtn, { key: " " });
      // Native button activation is left to take over; our handler skips.
      expect(playSpy).not.toHaveBeenCalled();
    });

    it("shortcuts are suppressed while a modifier key is held", () => {
      const playSpy = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      render(<Harness />);
      fireEvent.keyDown(document.body, { key: " ", ctrlKey: true });
      fireEvent.keyDown(document.body, { key: " ", metaKey: true });
      fireEvent.keyDown(document.body, { key: " ", altKey: true });
      expect(playSpy).not.toHaveBeenCalled();
    });
  });

  describe("shortcuts help overlay", () => {
    it("? toggles the overlay and Escape closes it", () => {
      render(<Harness />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      fireEvent.keyDown(document.body, { key: "?" });
      expect(
        screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
      ).toBeInTheDocument();

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("the close button and backdrop click dismiss the overlay", () => {
      render(<Harness />);
      fireEvent.keyDown(document.body, { key: "?" });
      fireEvent.click(screen.getByRole("button", { name: "Close shortcuts" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      fireEvent.keyDown(document.body, { key: "?" });
      // The dialog element is the backdrop.
      fireEvent.click(
        screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("media shortcuts are suspended while the overlay is open", () => {
      const playSpy = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      render(<Harness />);

      fireEvent.keyDown(document.body, { key: "?" });
      fireEvent.keyDown(document.body, { key: " " });
      expect(playSpy).not.toHaveBeenCalled();

      // Closing restores shortcuts.
      fireEvent.keyDown(document.body, { key: "?" });
      fireEvent.keyDown(document.body, { key: " " });
      expect(playSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("shortcut suppression in form fields", () => {
    function FieldHarness({ tag = "input" }: { tag?: "input" | "textarea" }) {
      const videoRef = useRef<HTMLVideoElement>(null);
      const containerRef = useRef<HTMLDivElement>(null);
      return (
        <div
          ref={containerRef}
          data-testid="container"
          style={{ width: 400, position: "relative" }}
        >
          <video ref={videoRef} data-testid="video" />
          <PlayerControls
            videoRef={videoRef}
            containerRef={containerRef}
            subtitleTracks={[]}
            videoId="v1"
          />
          {tag === "textarea" ? (
            <textarea data-testid="field" />
          ) : (
            <input data-testid="field" />
          )}
        </div>
      );
    }

    it("space does not toggle play while focused in an input", () => {
      const playSpy = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      render(<FieldHarness />);
      const field = screen.getByTestId("field");
      field.focus();
      fireEvent.keyDown(field, { key: " " });
      expect(playSpy).not.toHaveBeenCalled();
    });

    it("j/l and arrows do not seek while focused in a textarea", () => {
      render(<FieldHarness tag="textarea" />);
      const video = screen.getByTestId("video");
      setProp(video, "duration", 120);
      const field = screen.getByTestId("field");
      field.focus();
      fireEvent.keyDown(field, { key: "l" });
      fireEvent.keyDown(field, { key: "ArrowRight" });
      expect((video as HTMLVideoElement).currentTime).toBe(0);
    });

    it("shortcuts are suppressed inside a contentEditable element", () => {
      const playSpy = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockResolvedValue(undefined);
      render(<FieldHarness />);
      const field = screen.getByTestId("field");
      Object.defineProperty(field, "isContentEditable", {
        value: true,
        configurable: true,
      });
      fireEvent.keyDown(field, { key: " " });
      expect(playSpy).not.toHaveBeenCalled();
    });
  });

  describe("queue skip buttons (M3 T11)", () => {
    it("hides skip buttons when no queue props are provided", () => {
      render(<Harness />);
      expect(
        screen.queryByRole("button", { name: "Previous video" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Next video" }),
      ).not.toBeInTheDocument();
    });

    it("renders prev + next buttons when their callbacks are provided", () => {
      render(
        <Harness
          onPrev={() => {}}
          onNext={() => {}}
          hasPrev={true}
          hasNext={true}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Previous video" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Next video" }),
      ).toBeInTheDocument();
    });

    it("can render only one of the two (next-only is valid)", () => {
      render(<Harness onNext={() => {}} hasNext={true} />);
      expect(
        screen.queryByRole("button", { name: "Previous video" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Next video" }),
      ).toBeInTheDocument();
    });

    it("disables Prev when !hasPrev and Next when !hasNext", () => {
      render(
        <Harness
          onPrev={() => {}}
          onNext={() => {}}
          hasPrev={false}
          hasNext={false}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Previous video" }),
      ).toBeDisabled();
      expect(screen.getByRole("button", { name: "Next video" })).toBeDisabled();
    });

    it("clicking Prev fires the callback", () => {
      const onPrev = vi.fn();
      render(<Harness onPrev={onPrev} hasPrev={true} />);
      fireEvent.click(screen.getByRole("button", { name: "Previous video" }));
      expect(onPrev).toHaveBeenCalledTimes(1);
    });

    it("clicking Next fires the callback", () => {
      const onNext = vi.fn();
      render(<Harness onNext={onNext} hasNext={true} />);
      fireEvent.click(screen.getByRole("button", { name: "Next video" }));
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it("positions the skip buttons left of the play button", () => {
      const { container } = render(
        <Harness
          onPrev={() => {}}
          onNext={() => {}}
          hasPrev={true}
          hasNext={true}
        />,
      );
      // The first three buttons in the controls row are prev / play / next.
      const buttons = container.querySelectorAll("button");
      const labels = Array.from(buttons)
        .slice(0, 3)
        .map((b) => b.getAttribute("aria-label"));
      expect(labels).toEqual(["Previous video", "Play", "Next video"]);
    });
  });
});
