// Tests for the share add-items dialog (add-only since share-manage-page
// task 005 — removal moved to the manage page).
//
// Behavior under test, per the task acceptance criteria:
//   * current members render pre-checked at the top in the server's
//     curation order (not re-sorted), with the searchable catalog below
//     deduped against them;
//   * selection is an ordered document: unchecking a member splices it,
//     checking a catalog row appends it — the save PUT carries that array
//     verbatim (server order preserved, additions after members);
//   * checked state is independent of what's on screen: re-searching
//     narrows the catalog but a checked video that falls out of the
//     results stays selected (verified via the save payload);
//   * an empty selection disables submit (client guard; the server's 400
//     is the backstop);
//   * a failed PUT surfaces inline without closing, and a pending PUT
//     disables submit and blocks Escape dismissal;
//   * a successful save invalidates the mounted shares query (Settings
//     refetches — the server owns state) and then closes;
//   * reopening after a save adopts the saved member list, not the
//     cached pre-edit one (found by the task-009 e2e: with the app-wide
//     30s staleTime, an un-invalidated members cache made removals
//     reappear pre-checked, and saving again would resurrect them).
//
// fetch is stubbed through renderWithProviders' fetchSpy; the mounted
// `SharesProbe` keeps the shares query active so invalidation is
// observable as a refetch.

import { useState } from "react";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";

import { ShareEditDialog } from "./share-edit-dialog";
import {
  jsonResponse,
  jsonError,
  renderWithProviders,
  type FetchHandler,
} from "../test/utils";
import { setCsrfToken } from "../api/client";
import { useShares } from "../hooks/use-shares";
import type { VideoSummaryDto } from "../api/types";

/** Must mirror the component's CATALOG_LIMIT (generous page, no pagination). */
const CATALOG_LIMIT = 200;

function video(id: string, name: string): VideoSummaryDto {
  return {
    id,
    name,
    provider: "google_drive",
    size_bytes: 1_000,
    mime_type: "video/mp4",
    duration_ms: 60_000,
    width: 1920,
    height: 1080,
    sources: [],
    created_at: "2026-01-01T00:00:00Z",
    path: `/Videos/${name}`,
    is_favorite: false,
    my_rating: null,
    thumbnail_status: "pending",
    position_seconds: null,
    completed: false,
  };
}

// Members deliberately NOT alphabetical: the server's curation order is
// [Beta, Alpha] and the payload must preserve it, not re-sort it.
const MEMBERS = [video("v2", "Beta clip"), video("v1", "Alpha clip")];
const LIBRARY = [
  video("v1", "Alpha clip"),
  video("v2", "Beta clip"),
  video("v3", "Gamma clip"),
  video("v4", "Delta clip"),
];

const SHARE = { id: "s1", title: "Trip footage" };

const SHARES_BODY = [
  {
    id: "s1",
    title: "Trip footage",
    item_count: 2,
    created_at: "2026-08-01T00:00:00Z",
    expires_at: null,
    revoked_at: null,
    status: "active",
  },
];

/** Keeps the shares query mounted so invalidation refetches are observable. */
function SharesProbe() {
  useShares();
  return null;
}

interface EditFetchOverrides {
  /** Response factory for `PUT /api/shares/s1/items` (204 by default). */
  putResponse?: () => Response | Promise<Response>;
  /** Members per GET ordinal (1 = first open). Defaults to MEMBERS. */
  membersByGet?: (getNumber: number) => VideoSummaryDto[];
}

function editDialogFetch(overrides: EditFetchOverrides = {}): FetchHandler {
  let membersGets = 0;
  return (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/api/shares/s1/items") {
      if (method === "GET") {
        membersGets += 1;
        return jsonResponse(overrides.membersByGet?.(membersGets) ?? MEMBERS);
      }
      if (method === "PUT")
        return overrides.putResponse?.() ?? new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/videos") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const videos =
        q === ""
          ? LIBRARY
          : LIBRARY.filter((v) => v.name.toLowerCase().includes(q));
      return jsonResponse({
        videos,
        total: videos.length,
        page: 1,
        limit: CATALOG_LIMIT,
      });
    }
    if (url.pathname === "/api/shares" && method === "GET")
      return jsonResponse(SHARES_BODY);
    return jsonError(404, `unmocked ${method} ${url.pathname}`);
  };
}

