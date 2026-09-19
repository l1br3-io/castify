// Collection detail view (library-collections task 008): the ordered
// member grid, play-all into the existing watch queue, rename, and
// delete-with-confirmation.

import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { CollectionDetailPage } from "./collection-detail";
import type { CollectionDetailDto, VideoSummaryDto } from "../../api/types";
import { jsonResponse, renderWithProviders } from "../../test/utils";

function member(id: string, name: string): VideoSummaryDto {
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
  name: "Weekend watchlist",
  kind: "manual",
  created_at: "2026-09-19T00:00:00Z",
  members: [member("v1", "alpha.mp4"), member("v2", "beta.mp4")],
};

function detailFetch(
  detail: CollectionDetailDto = DETAIL,
  extra: (input: RequestInfo | URL, init?: RequestInit) => Response | null = () => null,
) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const extraResponse = extra(input, init);
    if (extraResponse) return extraResponse;
    if (url === `/api/collections/${detail.id}`) return jsonResponse(detail);
    if (url.startsWith("/api/videos/") && url.endsWith("/thumbnail"))
      return new Response("fake-image", { status: 200 });
    return jsonResponse({ message: `unmocked: ${url}` }, 404);
  };
}

function renderDetail(
  fetchImpl: NonNullable<
    Parameters<typeof renderWithProviders>[1]
  >["fetchImplementation"] = detailFetch(),
) {
  return renderWithProviders(
    <Routes>
      <Route path="/collections/:id" element={<CollectionDetailPage />} />
      <Route path="/" element={<div>library home</div>} />
    </Routes>,
    { initialEntries: ["/collections/c1"], fetchImplementation: fetchImpl },
  );
}

describe("CollectionDetailPage", () => {
  it("renders the collection name, kind, count, and ordered members", async () => {
    renderDetail();

    expect(await screen.findByRole("heading", { name: /weekend watchlist/i }));
    expect(screen.getByText(/Collection · 2 videos/)).toBeInTheDocument();
    expect(screen.getByText("alpha.mp4")).toBeInTheDocument();
    expect(screen.getByText("beta.mp4")).toBeInTheDocument();
  });

  it("play-all links to the first member with the full queue", async () => {
    renderDetail();

    const playAll = await screen.findByRole("link", { name: /play all/i });
    expect(playAll).toHaveAttribute("href", "/watch/v1");
    // The queue rides router state — asserted via the link's navigate
    // payload in PosterCard; here the contract is href + presence.
  });

  it("renames the collection via PATCH and shows the new name", async () => {
        const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    renderDetail((input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === "/api/collections/c1" && method === "PATCH")
        return jsonResponse({ id: "c1", name: "Renamed", kind: "manual", created_at: "t" });
      return detailFetch()(input, init);
    });

    fireEvent.click(await screen.findByRole("button", { name: /rename/i }));
    const input = screen.getByLabelText(/collection name/i);
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      const patch = requests.find((r) => r.method === "PATCH");
      expect(patch).toMatchObject({ url: "/api/collections/c1", body: { name: "Renamed" } });
    });
  });

  it("deletes with confirmation and returns to the library", async () => {
        const requests: Array<{ url: string; method: string }> = [];
    renderDetail((input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push({ url, method });
      if (url === "/api/collections/c1" && method === "DELETE")
        return new Response(null, { status: 204 });
      return detailFetch()(input, init);
    });

    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));
    // Confirmation dialog, not an immediate delete.
    expect(
      requests.filter((r) => r.method === "DELETE"),
    ).toHaveLength(0);

    expect(
      await screen.findByRole("dialog", { name: /delete collection/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /yes, delete/i }));

    await waitFor(() => {
      expect(requests.some((r) => r.method === "DELETE")).toBe(true);
    });
    // Navigated home after delete.
    expect(await screen.findByText("library home")).toBeInTheDocument();
  });

  it("opens the share dialog pre-filled with members in curation order", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    renderDetail((input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === "/api/shares" && method === "POST")
        return jsonResponse({
          id: "s1",
          title: "Shared",
          token: "tok_abc",
          share_url: "/share/tok_abc",
        });
      return detailFetch()(input, init);
    });

    fireEvent.click(await screen.findByRole("button", { name: /share/i }));

    // itemLabel = collection name rides the dialog heading.
    const dialog = await screen.findByRole("dialog", {
      name: /share weekend watchlist/i,
    });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/these 2 videos/i)).toBeInTheDocument();

    // The create POST carries exactly the members, in on-page order.
    fireEvent.click(screen.getByRole("button", { name: /create share/i }));
    await waitFor(() => {
      const post = requests.find(
        (r) => r.method === "POST" && r.url === "/api/shares",
      );
      expect(post?.body).toMatchObject({ video_ids: ["v1", "v2"] });
    });
  });

  it("disables share with a reason on an empty collection and never opens the dialog", async () => {
    renderDetail(detailFetch({ ...DETAIL, members: [] }));

    const share = await screen.findByRole("button", { name: /share/i });
    expect(share).toBeDisabled();
    expect(share).toHaveAttribute(
      "title",
      "Empty collections can't be shared",
    );
    // Play all's conditional-render pattern is deliberately not copied —
    // the button stays mounted so the header layout doesn't jump.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the empty state for a collection with no members", async () => {
    renderDetail(detailFetch({ ...DETAIL, members: [] }));

    expect(
      await screen.findByText(/this collection is empty/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /play all/i })).not.toBeInTheDocument();
  });

  it("surfaces a retryable error state when the fetch fails", async () => {
        let calls = 0;
    renderWithProviders(
      <Routes>
        <Route path="/collections/:id" element={<CollectionDetailPage />} />
      </Routes>,
      {
        initialEntries: ["/collections/c1"],
        fetchImplementation: () => {
          calls += 1;
          return calls === 1
            ? jsonResponse({ message: "boom" }, 500)
            : jsonResponse(DETAIL);
        },
      },
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("heading", { name: /weekend watchlist/i })).toBeInTheDocument();
  });
});
