// Tests for the owner-facing Shares management section (task 011).
//
// Behavior under test, per the task acceptance criteria:
//   * the list loads on mount with a single GET /api/shares — no polling;
//   * revoke asks for confirmation, DELETEs, and the row flips to the
//     server-provided revoked state in place;
//   * copy link uses navigator.clipboard when available and falls back to
//     the legacy execCommand path otherwise, surfacing copied-state
//     feedback either way;
//   * rows for shares created on another device (no IndexedDB link) render
//     status only — no link, no copy button, no reconstruction;
//   * "Edit items" appears on active rows only (revoked/expired rows
//     render status only — matches the server's 409), opens the edit
//     dialog for that share, and a saved edit flows back into the row's
//     item count via the shares-query invalidation the dialog fires.
//   * delete (share-management task 005) renders on every status: confirm
//     → one DELETE with `purge=true` → the row disappears after the
//     refetch (the server owns the list), the per-device IndexedDB link
//     entry is dropped, the button disables while in flight, and a
//     failure surfaces inline without dropping the row.
//   * search + status chips (share-management task 006): the list mounts
//     with the Active chip applied (past shares hidden until asked for);
//     title search is a case-insensitive substring ANDed with the chip;
//     chip counts are scoped to the current query; filtering is entirely
//     client-side over the cached list, so the fetch-call count must stay
//     at the single mount GET across every filter interaction.
//
// The IndexedDB link store is mocked at the module boundary (jsdom has no
// IndexedDB); fetch is stubbed through renderWithProviders' fetchSpy.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { SharesSection } from "./shares-list";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";
import { setCsrfToken } from "../api/client";
import type { ShareDto } from "../api/shares";
import { deleteShareLink, getShareLinkMap, getShortLink, saveShortLink } from "../lib/share-links-db";

vi.mock("../lib/share-links-db", () => ({
  getShareLinkMap: vi.fn(),
  saveShareLink: vi.fn(),
  deleteShareLink: vi.fn(),
  getShortLink: vi.fn(),
  saveShortLink: vi.fn(),
}));

// `restoreMocks: true` in the vitest config resets mock implementations
// between tests — re-establish the fire-and-forget defaults every time
// (same pattern as browse.test.tsx's player-db mock).
beforeEach(() => {
  vi.mocked(getShareLinkMap).mockResolvedValue({});
  vi.mocked(deleteShareLink).mockResolvedValue(undefined);
  vi.mocked(getShortLink).mockResolvedValue(null);
  vi.mocked(saveShortLink).mockResolvedValue(undefined);
});

// jsdom ships no Async Clipboard API. Tests install (or remove)
// navigator.clipboard per case to drive the primary and fallback paths.
// jsdom ships no Async Clipboard API. Tests install (or remove)
// navigator.clipboard per case to drive the primary and fallback paths.
function installClipboard(
  writeText: ((text: string) => Promise<void>) | undefined,
): void {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

// jsdom ships no execCommand either — stub it (spyOn needs the property
// to exist) and restore the original (absent) value afterwards.
const ORIGINAL_EXEC_COMMAND = document.execCommand;

function stubExecCommand(returns: boolean): ReturnType<typeof vi.fn> {
  const execCommand = vi.fn().mockReturnValue(returns);
  document.execCommand = execCommand as unknown as typeof document.execCommand;
  return execCommand;
}

function restoreExecCommand(): void {
  document.execCommand =
    ORIGINAL_EXEC_COMMAND as unknown as typeof document.execCommand;
}

beforeEach(() => {
  installClipboard(vi.fn().mockResolvedValue(undefined));
});

function shareDto(overrides: Partial<ShareDto> = {}): ShareDto {
  return {
    id: "s1",
    title: "Trip footage",
    item_count: 3,
    created_at: "2026-08-01T12:00:00Z",
    expires_at: null,
    revoked_at: null,
    status: "active",
    ...overrides,
  };
}

const ACTIVE = shareDto();
const OTHER_DEVICE = shareDto({
  id: "s2",
  title: "Wedding cut",
  item_count: 1,
  created_at: "2026-07-01T12:00:00Z",
});
const REVOKED = shareDto({
  id: "s3",
  title: "Old share",
  item_count: 5,
  revoked_at: "2026-08-02T12:00:00Z",
  status: "revoked",
});
const EXPIRED = shareDto({
  id: "s4",
  title: "Stale share",
  item_count: 2,
  expires_at: "2026-08-01T00:00:00Z",
  status: "expired",
});

function sharesFetch(shares: unknown) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/shares" && method === "GET") return jsonResponse(shares);
    if (url.startsWith("/api/shares/") && method === "DELETE")
      return new Response(null, { status: 204 });
    return jsonError(404, `unmocked ${method} ${url}`);
  };
}

