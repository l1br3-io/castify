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

  // --- task 004: rename from the grid ---

  function patchUrls(fetchSpy: { mock: { calls: unknown[][] } }): string[] {
    return fetchSpy.mock.calls
      .filter(([url, init]) => String(url) === "/api/collections/c1" && (init as RequestInit | undefined)?.method === "PATCH")
      .map(([url]) => String(url));
  }

  function collectionApi(
    list: CollectionDto[],
    patchStatus: number = 200,
  ) {
    // Stateful like the real backend: a successful PATCH persists, so
    // the post-settle invalidation refetch returns the renamed row (the
    // optimistic patch must not flicker back).
    let current = list;
    return (input: RequestInfo | URL, init?: RequestInit): Response => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/collections") return jsonResponse(current);
      if (url === "/api/collections/c1" && method === "PATCH") {
        if (patchStatus === 200) {
          current = current.map((c) =>
            c.id === "c1" ? { ...c, name: "Better Call Saul" } : c,
          );
          return jsonResponse({
            id: "c1",
            name: "Better Call Saul",
            kind: "show",
            created_at: "2026-09-01T00:00:00Z",
          });
        }
        return jsonError(500, "boom");
      }
      return jsonError(404, "unmocked");
    };
  }

  async function openRenameDialog(): Promise<void> {
    fireEvent.click(
      await screen.findByRole("button", { name: "Actions for Breaking Bad" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    await screen.findByRole("dialog", { name: "Rename collection" });
  }

  it("kebab opens a menu with Rename; the card link still works", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: collectionApi([collection()]),
    });

    await screen.findByText("Breaking Bad");
    // The card link coexists with the closed menu.
    expect(
      screen.getByRole("link", { name: "Open collection Breaking Bad" }),
    ).toHaveAttribute("href", "/collections/c1");

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Breaking Bad" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).toBeInTheDocument();
  });

  it("rename dialog prefills and skips the PATCH for empty or unchanged names", async () => {
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: collectionApi([collection()]),
    });

    await openRenameDialog();
    const input = screen.getByLabelText("Collection name");
    expect(input).toHaveValue("Breaking Bad");

    // Unchanged name — Save treats it as a cancel.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.queryByRole("dialog", { name: "Rename collection" }),
    ).not.toBeInTheDocument();
    expect(patchUrls(fetchSpy)).toHaveLength(0);

    // Empty name — same.
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Breaking Bad" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input2 = await screen.findByLabelText("Collection name");
    fireEvent.change(input2, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(patchUrls(fetchSpy)).toHaveLength(0);
  });

  it("renames the card in place optimistically on save (Enter submits)", async () => {
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: collectionApi([collection()]),
    });

    await openRenameDialog();
    fireEvent.change(screen.getByLabelText("Collection name"), {
      target: { value: "Better Call Saul" },
    });
    fireEvent.keyDown(screen.getByLabelText("Collection name"), {
      key: "Enter",
    });

    // Optimistic: the card shows the new name immediately.
    expect(await screen.findByText("Better Call Saul")).toBeInTheDocument();
    expect(screen.queryByText("Breaking Bad")).not.toBeInTheDocument();
    expect(patchUrls(fetchSpy)).toHaveLength(1);
  });

  it("rolls the card back and toasts when the rename fails", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: collectionApi([collection()], 500),
    });

    await openRenameDialog();
    fireEvent.change(screen.getByLabelText("Collection name"), {
      target: { value: "Better Call Saul" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Rolled back to the original name, error toast announced.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(await screen.findByText("Breaking Bad")).toBeInTheDocument();
    expect(screen.queryByText("Better Call Saul")).not.toBeInTheDocument();
  });

  it("Escape closes the dialog and restores focus to the kebab", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: collectionApi([collection()]),
    });

    const kebab = await screen.findByRole("button", {
      name: "Actions for Breaking Bad",
    });
    fireEvent.click(kebab);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    await screen.findByRole("dialog", { name: "Rename collection" });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", { name: "Rename collection" }),
    ).not.toBeInTheDocument();
    expect(document.activeElement).toBe(kebab);
  });

  // --- task 005: delete from the grid ---

  const TWO = [
    collection(),
    collection({ id: "c2", name: "Alpha Movie", kind: "movie", member_count: 2 }),
  ];

  function collectionsApi(
    initial: CollectionDto[],
    deleteStatus: number = 204,
  ) {
    // Stateful: a successful DELETE persists into later GETs.
    let current = initial;
    return (input: RequestInfo | URL, init?: RequestInit): Response => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/collections" && method === "GET")
        return jsonResponse(current);
      if (method === "DELETE" && /^\/api\/collections\/[^/]+$/.test(url)) {
        if (deleteStatus !== 204) return jsonError(deleteStatus, "boom");
        current = current.filter((c) => url !== `/api/collections/${c.id}`);
        return new Response(null, { status: 204 });
      }
      return jsonError(404, "unmocked");
    };
  }

  function deleteUrls(fetchSpy: { mock: { calls: unknown[][] } }): string[] {
    return fetchSpy.mock.calls
      .filter(
        ([url, init]) =>
          String(url) === "/api/collections/c1" &&
          (init as RequestInit | undefined)?.method === "DELETE",
      )
      .map(([url]) => String(url));
  }

  async function openDeleteDialog(
    name = "Actions for Breaking Bad",
  ): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole("button", { name }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    return screen.findByRole("dialog", { name: "Delete collection" });
  }

  it("kebab offers Delete below Rename; the confirm dialog names collection and count", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: collectionsApi(TWO),
    });

    await screen.findByText("Breaking Bad");
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Breaking Bad" }),
    );
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Rename", "Delete"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete collection",
    });
    expect(dialog).toHaveTextContent("Breaking Bad");
    expect(dialog).toHaveTextContent("5 videos");
    expect(dialog).toHaveTextContent("videos stay in the library");
  });

  it("confirm deletes: card leaves optimistically and the count updates", async () => {
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: collectionsApi(TWO),
    });

    await screen.findByText("Breaking Bad");
    expect(screen.getByText("· 2")).toBeInTheDocument();

    await openDeleteDialog();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));

    await waitFor(() => {
      expect(screen.queryByText("Breaking Bad")).not.toBeInTheDocument();
    });
    expect(await screen.findByText("· 1")).toBeInTheDocument();
    expect(screen.getByText("Alpha Movie")).toBeInTheDocument();
    expect(deleteUrls(fetchSpy)).toHaveLength(1);
  });

  it("cancel leaves everything untouched and restores focus to the kebab", async () => {
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: collectionsApi(TWO),
    });

    const kebab = await screen.findByRole("button", {
      name: "Actions for Breaking Bad",
    });
    fireEvent.click(kebab);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await screen.findByRole("dialog", { name: "Delete collection" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("dialog", { name: "Delete collection" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Breaking Bad")).toBeInTheDocument();
    expect(deleteUrls(fetchSpy)).toHaveLength(0);
    expect(document.activeElement).toBe(kebab);
  });

  it("failed delete rolls the card back and toasts", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: collectionsApi(TWO, 500),
    });

    await openDeleteDialog();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Breaking Bad")).toBeInTheDocument();
    expect(screen.getByText("· 2")).toBeInTheDocument();
  });

  it("deleting the last collection of a filtered kind shows the filtered-empty state", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: collectionsApi(TWO),
    });

    await screen.findByText("Breaking Bad");
    fireEvent.click(screen.getByRole("button", { name: "Movies" }));
    expect(await screen.findByText("Alpha Movie")).toBeInTheDocument();

    await openDeleteDialog("Actions for Alpha Movie");
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));

    expect(
      await screen.findByText("No collections of this kind"),
    ).toBeInTheDocument();
    // The grid itself is gone — no blank cards left behind.
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
});
