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
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";
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

  // --- Item ops (share-folders task 008) ---------------------------------
  //
  // Removal is the granular DELETE and undo is an append — one item, one
  // request, no list computation. The old PUT-based machinery
  // (pendingRemovals, freshMemberIds, stale-cache gating) is deleted with
  // the code; these tests pin the new contract.

  it("removes via the granular DELETE, refetches, and offers undo", async () => {
    const state = { folders: [], items: [{ ...MEMBERS[0], folder_id: null }, { ...MEMBERS[1], folder_id: null }] };
    const handler = folderCrudFetch(state);
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

    await waitFor(() => expect(handler.itemDeletes).toEqual(["v1"]));
    // Refetched grid no longer contains the removed item.
    await waitFor(() =>
      expect(screen.queryByText("Alpha clip")).not.toBeInTheDocument(),
    );
    // Undo toast names the removed item.
    expect(screen.getByText(/removed 'alpha clip'/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /undo/i })).toHaveLength(1);
  });

  it("undo re-adds via append — the item returns at the share root", async () => {
    const state = {
      folders: [{ id: "f-trip", parent_id: null, name: "Trip", position: 0 }] as ShareFolderDto[],
      items: [
        { ...MEMBERS[0], folder_id: null },
        { ...MEMBERS[1], folder_id: "f-trip" },
        { ...GAMMA, folder_id: "f-trip" },
      ],
    };
    const handler = folderCrudFetch(state);
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

    await waitFor(() => expect(handler.itemAppends).toEqual([["v1"]]));
    // Back at the root level — placement is not restored by design (spec
    // resolved question 3): the append lands the item at root, next to
    // the Trip tile, not inside it.
    expect(await screen.findByText("Alpha clip")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open folder Trip" })).toBeInTheDocument();
  });

  it("keeps the item and surfaces an inline error when the DELETE fails", async () => {
    const state = {
      folders: [],
      items: [{ ...MEMBERS[0], folder_id: null }, { ...MEMBERS[1], folder_id: null }],
      failItemDelete: true,
    };
    const handler = folderCrudFetch(state);
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
    const state = { folders: [], items: [{ ...MEMBERS[0], folder_id: null }] };
    const handler = folderCrudFetch(state);
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
    expect(handler.itemDeletes).toHaveLength(0);
  });

  it("single-slot undo: a second removal replaces the first toast", async () => {
    // Three members: after removing Alpha, two remain — Beta is not yet
    // the guarded last item, so a second removal is allowed.
    const state = {
      folders: [],
      items: [
        { ...MEMBERS[0], folder_id: null },
        { ...MEMBERS[1], folder_id: null },
        { ...GAMMA, folder_id: null },
      ],
    };
    const handler = folderCrudFetch(state);
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

  it("moves an item into a folder via the shared picker", async () => {
    const handler = folderCrudFetch(treeState());
    renderManage(handler, "/settings/shares/s1");

    fireEvent.click(
      await screen.findByRole("button", { name: /more actions for alpha clip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /move to folder…/i }));

    const dialog = await screen.findByRole("dialog", { name: /move "alpha clip"/i });
    // The item's current scope (root) is indicated and not pickable.
    expect(within(dialog).getByRole("button", { name: /share root/i })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Trip" }));

    await waitFor(() =>
      expect(handler.itemPatches).toEqual([{ videoId: "v1", folderId: "f-trip" }]),
    );
    // Refetched payload: Alpha now lives inside Trip — root loses it,
    // descending Trip finds it next to Beta.
    await waitFor(() =>
      expect(screen.queryByText("Alpha clip")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("link", { name: "Open folder Trip" }));
    expect(await screen.findByText("Alpha clip")).toBeInTheDocument();
    expect(screen.getByText("Beta clip")).toBeInTheDocument();
  });

  it("removing under an active search filter fires the same granular DELETE", async () => {
    // Filtering is render-only; the DELETE targets the item by id, so no
    // unfiltered-list computation exists to get wrong anymore.
    const state = {
      folders: [],
      items: [
        { ...MEMBERS[0], folder_id: null },
        { ...MEMBERS[1], folder_id: null },
        { ...GAMMA, folder_id: null },
      ],
    };
    const handler = folderCrudFetch(state);
    renderWithProviders(
      <Routes>
        <Route path="/settings/shares/:id" element={<ShareManagePage />} />
      </Routes>,
      { initialEntries: ["/settings/shares/s1"], fetchImplementation: handler },
    );

    // Filter down to Beta alone and remove it.
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
    await waitFor(() => expect(handler.itemDeletes).toEqual(["v2"]));

    // Clearing the filter shows the survivors.
    fireEvent.change(screen.getByLabelText(/search this share/i), {
      target: { value: "" },
    });
    expect(await screen.findByText("Alpha clip")).toBeInTheDocument();
    expect(screen.getByText("Gamma clip")).toBeInTheDocument();
  });

  // --- Search + add-only picker (task 005) --------------------------------

  it("filters the grid client-side as the owner types, and clears back to full order", async () => {
    const state = {
      folders: [],
      items: [
        { ...MEMBERS[0], folder_id: null },
        { ...MEMBERS[1], folder_id: null },
        { ...GAMMA, folder_id: null },
      ],
    };
    const handler = folderCrudFetch(state);
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
    const state = { folders: [], items: [{ ...MEMBERS[0], folder_id: null }, { ...MEMBERS[1], folder_id: null }] };
    const handler = folderCrudFetch(state);
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
    const state = { folders: [], items: [{ ...MEMBERS[0], folder_id: null }, { ...MEMBERS[1], folder_id: null }] };
    const handler = folderCrudFetch(state);
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

// ---------------- folder CRUD UI (share-folders task 007) ----------------

/** Tree fixture: Trip at root with Beta inside and subfolder Night
 * (Gamma inside); Alpha at root. */
function treeState() {
  return {
    folders: [
      { id: "f-trip", parent_id: null, name: "Trip", position: 0 },
      { id: "f-night", parent_id: "f-trip", name: "Night", position: 0 },
    ] as ShareFolderDto[],
    items: [
      { ...MEMBERS[0], folder_id: null },
      { ...MEMBERS[1], folder_id: "f-trip" },
      { ...GAMMA, folder_id: "f-night" },
    ],
  };
}

/** Stateful handler over the folder + item routes: GET serves the
 * wrapped payload; mutations record bodies and apply real semantics
 * (folder delete lifts items to root and flattens subfolders; item PUT
 * keeps survivors' placement and roots newcomers; last-item DELETE
 * answers 400) so refetched assertions see what the server would
 * serve. */
function folderCrudFetch(state: {
  folders: ShareFolderDto[];
  items: Array<VideoSummaryDto & { folder_id: string | null }>;
  failCreate?: string;
  failItemDelete?: boolean;
}) {
  let nextId = 0;
  const posts: Array<{ name: string; parent_id: string | null }> = [];
  const patches: Array<{ fid: string; body: { name?: string; parent_id?: string | null } }> = [];
  const deletes: string[] = [];
  const itemDeletes: string[] = [];
  const itemPatches: Array<{ videoId: string; folderId: string | null }> = [];
  const itemAppends: string[][] = [];
  const puts: string[][] = [];
  const handler = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/shares") return jsonResponse([ACTIVE]);
    if (url === "/api/shares/s1/items" && method === "GET")
      return jsonResponse({ folders: state.folders, items: state.items });
    if (url === "/api/shares/s1/items" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { video_ids: string[] };
      itemAppends.push(body.video_ids);
      for (const id of body.video_ids) {
        if (state.items.some((i) => i.id === id)) continue;
        const video = UNIVERSE.find((v) => v.id === id);
        if (video) state.items = [...state.items, { ...video, folder_id: null }];
      }
      return new Response(null, { status: 204 });
    }
    if (url === "/api/shares/s1/items" && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { video_ids: string[] };
      puts.push(body.video_ids);
      state.items = body.video_ids
        .map((id) => {
          const existing = state.items.find((i) => i.id === id);
          if (existing) return existing;
          const video = UNIVERSE.find((v) => v.id === id);
          return video ? { ...video, folder_id: null } : null;
        })
        .filter((i): i is VideoSummaryDto & { folder_id: string | null } => i !== null);
      return new Response(null, { status: 204 });
    }
    const item = url.match(/^\/api\/shares\/s1\/items\/([^/]+)$/);
    if (item && method === "DELETE") {
      const vid = item[1]!;
      if (state.failItemDelete) return jsonResponse({ message: "database exploded" }, 500);
      if (state.items.length <= 1) {
        return jsonResponse(
          { message: "cannot remove the last item — a share must contain at least 1 item" },
          400,
        );
      }
      itemDeletes.push(vid);
      state.items = state.items.filter((i) => i.id !== vid);
      return new Response(null, { status: 204 });
    }
    if (item && method === "PATCH") {
      const vid = item[1]!;
      const body = JSON.parse(String(init?.body ?? "{}")) as { folder_id: string | null };
      itemPatches.push({ videoId: vid, folderId: body.folder_id });
      state.items = state.items.map((i) =>
        i.id === vid ? { ...i, folder_id: body.folder_id } : i,
      );
      return new Response(null, { status: 204 });
    }
    if (url === "/api/shares/s1/folders" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        name: string;
        parent_id: string | null;
      };
      posts.push(body);
      if (state.failCreate)
        return jsonResponse({ message: state.failCreate }, 409);
      const folder: ShareFolderDto = {
        id: `f-new-${nextId++}`,
        parent_id: body.parent_id,
        name: body.name,
        position: state.folders.length,
      };
      state.folders = [...state.folders, folder];
      return jsonResponse(folder, 201);
    }
    const patch = url.match(/^\/api\/shares\/s1\/folders\/([^/]+)$/);
    if (patch && method === "PATCH") {
      const fid = patch[1]!;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        name?: string;
        parent_id?: string | null;
      };
      patches.push({ fid, body });
      state.folders = state.folders.map((f) =>
        f.id === fid
          ? {
              ...f,
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.parent_id !== undefined ? { parent_id: body.parent_id } : {}),
            }
          : f,
      );
      return jsonResponse(state.folders.find((f) => f.id === fid)!, 200);
    }
    if (patch && method === "DELETE") {
      const fid = patch[1]!;
      deletes.push(fid);
      state.folders = state.folders.map((f) =>
        f.parent_id === fid ? { ...f, parent_id: null } : f,
      );
      state.items = state.items.map((i) =>
        i.folder_id === fid ? { ...i, folder_id: null } : i,
      );
      state.folders = state.folders.filter((f) => f.id !== fid);
      return new Response(null, { status: 204 });
    }
    if (new URL(url, "http://localhost").pathname === "/api/videos") {
      const q = new URL(url, "http://localhost").searchParams.get("q") ?? "";
      const videos = UNIVERSE.filter((v) =>
        v.name.toLowerCase().includes(q.toLowerCase()),
      );
      return jsonResponse({ videos, total: videos.length, page: 1, limit: 200 });
    }
    return jsonError(404, `unmocked ${method} ${url}`);
  };
  return Object.assign(handler, {
    posts,
    patches,
    deletes,
    itemDeletes,
    itemPatches,
    itemAppends,
    puts,
  });
}

describe("ShareManagePage folder CRUD", () => {
  it("creates a folder in the current level from the toolbar and refetches", async () => {
    const handler = folderCrudFetch(treeState());
    renderManage(handler, "/settings/shares/s1");

    fireEvent.click(await screen.findByRole("button", { name: /new folder/i }));
    fireEvent.change(await screen.findByLabelText(/folder name/i), {
      target: { value: "Docs" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(handler.posts).toEqual([{ name: "Docs", parent_id: null }]));
    // The invalidation refetches the payload — the new tile appears.
    expect(await screen.findByRole("link", { name: "Open folder Docs" })).toBeInTheDocument();
  });

  it("surfaces the server's duplicate-name rejection inline in the dialog", async () => {
    const handler = folderCrudFetch({ ...treeState(), failCreate: "a sibling folder is already named Trip" });
    renderManage(handler, "/settings/shares/s1");

    fireEvent.click(await screen.findByRole("button", { name: /new folder/i }));
    fireEvent.change(await screen.findByLabelText(/folder name/i), {
      target: { value: "Trip" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/already named trip/i)).toBeInTheDocument();
    // Dialog stays open for a retry.
    expect(screen.getByLabelText(/folder name/i)).toBeInTheDocument();
  });

  it("renames a folder from its kebab menu", async () => {
    const handler = folderCrudFetch(treeState());
    renderManage(handler, "/settings/shares/s1");

    fireEvent.click(
      await screen.findByRole("button", { name: /more actions for trip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    const input = await screen.findByLabelText(/folder name/i);
    expect(input).toHaveValue("Trip");
    fireEvent.change(input, { target: { value: "Travels" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(handler.patches).toEqual([
        { fid: "f-trip", body: { name: "Travels" } },
      ]),
    );
    expect(await screen.findByRole("link", { name: "Open folder Travels" })).toBeInTheDocument();
  });

  it("moves a folder via the picker, which excludes its own subtree", async () => {
    // A second root folder (Docs) gives the move a distinct target.
    const state = {
      ...treeState(),
      folders: [
        ...treeState().folders,
        { id: "f-docs", parent_id: null, name: "Docs", position: 1 },
      ],
    };
    const handler = folderCrudFetch(state);
    renderManage(handler, "/settings/shares/s1");

    fireEvent.click(
      await screen.findByRole("button", { name: /more actions for trip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /^move$/i }));

    const dialog = await screen.findByRole("dialog", { name: /move "trip"/i });
    // Own subtree unpickable: Trip and Night are absent.
    expect(within(dialog).queryByRole("button", { name: "Trip" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Night" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Docs" }));

    await waitFor(() =>
      expect(handler.patches).toEqual([
        { fid: "f-trip", body: { parent_id: "f-docs" } },
      ]),
    );
  });

  it("deletes a folder after the contents-to-root confirmation; the level lifts", async () => {
    const state = treeState();
    const handler = folderCrudFetch(state);
    renderManage(handler, "/settings/shares/s1");

    fireEvent.click(
      await screen.findByRole("button", { name: /more actions for trip/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }));

    // The confirmation names the consequence before anything is sent.
    const dialog = await screen.findByRole("dialog", { name: /delete "trip"/i });
    expect(within(dialog).getByText(/move to the top level/i)).toBeInTheDocument();
    expect(handler.deletes).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(handler.deletes).toEqual(["f-trip"]));
    // Refetched payload: Trip is gone, Beta lifted to root, Night
    // flattened to root (Gamma still inside it).
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /open folder trip/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Beta clip")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open folder Night" })).toBeInTheDocument();
  });

  it("terminal shares hide the toolbar action and folder menus", async () => {
    const state = treeState();
    const handler = (input: RequestInfo | URL, init?: RequestInit): Response => {
      const url = String(input);
      if (url === "/api/shares") return jsonResponse([REVOKED]);
      if (url === "/api/shares/s1/items" && (init?.method ?? "GET").toUpperCase() === "GET")
        return jsonResponse({ folders: state.folders, items: state.items });
      return folderCrudFetch(state)(input, init);
    };
    renderManage(handler, "/settings/shares/s1");

    // Root level: Alpha + the Trip tile; no editing affordances.
    expect(await screen.findByText("Alpha clip")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open folder Trip" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new folder/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /more actions for trip/i }),
    ).not.toBeInTheDocument();
  });
});
