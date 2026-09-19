// Share manage page tests (share-manage-page tasks 003 + 004).
//
// Owner-facing detail route `/settings/shares/:id`. The page composes two
// reads: share meta from the shares list query (find by id — there is no
// single-share endpoint, and the list is already cached from Settings) and
// members from the owned-items route. These tests pin the state machine:
// render order, unknown-id not-found, terminal read-only, members error
// retry, and (task 004) the removal flow — PUT splices, undo restores the
// original index, failure keeps the card, last-item guard, and single-slot
// undo toasts.

import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { ShareManagePage } from "./share-manage";
import {
  jsonResponse,
  jsonError,
  renderWithProviders,
  type FetchHandler,
} from "../test/utils";
import type { ShareDto } from "../api/shares";
import type { ShareFolderDto, VideoSummaryDto } from "../api/types";

const ACTIVE: ShareDto = {
  id: "s1",
  title: "Trip footage",
  item_count: 2,
  created_at: "2026-08-01T00:00:00Z",
  expires_at: null,
  revoked_at: null,
  status: "active",
};

const REVOKED: ShareDto = {
  ...ACTIVE,
  status: "revoked",
  revoked_at: "2026-08-02T00:00:00Z",
};

function video(id: string, name: string): VideoSummaryDto {
  return {
    id,
    name,
    provider: "google_drive",
    size_bytes: 1024,
    mime_type: "video/mp4",
    duration_ms: null,
    width: null,
    height: null,
    sources: [],
    created_at: "2026-01-01T00:00:00Z",
    path: null,
    is_favorite: false,
    my_rating: null,
    thumbnail_status: "pending",
    position_seconds: null,
    completed: false,
  };
}

const MEMBERS = [video("v1", "Alpha clip"), video("v2", "Beta clip")];
const GAMMA = video("v3", "Gamma clip");
/** Every video any test in this file can PUT — the id→video universe. */
const UNIVERSE = [...MEMBERS, GAMMA];

/** Wrapped owned-items payload (share-folders task 004 shape). Flat by
 * default — folder fixtures pass their own folder list. Items always
 * carry `folder_id` (null = root), exactly as the server serializes. */
function ownedPayload(items: VideoSummaryDto[], folders: ShareFolderDto[] = []) {
  return { folders, items: items.map((v) => ({ ...v, folder_id: null })) };
}

/** Stubs the two GETs the page rides. Extra URLs 404 so omissions are loud. */
function manageFetch(
  shares: ShareDto[],
  items?: { status: number; body?: unknown },
) {
  return (input: RequestInfo | URL): Response => {
    const url = String(input);
    if (url === "/api/shares") return jsonResponse(shares);
    if (url === "/api/shares/s1/items") {
      return items
        ? jsonError(items.status, "boom")
        : jsonResponse(ownedPayload(MEMBERS));
    }
    return jsonError(404, "unmocked");
  };
}

function renderManage(
  fetchImplementation: ReturnType<typeof manageFetch>,
  path = "/settings/shares/s1",
) {
  return renderWithProviders(
    <Routes>
      <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      <Route path="/settings" element={<p>settings home</p>} />
    </Routes>,
    { initialEntries: [path], fetchImplementation },
  );
}

