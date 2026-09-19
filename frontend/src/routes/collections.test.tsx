// Collections index page (collections-page task 002): `/collections`
// renders every collection as a CollectionCard grid off
// `GET /api/collections`, with loading / error / truly-empty states and
// a header row carrying the total count as a mono figure. The sr-only
// h1 keeps the a11y tree honest while the header row is the visible
// identity (browse-page precedent).

import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useParams } from "react-router-dom";

import { CollectionsPage } from "./collections";
import type { CollectionDetailDto, CollectionDto, VideoSummaryDto } from "../api/types";
import { collectionsQueryKeys } from "../api/collections";
import { jsonError, jsonResponse, renderWithProviders } from "../test/utils";
import { QueryClient } from "@tanstack/react-query";

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

function DetailProbe() {
  const { id = "" } = useParams();
  return <div data-testid="detail">{id}</div>;
}

function pageRoutes() {
  return (
    <Routes>
      <Route path="/collections" element={<CollectionsPage />} />
      <Route path="/collections/:id" element={<DetailProbe />} />
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
      fetchImplementation: createCollectionsApi(),
    });

    expect(
      await screen.findByText("No collections yet"),
    ).toBeInTheDocument();
    // The note explains where collections come from…
    expect(
      screen.getByText(/scan/i),
    ).toBeInTheDocument();

    // …and the CTA opens the create dialog (spec F1).
    fireEvent.click(screen.getByRole("button", { name: "New collection" }));
    expect(
      await screen.findByRole("dialog", { name: "New collection" }),
    ).toBeInTheDocument();
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
    expect(items.map((i) => i.textContent)).toEqual([
      "Rename",
      "Share",
      "Delete",
    ]);

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

  // --- task 006: create collection dialog ---

  function createCollectionsApi(
    initial: CollectionDto[] = [],
    postStatus: number = 200,
  ) {
    // Stateful: a successful POST persists into later GETs.
    let current = initial;
    return (input: RequestInfo | URL, init?: RequestInit): Response => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/collections" && method === "GET")
        return jsonResponse(current);
      if (url === "/api/collections" && method === "POST") {
        if (postStatus !== 200)
          return jsonError(postStatus, "name already exists");
        const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
        const created: CollectionDto = {
          id: "c9",
          name: body.name,
          kind: "manual",
          created_at: "2026-09-19T00:00:00Z",
          member_count: 0,
          preview: [],
        };
        current = [...current, created];
        return jsonResponse(created);
      }
      return jsonError(404, "unmocked");
    };
  }

  function postUrls(fetchSpy: { mock: { calls: unknown[][] } }): string[] {
    return fetchSpy.mock.calls
      .filter(
        ([url, init]) =>
          String(url) === "/api/collections" &&
          (init as RequestInit | undefined)?.method === "POST",
      )
      .map(([url]) => String(url));
  }

  async function openCreateDialog(): Promise<void> {
    fireEvent.click(
      screen.getByRole("button", { name: "New collection" }),
    );
    await screen.findByRole("dialog", { name: "New collection" });
  }

  it("the header's New collection button opens the dialog", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: createCollectionsApi([collection()]),
    });

    await screen.findByText("Breaking Bad");
    await openCreateDialog();
    expect(
      screen.getByLabelText("New collection name"),
    ).toBeInTheDocument();
  });

  it("creating POSTs, invalidates the list, and navigates to the new detail", async () => {
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: createCollectionsApi(),
    });

    // Truly-empty start: the CTA's New collection opens the same dialog.
    await screen.findByText("No collections yet");
    await openCreateDialog();

    fireEvent.change(screen.getByLabelText("New collection name"), {
      target: { value: "Mixtape" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.getByTestId("detail")).toBeInTheDocument();
    });
    // Landed on the new collection's own detail page.
    expect(screen.getByTestId("detail")).toHaveTextContent("c9");
    expect(postUrls(fetchSpy)).toHaveLength(1);
    // The list was invalidated and refetched with the new row.
    const gets = fetchSpy.mock.calls.filter(
      ([url, init]) =>
        String(url) === "/api/collections" &&
        (init?.method ?? "GET") === "GET",
    ).length;
    expect(gets).toBeGreaterThanOrEqual(2);
  });

  it("rejects empty and whitespace-only names client-side", async () => {
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: createCollectionsApi([collection()]),
    });

    await screen.findByText("Breaking Bad");
    await openCreateDialog();

    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText("New collection name"), {
      target: { value: "   " },
    });
    expect(create).toBeDisabled();

    // Enter on an empty draft never fires the POST either.
    fireEvent.keyDown(screen.getByLabelText("New collection name"), {
      key: "Enter",
    });
    expect(postUrls(fetchSpy)).toHaveLength(0);
  });

  it("surfaces API errors inline with the draft preserved", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: createCollectionsApi([collection()], 409),
    });

    await screen.findByText("Breaking Bad");
    await openCreateDialog();

    fireEvent.change(screen.getByLabelText("New collection name"), {
      target: { value: "Mixtape" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("name already exists");
    // Draft preserved, dialog still open, no navigation.
    expect(screen.getByLabelText("New collection name")).toHaveValue("Mixtape");
    expect(screen.queryByTestId("detail")).not.toBeInTheDocument();
  });

  it("Escape and Cancel abort with nothing sent", async () => {
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: createCollectionsApi([collection()]),
    });

    await screen.findByText("Breaking Bad");
    await openCreateDialog();
    fireEvent.change(screen.getByLabelText("New collection name"), {
      target: { value: "Mixtape" },
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "New collection" }),
    ).not.toBeInTheDocument();

    await openCreateDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "New collection" }),
    ).not.toBeInTheDocument();

    expect(postUrls(fetchSpy)).toHaveLength(0);
  });

  // --- share-collections: share from the grid kebab ---

  function detailMember(id: string, name: string): VideoSummaryDto {
    return {
      id,
      name,
      provider: "google_drive",
      size_bytes: 1000,
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

  const DETAIL: CollectionDetailDto = {
    id: "c1",
    name: "Breaking Bad",
    kind: "show",
    created_at: "2026-09-01T00:00:00Z",
    members: [
      detailMember("v1", "s01e01.mp4"),
      detailMember("v2", "s01e02.mp4"),
      detailMember("v3", "s01e03.mp4"),
    ],
  };

  /** List API + detail API; detailMembers overrides the fetched detail so
   *  the stale-count path can return something contradicting the card. */
  function shareApi(
    detail: CollectionDetailDto = DETAIL,
    detailStatus: number = 200,
  ) {
    return (input: RequestInfo | URL, init?: RequestInit): Response => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/collections" && method === "GET")
        return jsonResponse([
          collection({ member_count: detail.members.length || 5 }),
        ]);
      if (url === "/api/collections/c1")
        return detailStatus === 200
          ? jsonResponse(detail)
          : jsonError(detailStatus, "boom");
      return jsonError(404, "unmocked");
    };
  }

  function detailGetCount(fetchSpy: { mock: { calls: unknown[][] } }): number {
    return fetchSpy.mock.calls.filter(
      ([url, init]) =>
        String(url) === "/api/collections/c1" &&
        (init as RequestInit | undefined)?.method !== "DELETE" &&
        (init as RequestInit | undefined)?.method !== "PATCH",
    ).length;
  }

  async function openKebabMenu(): Promise<void> {
    fireEvent.click(
      await screen.findByRole("button", { name: "Actions for Breaking Bad" }),
    );
    await screen.findByRole("menu");
  }

  it("kebab Share sits between Rename and Delete; selecting fetches the detail and opens the pre-filled dialog", async () => {
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: shareApi(),
    });

    await openKebabMenu();
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Rename",
      "Share",
      "Delete",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Share" }));

    // One GET of the detail, then the dialog with name label + count.
    const dialog = await screen.findByRole("dialog", {
      name: /share breaking bad/i,
    });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/these 3 videos/i)).toBeInTheDocument();
    expect(detailGetCount(fetchSpy)).toBe(1);
    // Selecting closed the kebab menu.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Share menuitem is disabled with a reason when member_count is 0 (no fetch)", async () => {
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: (input) => {
        const url = String(input);
        if (url === "/api/collections")
          return jsonResponse([collection({ member_count: 0 })]);
        return jsonError(404, "unmocked");
      },
    });

    await openKebabMenu();
    const share = screen.getByRole("menuitem", { name: "Share" });
    expect(share).toBeDisabled();
    expect(share).toHaveAttribute(
      "title",
      "Empty collections can't be shared",
    );
    expect(detailGetCount(fetchSpy)).toBe(0);
  });

  it("stale member_count (fetch returns 0 members) toasts and never opens the dialog", async () => {
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: shareApi({ ...DETAIL, members: [] }),
    });

    await openKebabMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Share" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/empty/i);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(detailGetCount(fetchSpy)).toBe(1);
  });

  it("failed detail fetch toasts naming the collection; no dialog", async () => {
    renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: shareApi(DETAIL, 500),
    });

    await openKebabMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Share" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't share "breaking bad"/i,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a cached detail serves the share path without a network request", async () => {
    // Mirrors the production client (query-client.ts) except retry: the
    // app-wide 30s staleTime is what lets a visited detail serve this
    // path from cache; gcTime must stay default or the unobserved
    // seeded entry is collected before the click.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    queryClient.setQueryData(collectionsQueryKeys.detail("c1"), DETAIL);
    const { fetchSpy } = renderWithProviders(pageRoutes(), {
      initialEntries: ["/collections"],
      fetchImplementation: shareApi(),
      queryClient,
    });

    await openKebabMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Share" }));

    const dialog = await screen.findByRole("dialog", {
      name: /share breaking bad/i,
    });
    expect(dialog).toBeInTheDocument();
    expect(detailGetCount(fetchSpy)).toBe(0);
  });
});
