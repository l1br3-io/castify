// Share landing page tests (docs/specs/sharing task 009).
//
// Covers the page's state machine end to end through the fetch boundary:
//   resolve → (locked? gate → unlock → items : items) → grid
// plus the terminal 410/404 variants and the request-budget guarantee
// (spec criterion 8: resolve/unlock/items are the only JSON requests a
// cold visit can generate).

import { describe, expect, it, type Mock } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { SharePage } from "./share";
import {
  jsonError,
  jsonResponse,
  renderWithProviders,
  type FetchHandler,
} from "../test/utils";
import type { VideoSummaryDto } from "../api/types";

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

function renderSharePage(api: ShareApi) {
  return renderWithProviders(
    <Routes>
      <Route path="/share/:token" element={<SharePage />} />
    </Routes>,
    {
      initialEntries: [`/share/${TOKEN}`],
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
        jsonResponse([shareVideo("vA", "Video A"), shareVideo("vB", "Video B")]),
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
      await screen.findByText("Too many attempts. Please try again in a minute."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
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
      items: () => jsonResponse([shareVideo("vA", "Video A")]),
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