describe("ShareManagePage", () => {
  it("renders share meta and the member grid in curation order", async () => {
    renderManage(manageFetch([ACTIVE]));

    expect(
      await screen.findByRole("heading", { name: "Trip footage" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/2 items/)).toBeInTheDocument();

    // Curation order is the server's array order.
    const names = await screen.findAllByText(/clip/i);
    expect(names.map((n) => n.textContent)).toEqual([
      "Alpha clip",
      "Beta clip",
    ]);

    // Back to the standalone shares list (/shares since task 005).
    expect(
      screen.getByRole("link", { name: /back to shares/i }),
    ).toHaveAttribute("href", "/shares");
  });

  it("renders a not-found card for an unknown share id", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      {
        initialEntries: ["/settings/shares/nope"],
        fetchImplementation: manageFetch([]),
      },
    );

    expect(
      await screen.findByText(/doesn't exist/i),
    ).toBeInTheDocument();
  });

  it("renders a revoked share read-only (badge, note, no actions)", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: manageFetch([REVOKED]) },
    );

    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    expect(screen.getByText(/no longer available/i)).toBeInTheDocument();
    // Read-only: nothing to press on this page yet (no remove/add).
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });

  it("surfaces a members load error with a working retry", async () => {
    let failures = 0;
    const { fetchSpy } = renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      {
        initialEntries: ["/settings/shares/s1"],
        fetchImplementation: (input) => {
          const url = String(input);
          if (url === "/api/shares/s1/items") {
            failures += 1;
            return failures === 1
              ? jsonError(500, "boom")
              : jsonResponse(ownedPayload(MEMBERS));
          }
          return manageFetch([ACTIVE])(input);
        },
      },
    );

    expect(
      await screen.findByText(/couldn't load/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.filter(([input]) => String(input) === "/api/shares/s1/items"),
      ).toHaveLength(2);
    });
    expect(await screen.findByText("Alpha clip")).toBeInTheDocument();
  });

  // --- Removal flow (task 004) -------------------------------------------

  it("removes an item: PUT splices the id, grid refetches, undo toast offers restore", async () => {
    const state = { items: MEMBERS };
    const handler = removalFetch(state);
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: handler },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /more actions for alpha clip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /remove from share/i }));

    await waitFor(() => {
      expect(handler.puts).toEqual([["v2"]]);
    });
    // Refetched grid no longer contains the removed item.
    await waitFor(() =>
      expect(screen.queryByText("Alpha clip")).not.toBeInTheDocument(),
    );
    // Undo toast names the removed item.
    expect(screen.getByText(/removed 'alpha clip'/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /undo/i })).toHaveLength(1);
  });

  it("undo re-PUTs the item at its original index", async () => {
    const state = { items: MEMBERS };
    const handler = removalFetch(state);
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: handler },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /more actions for alpha clip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /remove from share/i }));
    fireEvent.click(await screen.findByRole("button", { name: /undo/i }));

    await waitFor(() => {
      expect(handler.puts).toEqual([["v2"], ["v1", "v2"]]);
    });
    await waitFor(() =>
      expect(screen.getByText("Alpha clip")).toBeInTheDocument(),
    );
  });

  it("keeps the item and surfaces an inline error when the PUT fails", async () => {
    const state = { items: MEMBERS, failPut: true };
    const handler = removalFetch(state);
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: handler },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /more actions for alpha clip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /remove from share/i }));

    expect(
      await screen.findByRole("alert", { name: /couldn't remove/i }),
    ).toBeInTheDocument();
    // The card is still there (no refetch happened, no toast fired).
    expect(screen.getByText("Alpha clip")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /undo/i })).not.toBeInTheDocument();
  });

  it("guards the last item: Remove is disabled with the revoke hint", async () => {
    const state = { items: [MEMBERS[0]] };
    const handler = removalFetch(state);
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: handler },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /more actions for alpha clip/i }),
    );

    const remove = screen.getByRole("menuitem", { name: /remove from share/i });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText(/a share needs at least one item/i),
    ).toBeInTheDocument();
    expect(handler.puts).toHaveLength(0);
  });

  it("single-slot undo: a second removal replaces the first toast", async () => {
    // Three members: after removing Alpha, two remain — Beta is not yet
    // the guarded last item, so a second removal is allowed.
    const state = { items: [MEMBERS[0], MEMBERS[1], GAMMA] };
    const handler = removalFetch(state);
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: handler },
    );

    // Remove Alpha; wait for its toast, then remove Beta.
    fireEvent.click(
      await screen.findByRole("button", { name: /more actions for alpha clip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /remove from share/i }));
    await screen.findByText(/removed 'alpha clip'/i);

    // The refetched grid now shows only Beta; open its menu.
    const betaTrigger = await screen.findByRole("button", {
      name: /more actions for beta clip/i,
    });
    fireEvent.click(betaTrigger);
    fireEvent.click(screen.getByRole("menuitem", { name: /remove from share/i }));

    // Exactly one undo toast remains, naming the latest removal.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /undo/i })).toHaveLength(1),
    );
    expect(screen.getByText(/removed 'beta clip'/i)).toBeInTheDocument();
    expect(screen.queryByText(/removed 'alpha clip'/i)).not.toBeInTheDocument();
  });

  it("rapid removals never resurrect: the second PUT waits out the stale-cache window", async () => {
    // C1 regression: between PUT1's 204 and its refetch landing, the
    // cached list is stale. The second removal must NOT splice from it —
    // the just-removed Alpha would come back. Gated GET: after the first
    // PUT, the members refetch blocks until the test releases it, holding
    // that window open deterministically.
    const state = { items: [MEMBERS[0], MEMBERS[1], GAMMA] };
    let gateNextGet = false;
    let getGated = false;
    let releaseGet: () => void = () => {};
    const handler = removalFetch(state);
    const original = handler;
    const gatedHandler: FetchHandler = (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/shares/s1/items" && method === "GET" && gateNextGet) {
        gateNextGet = false;
        getGated = true;
        return new Promise<Response>((resolve) => {
          releaseGet = () => resolve(jsonResponse(ownedPayload(state.items)));
        });
      }
      const response = original(input, init);
      if (url === "/api/shares/s1/items" && method === "PUT") {
        // The next members GET (the invalidation's refetch) blocks.
        gateNextGet = true;
      }
      return response;
    };
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: gatedHandler },
    );

    // Remove Alpha; PUT1 lands, refetch gates open.
    fireEvent.click(
      await screen.findByRole("button", { name: /more actions for alpha clip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /remove from share/i }));
    await waitFor(() =>
      expect(handler.puts).toEqual([["v2", "v3"]]),
    );
    await waitFor(() => expect(getGated).toBe(true));

    // Remove Beta while Alpha's refetch is still gated. The buggy version
    // computed PUT2 from the stale cache immediately (["v1","v3"],
    // resurrecting Alpha); the fix waits for the fresh list.
    fireEvent.click(
      screen.getByRole("button", { name: /more actions for beta clip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /remove from share/i }));
    expect(handler.puts).toHaveLength(1); // still waiting on the gate

    releaseGet();
    await waitFor(() =>
      expect(handler.puts).toEqual([["v2", "v3"], ["v3"]]),
    );
  });

  it("undo racing an in-flight removal never re-asserts the in-flight id", async () => {
    // R1 regression: Undo(Alpha) while Beta's removal is still computing
    // must not PUT Beta back. Both paths await the same members fetch
    // (ensureQueryData dedupes), so gating that one GET holds the whole
    // race open: on release, Beta's PUT splices v2 out and the undo's PUT
    // restores v1 into a v2-free list. Buggy code produced [v1, v2, v3].
    const state = { items: [MEMBERS[0], MEMBERS[1], GAMMA] };
    let gateNextGet = false;
    let getGated = false;
    let releaseGet: () => void = () => {};
    const handler = removalFetch(state);
    const gated: FetchHandler = (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/shares/s1/items" && method === "GET" && gateNextGet) {
        gateNextGet = false;
        getGated = true;
        return new Promise<Response>((resolve) => {
          releaseGet = () => resolve(jsonResponse(ownedPayload(state.items)));
        });
      }
      const response = handler(input, init);
      if (url === "/api/shares/s1/items" && method === "PUT") {
        // The removal's own refetch (the mutationFn's freshMemberIds)
        // blocks until released.
        gateNextGet = true;
      }
      return response;
    };
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: gated },
    );

    // Remove Alpha: its PUT arms the gate and its own invalidation
    // refetch parks on it — release to let the removal settle fully.
    fireEvent.click(
      await screen.findByRole("button", { name: /more actions for alpha clip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /remove from share/i }));
    await waitFor(() => expect(getGated).toBe(true));
    releaseGet();
    await screen.findByText(/removed 'alpha clip'/i);

    // Remove Beta: PUT2 lands (ungated) and re-arms the gate, so Beta's
    // post-PUT refetch parks — Beta is now mid-flight forever: still in
    // pendingRemovals, toast not yet pushed.
    fireEvent.click(
      screen.getByRole("button", { name: /more actions for beta clip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /remove from share/i }));
    await waitFor(() =>
      expect(handler.puts.some((p) => p.length === 1 && p[0] === "v3")).toBe(true),
    );
    await waitFor(() => expect(getGated).toBe(true));

    // Undo Alpha (its toast is the live one). The undo's own members
    // fetch parks on the same gate.
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));

    // Release: the undo computes from the fresh list minus the in-flight
    // v2 — its restore must land as [v1, v3], never [v1, v2, v3].
    releaseGet?.();
    await waitFor(() =>
      expect(handler.puts.some((p) => p[0] === "v1" && p[1] === "v3")).toBe(true),
    );
    for (const put of handler.puts.filter((p) => p.includes("v1"))) {
      expect(put).not.toContain("v2");
    }
  });

  it("removing under an active search filter uses the unfiltered list for undo", async () => {
    // Spec criterion 5: filtering is render-only — undo indices come from
    // the unfiltered server list, so a filtered removal restores in place.
    const state = { items: [MEMBERS[0], MEMBERS[1], GAMMA] };
    const handler = removalFetch(state);
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: handler },
    );

    // Filter down to Beta alone, remove it, clear the filter, undo.
    fireEvent.change(await screen.findByLabelText(/search this share/i), {
      target: { value: "beta" },
    });
    await waitFor(() =>
      expect(screen.queryByText("Alpha clip")).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /more actions for beta clip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /remove from share/i }));
    await waitFor(() =>
      expect(handler.puts).toEqual([["v1", "v3"]]),
    );

    fireEvent.change(screen.getByLabelText(/search this share/i), {
      target: { value: "" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /undo/i }));
    await waitFor(() =>
      expect(handler.puts).toEqual([["v1", "v3"], ["v1", "v2", "v3"]]),
    );
    // Beta is back between Alpha and Gamma.
    await waitFor(() =>
      expect(screen.getByText("Beta clip")).toBeInTheDocument(),
    );
  });

  // --- Search + add-only picker (task 005) --------------------------------

  it("filters the grid client-side as the owner types, and clears back to full order", async () => {
    const state = { items: [MEMBERS[0], MEMBERS[1], GAMMA] };
    const handler = removalFetch(state);
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: handler },
    );

    fireEvent.change(await screen.findByLabelText(/search this share/i), {
      target: { value: "alpha" },
    });
    await waitFor(() =>
      expect(screen.queryByText("Beta clip")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Alpha clip")).toBeInTheDocument();
    expect(screen.queryByText("Gamma clip")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/search this share/i), {
      target: { value: "" },
    });
    expect(await screen.findByText("Gamma clip")).toBeInTheDocument();
    expect(screen.getByText("Alpha clip")).toBeInTheDocument();
  });

  it("renders an empty-match state for a query with no hits", async () => {
    const state = { items: MEMBERS };
    const handler = removalFetch(state);
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: handler },
    );

    fireEvent.change(await screen.findByLabelText(/search this share/i), {
      target: { value: "zzz-no-match" },
    });

    expect(await screen.findByText(/no videos match/i)).toBeInTheDocument();
    expect(screen.queryByText("Alpha clip")).not.toBeInTheDocument();
  });

  it("Add items opens the add-only picker; saving appends and refetches the grid", async () => {
    const state = { items: MEMBERS };
    const handler = removalFetch(state);
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: handler },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /add items/i }),
    );

    const dialog = await screen.findByRole("dialog");
    // Add-only: the current members are locked in (checked + disabled).
    const alpha = within(dialog).getByLabelText("Alpha clip");
    expect(alpha).toBeDisabled();
    expect(alpha).toBeChecked();

    fireEvent.click(await within(dialog).findByLabelText("Gamma clip"));
    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(handler.puts).toEqual([["v1", "v2", "v3"]]);
    });
    // The shared owned-items key (task 002) makes the page refetch with
    // the dialog's invalidation — Gamma appears without a manual reload.
    expect(await screen.findByText("Gamma clip")).toBeInTheDocument();
  });
});

