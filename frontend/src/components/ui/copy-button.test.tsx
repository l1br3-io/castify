// CopyButton — copy-to-clipboard with "Copied" feedback.
// Clipboard is exercised through lib/clipboard (mocked here) so the
// primitive's contract is: success → label flips to "Copied" for 2s;
// failure → inline message, announced via a polite live region.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CopyButton } from "./copy-button";

const copyToClipboard = vi.fn();

vi.mock("../../lib/clipboard", () => ({
  copyToClipboard: (text: string) => copyToClipboard(text),
}));

describe("CopyButton", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    copyToClipboard.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("copies the given value", async () => {
    render(<CopyButton value="/share/abc123" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    });
    expect(copyToClipboard).toHaveBeenCalledWith("/share/abc123");
  });

  it("flips to Copied for 2s, then back to Copy link", async () => {
    render(<CopyButton value="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("announces the copied state in a live region", async () => {
    render(<CopyButton value="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard");
  });

  it("shows a recovery message when copying fails", async () => {
    copyToClipboard.mockResolvedValue(false);
    render(<CopyButton value="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    });
    expect(screen.getByText(/couldn't copy/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("accepts custom labels", async () => {
    render(
      <CopyButton value="x" label="Copy invite" copiedLabel="Invite copied" />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy invite" }));
    });
    expect(screen.getByText("Invite copied to clipboard")).toBeInTheDocument();
  });
});
