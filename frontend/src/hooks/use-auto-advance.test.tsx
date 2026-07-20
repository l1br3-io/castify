import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";

import { useAutoAdvance } from "./use-auto-advance";

function Harness({
  videoId = "v1",
  hasNext = true,
  onAdvance = vi.fn(),
}: {
  videoId?: string;
  hasNext?: boolean;
  onAdvance?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const aa = useAutoAdvance(videoRef, videoId, hasNext, onAdvance);
  return (
    <div>
      <video ref={videoRef} data-testid="video" />
      {aa.counting && (
        <div data-testid="overlay">
          <span data-testid="seconds">{aa.secondsLeft}</span>
          <button type="button" onClick={aa.playNextNow} data-testid="play-now">
            Play next now
          </button>
          <button
            type="button"
            onClick={aa.cancelCountdown}
            data-testid="cancel"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("useAutoAdvance", () => {
  it("does not start a countdown before the video ends", () => {
    render(<Harness />);
    expect(screen.queryByTestId("overlay")).not.toBeInTheDocument();
  });

  it("starts a 5-second countdown when the video ends and hasNext is true", () => {
    vi.useFakeTimers();
    try {
      render(<Harness hasNext={true} />);
      const video = screen.getByTestId("video");

      act(() => {
        fireEvent(video, new Event("ended"));
      });

      expect(screen.getByTestId("overlay")).toBeInTheDocument();
      expect(screen.getByTestId("seconds").textContent).toBe("5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a countdown when hasNext is false", () => {
    render(<Harness hasNext={false} />);
    const video = screen.getByTestId("video");

    act(() => {
      fireEvent(video, new Event("ended"));
    });

    expect(screen.queryByTestId("overlay")).not.toBeInTheDocument();
  });

  it("fires onAdvance when the countdown reaches zero", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    try {
      render(<Harness hasNext={true} onAdvance={onAdvance} />);
      const video = screen.getByTestId("video");

      act(() => {
        fireEvent(video, new Event("ended"));
      });

      // 5 ticks of 1s each → onAdvance fires on the 5th.
      expect(onAdvance).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId("seconds").textContent).toBe("4");
      expect(onAdvance).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(onAdvance).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("overlay")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("'Play next now' fires onAdvance immediately", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    try {
      render(<Harness hasNext={true} onAdvance={onAdvance} />);
      const video = screen.getByTestId("video");

      act(() => {
        fireEvent(video, new Event("ended"));
      });
      expect(onAdvance).not.toHaveBeenCalled();

      act(() => {
        fireEvent.click(screen.getByTestId("play-now"));
      });
      expect(onAdvance).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("overlay")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("'Cancel' dismisses the countdown without advancing", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    try {
      render(<Harness hasNext={true} onAdvance={onAdvance} />);
      const video = screen.getByTestId("video");

      act(() => {
        fireEvent(video, new Event("ended"));
      });

      act(() => {
        fireEvent.click(screen.getByTestId("cancel"));
      });

      expect(onAdvance).not.toHaveBeenCalled();
      expect(screen.queryByTestId("overlay")).not.toBeInTheDocument();

      // Advancing time after cancel doesn't fire onAdvance.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(onAdvance).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a subsequent 'play' event cancels the countdown (user replayed)", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    try {
      render(<Harness hasNext={true} onAdvance={onAdvance} />);
      const video = screen.getByTestId("video");

      act(() => {
        fireEvent(video, new Event("ended"));
      });
      expect(screen.getByTestId("overlay")).toBeInTheDocument();

      // The user replayed / sought back from the end.
      act(() => {
        fireEvent(video, new Event("play"));
      });

      expect(screen.queryByTestId("overlay")).not.toBeInTheDocument();
      expect(onAdvance).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pausing mid-countdown cancels it", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    try {
      render(<Harness hasNext={true} onAdvance={onAdvance} />);
      const video = screen.getByTestId("video");

      act(() => {
        fireEvent(video, new Event("ended"));
      });
      expect(screen.getByTestId("overlay")).toBeInTheDocument();

      act(() => {
        fireEvent(video, new Event("pause"));
      });

      expect(screen.queryByTestId("overlay")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flipping hasNext to false mid-countdown cancels it", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    try {
      const { rerender } = render(
        <Harness hasNext={true} onAdvance={onAdvance} />,
      );
      const video = screen.getByTestId("video");

      act(() => {
        fireEvent(video, new Event("ended"));
      });
      expect(screen.getByTestId("overlay")).toBeInTheDocument();

      // Queue runs out → countdown should cancel.
      rerender(<Harness hasNext={false} onAdvance={onAdvance} />);

      expect(screen.queryByTestId("overlay")).not.toBeInTheDocument();
      expect(onAdvance).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("countdown resets when the video changes (queue skip)", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    try {
      const { rerender } = render(
        <Harness videoId="v1" hasNext={true} onAdvance={onAdvance} />,
      );
      const video = screen.getByTestId("video");

      act(() => {
        fireEvent(video, new Event("ended"));
      });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByTestId("seconds").textContent).toBe("3");

      // User skipped — videoId changes, overlay should disappear and the
      // new video shouldn't inherit the prior countdown.
      rerender(<Harness videoId="v2" hasNext={true} onAdvance={onAdvance} />);

      expect(screen.queryByTestId("overlay")).not.toBeInTheDocument();

      // New video ends — countdown starts fresh from 5.
      const newVideo = screen.getByTestId("video");
      act(() => {
        fireEvent(newVideo, new Event("ended"));
      });
      expect(screen.getByTestId("seconds").textContent).toBe("5");
    } finally {
      vi.useRealTimers();
    }
  });
});
