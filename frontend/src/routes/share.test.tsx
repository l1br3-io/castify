// Share landing page tests (sharing task 009).
//
// Covers the page's state machine end to end through the fetch boundary:
//   resolve → (locked? gate → unlock → items : items) → grid
// plus the terminal 410/404 variants and the request-budget guarantee
// (spec criterion 8: resolve/unlock/items are the only JSON requests a
// cold visit can generate).

import { describe, expect, it, type Mock } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";

import { SharePage } from "./share";
import {
  jsonError,
  jsonResponse,
  renderWithProviders,
  type FetchHandler,
} from "../test/utils";
import type { ShareFolderDto, VideoSummaryDto } from "../api/types";
import type { ShareResolveDto } from "../api/shares";

const TOKEN = "tok_abc123";

function shareVideo(id: string, name: string): VideoSummaryDto {
  return {
    id,
    name,
    provider: "google_drive",
    size_bytes: 1_048_576,
    mime_type: "video/mp4",
    duration_ms: 60_000,
    width: 1920,
    height: 1080,
    sources: [],
    created_at: "2024-05-01T00:00:00Z",
    path: null,
    is_favorite: false,
    my_rating: null,
    thumbnail_status: "pending",
    position_seconds: null,
    completed: false,
  };
}

function treeFolder(id: string, name: string, parentId: string | null): ShareFolderDto {
  return { id, parent_id: parentId, name, position: 0 };
}

// Wrapped items payload (share-folders task 004 shape): folder list plus
// per-item placement. Defaults to the flat degenerate case.
function treePayload(
  videos: Array<{ id: string; name: string; folderId?: string }>,
  folders: ShareFolderDto[] = [],
): ReturnType<typeof jsonResponse> {
  return jsonResponse({
    folders,
    items: videos.map((v) => ({
      ...shareVideo(v.id, v.name),
      folder_id: v.folderId ?? null,
    })),
  });
}

interface ShareApi {
  resolve: () => Response;
  items?: () => Response;
  unlock?: () => Response;
}

function shareHandler(api: ShareApi): FetchHandler {
  return (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === `/api/share/${TOKEN}` && method === "GET")
      return api.resolve();
    if (url === `/api/share/${TOKEN}/items` && method === "GET")
      return api.items ? api.items() : jsonError(500, "no items mock");
    if (url === `/api/share/${TOKEN}/unlock` && method === "POST")
      return api.unlock ? api.unlock() : jsonError(500, "no unlock mock");
    return jsonError(404, `unmocked ${method} ${url}`);
  };
}

// Mirrors location.search into the DOM so tests can assert URL writes
// (the debounced `?q=`) inside the MemoryRouter.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.search}</div>;
}

function renderSharePage(api: ShareApi, initialPath = `/share/${TOKEN}`) {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/share/:token" element={<SharePage />} />
      </Routes>
      <LocationProbe />
    </>,
    {
      initialEntries: [initialPath],
      fetchImplementation: shareHandler(api),
    },
  );
}

function callsTo(fetchSpy: Mock<FetchHandler>, url: string): number {
  return fetchSpy.mock.calls.filter(([u]) => String(u) === url).length;
}

const RESOLVE_URL = `/api/share/${TOKEN}`;
const ITEMS_URL = `/api/share/${TOKEN}/items`;
const UNLOCK_URL = `/api/share/${TOKEN}/unlock`;

