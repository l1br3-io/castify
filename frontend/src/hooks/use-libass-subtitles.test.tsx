import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";

import { useLibassSubtitles } from "./use-libass-subtitles";

// Mock jassub. `vi.mock` is hoisted above every import by vitest, so the
// factory can only reference bindings created via `vi.hoisted`. The spies
// live on a shared object so tests can assert on constructor + destroy calls.
const mocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  destroy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("jassub", () => ({
  default: class MockJassub {
    ready: Promise<void>;
    constructor(opts: unknown) {
      mocks.ctor(opts);
      this.ready = Promise.resolve();
    }
    destroy() {
      return mocks.destroy();
    }
  },
}));

// Harness mirrors how routes/watch.tsx composes the hook: a <video> + a
// <canvas> overlay + the hook. The status is surfaced via a data attribute
// so tests can assert on the lifecycle without coupling to internals.
function Harness({ assUrl }: { assUrl: string | undefined }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { status } = useLibassSubtitles(videoRef, canvasRef, assUrl);
  return (
    <div>
      <video ref={videoRef} />
      <canvas ref={canvasRef} data-testid="canvas" />
      <span data-testid="status">{status}</span>
    </div>
  );
}

describe("useLibassSubtitles", () => {
  beforeEach(() => {
    mocks.ctor.mockClear();
    mocks.destroy.mockClear();
  });

  it("creates a JASSUB instance with video + canvas + subUrl when assUrl is set", async () => {
    render(<Harness assUrl="/api/videos/v1/subtitles/s1" />);

    await waitFor(() => {
      expect(mocks.ctor).toHaveBeenCalledTimes(1);
    });
    expect(mocks.ctor).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.any(HTMLVideoElement),
        canvas: expect.any(HTMLCanvasElement),
        subUrl: "/api/videos/v1/subtitles/s1",
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("ready");
    });
  });

  it("does nothing while assUrl is undefined (no load, no canvas wiring)", () => {
    render(<Harness assUrl={undefined} />);
    expect(mocks.ctor).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(screen.getByTestId("status").textContent).toBe("idle");
  });

  it("destroys the instance when assUrl becomes undefined (selecting Off)", async () => {
    const { rerender } = render(
      <Harness assUrl="/api/videos/v1/subtitles/s1" />,
    );
    await waitFor(() => expect(mocks.ctor).toHaveBeenCalledTimes(1));

    rerender(<Harness assUrl={undefined} />);

    await waitFor(() => expect(mocks.destroy).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("status").textContent).toBe("idle");
  });

  it("destroys the old instance and creates a new one when assUrl changes (switching ASS tracks)", async () => {
    const { rerender } = render(
      <Harness assUrl="/api/videos/v1/subtitles/s1" />,
    );
    await waitFor(() =>
      expect(mocks.ctor).toHaveBeenCalledWith(
        expect.objectContaining({ subUrl: "/api/videos/v1/subtitles/s1" }),
      ),
    );

    rerender(<Harness assUrl="/api/videos/v1/subtitles/s2" />);

    // Old instance torn down, new one created with the new URL.
    await waitFor(() => expect(mocks.destroy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mocks.ctor).toHaveBeenCalledWith(
        expect.objectContaining({ subUrl: "/api/videos/v1/subtitles/s2" }),
      ),
    );
  });

  it("destroys the instance on unmount", async () => {
    const { unmount } = render(
      <Harness assUrl="/api/videos/v1/subtitles/s1" />,
    );
    await waitFor(() => expect(mocks.ctor).toHaveBeenCalledTimes(1));

    unmount();

    await waitFor(() => expect(mocks.destroy).toHaveBeenCalledTimes(1));
  });
});