function putVideoIds(fetchSpy: {
  mock: { calls: [unknown, RequestInit?][] };
}): string[][] {
  return fetchSpy.mock.calls
    .filter(
      ([input, init]) =>
        String(input) === "/api/shares/s1/items" &&
        (init?.method ?? "GET") === "PUT",
    )
    .map(
      ([, init]) =>
        (JSON.parse(String(init?.body ?? "{}")) as { video_ids: string[] })
          .video_ids,
    );
}

function setupDialog(
  fetchImplementation: FetchHandler = editDialogFetch(),
): ReturnType<typeof renderWithProviders> & { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  const rendered = renderWithProviders(
    <>
      <ShareEditDialog share={SHARE} onClose={onClose} />
      <SharesProbe />
    </>,
    { fetchImplementation },
  );
  return { ...rendered, onClose };
}

/**
 * Mounts/unmounts the dialog the way the Settings row does
 * (`{isEditing && <ShareEditDialog/>}`) behind a "Reopen dialog" button —
 * one render, one QueryClient, so reopen-after-save exercises the same
 * cache the first mount populated.
 */
function EditDialogHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  function handleClose(): void {
    setOpen(false);
    onClose();
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen dialog
      </button>
      {open && <ShareEditDialog share={SHARE} onClose={handleClose} />}
    </>
  );
}