function countShareListCalls(fetchSpy: {
  mock: { calls: [unknown, RequestInit?][] };
}): number {
  return fetchSpy.mock.calls.filter(([input, init]) => {
    const url = String(input);
    return url === "/api/shares" && (init?.method ?? "GET") === "GET";
  }).length;
}

describe("SharesSection", () => {
  beforeEach(() => setCsrfToken("csrf-test"));
  afterEach(() => setCsrfToken(null));

  it("renders rows with title, item count, and status from a single mount GET", async () => {
    const { fetchSpy } = renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE, OTHER_DEVICE, REVOKED]),
    });

    expect(await screen.findByText("Trip footage")).toBeInTheDocument();
    // Items is its own column cell now (table layout, task 017).
    expect(screen.getByText("3")).toBeInTheDocument();
    // Default view (Active chip): two active rows, the revoked one hidden.
    expect(screen.getAllByText("Active")).toHaveLength(2);
    expect(screen.queryByText("Old share")).not.toBeInTheDocument();

    // All reveals past shares, preserving the server's newest-first order.
    fireEvent.click(screen.getByRole("button", { name: /^all/i }));
    expect(screen.getByText("Old share")).toBeInTheDocument();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    // Table rows (task 017): data rows in server order, names in the
    // first cell.
    const nameCells = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.querySelector("td")?.textContent);
    expect(nameCells).toEqual(["Trip footage", "Wedding cut", "Old share"]);

    // Single GET on mount, no polling.
    await waitFor(() => expect(countShareListCalls(fetchSpy)).toBe(1));
  });

  it("mounts with the Active chip applied — past shares invisible until asked for", async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE, REVOKED, EXPIRED]),
    });

    await screen.findByText("Trip footage");
    expect(screen.getByRole("button", { name: /^active/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^all/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByText("Old share")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale share")).not.toBeInTheDocument();

    // One chip at a time: pressing All drops Active's pressed state.
    fireEvent.click(screen.getByRole("button", { name: /^all/i }));
    expect(screen.getByText("Old share")).toBeInTheDocument();
    expect(screen.getByText("Stale share")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^active/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // …and the Revoked chip narrows to revoked rows only.
    fireEvent.click(screen.getByRole("button", { name: /^revoked/i }));
    expect(screen.getByText("Old share")).toBeInTheDocument();
    expect(screen.queryByText("Trip footage")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale share")).not.toBeInTheDocument();
  });

  it("searches by case-insensitive title substring, ANDed with the chip", async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE, REVOKED, EXPIRED]),
    });

    const search = await screen.findByRole("searchbox", {
      name: /search shares/i,
    });

    fireEvent.change(search, { target: { value: "TRIP" } });
    expect(screen.getByText("Trip footage")).toBeInTheDocument();
    expect(screen.queryByText("Old share")).not.toBeInTheDocument();

    // A query matching only past shares empties the Active view…
    fireEvent.change(search, { target: { value: "share" } });
    expect(screen.queryByText("Trip footage")).not.toBeInTheDocument();
    expect(screen.getByText(/no shares match/i)).toBeInTheDocument();

    // …but the same query under the Revoked chip shows the revoked row.
    fireEvent.click(screen.getByRole("button", { name: /^revoked/i }));
    expect(screen.getByText("Old share")).toBeInTheDocument();
    expect(screen.queryByText("Stale share")).not.toBeInTheDocument();
  });

  it("issues zero network requests across search and chip interactions", async () => {
    const { fetchSpy } = renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE, REVOKED, EXPIRED]),
    });

    await screen.findByText("Trip footage");
    fireEvent.change(
      screen.getByRole("searchbox", { name: /search shares/i }),
      {
        target: { value: "share" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /^expired/i }));
    fireEvent.click(screen.getByRole("button", { name: /^all/i }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: /search shares/i }),
      {
        target: { value: "" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /^active/i }));

    expect(await screen.findByText("Trip footage")).toBeInTheDocument();
    // Filtering is client-side over the cached list: still exactly the
    // single mount GET.
    expect(countShareListCalls(fetchSpy)).toBe(1);
  });

  it("scopes chip counts to the current search query", async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([
        ACTIVE,
        OTHER_DEVICE,
        REVOKED,
        EXPIRED,
      ]),
    });

    await screen.findByText("Trip footage");
    expect(
      screen.getByRole("button", { name: "Active 2" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expired 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Revoked 1" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All 4" })).toBeInTheDocument();

    // "share" matches only the two past shares — counts follow the query.
    fireEvent.change(
      screen.getByRole("searchbox", { name: /search shares/i }),
      {
        target: { value: "share" },
      },
    );
    expect(
      screen.getByRole("button", { name: "Active 0" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All 2" })).toBeInTheDocument();
  });

  it("shows the no-match empty state for a non-matching search", async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE]),
    });

    await screen.findByText("Trip footage");
    fireEvent.change(
      screen.getByRole("searchbox", { name: /search shares/i }),
      {
        target: { value: "nonexistent" },
      },
    );

    // Filter-excluded, not share-less — a distinct empty state, and the
    // controls stay up so the filter can be cleared.
    expect(screen.getByText(/no shares match/i)).toBeInTheDocument();
    expect(screen.queryByText(/no shares yet/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: /search shares/i }),
    ).toBeInTheDocument();
  });

  it("shows an empty state when the owner has no shares", async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([]),
    });

    expect(await screen.findByText(/no shares yet/i)).toBeInTheDocument();
  });

  it("shows an error state with retry when the list request fails", async () => {
    const { fetchSpy } = renderWithProviders(<SharesSection />, {
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/shares" && method === "GET") {
          return fetchSpy.mock.calls.filter(
            ([u]) => String(u) === "/api/shares",
          ).length <= 1
            ? jsonError(500, "boom")
            : jsonResponse([ACTIVE]);
        }
        return jsonError(404, `unmocked ${method} ${url}`);
      },
    });

    expect(
      await screen.findByText(/couldn't load shares/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText("Trip footage")).toBeInTheDocument();
  });

  it("copies the absolute link via navigator.clipboard and shows copied feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    vi.mocked(getShareLinkMap).mockResolvedValue({ s1: "/share/tok_abc" });

    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE]),
    });

    const button = await screen.findByRole("button", {
      name: /copy link/i,
    });
    fireEvent.click(button);

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/share/tok_abc`,
      ),
    );
    expect(
      await screen.findByRole("button", { name: /^copied$/i }),
    ).toBeInTheDocument();
  });

  it("falls back to the legacy copy path when clipboard is unavailable", async () => {
    installClipboard(undefined);
    vi.mocked(getShareLinkMap).mockResolvedValue({ s1: "/share/tok_abc" });
    const execCommand = stubExecCommand(true);

    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE]),
    });

    fireEvent.click(await screen.findByRole("button", { name: /copy link/i }));

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(
      await screen.findByRole("button", { name: /^copied$/i }),
    ).toBeInTheDocument();
    restoreExecCommand();
  });

  it("surfaces failure feedback when both copy paths fail", async () => {
    installClipboard(undefined);
    vi.mocked(getShareLinkMap).mockResolvedValue({ s1: "/share/tok_abc" });
    stubExecCommand(false);

    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE]),
    });

    fireEvent.click(await screen.findByRole("button", { name: /copy link/i }));

    expect(await screen.findByText(/couldn't copy/i)).toBeInTheDocument();
    restoreExecCommand();
  });

  it("renders status only for shares created on another device", async () => {
    vi.mocked(getShareLinkMap).mockResolvedValue({ s1: "/share/tok_abc" });

    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE, OTHER_DEVICE]),
    });

    await screen.findByText("Wedding cut");
    // Exactly one copy button — for the locally-created share.
    expect(screen.getAllByRole("button", { name: /copy link/i })).toHaveLength(
      1,
    );
    expect(screen.getByText("Wedding cut")).toBeInTheDocument();
  });

  // --- short link button (docs/specs/short-links task 004) ---

  it("active rows with a local link offer both Copy link and Copy short link", async () => {
    vi.mocked(getShareLinkMap).mockResolvedValue({ s1: "/share/tok_abc" });

    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE]),
    });

    expect(
      await screen.findByRole("button", { name: /copy link/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy short link/i }),
    ).toBeInTheDocument();
  });

  it("shares created on another device offer neither copy button", async () => {
    vi.mocked(getShareLinkMap).mockResolvedValue({});

    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([OTHER_DEVICE]),
    });

    await screen.findByText("Wedding cut");
    expect(
      screen.queryByRole("button", { name: /copy link/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /copy short link/i }),
    ).not.toBeInTheDocument();
  });

  it("past rows offer no short link even when a local link exists", async () => {
    vi.mocked(getShareLinkMap).mockResolvedValue({ s3: "/share/tok_old" });

    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([REVOKED]),
    });

    // Past rows hide under the default Active chip — reveal with All.
    fireEvent.click(await screen.findByRole("button", { name: /^all/i }));

    await screen.findByText("Old share");
    expect(
      screen.queryByRole("button", { name: /copy short link/i }),
    ).not.toBeInTheDocument();
  });

  it("revokes after confirmation: DELETE, refetch, row flips in place", async () => {
    vi.mocked(getShareLinkMap).mockResolvedValue({ s1: "/share/tok_abc" });
    // Holder the fetch dispatch reads per call, so the post-revoke GET
    // serves the server's updated (revoked) state — the server stays the
    // source of truth for status.
    let current = [ACTIVE];
    const { fetchSpy } = renderWithProviders(<SharesSection />, {
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/shares" && method === "GET")
          return jsonResponse(current);
        if (url === "/api/shares/s1" && method === "DELETE") {
          current = [
            shareDto({ revoked_at: "2026-08-29T00:00:00Z", status: "revoked" }),
          ];
          return new Response(null, { status: 204 });
        }
        return jsonError(404, `unmocked ${method} ${url}`);
      },
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    // Reveal every status: the row must survive the revoke flip in view —
    // under the default Active chip it would (correctly) vanish instead.
    fireEvent.click(await screen.findByRole("button", { name: /^all/i }));

    fireEvent.click(await screen.findByRole("button", { name: /copy link/i })); // ensure the row rendered with a link
    fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([input, init]) => {
          const url = String(input);
          return (
            url === "/api/shares/s1" && (init?.method ?? "GET") === "DELETE"
          );
        }),
      ).toBe(true);
    });

    // Row stays in the table and flips to the revoked state in place
    // (scoped to the row — the status chips also say "Revoked").
    const row = (await screen.findByText("Trip footage")).closest("tr")!;
    await waitFor(() =>
      expect(within(row).getByText(/revoked/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /copy link/i }),
    ).not.toBeInTheDocument();
    // The dead link is dropped from the local store.
    await waitFor(() => expect(deleteShareLink).toHaveBeenCalledWith("s1"));

    confirmSpy.mockRestore();
  });

  it("does not DELETE when the confirm dialog is cancelled", async () => {
    const { fetchSpy } = renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE]),
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(
      fetchSpy.mock.calls.filter(([input, init]) => {
        const url = String(input);
        return (
          url.startsWith("/api/shares/") && (init?.method ?? "GET") === "DELETE"
        );
      }),
    ).toHaveLength(0);

    confirmSpy.mockRestore();
  });

  it("renders Purge share on active, expired, and revoked rows", async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE, REVOKED, EXPIRED]),
    });

    // All statuses on screen at once (the default Active chip would hide
    // the past rows — that hiding is covered by its own test above).
    fireEvent.click(await screen.findByRole("button", { name: /^all/i }));

    expect(
      screen.getAllByRole("button", { name: /purge share/i }),
    ).toHaveLength(3);
  });

  it("renders the list as a table with scannable columns", async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE]),
    });

    expect(await screen.findByRole("table")).toBeInTheDocument();
    for (const column of ["Name", "Items", "Created", "Expires", "Status"]) {
      expect(
        screen.getByRole("columnheader", { name: column }),
      ).toBeInTheDocument();
    }
  });

  it("shows an empty state with a next action when there are no shares", async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([]),
    });

    expect(await screen.findByText("No shares yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Share something" }),
    ).toBeInTheDocument();
  });

  it("shows a no-results state with a clear action when the search misses", async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE]),
    });

    await screen.findByText("Trip footage");
    fireEvent.change(screen.getByLabelText(/search shares/i), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No shares match")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("Trip footage")).toBeInTheDocument();
  });

  it("purge asks first: names the share and warns it cannot be undone", async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE]),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /purge share/i }),
    );
    const dialog = screen.getByRole("dialog", { name: /purge/i });
    // The confirmation names the share (in the heading)…
    expect(
      within(dialog).getByText(/Purge "Trip footage"/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    // The confirm action carries the same verb as the row button.
    expect(
      within(dialog).getByRole("button", { name: /purge share/i }),
    ).toHaveClass("bg-[var(--color-danger-subtle)]");
  });

  it("purge: cancelling deletes nothing", async () => {
    const { fetchSpy } = renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE]),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /purge share/i }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      fetchSpy.mock.calls.some(([input, init]) => {
        const url = String(input);
        return (
          url.includes("purge=true") && (init?.method ?? "GET") === "DELETE"
        );
      }),
    ).toBe(false);
  });

  it("purge: confirming DELETEs, toasts 'Share purged', drops the row, drops the link entry", async () => {
    vi.mocked(getShareLinkMap).mockResolvedValue({ s1: "/share/tok_abc" });
    // Holder the fetch dispatch reads per call, so the post-purge GET
    // serves the server's purged (empty) list — the row must vanish via
    // refetch, not local patching.
    let current = [ACTIVE];
    const { fetchSpy } = renderWithProviders(<SharesSection />, {
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/shares" && method === "GET")
          return jsonResponse(current);
        if (url === "/api/shares/s1?purge=true" && method === "DELETE") {
          current = [];
          return new Response(null, { status: 204 });
        }
        return jsonError(404, `unmocked ${method} ${url}`);
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /purge share/i }),
    );
    // The confirm action carries the identical verb (FR-5.3 audit).
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /purge share/i,
      }),
    );

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([input, init]) => {
          const url = String(input);
          return (
            url === "/api/shares/s1?purge=true" &&
            (init?.method ?? "GET") === "DELETE"
          );
        }),
      ).toBe(true);
    });

    // Success feedback uses the same verb: "Share purged".
    expect(await screen.findByText("Share purged")).toBeInTheDocument();

    // Row disappears after the refetch — the server owns the list.
    await waitFor(() =>
      expect(screen.queryByText("Trip footage")).not.toBeInTheDocument(),
    );
    // The dead link is dropped from the local store.
    await waitFor(() => expect(deleteShareLink).toHaveBeenCalledWith("s1"));
  });

  it("disables the purge while it is in flight", async () => {
    let current = [ACTIVE];
    let resolveDelete: ((response: Response) => void) | undefined;
    renderWithProviders(<SharesSection />, {
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/shares" && method === "GET")
          return jsonResponse(current);
        if (url === "/api/shares/s1?purge=true" && method === "DELETE")
          return new Promise<Response>((resolve) => {
            resolveDelete = resolve;
          });
        return jsonError(404, `unmocked ${method} ${url}`);
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /purge share/i }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /purge share/i,
      }),
    );

    expect(
      await screen.findByRole("button", { name: /purging/i }),
    ).toBeDisabled();

    current = [];
    resolveDelete!(new Response(null, { status: 204 }));
    await waitFor(() =>
      expect(screen.queryByText("Trip footage")).not.toBeInTheDocument(),
    );
  });

  it("surfaces a purge failure inside the dialog without dropping the row", async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/shares" && method === "GET")
          return jsonResponse([ACTIVE]);
        if (url === "/api/shares/s1?purge=true" && method === "DELETE")
          return jsonError(500, "purge failed");
        return jsonError(404, `unmocked ${method} ${url}`);
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /purge share/i }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /purge share/i,
      }),
    );

    // The failure surfaces inside the dialog, and the row (and dialog) stay
    // for a retry.
    const dialog = screen.getByRole("dialog");
    expect(
      await within(dialog).findByText(/purge failed/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Trip footage")).toBeInTheDocument();
  });

  it('offers "Manage" on active rows only', async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE, REVOKED, EXPIRED]),
    });

    // All rows visible so this tests the status gating, not the filter.
    fireEvent.click(await screen.findByRole("button", { name: /^all/i }));

    expect(screen.getAllByRole("link", { name: /manage/i })).toHaveLength(1);
    // The link targets the share's detail route (share-manage-page 003).
    expect(screen.getByRole("link", { name: /manage/i })).toHaveAttribute(
      "href",
      "/settings/shares/s1",
    );
  });

  it("navigates Manage to the share's detail page", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SharesSection />} />
        <Route path="/settings/shares/:id" element={<p>manage page probe</p>} />
      </Routes>,
      {
        initialEntries: ["/settings"],
        fetchImplementation: sharesFetch([ACTIVE]),
      },
    );

    fireEvent.click(await screen.findByRole("link", { name: /manage/i }));

    expect(await screen.findByText("manage page probe")).toBeInTheDocument();
  });
});
