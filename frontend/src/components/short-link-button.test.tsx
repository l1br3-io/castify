// ShortLinkButton — mint-once + canonical-fallback behavior
// (short-links, task 003).
//
// The network layer is stubbed via globalThis.fetch (the real
// `src/api/shorten` seam runs), so the fetch spy genuinely counts outbound
// shortener calls — the spec's "≤1 request per user action, zero on cache
// hit" criterion is proven at the network layer, not by trusting mocks.
// IndexedDB helpers and the clipboard are module mocks.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { ShortLinkButton } from "./short-link-button";
import { jsonResponse, renderWithProviders } from "../test/utils";
import { copyToClipboard } from "../lib/clipboard";
import { getShortLink, saveShortLink } from "../lib/share-links-db";

vi.mock("../lib/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("../lib/share-links-db", () => ({
  getShortLink: vi.fn(),
  saveShortLink: vi.fn(),
}));

const SHARE_ID = "s1";
const LINK_PATH = "/share/t0k3n";
// jsdom's default origin is http://localhost:3000.
const CANONICAL_ABSOLUTE = "http://localhost:3000/share/t0k3n";

function spooMeHandler(): Response {
  return jsonResponse({ short_url: "http://spoo.me/U1b05Y" });
}

beforeEach(() => {
  vi.mocked(getShortLink).mockResolvedValue(null);
  vi.mocked(saveShortLink).mockResolvedValue(undefined);
  vi.mocked(copyToClipboard).mockResolvedValue(true);
});

describe("ShortLinkButton", () => {
  it("first click mints exactly one shortener request, copies the https alias, and fires onResolved", async () => {
    const onResolved = vi.fn();
    const { fetchSpy } = renderWithProviders(
      <ShortLinkButton shareId={SHARE_ID} linkPath={LINK_PATH} onResolved={onResolved} />,
      { fetchImplementation: spooMeHandler },
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy short link" }));

    await waitFor(() =>
      expect(copyToClipboard).toHaveBeenCalledWith("https://spoo.me/U1b05Y"),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://spoo.me/");
    expect(vi.mocked(saveShortLink)).toHaveBeenCalledWith(SHARE_ID, "https://spoo.me/U1b05Y");
    expect(onResolved).toHaveBeenCalledWith("https://spoo.me/U1b05Y");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Copied short link to clipboard");
  });

  it("a re-click after minting is served from the cache with zero network calls", async () => {
    vi.mocked(getShortLink)
      .mockResolvedValueOnce(null)
      .mockResolvedValue("https://spoo.me/U1b05Y");
    const { fetchSpy } = renderWithProviders(
      <ShortLinkButton shareId={SHARE_ID} linkPath={LINK_PATH} />,
      { fetchImplementation: spooMeHandler },
    );
    // Hold the DOM node: after the first click the label is "Copied" for 2s.
    const button = screen.getByRole("button", { name: "Copy short link" });

    fireEvent.click(button);
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledTimes(1));

    fireEvent.click(button);

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledTimes(2));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenNthCalledWith(2, "https://spoo.me/U1b05Y");
    expect(saveShortLink).toHaveBeenCalledTimes(1);
  });

  it("a cache hit copies without any outbound request", async () => {
    vi.mocked(getShortLink).mockResolvedValue("https://spoo.me/CACHED1");
    const onResolved = vi.fn();
    const { fetchSpy } = renderWithProviders(
      <ShortLinkButton shareId={SHARE_ID} linkPath={LINK_PATH} onResolved={onResolved} />,
      {
        fetchImplementation: () => {
          throw new Error("no network traffic expected on a cache hit");
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy short link" }));

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith("https://spoo.me/CACHED1"));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(saveShortLink).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith("https://spoo.me/CACHED1");
  });

  it("copies the canonical link and announces unavailability when the shortener 429s", async () => {
    const onResolved = vi.fn();
    renderWithProviders(
      <ShortLinkButton shareId={SHARE_ID} linkPath={LINK_PATH} onResolved={onResolved} />,
      { fetchImplementation: () => jsonResponse({ message: "rate limited" }, 429) },
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy short link" }));

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(CANONICAL_ABSOLUTE));
    const note = screen.getByText(/shortener unavailable/i);
    expect(note).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveTextContent("Copied full link to clipboard");
    expect(saveShortLink).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("copies the canonical link on a network failure too", async () => {
    renderWithProviders(
      <ShortLinkButton shareId={SHARE_ID} linkPath={LINK_PATH} />,
      { fetchImplementation: () => Promise.reject(new TypeError("Failed to fetch")) },
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy short link" }));

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(CANONICAL_ABSOLUTE));
    expect(screen.getByText(/shortener unavailable/i)).toBeInTheDocument();
  });

  it("shows the generic copy failure when even the canonical copy fails", async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(false);
    renderWithProviders(
      <ShortLinkButton shareId={SHARE_ID} linkPath={LINK_PATH} />,
      { fetchImplementation: () => jsonResponse({ message: "rate limited" }, 429) },
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy short link" }));

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(CANONICAL_ABSOLUTE));
    expect(screen.getByText(/couldn't copy/i)).toBeInTheDocument();
    expect(screen.queryByText(/shortener unavailable/i)).not.toBeInTheDocument();
  });

  it("disables itself and labels 'Shortening…' while minting", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    renderWithProviders(
      <ShortLinkButton shareId={SHARE_ID} linkPath={LINK_PATH} />,
      { fetchImplementation: () => pending },
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy short link" }));

    const busy = screen.getByRole("button", { name: "Shortening…" });
    expect(busy).toBeDisabled();

    release(jsonResponse({ short_url: "https://spoo.me/U1b05Y" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied" })).toBeEnabled(),
    );
  });
});