describe("ShareEditDialog", () => {
  beforeEach(() => setCsrfToken("csrf-test"));
  afterEach(() => setCsrfToken(null));

  // --- pre-check render ---

  it("renders members pre-checked in curation order and the catalog unchecked", async () => {
    const { fetchSpy } = setupDialog();

    expect(screen.getByText("Trip footage")).toBeInTheDocument();
    const beta = await screen.findByLabelText("Beta clip");
    const alpha = screen.getByLabelText("Alpha clip");
    expect(beta).toBeChecked();
    expect(alpha).toBeChecked();
    // Add-only picker: members are locked — removal is the manage page's.
    expect(beta).toBeDisabled();
    expect(alpha).toBeDisabled();
    // Curation order from the server (Beta before Alpha, not alphabetical).
    expect(
      beta.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Catalog rows are deduped against members and start unchecked.
    expect(await screen.findByLabelText("Gamma clip")).not.toBeChecked();
    expect(screen.getByLabelText("Delta clip")).not.toBeChecked();

    // One unfiltered catalog read on mount, at the generous limit.
    const catalogCalls = fetchSpy.mock.calls.filter(([input]) =>
      String(input).startsWith("/api/videos"),
    );
    expect(catalogCalls).toHaveLength(1);
    expect(String(catalogCalls[0][0])).toContain("limit=200");
  });

  // --- add flow + save payload order ---

  it("saves member order verbatim with additions appended, invalidates the shares list, and closes", async () => {
    const { fetchSpy, onClose } = setupDialog();

    fireEvent.click(await screen.findByLabelText("Delta clip")); // add from catalog
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // Server order [v2, v1] passes through verbatim, addition appended.
    expect(putVideoIds(fetchSpy)).toEqual([["v2", "v1", "v4"]]);

    // The mounted shares query refetches after invalidation (initial mount
    // + post-save = at least 2 GET /api/shares).
    await waitFor(() => {
      const shareListCalls = fetchSpy.mock.calls.filter(
        ([input]) => String(input) === "/api/shares",
      );
      expect(shareListCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // --- reopen after save (bug found by the task-009 e2e) ---

  it("reopening after a save adopts the saved list, not the cached pre-edit members", async () => {
    const onClose = vi.fn();
    // Mirror the production client's cache discipline (query-client.ts):
    // staleTime keeps a reopen serving cached data, and gcTime (explicit
    // here — the default 5min works but the contract shouldn't inherit
    // it) keeps the entry alive across the unmount gap. The default
    // throwaway client here uses gcTime 0, which garbage-collects the
    // members entry during that gap and hides the bug this test pins.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 30_000, gcTime: 300_000 },
      },
    });
    // GET #1 (first open): members [Beta, Alpha]. GET #2+ (reopen): the
    // server's post-save list — Gamma joined as a member.
    const { fetchSpy } = renderWithProviders(
      <>
        <EditDialogHarness onClose={onClose} />
        <SharesProbe />
      </>,
      {
        queryClient,
        fetchImplementation: editDialogFetch({
          membersByGet: (n) =>
            n === 1 ? MEMBERS : [...MEMBERS, video("v3", "Gamma clip")],
        }),
      },
    );

    // Add Gamma, save — the PUT carries members + the addition.
    fireEvent.click(await screen.findByLabelText("Gamma clip"));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(putVideoIds(fetchSpy)).toEqual([["v2", "v1", "v3"]]);

    // Reopen — same session, same cache (the manage page's lifecycle).
    fireEvent.click(screen.getByRole("button", { name: /reopen dialog/i }));

    // The dialog adopts the SAVED list: Gamma is now a checked, locked
    // member — not still sitting unchecked in the library from the
    // pre-save cache. (waitFor: the adoption effect commits a frame after
    // the rows mount.)
    await waitFor(() =>
      expect(screen.getByLabelText("Gamma clip")).toBeChecked(),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Gamma clip")).toBeDisabled(),
    );
  });

  // --- search + checked-state survival ---

  it("keeps checked state across re-search even when the row is no longer visible", async () => {
    const { fetchSpy, onClose } = setupDialog();

    fireEvent.click(await screen.findByLabelText("Delta clip"));
    fireEvent.change(screen.getByLabelText(/search videos/i), {
      target: { value: "gam" },
    });

    // The narrowed read actually carried the query, and its results show
    // Gamma without Delta (both were in the unfiltered page before).
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([input]) => String(input).includes("q=gam")),
      ).toBe(true);
    });
    expect(await screen.findByLabelText("Gamma clip")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByLabelText("Delta clip")).toBeNull(),
    );

    // Delta is still selected: the payload keeps it alongside a second
    // visible addition (Gamma re-checked after the search).
    fireEvent.click(screen.getByLabelText("Gamma clip"));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(putVideoIds(fetchSpy)).toEqual([["v2", "v1", "v4", "v3"]]);
  });

  // --- failure + retry ---

  it("shows a failed save inline without closing, then retries from the same form", async () => {
    let fails = true;
    const { fetchSpy, onClose } = setupDialog(
      editDialogFetch({
        putResponse: () =>
          fails
            ? jsonError(500, "database is locked")
            : new Response(null, { status: 204 }),
      }),
    );

    fireEvent.click(await screen.findByLabelText("Delta clip"));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/database is locked/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fails = false;
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(putVideoIds(fetchSpy)).toEqual([
      ["v2", "v1", "v4"],
      ["v2", "v1", "v4"],
    ]);
  });

  // --- pending state ---

  it("disables submit and ignores Escape while the save PUT is in flight", async () => {
    let release: (value: Response) => void = () => {};
    const inFlight = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { onClose } = setupDialog(
      editDialogFetch({ putResponse: () => inFlight }),
    );

    fireEvent.click(await screen.findByLabelText("Delta clip"));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const saving = await screen.findByRole("button", { name: /saving/i });
    expect(saving).toBeDisabled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    release(new Response(null, { status: 204 }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  // --- close behavior ---

  it("closes via Escape and Cancel when idle", async () => {
    const { onClose } = setupDialog();

    await screen.findByLabelText("Beta clip");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  // --- locked members ---

  it("clicking a member's label cannot uncheck it", async () => {
    setupDialog();

    await screen.findByLabelText("Beta clip");

    // Clicking the member's label is a no-op on the disabled checkbox.
    fireEvent.click(screen.getByText("Beta clip"));
    expect(screen.getByLabelText("Beta clip")).toBeChecked();
  });
});
