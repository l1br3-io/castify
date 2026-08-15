// FolderTree tests (M9 task 011): render, selection, URL sync via the
// `use-folder-dir` hook, and the ARIA tree keyboard pattern.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FolderTree } from "./folder-tree";
import { useFolderDir } from "../hooks/use-folder-dir";
import { useLocation, useNavigate } from "react-router-dom";
import type { FolderNodeDto } from "../api/types";
import { renderWithProviders } from "../test/utils";

const TREE: FolderNodeDto[] = [
  {
    name: "(Root)",
    path: "",
    video_count: 2,
    file_count: 0,
    children: [],
  },
  {
    name: "Media",
    path: "/Media",
    video_count: 3,
    file_count: 5,
    children: [
      {
        name: "Movies",
        path: "/Media/Movies",
        video_count: 3,
        file_count: 1,
        children: [
          {
            name: "Sci-fi",
            path: "/Media/Movies/Sci-fi",
            video_count: 1,
            file_count: 0,
            children: [],
          },
        ],
      },
      { name: "Music", path: "/Media/Music", video_count: 0, file_count: 4, children: [] },
    ],
  },
  {
    name: "(Unsorted)",
    path: "(Unsorted)",
    video_count: 0,
    file_count: 2,
    children: [],
  },
];

// Harness wiring the tree to the URL hook, mirroring how browse.tsx will.
// The location readout makes URL-state assertions possible under
// MemoryRouter (window.location never changes); the Back button drives
// history through a real navigate(-1) for FR-9.1 assertions.
function TreeHarness() {
  const [dir, setDir] = useFolderDir();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <output data-testid="location">{location.search}</output>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
      <FolderTree nodes={TREE} selectedPath={dir} onSelect={setDir} />
    </div>
  );
}

function renderTree(initialEntries: string[] = ["/"]) {
  return renderWithProviders(<TreeHarness />, { initialEntries });
}

