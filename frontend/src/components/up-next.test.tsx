import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { UpNext } from "./up-next";
import type { VideoDetailDto } from "../api/types";
import { jsonResponse } from "../test/utils";

function makeDetail(overrides: Partial<VideoDetailDto> = {}): VideoDetailDto {
  return {
    id: "v1",
    name: "video.mp4",
    provider: "google_drive",
    size_bytes: 1024,
    mime_type: "video/mp4",
    duration_ms: 60_000,
    width: 1920,
    height: 1080,
    sources: [
      { connection_id: "c1", provider: "google_drive", provider_file_id: "f1" },
    ],
    created_at: "2026-01-01T00:00:00Z",
    path: "/x.mp4",
    is_favorite: false,
    my_rating: null,
    thumbnail_status: "cached",
    position_seconds: null,
    duration_seconds: null,
    completed: false,
    subtitle_tracks: [],
    ...overrides,
  };
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// Fetch mock that returns a distinct detail per video id.
function detailPerId(idsToDetails: Record<string, VideoDetailDto>) {
  return (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [id, detail] of Object.entries(idsToDetails)) {
      if (url === `/api/videos/${id}`) return jsonResponse(detail);
      if (url === `/api/videos/${id}/thumbnail`)
        return new Response("img-bytes", { status: 200 });
    }
    return jsonResponse({ message: "unmocked" }, 404);
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UpNext", () => {
  it("renders nothing when the queue has no items beyond the current index", () => {
    const fetchSpy = vi.fn(detailPerId({}));
    vi.stubGlobal("fetch", fetchSpy);
    const onSelect = vi.fn();
    const { container } = renderWithClient(
      <UpNext queue={["v1"]} currentIndex={0} onSelect={onSelect} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Up next")).not.toBeInTheDocument();
  });

  it("renders the panel heading and one item per upcoming id", async () => {
    vi.stubGlobal(
      "fetch",
      detailPerId({
        v2: makeDetail({ id: "v2", name: "second.mp4" }),
        v3: makeDetail({ id: "v3", name: "third.mp4" }),
      }),
    );
    renderWithClient(
      <UpNext
        queue={["v1", "v2", "v3"]}
        currentIndex={0}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByText("Up next")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Play second.mp4" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Play third.mp4" }),
    ).toBeInTheDocument();
  });

  it("limits the list to 5 upcoming items", async () => {
    const details: Record<string, VideoDetailDto> = {};
    for (let i = 2; i <= 8; i++) {
      details[`v${i}`] = makeDetail({ id: `v${i}`, name: `video${i}.mp4` });
    }
    vi.stubGlobal("fetch", detailPerId(details));

    renderWithClient(
      <UpNext
        queue={["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"]}
        currentIndex={0}
        onSelect={() => {}}
      />,
    );

    // Should render exactly 5 items (v2..v6).
    await waitFor(() => {
      const items = screen
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-label")?.startsWith("Play "));
      expect(items).toHaveLength(5);
    });
    expect(
      screen.queryByRole("button", { name: "Play video7.mp4" }),
    ).not.toBeInTheDocument();
  });

  it("clicking an item calls onSelect with the video id", async () => {
    vi.stubGlobal(
      "fetch",
      detailPerId({ v2: makeDetail({ id: "v2", name: "second.mp4" }) }),
    );
    const onSelect = vi.fn();
    renderWithClient(
      <UpNext queue={["v1", "v2"]} currentIndex={0} onSelect={onSelect} />,
    );

    const item = await screen.findByRole("button", { name: "Play second.mp4" });
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith("v2");
  });

  it("clicking an item fires onSelect even while the item is still loading", () => {
    // Never resolve — items stay in loading state.
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    const onSelect = vi.fn();
    renderWithClient(
      <UpNext queue={["v1", "v2"]} currentIndex={0} onSelect={onSelect} />,
    );

    // Loading placeholder uses the id-based aria-label.
    const placeholder = screen.getByRole("button", {
      name: "Play video v2",
    });
    fireEvent.click(placeholder);
    expect(onSelect).toHaveBeenCalledWith("v2");
  });

  it("the toggle pill collapses and expands the list", async () => {
    vi.stubGlobal(
      "fetch",
      detailPerId({ v2: makeDetail({ id: "v2", name: "second.mp4" }) }),
    );
    renderWithClient(
      <UpNext queue={["v1", "v2"]} currentIndex={0} onSelect={() => {}} />,
    );

    // Wait for the item to load first to ensure the panel is populated.
    await screen.findByRole("button", { name: "Play second.mp4" });

    const collapse = screen.getByRole("button", { name: "Hide up next" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(collapse);

    expect(
      screen.queryByRole("button", { name: "Play second.mp4" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show up next" }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Show up next" }));
    expect(
      await screen.findByRole("button", { name: "Play second.mp4" }),
    ).toBeInTheDocument();
  });

  it("shows duration + resolution badges per item", async () => {
    vi.stubGlobal(
      "fetch",
      detailPerId({
        v2: makeDetail({
          id: "v2",
          name: "second.mp4",
          duration_ms: 120_000,
          height: 720,
        }),
      }),
    );
    renderWithClient(
      <UpNext queue={["v1", "v2"]} currentIndex={0} onSelect={() => {}} />,
    );

    await screen.findByRole("button", { name: "Play second.mp4" });
    expect(screen.getByText("2:00")).toBeInTheDocument();
    expect(screen.getByText("720p")).toBeInTheDocument();
  });
});
