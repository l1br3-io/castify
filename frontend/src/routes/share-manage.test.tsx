// Share manage page tests (share-manage-page task 003).
//
// Owner-facing detail route `/settings/shares/:id`. The page composes two
// reads: share meta from the shares list query (find by id — there is no
// single-share endpoint, and the list is already cached from Settings) and
// members from the owned-items route. These tests pin the state machine:
// render order, unknown-id not-found, terminal read-only, and members
// error retry. Removal/undo arrive in task 004 and extend this file.

import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { ShareManagePage } from "./share-manage";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";
import type { ShareDto } from "../api/shares";
import type { VideoSummaryDto } from "../api/types";

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
        : jsonResponse(MEMBERS);
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

    // Back to the shares section of Settings.
    expect(
      screen.getByRole("link", { name: /back to shares/i }),
    ).toHaveAttribute("href", "/settings");
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
              : jsonResponse(MEMBERS);
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
});