describe("FolderTree", () => {
  it("renders root-level nodes with cumulative counts", () => {
    renderTree();

    expect(screen.getByRole("treeitem", { name: /Media/ })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /\(Root\)/ })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /\(Unsorted\)/ })).toBeInTheDocument();
    expect(screen.getByText(/3 videos/)).toBeInTheDocument(); // Media cumulative count
  });

  it("hides children until a branch is expanded, then shows them", () => {
    renderTree();

    expect(
      screen.queryByRole("treeitem", { name: /Movies/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand Media" }));

    expect(screen.getByRole("treeitem", { name: /Movies/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("treeitem", { name: /Sci-fi/ }),
    ).not.toBeInTheDocument();
  });

  it("selection writes ?dir= to the URL", () => {
    renderTree(["/"]);

    fireEvent.click(screen.getByRole("treeitem", { name: /\(Root\)/ }).querySelector("button[data-tree-path]")!);
    fireEvent.click(screen.getByRole("treeitem", { name: /Media/ }).querySelector("button[data-tree-path]")!);

    expect(screen.getByTestId("location").textContent).toContain(
      `dir=${encodeURIComponent("/Media")}`,
    );
  });

  // FR-9.1: folder selections push history entries — back/forward walks
  // folder history (a replaceState URL would take Back off the page).
  it("back navigates to the previously selected folder", () => {
    renderTree(["/"]);

    fireEvent.click(screen.getByRole("treeitem", { name: /Media/ }).querySelector("button[data-tree-path]")!);
    expect(screen.getByTestId("location").textContent).toContain("dir=");

    fireEvent.click(screen.getByRole("treeitem", { name: /\(Unsorted\)/ }).querySelector("button[data-tree-path]")!);
    // URLSearchParams escapes parens (encodeURIComponent does not).
    expect(screen.getByTestId("location").textContent).toContain(
      "dir=%28Unsorted%29",
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("location").textContent).toContain(
      `dir=${encodeURIComponent("/Media")}`,
    );
  });

  it("deep-links: ?dir= selects the node and expands its ancestors", async () => {
    renderTree([`/?dir=${encodeURIComponent("/Media/Movies/Sci-fi")}`]);

    expect(screen.getByRole("treeitem", { name: /Sci-fi/ })).toBeVisible();
    // Ancestors expanded to reveal it.
    expect(screen.getByRole("treeitem", { name: /Movies/ })).toBeVisible();
  });

  it("renders without selection when dir names no known node", () => {
    renderTree(["/?dir=%2Fnope%2Fnot%2Fa%2Ffolder"]);

    // The tree itself is router-free — it simply has nothing selected
    // (fallback-to-root is FolderOrganizer's job, tested there).
    expect(screen.getByRole("treeitem", { name: /\(Root\)/ })).toBeInTheDocument();
    expect(
      document.querySelector("[data-tree-path][aria-current]"),
    ).toBeNull();
  });

  it("supports arrow-key navigation through visible nodes", () => {
    renderTree(["/?dir=/Media"]);

    const media = document.querySelector<HTMLElement>(
      "[data-tree-path='/Media']",
    )!;
    media.focus();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    // Media is expanded (selected-path auto-expand) → next visible is Movies.
    const movies = screen
      .getByRole("treeitem", { name: /Movies/ })
      .querySelector<HTMLElement>("[data-tree-path='/Media/Movies']")!;
    expect(movies).toHaveFocus();

    // ArrowRight on a collapsed branch expands it (label flips to Collapse).
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowRight" });
    expect(
      screen.getByRole("button", { name: "Collapse Movies" }),
    ).toHaveAttribute("aria-expanded", "true");

    // ArrowRight again descends to the first child.
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowRight" });
    const scifi = screen
      .getByRole("treeitem", { name: /Sci-fi/ })
      .querySelector<HTMLElement>("[data-tree-path='/Media/Movies/Sci-fi']")!;
    expect(scifi).toHaveFocus();

    // ArrowLeft on a leaf moves back to the parent.
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowLeft" });
    expect(
      screen.getByRole("treeitem", { name: /Movies/ }),
    ).toBeInTheDocument();
  });

  it("arrow keys from a disclosure button keep the tree position", () => {
    renderTree(["/?dir=/Media"]); // Media auto-expanded

    const disclosure = screen.getByRole("button", { name: "Collapse Media" });
    disclosure.focus();

    // Down from Media's disclosure must land on the NEXT node (Movies) —
    // not yank focus back to the first treeitem (the old resolve-by-
    // activeElement bug: disclosures carry no data-tree-path).
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    const movies = screen
      .getByRole("treeitem", { name: /Movies/ })
      .querySelector<HTMLElement>("[data-tree-path='/Media/Movies']")!;
    expect(movies).toHaveFocus();

    // Up from the Movies disclosure walks back to Media, still in place.
    const moviesDisclosure = screen.getByRole("button", {
      name: /Collapse Movies|Expand Movies/,
    });
    moviesDisclosure.focus();
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowUp" });
    const media = document.querySelector<HTMLElement>(
      "[data-tree-path='/Media']",
    )!;
    expect(media).toHaveFocus();
  });

  it("Home/End jump to the first and last visible nodes", () => {
    renderTree(["/?dir=/Media"]); // visible: Root, Media, Movies, (Unsorted)

    const movies = screen
      .getByRole("treeitem", { name: /Movies/ })
      .querySelector<HTMLElement>("[data-tree-path='/Media/Movies']")!;
    movies.focus();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "End" });
    const unsorted = document.querySelector<HTMLElement>(
      "[data-tree-path='(Unsorted)']",
    )!;
    expect(unsorted).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "Home" });
    const root = document.querySelector<HTMLElement>(
      "[data-tree-path='']",
    )!;
    expect(root).toHaveFocus();
  });
});

describe("useFolderDir", () => {
  it("reads the dir param and defaults to root", () => {
    let observed: string | undefined;
    function Probe() {
      const [dir] = useFolderDir();
      observed = dir;
      return null;
    }
    renderWithProviders(<Probe />, { initialEntries: ["/"] });
    expect(observed).toBe("");
  });

  it("clearing the dir param removes it from the URL", () => {
    function Probe() {
      const [dir, setDir] = useFolderDir();
      return <button type="button" onClick={() => setDir("")}>{dir}</button>;
    }
    renderWithProviders(<Probe />, {
      initialEntries: [`/?dir=${encodeURIComponent("/Media")}`],
    });

    fireEvent.click(screen.getByRole("button"));
    expect(globalThis.location.search).not.toContain("dir=");
  });
});
