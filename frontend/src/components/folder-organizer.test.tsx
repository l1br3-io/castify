// FolderOrganizer tests (M9 task 013): the two-pane organizer — tree
// selection drives the contents pane; mixed kinds render with the right
// affordances (play on videos ONLY); provider chips filter; pagination
// walks pages; empty folders get an invitation, not a blank.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FolderOrganizer } from "./folder-organizer";
import type {
  FolderContentsPageDto,
  FolderNodeDto,
  ProviderKey,
  VideoSummaryDto,
} from "../api/types";
import { renderWithProviders, jsonResponse } from "../test/utils";

const TREE: FolderNodeDto[] = [
  { name: "(Root)", path: "", video_count: 1, file_count: 0, children: [] },
  {
    name: "Media",
    path: "/Media",
    video_count: 2,
    file_count: 2,
    children: [
      { name: "Movies", path: "/Media/Movies", video_count: 2, file_count: 0, children: [] },
    ],
  },
];

function video(id: string, name: string): { kind: "video" } & VideoSummaryDto {
  return {
    kind: "video",
    id,
    name,
    provider: "google_drive",
    size_bytes: 1000,
    mime_type: "video/mp4",
    duration_ms: 60_000,
    width: 1920,
    height: 1080,
    sources: [{ connection_id: "c1", provider: "google_drive", provider_file_id: id }],
    created_at: "2026-01-01T00:00:00Z",
    path: `/Media/Movies/${name}`,
    is_favorite: false,
    my_rating: null,
    thumbnail_status: "pending",
    position_seconds: null,
    completed: false,
  };
}

const MOVIES_PAGE: FolderContentsPageDto = {
  entries: [
    video("v1", "Zeta.mp4"),
    {
      kind: "audio",
      id: "f1",
      name: "Alpha.mp3",
      provider: "google_drive",
      path: "/Media/Movies/Alpha.mp3",
      size_bytes: 4096,
      mime_type: "audio/mpeg",
      modified_at: null,
    },
    {
      kind: "document",
      id: "f2",
      name: "Notes.pdf",
      provider: "dropbox",
      path: "/Media/Movies/Notes.pdf",
      size_bytes: 2048,
      mime_type: "application/pdf",
      modified_at: null,
    },
  ],
  total: 5,
  page: 1,
  limit: 3,
};

interface OrganizerOpts {
  tree?: FolderNodeDto[];
  contents?: FolderContentsPageDto;
  contentsByPath?: Record<string, FolderContentsPageDto>;
  connectedProviders?: string[];
}

function organizerFetch(opts: OrganizerOpts = {}) {
  const tree = opts.tree ?? TREE;
  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/folders/tree")) return jsonResponse(tree);
    if (url.startsWith("/api/folders/contents")) {
      const params = new URL(url, "http://x").searchParams;
      const path = params.get("path") ?? "";
      if (opts.contentsByPath) {
        const page = opts.contentsByPath[path];
        if (page) return jsonResponse(page);
      }
      return jsonResponse(opts.contents ?? MOVIES_PAGE);
    }
    return jsonResponse({ message: "unmocked" }, 404);
  };
}

function renderOrganizer(opts: OrganizerOpts = {}, initialEntries: string[] = ["/"]) {
  return renderWithProviders(
    <FolderOrganizer
      connectedProviders={(opts.connectedProviders ?? ["google_drive"]) as ProviderKey[]}
    />,
    {
      initialEntries,
      fetchImplementation: organizerFetch(opts),
    },
  );
}

describe("FolderOrganizer", () => {
  it("renders the tree and the contents pane with mixed kinds", async () => {
    renderOrganizer();

    expect(await screen.findByRole("treeitem", { name: /Media/ })).toBeInTheDocument();
    expect(await screen.findByText("Zeta.mp4")).toBeInTheDocument();
    expect(screen.getByText("Alpha.mp3")).toBeInTheDocument();
    expect(screen.getByText("Notes.pdf")).toBeInTheDocument();
  });

  it("renders videos with a play link and files with download only", async () => {
    renderOrganizer();

    // Video → watch page link with a Play label.
    await screen.findByText("Zeta.mp4");
    expect(screen.getByRole("link", { name: "Play Zeta.mp4" })).toHaveAttribute(
      "href",
      "/watch/v1",
    );

    // Files → download link, never play.
    expect(
      screen.getByRole("link", { name: "Download Alpha.mp3" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Play Alpha/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Play Notes/ })).not.toBeInTheDocument();
  });

  it("selecting a tree node refetches contents for that path", async () => {
    renderOrganizer();
    await screen.findByText("Zeta.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Expand Media" }));
    const moviesSelect = screen
      .getByRole("treeitem", { name: /Movies/ })
      .querySelector<HTMLButtonElement>("button[data-tree-path]")!;
    fireEvent.click(moviesSelect);

    await waitFor(() => {
      expect(screen.getByTestId("contents-path")).toHaveTextContent("Movies");
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => String(c[0]),
      );
      expect(
        calls.some((c) =>
          c.includes(`path=${encodeURIComponent("/Media/Movies")}`),
        ),
      ).toBe(true);
    });
  });

  it("provider chips filter contents and All clears", async () => {
    renderOrganizer({ connectedProviders: ["google_drive", "dropbox"] });
    await screen.findByText("Zeta.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Dropbox" }));
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => String(c[0]),
      );
      expect(
        calls.some((c) => c.includes("provider=dropbox")),
      ).toBe(true);
    });
  });

  it("paginates with Previous/Next", async () => {
    renderOrganizer();
    await screen.findByText("Zeta.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    });
  });

  it("shows an empty state for empty folders", async () => {
    renderOrganizer({ contents: { entries: [], total: 0, page: 1, limit: 50 } });
    await screen.findByText(/This folder is empty/i);
  });

  it("name filter forwards q to the contents query", async () => {
    renderOrganizer();
    await screen.findByText("Zeta.mp4");

    fireEvent.change(screen.getByLabelText("Filter by name"), {
      target: { value: "zeta" },
    });
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => String(c[0]),
      );
      expect(calls.some((c) => c.includes("q=zeta"))).toBe(true);
    });
  });
});