// --------------- folder browse parity (share-folders task 006) -----------
//
// The owner sees exactly what recipients see (task 5 helpers/tile):
// folders first per level, `?folder=` descent, breadcrumbs — no editing
// affordances on folders yet (tasks 7/8).

const TREE_FOLDERS: ShareFolderDto[] = [
  { id: "f-trip", parent_id: null, name: "Trip", position: 0 },
  { id: "f-night", parent_id: "f-trip", name: "Night", position: 0 },
];

/** Alpha at root, Beta in Trip, Gamma in Night — GET-only handler. */
function treeFetch(): (input: RequestInfo | URL) => Response {
  return (input) => {
    const url = String(input);
    if (url === "/api/shares")
      return jsonResponse([{ ...ACTIVE, item_count: 3 }]);
    if (url === "/api/shares/s1/items")
      return jsonResponse({
        folders: TREE_FOLDERS,
        items: [
          { ...MEMBERS[0], folder_id: null },
          { ...MEMBERS[1], folder_id: "f-trip" },
          { ...GAMMA, folder_id: "f-night" },
        ],
      });
    return jsonError(404, "unmocked");
  };
}

describe("ShareManagePage folder browse", () => {
  it("renders folder tiles before the level's videos, descends, and climbs via breadcrumbs", async () => {
    renderManage(treeFetch(), "/settings/shares/s1");

    const tripTile = await screen.findByRole("link", { name: "Open folder Trip" });
    expect(screen.getByText("Alpha clip")).toBeInTheDocument();
    // Folder contents stay hidden at the root level.
    expect(screen.queryByText("Beta clip")).not.toBeInTheDocument();

    fireEvent.click(tripTile);
    expect(await screen.findByText("Beta clip")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open folder Night" })).toBeInTheDocument();
    expect(screen.queryByText("Alpha clip")).not.toBeInTheDocument();

    // Breadcrumb parity: root crumb (share title) / current folder.
    fireEvent.click(screen.getByRole("link", { name: "Open folder Night" }));
    expect(await screen.findByText("Gamma clip")).toBeInTheDocument();
    const rootCrumb = screen.getByRole("link", { name: "Trip footage" });
    const tripCrumb = screen.getByRole("link", { name: "Trip" });
    expect(
      rootCrumb.compareDocumentPosition(tripCrumb) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(tripCrumb);
    expect(await screen.findByText("Beta clip")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Trip footage" }));
    expect(await screen.findByText("Alpha clip")).toBeInTheDocument();
  });

  it("search filters the current level's videos; folder tiles stay visible", async () => {
    renderManage(treeFetch(), "/settings/shares/s1");

    fireEvent.change(await screen.findByLabelText(/search this share/i), {
      target: { value: "beta" },
    });
    await waitFor(() =>
      expect(screen.queryByText("Alpha clip")).not.toBeInTheDocument(),
    );
    // The tile survives the filter — search is render-only over videos,
    // folders keep their place in the grid.
    expect(screen.getByRole("link", { name: "Open folder Trip" })).toBeInTheDocument();
  });
});

/** Stateful handler for removal-flow tests: GET serves the live array, PUT
 * records every body (for order assertions) and flips the array. `failPut`
 * makes PUTs answer 500 to exercise the error path. */
function removalFetch(state: {
  items: VideoSummaryDto[];
  failPut?: boolean;
}): ((input: RequestInfo | URL, init?: RequestInit) => Response) & {
  puts: string[][];
} {
  const puts: string[][] = [];
  const handler = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/shares") return jsonResponse([ACTIVE]);
    if (url === "/api/shares/s1/items" && method === "GET")
      return jsonResponse(ownedPayload(state.items));
    if (url === "/api/shares/s1/items" && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        video_ids: string[];
      };
      puts.push(body.video_ids);
      if (state.failPut) return jsonError(500, "boom");
      // Map ids from the full universe (an undo re-adds an id that is not
      // in the current list — filtering current would drop it).
      state.items = body.video_ids
        .map((id) => UNIVERSE.find((v) => v.id === id))
        .filter((v): v is VideoSummaryDto => v !== undefined);
      return new Response(null, { status: 204 });
    }
    if (new URL(url, "http://localhost").pathname === "/api/videos") {
      const q = new URL(url, "http://localhost").searchParams.get("q") ?? "";
      const videos = UNIVERSE.filter((v) =>
        v.name.toLowerCase().includes(q.toLowerCase()),
      );
      return jsonResponse({
        videos,
        total: videos.length,
        page: 1,
        limit: 200,
      });
    }
    return jsonError(404, "unmocked");
  };
  handler.puts = puts;
  return handler;
}

