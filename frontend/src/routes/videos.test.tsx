import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";

import { VideoList } from "./videos";
import { setCsrfToken } from "../api/client";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";

// The VideoList issues two GETs on mount: `GET /api/connections` (for the
// empty-state scan indicator) and `GET /api/videos?page=1&sort=date-desc`
// (the catalog). Sort/page changes fire new `GET /api/videos` requests with
// updated query params.

const VIDEO_PAGE_ONE = {
  videos: [
    {
      id: "v1",
      name: "cat.mp4",
      provider: "google_drive",
      size_bytes: 5_242_880,
      mime_type: "video/mp4",
      duration_ms: 120_000,
      width: 1920,
      height: 1080,
      sources: [
        {
          connection_id: "c1",
          provider: "google_drive",
          provider_file_id: "gd-1",
        },
      ],
    },
    {
      id: "v2",
      name: "dedup-video.mp4",
      provider: "google_drive",
      size_bytes: 1_073_741_824,
      mime_type: "video/mp4",
      duration_ms: 3_661_000,
      width: 3840,
      height: 2160,
      sources: [
        {
          connection_id: "c1",
          provider: "google_drive",
          provider_file_id: "gd-2",
        },
        {
          connection_id: "c2",
          provider: "dropbox",
          provider_file_id: "db-1",
        },
      ],
    },
  ],
  total: 60,
  page: 1,
  limit: 50,
};

const EMPTY_VIDEO_PAGE = {
  videos: [],
  total: 0,
  page: 1,
  limit: 50,
};

const NO_CONNECTIONS: unknown[] = [];

function videoListFetch(
  videoPage: unknown = VIDEO_PAGE_ONE,
  connections: unknown = NO_CONNECTIONS,
) {
  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/connections") return jsonResponse(connections);
    if (url.startsWith("/api/videos")) return jsonResponse(videoPage);
    return jsonError(404, "unmocked");
  };
}

describe("VideoList", () => {
  beforeEach(() => setCsrfToken("csrf-test"));
  afterEach(() => setCsrfToken(null));

  it("renders video cards with name, provider badge, size, and duration", async () => {
    renderWithProviders(<VideoList />, {
      fetchImplementation: videoListFetch(),
    });

    expect(await screen.findByText("cat.mp4")).toBeInTheDocument();
    expect(screen.getAllByText("Google Drive").length).toBeGreaterThan(0);
    // Size, duration, and resolution are rendered as a joined metadata line.
    expect(
      screen.getByText(/5\.0 MB · 2:00 · 1920\u00d71080/),
    ).toBeInTheDocument();
  });

  it("shows a dedup badge when sources > 1", async () => {
    renderWithProviders(<VideoList />, {
      fetchImplementation: videoListFetch(),
    });

    expect(await screen.findByText("dedup-video.mp4")).toBeInTheDocument();
    expect(screen.getByText(/Also in: Dropbox/)).toBeInTheDocument();
  });

  it("hides the dedup badge for single-source videos", async () => {
    const singleSourcePage = {
      ...VIDEO_PAGE_ONE,
      videos: [VIDEO_PAGE_ONE.videos[0]],
    };
    renderWithProviders(<VideoList />, {
      fetchImplementation: videoListFetch(singleSourcePage),
    });

    await screen.findByText("cat.mp4");
    expect(screen.queryByText(/Also in:/)).not.toBeInTheDocument();
  });

  it("changes the sort query param when the dropdown changes", async () => {
    const { fetchSpy } = renderWithProviders(<VideoList />, {
      fetchImplementation: videoListFetch(),
    });

    await screen.findByText("cat.mp4");

    fireEvent.change(screen.getByLabelText("Sort videos"), {
      target: { value: "size" },
    });

    await waitFor(() => {
      const sizeCall = fetchSpy.mock.calls.find(
        ([url]) =>
          String(url).includes("sort=size") &&
          String(url).startsWith("/api/videos"),
      );
      expect(sizeCall).toBeDefined();
    });
  });

  it("navigates to the next page when Next is clicked", async () => {
    renderWithProviders(<VideoList />, {
      fetchImplementation: (input) => {
        const url = String(input);
        if (url === "/api/connections") return jsonResponse([]);
        if (url.startsWith("/api/videos")) {
          const params = new URL(url, "http://x").searchParams;
          const page = Number(params.get("page") ?? 1);
          return jsonResponse({
            ...VIDEO_PAGE_ONE,
            page,
            videos:
              page === 1
                ? VIDEO_PAGE_ONE.videos
                : [{ ...VIDEO_PAGE_ONE.videos[0], id: "v-page2", name: "page2.mp4" }],
          });
        }
        return jsonError(404, "unmocked");
      },
    });

    await screen.findByText("cat.mp4");
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await screen.findByText("page2.mp4");
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument();
  });

  it("shows the empty state when zero videos exist", async () => {
    renderWithProviders(<VideoList />, {
      fetchImplementation: videoListFetch(EMPTY_VIDEO_PAGE),
    });

    expect(await screen.findByText("No videos yet")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Connect a provider" }),
    ).toHaveAttribute("href", "/connections");
  });

  it("shows a loading skeleton while videos are loading", () => {
    renderWithProviders(<VideoList />, {
      fetchImplementation: () => new Promise<Response>(() => {}),
    });
    // The skeleton renders placeholder bars; we assert the header is present
    // and no video names leaked through.
    expect(screen.getByText("Your library")).toBeInTheDocument();
    expect(screen.queryByText("cat.mp4")).not.toBeInTheDocument();
  });

  it("shows an error message when the videos request fails", async () => {
    renderWithProviders(<VideoList />, {
      fetchImplementation: (input) => {
        const url = String(input);
        if (url === "/api/connections") return jsonResponse([]);
        if (url.startsWith("/api/videos"))
          return jsonError(500, "database is locked");
        return jsonError(404, "unmocked");
      },
    });

    expect(await screen.findByText(/Couldn't load videos/)).toBeInTheDocument();
  });
});
