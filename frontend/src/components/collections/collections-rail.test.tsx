// Collections rail (library-collections task 008): renders only when the
// user has ≥1 collection; cards carry name, kind label, member count,
// and link into the detail view. Self-fetching — a failed/empty query
// renders nothing so the browse layout stays quiet.

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { CollectionsRail } from "./collections-rail";
import type { CollectionDto } from "../../api/types";
import { jsonResponse, renderWithProviders } from "../../test/utils";

function collection(over: Partial<CollectionDto> = {}): CollectionDto {
  return {
    id: "c1",
    name: "Breaking Bad",
    kind: "show",
    created_at: "2026-09-19T00:00:00Z",
    member_count: 5,
    preview: [],
    ...over,
  };
}

describe("CollectionsRail", () => {
  it("renders nothing when there are no collections", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/" element={<CollectionsRail />} />
      </Routes>,
      { fetchImplementation: () => jsonResponse([]) },
    );

    // Let the empty-list query settle — waitFor keeps the resolution's
    // state updates inside act(); the rail must stay absent.
    await waitFor(() =>
      expect(screen.queryByText("Collections")).not.toBeInTheDocument(),
    );
  });

  it("shows a card per collection with kind label, count, and detail link", async () => {
    const { fetchSpy } = renderWithProviders(
      <Routes>
        <Route path="/" element={<CollectionsRail />} />
        <Route path="/collections/:id" element={<div>detail</div>} />
      </Routes>,
      {
        fetchImplementation: () =>
          jsonResponse([
            collection(),
            collection({
              id: "c2",
              name: "June 2026",
              kind: "time",
              member_count: 12,
            }),
          ]),
      },
    );

    expect(await screen.findByRole("heading", { name: /collections/i }));
    expect(screen.getByText("Breaking Bad")).toBeInTheDocument();
    expect(screen.getByText(/Series · 5 videos/)).toBeInTheDocument();
    expect(screen.getByText("June 2026")).toBeInTheDocument();
    expect(screen.getByText(/Time group · 12 videos/)).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /breaking bad/i });
    expect(link).toHaveAttribute("href", "/collections/c1");
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toContain(
      "/api/collections",
    );
  });

  it("links View all to the /collections index page", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/" element={<CollectionsRail />} />
        <Route path="/collections" element={<div>index</div>} />
      </Routes>,
      {
        fetchImplementation: () => jsonResponse([collection()]),
      },
    );

    expect(await screen.findByText("Breaking Bad"));
    const viewAll = screen.getByRole("link", { name: "View all" });
    expect(viewAll).toHaveAttribute("href", "/collections");
  });

  it("renders nothing while the query fails", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/" element={<CollectionsRail />} />
      </Routes>,
      { fetchImplementation: () => jsonResponse({ message: "boom" }, 500) },
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Collections")).not.toBeInTheDocument();
  });
});
