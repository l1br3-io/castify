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
//
// The IndexedDB link store is mocked at the module boundary (jsdom has no
// IndexedDB); fetch is stubbed through renderWithProviders' fetchSpy.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { SharesSection } from "./shares-list";
import {
  jsonResponse,
  jsonError,
  renderWithProviders,
} from "../test/utils";
import { setCsrfToken } from "../api/client";
import type { ShareDto } from "../api/shares";
import { deleteShareLink, getShareLinkMap } from "../lib/share-links-db";

vi.mock("../lib/share-links-db", () => ({
  getShareLinkMap: vi.fn(),
  saveShareLink: vi.fn(),
  deleteShareLink: vi.fn(),
}));

// `restoreMocks: true` in the vitest config resets mock implementations
// between tests — re-establish the fire-and-forget defaults every time
// (same pattern as browse.test.tsx's player-db mock).
beforeEach(() => {
  vi.mocked(getShareLinkMap).mockResolvedValue({});
  vi.mocked(deleteShareLink).mockResolvedValue(undefined);
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
  document.execCommand =
    execCommand as unknown as typeof document.execCommand;
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
    if (url === "/api/shares" && method === "GET")
      return jsonResponse(shares);
    if (url.startsWith("/api/shares/") && method === "DELETE")
      return new Response(null, { status: 204 });
    return jsonError(404, `unmocked ${method} ${url}`);
  };
}

function countShareListCalls(
  fetchSpy: { mock: { calls: [unknown, RequestInit?][] } },
): number {
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
    expect(screen.getByText(/3 items/)).toBeInTheDocument();
    expect(screen.getAllByText("Active")).toHaveLength(2);
    expect(screen.getByText("Revoked")).toBeInTheDocument();

    // Single GET on mount, no polling.
    await waitFor(() =>
      expect(countShareListCalls(fetchSpy)).toBe(1),
    );
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
          return fetchSpy.mock.calls.filter(([u]) => String(u) === "/api/shares")
            .length <= 1
            ? jsonError(500, "boom")
            : jsonResponse([ACTIVE]);
        }
        return jsonError(404, `unmocked ${method} ${url}`);
      },
    });

    expect(await screen.findByText(/couldn't load shares/i)).toBeInTheDocument();
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

    fireEvent.click(
      await screen.findByRole("button", { name: /copy link/i }),
    );

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

    fireEvent.click(
      await screen.findByRole("button", { name: /copy link/i }),
    );

    expect(
      await screen.findByText(/couldn't copy/i),
    ).toBeInTheDocument();
    restoreExecCommand();
  });

  it("renders status only for shares created on another device", async () => {
    vi.mocked(getShareLinkMap).mockResolvedValue({ s1: "/share/tok_abc" });

    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE, OTHER_DEVICE]),
    });

    await screen.findByText("Wedding cut");
    // Exactly one copy button — for the locally-created share.
    expect(
      screen.getAllByRole("button", { name: /copy link/i }),
    ).toHaveLength(1);
    expect(screen.getByText("Wedding cut")).toBeInTheDocument();
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

    fireEvent.click(
      await screen.findByRole("button", { name: /copy link/i }),
    ); // ensure the row rendered with a link
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

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

    // Row stays in the list and flips to the revoked state in place.
    expect(await screen.findByText("Trip footage")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/revoked/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /copy link/i }),
    ).not.toBeInTheDocument();
    // The dead link is dropped from the local store.
    await waitFor(() =>
      expect(deleteShareLink).toHaveBeenCalledWith("s1"),
    );

    confirmSpy.mockRestore();
  });

  it("does not DELETE when the confirm dialog is cancelled", async () => {
    const { fetchSpy } = renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE]),
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.click(
      await screen.findByRole("button", { name: /revoke/i }),
    );

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

  it("renders Delete on active, expired, and revoked rows", async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE, REVOKED, EXPIRED]),
    });

    await screen.findByText("Trip footage");
    expect(
      screen.getAllByRole("button", { name: /^delete$/i }),
    ).toHaveLength(3);
  });

  it("deletes after confirmation: purge DELETE, refetch drops the row, link entry removed", async () => {
    vi.mocked(getShareLinkMap).mockResolvedValue({ s1: "/share/tok_abc" });
    // Holder the fetch dispatch reads per call, so the post-delete GET
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
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    // The confirm copy must be distinct from revoke's soft-delete wording.
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("removed permanently from this list"),
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

    // Row disappears after the refetch — the server owns the list.
    await waitFor(() =>
      expect(screen.queryByText("Trip footage")).not.toBeInTheDocument(),
    );
    // The dead link is dropped from the local store.
    await waitFor(() =>
      expect(deleteShareLink).toHaveBeenCalledWith("s1"),
    );

    confirmSpy.mockRestore();
  });

  it("disables Delete while the purge is in flight", async () => {
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
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    expect(
      await screen.findByRole("button", { name: /deleting/i }),
    ).toBeDisabled();

    current = [];
    resolveDelete!(new Response(null, { status: 204 }));
    await waitFor(() =>
      expect(screen.queryByText("Trip footage")).not.toBeInTheDocument(),
    );

    confirmSpy.mockRestore();
  });

  it("does not purge when the delete confirm dialog is cancelled", async () => {
    const { fetchSpy } = renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE]),
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(
      fetchSpy.mock.calls.filter(([input, init]) => {
        const url = String(input);
        return (
          String(url).includes("purge=true") &&
          (init?.method ?? "GET") === "DELETE"
        );
      }),
    ).toHaveLength(0);

    confirmSpy.mockRestore();
  });

  it("surfaces a delete failure inline without dropping the row", async () => {
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
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    expect(await screen.findByText(/purge failed/i)).toBeInTheDocument();
    expect(screen.getByText("Trip footage")).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  it('offers "Manage" on active rows only', async () => {
    renderWithProviders(<SharesSection />, {
      fetchImplementation: sharesFetch([ACTIVE, REVOKED, EXPIRED]),
    });

    await screen.findByText("Trip footage");
    expect(
      screen.getAllByRole("link", { name: /manage/i }),
    ).toHaveLength(1);
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
        <Route
          path="/settings/shares/:id"
          element={<p>manage page probe</p>}
        />
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
