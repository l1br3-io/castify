import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";

import { useLibassSubtitles } from "./use-libass-subtitles";

// A throwing mock factory simulates the dynamic `import("jassub")` rejecting
// — e.g. the chunk failed to download over the network. vitest turns a
// factory throw into a rejection of the imported module, which is exactly
// the condition the hook must survive (NFR — Reliability: load failure
// degrades gracefully; subtitle off, video continues, no unhandled rejection).
vi.mock("jassub", () => {
  throw new Error("network blocked: jassub chunk failed to load");
});

function Harness({ assUrl }: { assUrl: string | undefined }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { status } = useLibassSubtitles(videoRef, canvasRef, assUrl);
  return (
    <div>
      <video ref={videoRef} />
      <canvas ref={canvasRef} />
      <span data-testid="status">{status}</span>
    </div>
  );
}

describe("useLibassSubtitles — load failure", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("degrades gracefully when import('jassub') rejects: status=error, warns, no throw", async () => {
    render(<Harness assUrl="/api/videos/v1/subtitles/s1" />);

    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("error");
    });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("libass"),
      expect.any(Error),
    );
  });
});
