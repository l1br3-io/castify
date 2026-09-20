// `shortenShareUrl` — the single shortener seam (docs/specs/short-links,
// task 001). All cases use a stubbed global fetch; nothing here touches the
// live spoo.me service.
//
// Covers every failure mode the caller (ShortLinkButton, task 003) must
// fall back on: non-200 (incl. 429), network error, 10s timeout abort, and
// a malformed body — plus the request shape (form-encoded `url=` only) and
// the http:→https: scheme upgrade on the returned alias.

import { describe, expect, it, vi } from "vitest";

import { ShortenerError, shortenShareUrl } from "./shorten";
import { jsonResponse } from "../test/utils";

const SHARE_URL = "https://castify.example/share/t0k3n";
const ENCODED = "url=https%3A%2F%2Fcastify.example%2Fshare%2Ft0k3n";

function lastCall(fetchSpy: ReturnType<typeof vi.fn>): {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
} {
  const [input, init] = fetchSpy.mock.calls.at(-1)!;
  return { input: input as RequestInfo | URL, init: init as RequestInit };
}

function neverResolvingUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
  });
}

describe("shortenShareUrl", () => {
  it("POSTs the form-encoded url and returns the https-normalized short URL", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ short_url: "http://spoo.me/U1b05Y" }));
    vi.stubGlobal("fetch", fetchSpy);

    const shortUrl = await shortenShareUrl(SHARE_URL);

    expect(shortUrl).toBe("https://spoo.me/U1b05Y");
    const { input, init } = lastCall(fetchSpy);
    expect(input.toString()).toBe("https://spoo.me/");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    // Body is exactly the absolute URL — no extra fields.
    expect(String(init?.body)).toBe(ENCODED);
  });

  it("does not upgrade a short URL that is already https", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ short_url: "https://spoo.me/AbCdEf" }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(shortenShareUrl(SHARE_URL)).resolves.toBe("https://spoo.me/AbCdEf");
  });

  it("throws a typed error carrying the status on non-200 (429)", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ message: "rate limited" }, 429));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(shortenShareUrl(SHARE_URL)).rejects.toMatchObject({
      name: "ShortenerError",
      kind: "http",
      status: 429,
    });
  });

  it("wraps network failures in a ShortenerError", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(shortenShareUrl(SHARE_URL)).rejects.toMatchObject({
      name: "ShortenerError",
      kind: "network",
    });
  });

  it("aborts with a 10s budget and reports a timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) => neverResolvingUntilAbort(init),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const pending = shortenShareUrl(SHARE_URL);
      const assertion = expect(pending).rejects.toMatchObject({
        name: "ShortenerError",
        kind: "timeout",
      });
      await vi.advanceTimersByTimeAsync(9_999);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;

      const { init } = lastCall(fetchSpy);
      expect(init?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on a body missing short_url", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ error: "nope" }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(shortenShareUrl(SHARE_URL)).rejects.toMatchObject({
      name: "ShortenerError",
      kind: "shape",
    });
  });

  it("throws on a non-string short_url", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ short_url: 42 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(shortenShareUrl(SHARE_URL)).rejects.toMatchObject({
      name: "ShortenerError",
      kind: "shape",
    });
  });

  it("throws on a non-JSON body", async () => {
    const fetchSpy = vi.fn(
      () => new Response("<html>gateway error</html>", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(shortenShareUrl(SHARE_URL)).rejects.toMatchObject({
      name: "ShortenerError",
      kind: "shape",
    });
  });

  it("exports ShortenerError distinguishable from other errors", () => {
    const error = new ShortenerError("http", "boom", 500);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ShortenerError");
    expect(error.kind).toBe("http");
    expect(error.status).toBe(500);
  });
});