describe("SharePage", () => {
  it("renders the password gate for a locked share without fetching items or unlocking", async () => {
    const { fetchSpy } = renderSharePage({
      resolve: () =>
        jsonResponse({
          title: "Trip footage",
          item_count: 2,
          locked: true,
          status: "active",
        }),
    });

    expect(await screen.findByRole("heading", { name: "Trip footage" })).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /unlock/i })).toBeInTheDocument();

    // Locked: items stay unfetched and unlock only fires on submit.
    await waitFor(() => expect(callsTo(fetchSpy, RESOLVE_URL)).toBe(1));
    expect(callsTo(fetchSpy, ITEMS_URL)).toBe(0);
    expect(callsTo(fetchSpy, UNLOCK_URL)).toBe(0);
  });

  it("brands the page as a shared link, distinct from the owner shell", async () => {
    const { fetchSpy } = renderSharePage({
      resolve: () =>
        jsonResponse({ title: "Trip footage", locked: false }),
      items: () => treePayload([]),
    });

    await screen.findByRole("heading", { name: "Trip footage" });
    // FR-5.4: the "shared link" chip brands the surface; no owner sidebar.
    expect(screen.getByText("Shared link")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    // Empty share renders the EmptyState.
    expect(
      await screen.findByText("Nothing in this share."),
    ).toBeInTheDocument();
    await waitFor(() => expect(callsTo(fetchSpy, ITEMS_URL)).toBe(1));
  });

  it("unlocks and renders items in share order with share watch links", async () => {
    const { fetchSpy } = renderSharePage({
      resolve: () =>
        jsonResponse({
          title: "Trip footage",
          item_count: 2,
          locked: true,
          status: "active",
        }),
      unlock: () => new Response(null, { status: 204 }),
      items: () =>
        treePayload([
          { id: "vA", name: "Video A" },
          { id: "vB", name: "Video B" },
        ]),
    });

    fireEvent.change(await screen.findByLabelText("Password"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    // Both cards appear, and in the owner's curation order.
    const cardA = await screen.findByRole("link", { name: "Play Video A" });
    const cardB = screen.getByRole("link", { name: "Play Video B" });
    expect(cardA.getAttribute("href")).toBe(`/share/${TOKEN}/watch/vA`);
    expect(cardB.getAttribute("href")).toBe(`/share/${TOKEN}/watch/vB`);
    expect(cardA.compareDocumentPosition(cardB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Request budget: resolve + items + unlock, nothing else.
    await waitFor(() => expect(callsTo(fetchSpy, ITEMS_URL)).toBe(1));
    expect(callsTo(fetchSpy, RESOLVE_URL)).toBe(1);
    expect(callsTo(fetchSpy, UNLOCK_URL)).toBe(1);
  });

  it("shows an inline error and stays on the gate after a wrong password", async () => {
    const { fetchSpy } = renderSharePage({
      resolve: () =>
        jsonResponse({
          title: "Trip footage",
          item_count: 1,
          locked: true,
          status: "active",
        }),
      unlock: () => jsonError(401, "invalid password"),
    });

    fireEvent.change(await screen.findByLabelText("Password"), {
      target: { value: "wrong pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    expect(await screen.findByText("Wrong password. Try again.")).toBeInTheDocument();
    // Still on the form — no navigation, no items fetch.
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(callsTo(fetchSpy, ITEMS_URL)).toBe(0);
  });

  it("renders a try-later state when unlock is rate-limited", async () => {
    renderSharePage({
      resolve: () =>
        jsonResponse({
          title: "Trip footage",
          item_count: 1,
          locked: true,
          status: "active",
        }),
      unlock: () => jsonError(429, "rate limited"),
    });

    fireEvent.change(await screen.findByLabelText("Password"), {
      target: { value: "some guess" },
    });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    expect(
      await screen.findByText("Too many attempts. Please try again in about 15 minutes."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("shows an inline error when unlock fails without a status (network/5xx)", async () => {
    const { fetchSpy } = renderSharePage({
      resolve: () =>
        jsonResponse({
          title: "Trip footage",
          item_count: 1,
          locked: true,
          status: "active",
        }),
      unlock: () => jsonError(500, "database exploded"),
    });

    fireEvent.change(await screen.findByLabelText("Password"), {
      target: { value: "correct horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    // Any non-401/429 failure surfaces inline — never a silent dead button.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(callsTo(fetchSpy, ITEMS_URL)).toBe(0);
  });

  it("flips the cached resolve to unlocked on success, so a remount skips the gate", async () => {
    // The app's query client keeps resolve cached between mounts (gcTime
    // 5min, staleTime Infinity). The gate must not reappear after
    // unlock → watch → back while the unlock cookie is still valid, so
    // the unlock handler owns flipping the cached `locked` flag.
    const { fetchSpy, queryClient } = renderSharePage({
      resolve: () =>
        jsonResponse({
          title: "Trip footage",
          item_count: 1,
          locked: true,
          status: "active",
        }),
      unlock: () => new Response(null, { status: 204 }),
      items: () => treePayload([{ id: "vA", name: "Video A" }]),
    });

    fireEvent.change(await screen.findByLabelText("Password"), {
      target: { value: "correct horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    await screen.findByRole("link", { name: "Play Video A" });

    const cached = queryClient.getQueryData<ShareResolveDto>(["share", TOKEN, "resolve"]);
    expect(cached?.locked).toBe(false);

    // And the flip cost nothing extra: still one resolve, one unlock.
    expect(callsTo(fetchSpy, RESOLVE_URL)).toBe(1);
    expect(callsTo(fetchSpy, UNLOCK_URL)).toBe(1);
  });

  it("renders a sticky terminal state without a retry loop on 410", async () => {
    const { fetchSpy } = renderSharePage({
      resolve: () => jsonError(410, "share expired"),
    });

    expect(
      await screen.findByText("This share is no longer available."),
    ).toBeInTheDocument();
    // No retry affordance — a dead share stays dead.
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();

    // Sticky: exactly one resolve call, and none follow.
    await waitFor(() => expect(callsTo(fetchSpy, RESOLVE_URL)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callsTo(fetchSpy, RESOLVE_URL)).toBe(1);
    expect(callsTo(fetchSpy, ITEMS_URL)).toBe(0);
  });

  it("renders the not-found variant for an unknown token (404)", async () => {
    renderSharePage({
      resolve: () => jsonError(404, "unknown share"),
    });

    expect(await screen.findByText("This share doesn't exist.")).toBeInTheDocument();
    // Not-found is its own variant, distinct from the 410 terminal copy.
    expect(screen.queryByText("This share is no longer available.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("renders the grid directly for an unlocked share with no gate", async () => {
    const { fetchSpy } = renderSharePage({
      resolve: () =>
        jsonResponse({
          title: "Trip footage",
          item_count: 1,
          locked: false,
          status: "active",
        }),
      items: () => treePayload([{ id: "vA", name: "Video A" }]),
    });

    expect(await screen.findByRole("link", { name: "Play Video A" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    // Cold-visit budget for a passwordless share: resolve + items, nothing else.
    await waitFor(() => expect(callsTo(fetchSpy, ITEMS_URL)).toBe(1));
    expect(callsTo(fetchSpy, RESOLVE_URL)).toBe(1);
    expect(callsTo(fetchSpy, UNLOCK_URL)).toBe(0);
    const requestedUrls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(requestedUrls.every((u) => u.startsWith(`/api/share/${TOKEN}`))).toBe(true);
  });
});

// -------------------- folder browse (share-folders task 005) --------------------
//
// One items fetch covers the whole tree: descending is `?folder=` client
// state, so every navigation below must leave the request count alone.

function treeApi(): ShareApi {
  return {
    resolve: () =>
      jsonResponse({
        title: "Trip footage",
        item_count: 3,
        locked: false,
        status: "active",
      }),
    items: () =>
      treePayload(
        [
          { id: "vA", name: "Video A" },
          { id: "vC", name: "Video C", folderId: "trip" },
          { id: "vD", name: "Video D", folderId: "night" },
        ],
        [treeFolder("trip", "Trip", null), treeFolder("night", "Night", "trip")],
      ),
  };
}

describe("SharePage folder browse", () => {
  it("renders folder tiles before the level's videos, then descends without fetching", async () => {
    const { fetchSpy } = renderSharePage(treeApi());

    const tripTile = await screen.findByRole("link", { name: "Open folder Trip" });
    const videoA = screen.getByRole("link", { name: "Play Video A" });
    // Folders first, videos after — the level's deterministic order.
    expect(
      tripTile.compareDocumentPosition(videoA) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Folder contents are not rendered at the root level.
    expect(screen.queryByRole("link", { name: "Play Video C" })).not.toBeInTheDocument();

    fireEvent.click(tripTile);

    // Inside Trip: the nested Night tile + Trip's videos.
    expect(await screen.findByRole("link", { name: "Open folder Night" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Play Video C" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Play Video A" })).not.toBeInTheDocument();

    // Descent is client state — the items fetch count never moves.
    await waitFor(() => expect(callsTo(fetchSpy, ITEMS_URL)).toBe(1));
  });

  it("descends deeper and climbs back via breadcrumbs", async () => {
    renderSharePage(treeApi());

    fireEvent.click(await screen.findByRole("link", { name: "Open folder Trip" }));
    fireEvent.click(await screen.findByRole("link", { name: "Open folder Night" }));

    // The chain renders: root crumb (share title) / Trip / Night (current).
    expect(await screen.findByRole("link", { name: "Play Video D" })).toBeInTheDocument();
    const rootCrumb = screen.getByRole("link", { name: "Trip footage" });
    const tripCrumb = screen.getByRole("link", { name: "Trip" });
    expect(
      rootCrumb.compareDocumentPosition(tripCrumb) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // One hop up: back inside Trip (its videos, Night as a tile again).
    fireEvent.click(tripCrumb);
    expect(await screen.findByRole("link", { name: "Play Video C" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open folder Night" })).toBeInTheDocument();

    // All the way up via the root crumb.
    fireEvent.click(screen.getByRole("link", { name: "Trip footage" }));
    expect(await screen.findByRole("link", { name: "Play Video A" })).toBeInTheDocument();
  });

  it("restores a deep-linked folder level on first render", async () => {
    renderSharePage(treeApi(), `/share/${TOKEN}?folder=night`);

    expect(await screen.findByRole("link", { name: "Play Video D" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trip" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Play Video A" })).not.toBeInTheDocument();
  });

  it("falls back to the root level for a stale folder id, silently", async () => {
    renderSharePage(treeApi(), `/share/${TOKEN}?folder=deleted-long-ago`);

    expect(await screen.findByRole("link", { name: "Play Video A" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open folder Trip" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the empty state inside a folder with no children", async () => {
    const empty: ShareApi = {
      resolve: () =>
        jsonResponse({ title: "Trip footage", item_count: 1, locked: false, status: "active" }),
      items: () =>
        treePayload(
          [{ id: "vA", name: "Video A" }],
          [treeFolder("hollow", "Hollow", null)],
        ),
    };
    renderSharePage(empty);

    fireEvent.click(await screen.findByRole("link", { name: "Open folder Hollow" }));
    expect(await screen.findByText("This folder is empty.")).toBeInTheDocument();
  });

  it("renders a flat share with no folder affordances at all", async () => {
    renderSharePage({
      resolve: () =>
        jsonResponse({ title: "Trip footage", item_count: 1, locked: false, status: "active" }),
      items: () => treePayload([{ id: "vA", name: "Video A" }]),
    });

    expect(await screen.findByRole("link", { name: "Play Video A" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open folder/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Folders" })).not.toBeInTheDocument();
  });
});

// -------------------- recipient search (share-search-ux task 003) --------------------
//
// Search spans the whole share from the already-fetched tree: typing
// writes a debounced `?q=`, the grid swaps to flat results with
// folder-path labels, and none of it may cost another fetch.

function searchApi(): ShareApi {
  return {
    resolve: () =>
      jsonResponse({
        title: "Trip footage",
        item_count: 4,
        locked: false,
        status: "active",
      }),
    items: () =>
      treePayload(
        [
          { id: "vA", name: "Aurora Intro" },
          { id: "vG", name: "Goodnight Munich" },
          { id: "vT", name: "Sunset Drive", folderId: "trip" },
          { id: "vN", name: "Northern Aurora", folderId: "night" },
        ],
        [treeFolder("trip", "Trip", null), treeFolder("night", "Night", "trip")],
      ),
  };
}

describe("SharePage search", () => {
  it("shows no search field on the password gate", async () => {
    renderSharePage({
      resolve: () =>
        jsonResponse({ title: "Trip footage", item_count: 1, locked: true, status: "active" }),
    });

    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByLabelText("Search this share")).not.toBeInTheDocument();
  });

  it("updates the input immediately, then filters across folders after the debounce", async () => {
    const { fetchSpy } = renderSharePage(searchApi());

    const input = (await screen.findByLabelText("Search this share")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "aurora" } });

    // Raw input is instant — no debounce on what the user typed.
    expect(input.value).toBe("aurora");

    // URL takes the debounced write (real 300ms timer).
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("q=aurora"),
    );

    // Whole-share results: root video + one nested two folders deep,
    // the latter labeled with its folder path. Browse chrome is gone.
    expect(screen.getByRole("link", { name: "Play Aurora Intro" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Play Northern Aurora" })).toBeInTheDocument();
    expect(screen.getByText("Trip / Night")).toBeInTheDocument();
    expect(screen.getByText(/2 results for “aurora”/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Folders" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open folder Trip" })).not.toBeInTheDocument();

    // Search is client-side filtering — the tree was fetched once.
    await waitFor(() => expect(callsTo(fetchSpy, ITEMS_URL)).toBe(1));
  });

  it("renders results on first load from a ?q= deep link", async () => {
    const { fetchSpy } = renderSharePage(searchApi(), `/share/${TOKEN}?q=aurora`);

    expect(await screen.findByText(/2 results for “aurora”/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Play Northern Aurora" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open folder Trip" })).not.toBeInTheDocument();

    await waitFor(() => expect(callsTo(fetchSpy, ITEMS_URL)).toBe(1));
  });

  it("renders matching folders as tiles that enter the folder and clear the query", async () => {
    renderSharePage(searchApi());

    fireEvent.change(await screen.findByLabelText("Search this share"), {
      target: { value: "night" },
    });

    const results = await screen.findByRole("region", { name: /Search results/ });
    // Both kinds at once: the Night folder tile and the root video hit.
    const nightTile = within(results).getByRole("link", { name: "Open folder Night" });
    expect(within(results).getByRole("link", { name: "Play Goodnight Munich" })).toBeInTheDocument();

    fireEvent.click(nightTile);

    // OQ2 default: the tile browse-into the folder with the query gone.
    expect(await screen.findByRole("navigation", { name: "Folders" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Play Northern Aurora" })).toBeInTheDocument();
    expect(screen.queryByText(/results for/)).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("folder=night");
    expect(screen.getByTestId("location")).not.toHaveTextContent("q=");
    const input = screen.getByLabelText("Search this share") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("clears from the empty state back to the folder the user was in", async () => {
    renderSharePage(searchApi());

    // Descend into Trip first — the cleared search must land back here.
    fireEvent.click(await screen.findByRole("link", { name: "Open folder Trip" }));
    expect(await screen.findByRole("link", { name: "Play Sunset Drive" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search this share"), {
      target: { value: "zzz" },
    });

    const results = await screen.findByRole("region", { name: /Search results/ });
    expect(within(results).getByText(/No results for “zzz”/)).toBeInTheDocument();
    fireEvent.click(within(results).getByRole("button", { name: "Clear search" }));

    // Back in Trip: same folder level, query gone from URL and input.
    expect(await screen.findByRole("link", { name: "Play Sunset Drive" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("folder=trip");
    expect(screen.getByTestId("location")).not.toHaveTextContent("q=");
    expect((screen.getByLabelText("Search this share") as HTMLInputElement).value).toBe("");
  });
});
