// Collections index page (collections-page task 002): `/collections`
// renders every collection as a CollectionCard grid off
// `GET /api/collections`, with loading / error / truly-empty states and
// a header row carrying the total count as a mono figure. The sr-only
// h1 keeps the a11y tree honest while the header row is the visible
// identity (browse-page precedent).

import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { CollectionsPage } from "./collections";
import type { CollectionDto } from "../api/types";
import { jsonError, jsonResponse, renderWithProviders } from "../test/utils";

function collection(over: Partial<CollectionDto> = {}): CollectionDto {
  return {
    id: "c1",
    name: "Breaking Bad",
    kind: "show",
    created_at: "2026-09-01T00:00:00Z",
    member_count: 5,
    preview: [],
    ...over,
  };
}

function pageRoutes() {
  return (
    <Routes>
      <Route path="/collections" element={<CollectionsPage />} />
      <Route
        path="/collections/:id"
        element={<div data-testid="detail">detail</div>}
      />
      <Route
        path="/connections"
        element={<div data-testid="connections">connections</div>}
      />
    </Routes>
  );
}

describe("CollectionsPage", () => {
  it("renders the grid of collection cards from GET /api/collections", async () => {
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: () =>
        jsonResponse([
          collection(),
          collection({ id: "c2", name: "June 2026", kind: "time" }),
        ]),
    });

    expect(await screen.findByText("Breaking Bad")).toBeInTheDocument();
    expect(screen.getByText("June 2026")).toBeInTheDocument();
    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(urls).toContain("/api/collections");
  });

  it("uses the browse grid's responsive column breakpoints", async () => {
    const { container } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: () => jsonResponse([collection()]),
    });

    await screen.findByText("Breaking Bad");
    const grid = container.querySelector(".grid");
    expect(grid).not.toBeNull();
    expect(grid!.className).toContain("grid-cols-2");
    expect(grid!.className).toContain("xl:grid-cols-6");
  });

  it("carries an sr-only h1 and the total count as a mono figure", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: () =>
        jsonResponse([collection(), collection({ id: "c2" })]),
    });

    // sr-only page heading — the a11y identity of the route.
    expect(
      screen.getByRole("heading", { level: 1, name: "Collections" }),
    ).toBeInTheDocument();

    const count = await screen.findByText("· 2");
    expect(count).toHaveClass("figure");
  });

  it("navigates to the detail page when a card is clicked", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: () => jsonResponse([collection()]),
    });

    fireEvent.click(
      await screen.findByRole("link", { name: "Open collection Breaking Bad" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("detail")).toBeInTheDocument();
    });
  });

  it("renders a skeleton grid while the query loads", async () => {
    const { container } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      // Never resolves — the page must hold its skeleton.
      fetchImplementation: () => new Promise(() => {}),
    });

    // The loading state is skeleton cards (aria-hidden pulse blocks),
    // not an error or empty state.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("surfaces an error state with retry when the query fails", async () => {
    let calls = 0;
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: () => {
        calls += 1;
        return calls === 1
          ? jsonError(500, "boom")
          : jsonResponse([collection()]);
      },
    });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(fetchSpy.mock.calls.filter(([url]) => String(url) === "/api/collections").length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Breaking Bad")).toBeInTheDocument();
    expect(fetchSpy.mock.calls.filter(([url]) => String(url) === "/api/collections").length).toBe(2);
  });

  it("truly-empty state points at scans and review", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: () => jsonResponse([]),
    });

    expect(
      await screen.findByText("No collections yet"),
    ).toBeInTheDocument();
    // The note explains where collections come from…
    expect(
      screen.getByText(/scan/i),
    ).toBeInTheDocument();

    // …and the CTA starts the path to a first scan.
    fireEvent.click(screen.getByRole("button", { name: "Connect a source" }));
    await waitFor(() => {
      expect(screen.getByTestId("connections")).toBeInTheDocument();
    });
  });

  // --- task 003: kind filter chips + sort ---

  function cardNames(container: HTMLElement): (string | null)[] {
    return Array.from(container.querySelectorAll("h3")).map(
      (h) => h.textContent,
    );
  }

  const FILTERABLE = [
    collection({ id: "c1", name: "Breaking Bad", kind: "show", member_count: 5, created_at: "2026-09-01T00:00:00Z" }),
    collection({ id: "c2", name: "Alpha Movie", kind: "movie", member_count: 2, created_at: "2026-08-01T00:00:00Z" }),
    collection({ id: "c3", name: "June 2026", kind: "time", member_count: 9, created_at: "2026-07-01T00:00:00Z" }),
  ];

  it("kind chips filter the grid client-side without a refetch", async () => {
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: () => jsonResponse(FILTERABLE),
    });

    expect(await screen.findByText("Breaking Bad")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Movies" }));

    expect(await screen.findByText("Alpha Movie")).toBeInTheDocument();
    expect(screen.queryByText("Breaking Bad")).not.toBeInTheDocument();
    expect(
      fetchSpy.mock.calls.filter(([url]) => String(url) === "/api/collections")
        .length,
    ).toBe(1);
  });

  it("deep-links ?kind= and marks the matching chip active", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections?kind=movie"],
      fetchImplementation: () => jsonResponse(FILTERABLE),
    });

    expect(await screen.findByText("Alpha Movie")).toBeInTheDocument();
    expect(screen.queryByText("Breaking Bad")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Movies" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("falls back to All for unknown ?kind= values", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections?kind=bogus"],
      fetchImplementation: () => jsonResponse(FILTERABLE),
    });

    expect(await screen.findByText("Breaking Bad")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("sorts newest-first by default and re-orders without a refetch", async () => {
    const { container, fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: () => jsonResponse(FILTERABLE),
    });

    await screen.findByText("Breaking Bad");
    // Default: newest by created_at desc.
    expect(cardNames(container)).toEqual([
      "Breaking Bad",
      "Alpha Movie",
      "June 2026",
    ]);

    // Name A–Z.
    fireEvent.change(screen.getByLabelText("Sort collections"), {
      target: { value: "name" },
    });
    expect(cardNames(container)).toEqual([
      "Alpha Movie",
      "Breaking Bad",
      "June 2026",
    ]);

    // Largest by member count desc.
    fireEvent.change(screen.getByLabelText("Sort collections"), {
      target: { value: "largest" },
    });
    expect(cardNames(container)).toEqual([
      "June 2026",
      "Breaking Bad",
      "Alpha Movie",
    ]);

    expect(
      fetchSpy.mock.calls.filter(([url]) => String(url) === "/api/collections")
        .length,
    ).toBe(1);
  });

  it("filtered-empty state names the kind and offers a clear action", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: () =>
        jsonResponse([collection({ kind: "show", name: "Breaking Bad" })]),
    });

    expect(await screen.findByText("Breaking Bad")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Movies" }));

    expect(
      await screen.findByText("No collections of this kind"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show all kinds" }));
    expect(await screen.findByText("Breaking Bad")).toBeInTheDocument();
  });

  it("chip row wraps instead of overflowing horizontally", async () => {
    const { container } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: () => jsonResponse(FILTERABLE),
    });

    await screen.findByText("Breaking Bad");
    const chipRow = screen
      .getByRole("group", { name: "Filter by kind" })
      .closest("div");
    expect(chipRow).not.toBeNull();
    expect(chipRow!.className).toContain("flex-wrap");
    expect(container.querySelector(".grid")).not.toBeNull();
  });
});
