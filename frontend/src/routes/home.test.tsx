import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { HomePage } from "./home";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";

// The home page branches on `GET /api/connections` (via the `['connections']`
// query) and `GET /api/connections/available`. Zero connections → first-run
// guide (if a provider is configured) or setup-required notice (if none are);
// at least one connection → the video library (`VideoList`), which queries
// `GET /api/videos`.

const ALL_AVAILABLE = {
  google_drive: true,
  dropbox: true,
  onedrive: true,
};

const NONE_AVAILABLE = {
  google_drive: false,
  dropbox: false,
  onedrive: false,
};

const SAMPLE_CONNECTION = {
  id: "c1",
  provider: "google_drive",
  provider_account_email: "user@example.com",
  connected_at: "2026-01-01T00:00:00Z",
  scan_status: "idle" as const,
  last_scan_at: null,
  video_count: 3,
};

const SAMPLE_VIDEO_PAGE = {
  videos: [
    {
      id: "v1",
      name: "sample.mp4",
      provider: "google_drive",
      size_bytes: 1048576,
      mime_type: "video/mp4",
      duration_ms: 60000,
      width: 1920,
      height: 1080,
      sources: [
        {
          connection_id: "c1",
          provider: "google_drive",
          provider_file_id: "gd-1",
        },
      ],
      created_at: "2026-01-01T00:00:00Z",
      path: "/Movies/sample.mp4",
      is_favorite: false,
      my_rating: null,
      thumbnail_status: "pending",
    },
  ],
  total: 1,
  page: 1,
  limit: 50,
};

function fetchFor(
  connectionsResponse: unknown,
  videoPage: unknown = SAMPLE_VIDEO_PAGE,
  available: unknown = ALL_AVAILABLE,
) {
  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/connections") return jsonResponse(connectionsResponse);
    if (url === "/api/connections/available") return jsonResponse(available);
    if (url.startsWith("/api/videos/folders")) return jsonResponse([]);
    if (url.startsWith("/api/videos")) return jsonResponse(videoPage);
    return jsonError(404, "unmocked");
  };
}

describe("HomePage", () => {
  it("shows the first-run guide when no connections exist", async () => {
    renderWithProviders(<HomePage />, {
      fetchImplementation: fetchFor([]),
    });

    expect(
      await screen.findByText("Connect your first cloud"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Connect a provider" }),
    ).toHaveAttribute("href", "/connections");
  });

  it("shows a setup-required notice when no providers are configured", async () => {
    renderWithProviders(<HomePage />, {
      fetchImplementation: fetchFor([], SAMPLE_VIDEO_PAGE, NONE_AVAILABLE),
    });

    expect(await screen.findByText(/Setup required/i)).toBeInTheDocument();
    // No dead-end "Connect a provider" link when nothing can be connected.
    expect(
      screen.queryByRole("link", { name: "Connect a provider" }),
    ).toBeNull();
  });

  it("shows the video library when a connection exists", async () => {
    renderWithProviders(<HomePage />, {
      fetchImplementation: fetchFor([SAMPLE_CONNECTION]),
    });

    expect(await screen.findByText("All Videos")).toBeInTheDocument();
    // "sample.mp4" appears in the hero, Recently Added shelf, and grid.
    expect((await screen.findAllByText("sample.mp4")).length).toBeGreaterThanOrEqual(1);
  });

  it("shows a loading state while connections resolve", () => {
    renderWithProviders(<HomePage />, {
      fetchImplementation: () => new Promise<Response>(() => {}),
    });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});
