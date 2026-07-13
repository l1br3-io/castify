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

// Fetch mock: connections + folders. The panel calls useConnections() and
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

describe("FilterPanel", () => {
  // --- Toggle ---

  it("is collapsed by default and expands on click", () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(),
    });

    const toggle = screen.getByRole("button", { name: /Filters/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Body not present.
    expect(
      screen.queryByRole("group", { name: "Filter by provider" }),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("group", { name: "Filter by provider" }),
    ).toBeInTheDocument();
  });

  // --- Provider ---

  it("shows connected providers as options", async () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(CONNECTIONS),
    });

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

    // Wait for connections to load.
    expect(
      await screen.findByRole("button", { name: "Google Drive" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dropbox" })).toBeInTheDocument();
    // OneDrive is not connected — should not appear.
    expect(
      screen.queryByRole("button", { name: "OneDrive" }),
    ).not.toBeInTheDocument();
  });

  it("sets the provider filter when a provider button is clicked", async () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(CONNECTIONS),
    });

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Google Drive" }),
    );

    expect(
      screen.getByRole("button", { name: "Google Drive" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  // --- Duration ---

  it("selects a duration preset and shows it as active", () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(),
    });

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

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

  it("selects a resolution preset and shows it as active", () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(),
    });

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

    const resGroup = screen.getByRole("group", {
      name: "Filter by resolution",
    });
    fireEvent.click(within(resGroup).getByRole("button", { name: "HD+" }));

    expect(
      within(resGroup).getByRole("button", { name: "HD+" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  // --- Favorites ---

  it("toggles favorites only checkbox", () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(),
    });

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    const checkbox = screen.getByRole("checkbox", { name: /Favorites only/ });
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  // --- Minimum rating ---

  it("selects a minimum rating preset", () => {
    renderWithProviders(<FilterPanelHarness />, {
      fetchImplementation: panelFetch(),
    });

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

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

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

    // Wait for folders to load.
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

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    const select = await screen.findByLabelText("Filter by folder");

    // Wait for options to populate.
    await screen.findByRole("option", { name: "Movies (10)" });

    fireEvent.change(select, { target: { value: "Movies" } });
    expect(select).toHaveValue("Movies");
  });

  // --- Chips ---

  it("shows active-filter chips when filters are set via URL", () => {
    // Start with filters already in the URL (deep-link scenario).
    renderWithProviders(<FilterPanelHarness />, {
      initialEntries: ["/?provider=google_drive&duration=short"],
      fetchImplementation: panelFetch(CONNECTIONS),
    });

    // Chips are visible even when the panel is collapsed.
    // The chip text appears inside <span> elements within chip buttons.
    // Use getAllByText since the same text may appear in the expanded panel
    // body AND the chip strip.
    expect(screen.getAllByText("Google Drive").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("< 5 min").length).toBeGreaterThanOrEqual(1);
    // Active count badge.
    expect(screen.getByLabelText(/2 active filters/)).toBeInTheDocument();
  });

  it("removes only the clicked filter when a chip is clicked", () => {
    renderWithProviders(<FilterPanelHarness />, {
      initialEntries: ["/?provider=google_drive&duration=short"],
      fetchImplementation: panelFetch(CONNECTIONS),
    });

    // Both chips present (collapsible body is closed, so these only appear
    // as chip text).
    expect(screen.getByText("Google Drive")).toBeInTheDocument();
    expect(screen.getByText("< 5 min")).toBeInTheDocument();

    // Click the Google Drive chip (the <span> inside the chip button).
    fireEvent.click(screen.getByText("Google Drive"));

    // Google Drive chip gone, duration chip remains.
    expect(screen.queryByText("Google Drive")).not.toBeInTheDocument();
    expect(screen.getByText("< 5 min")).toBeInTheDocument();
    expect(screen.getByLabelText(/1 active filter/)).toBeInTheDocument();
  });

  it("clears all resettable filters via Clear all", () => {
    renderWithProviders(<FilterPanelHarness />, {
      initialEntries: [
        "/?provider=google_drive&duration=short&sort=name&q=concert",
      ],
      fetchImplementation: panelFetch(CONNECTIONS),
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    // Filter chips gone.
    expect(screen.queryByText("Google Drive")).not.toBeInTheDocument();
    expect(screen.queryByText("< 5 min")).not.toBeInTheDocument();
    // No active-count badge.
    expect(screen.queryByLabelText(/active filter/)).not.toBeInTheDocument();
  });

  // --- Deep-link restore ---

  it("reflects URL filter state on initial render (deep-link)", () => {
    renderWithProviders(<FilterPanelHarness />, {
      initialEntries: ["/?provider=google_drive&resolution=hd&min_rating=3"],
      fetchImplementation: panelFetch(CONNECTIONS),
    });

    // Open panel to inspect active states.
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

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
