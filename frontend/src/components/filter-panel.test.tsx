import { describe, expect, it } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";

import { FilterPanel } from "./filter-panel";
import { useBrowseFilters } from "../lib/filter-state";
import { jsonResponse, renderWithProviders } from "../test/utils";

// FilterPanel receives a `filters` prop (the result of `useBrowseFilters()`).
// Since that hook needs a Router context, we wrap it in a small harness that
// calls the hook and passes the result to FilterPanel.

function FilterPanelHarness() {
  const filters = useBrowseFilters();
  return <FilterPanel filters={filters} />;
}

// Fetch mock: connections + folder. The panel calls useConnections() and
// useFolders() internally for the provider list + folder dropdown.
function panelFetch(connections: unknown[] = [], folders: unknown[] = []) {
  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/connections") return jsonResponse(connections);
    if (url.startsWith("/api/videos/folders")) return jsonResponse(folders);
    return jsonResponse({});
  };
}

const CONNECTIONS = [
  {
    id: "c1",
    provider: "google_drive",
    provider_account_email: "u@example.com",
    connected_at: "2026-01-01T00:00:00Z",
    scan_status: "idle",
    last_scan_at: null,
    video_count: 10,
  },
  {
    id: "c2",
    provider: "dropbox",
    provider_account_email: "u@example.com",
    connected_at: "2026-01-01T00:00:00Z",
    scan_status: "idle",
    last_scan_at: null,
    video_count: 5,
  },
];

const FOLDERS = [
  { folder: "Movies", video_count: 10 },
  { folder: "Shows", video_count: 5 },
];

// Design-pass §5: provider chips are always visible inline; long-tail
// filters (duration / resolution / rating / folder / favorites) live behind
// a "More filters" button that opens a slide-over drawer. The drawer's
// open/close state persists in localStorage. Tests stub the storage to
// start closed so the assertions stay deterministic.
beforeEach(() => {
  try {
    localStorage.setItem("castify-filter-drawer-open", "false");
  } catch {
    /* jsdom sometimes blocks storage in iframes. */
  }
});

import { beforeEach } from "vitest";

// Helper: open the drawer so long-tail controls are queryable.
function openDrawer() {
  fireEvent.click(screen.getByRole("button", { name: /More filters/i }));
}

describe("FilterPanel", () => {
  // --- Inline provider chips (no drawer open required) ---

  it("shows connected providers as inline preset chips", async () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(CONNECTIONS),
    });

    // Provider chips render without opening the drawer.
    expect(
      await screen.findByRole("button", { name: "Google Drive" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dropbox" })).toBeInTheDocument();
    // OneDrive is not connected — should not appear.
    expect(
      screen.queryByRole("button", { name: "OneDrive" }),
    ).not.toBeInTheDocument();
  });

  it("selects a provider when its chip is clicked", async () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(CONNECTIONS),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Google Drive" }),
    );

    expect(
      screen.getByRole("button", { name: "Google Drive" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "All" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("opens the drawer on More filters click", () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(),
    });

    const toggle = screen.getByRole("button", { name: /More filters/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Drawer body not present yet.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    openDrawer();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "More filters" })).toBeInTheDocument();
  });

  // --- Duration ---

  it("selects a duration preset inside the drawer", () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(),
    });

    openDrawer();

    const durationGroup = screen.getByRole("group", {
      name: "Filter by duration",
    });
    fireEvent.click(
      within(durationGroup).getByRole("button", { name: "< 5 min" }),
    );

    expect(
      within(durationGroup).getByRole("button", { name: "< 5 min" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(durationGroup).getByRole("button", { name: "All" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  // --- Resolution ---

  it("selects a resolution preset inside the drawer", () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(),
    });

    openDrawer();

    const resGroup = screen.getByRole("group", {
      name: "Filter by resolution",
    });
    fireEvent.click(within(resGroup).getByRole("button", { name: "HD+" }));

    expect(
      within(resGroup).getByRole("button", { name: "HD+" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  // --- Favorites ---

  it("toggles favorites only checkbox inside the drawer", () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(),
    });

    openDrawer();
    const checkbox = screen.getByRole("checkbox", { name: /Favorites only/ });
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  // --- Minimum rating ---

  it("selects a minimum rating preset inside the drawer", () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(),
    });

    openDrawer();

    const ratingGroup = screen.getByRole("group", {
      name: "Filter by minimum rating",
    });
    fireEvent.click(
      within(ratingGroup).getByRole("button", { name: "3\u2605+" }),
    );

    expect(
      within(ratingGroup).getByRole("button", { name: "3\u2605+" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  // --- Folder dropdown ---

  it("populates the folder dropdown from useFolders data", async () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch([], FOLDERS),
    });

    openDrawer();

    expect(
      await screen.findByRole("option", { name: "Movies (10)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Shows (5)" }),
    ).toBeInTheDocument();
  });

  it("selects a folder filter from the dropdown", async () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch([], FOLDERS),
    });

    openDrawer();
    const select = await screen.findByLabelText("Filter by folder");
    await screen.findByRole("option", { name: "Movies (10)" });

    fireEvent.change(select, { target: { value: "Movies" } });
    expect(select).toHaveValue("Movies");
  });

  // --- Chips ---

  it("shows active-filter chips when filters are set via URL", () => {
    renderWithProviders(<FilterPanelHarness />, {
      initialEntries: ["/?provider=google_drive&duration=short"],
      fetchImplementation: panelFetch(CONNECTIONS),
    });

    // Chips are visible whether or not the drawer is open.
    expect(screen.getAllByText("Google Drive").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("< 5 min").length).toBeGreaterThanOrEqual(1);
  });

  it("removes only the clicked filter when a chip is clicked", () => {
    renderWithProviders(<FilterPanelHarness />, {
      initialEntries: ["/?provider=google_drive&duration=short"],
      fetchImplementation: panelFetch(CONNECTIONS),
    });

    // Drawer is closed; the chip strip is the only place these strings appear.
    expect(screen.getByText("Google Drive")).toBeInTheDocument();
    expect(screen.getByText("< 5 min")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Google Drive"));

    expect(screen.queryByText("Google Drive")).not.toBeInTheDocument();
    expect(screen.getByText("< 5 min")).toBeInTheDocument();
  });

  it("clears all resettable filters via Clear all", () => {
    renderWithProviders(<FilterPanelHarness />, {
      initialEntries: [
        "/?provider=google_drive&duration=short&sort=name&q=concert",
      ],
      fetchImplementation: panelFetch(CONNECTIONS),
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    expect(screen.queryByText("Google Drive")).not.toBeInTheDocument();
    expect(screen.queryByText("< 5 min")).not.toBeInTheDocument();
  });

  // --- Deep-link restore ---

  it("reflects URL filter state on initial render (deep-link)", async () => {
    renderWithProviders(<FilterPanelHarness />, {
      initialEntries: ["/?provider=google_drive&resolution=hd&min_rating=3"],
      fetchImplementation: panelFetch(CONNECTIONS),
    });

    // Provider chip is selectable inline without opening the drawer.
    expect(
      await screen.findByRole("button", { name: "Google Drive" }),
    ).toHaveAttribute("aria-pressed", "true");

    // Long-tail filters require the drawer.
    openDrawer();

    const resGroup = screen.getByRole("group", {
      name: "Filter by resolution",
    });
    expect(
      within(resGroup).getByRole("button", { name: "HD+" }),
    ).toHaveAttribute("aria-pressed", "true");

    const ratingGroup = screen.getByRole("group", {
      name: "Filter by minimum rating",
    });
    expect(
      within(ratingGroup).getByRole("button", { name: "3\u2605+" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
