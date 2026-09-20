// FolderTree tests (M9 task 011; generalized in the library-folders
// effort): render, selection, URL sync via the `use-folder-dir` hook,
// and the ARIA tree keyboard pattern. The tree is generic over
// `{ key, label, count, children }` — provider paths and curated folder
// ids are both just keys; the provider adapter in sidebar-folders keeps
// path keys, so this harness exercises the URL contract through them.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FolderTree, type TreeNode } from "./folder-tree";
import { useFolderDir } from "../hooks/use-folder-dir";
import { useLocation, useNavigate } from "react-router-dom";
import { renderWithProviders } from "../test/utils";

const TREE: TreeNode[] = [
  { key: "", label: "(Root)", count: "2 videos", children: [] },
  {
    key: "/Media",
    label: "Media",
    count: "3 videos · 5 files",
    children: [
      {
        key: "/Media/Movies",
        label: "Movies",
        count: "3 videos · 1 file",
        children: [
          {
            key: "/Media/Movies/Sci-fi",
            label: "Sci-fi",
            count: "1 video",
            children: [],
          },
        ],
      },
      {
        key: "/Media/Music",
        label: "Music",
        count: "4 files",
        children: [],
      },
    ],
  },
  { key: "(Unsorted)", label: "(Unsorted)", count: "2 files", children: [] },
];

// Harness wiring the tree to the URL hook, mirroring how the sidebar
// does. The location readout makes URL-state assertions possible under
// MemoryRouter (window.location never changes); the Back button drives
// history through a real navigate(-1).
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
      <FolderTree nodes={TREE} selectedKey={dir} onSelect={setDir} />
    </div>
  );
}

function renderTree(initialEntries: string[] = ["/"]) {
  return renderWithProviders(<TreeHarness />, { initialEntries });
}

describe("FolderTree", () => {
  it("renders root-level nodes with their counts", () => {
    renderTree();

    expect(screen.getByRole("treeitem", { name: /Media/ })).toBeInTheDocument();
    expect(
      screen.getByRole("treeitem", { name: /\(Root\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("treeitem", { name: /\(Unsorted\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/3 videos/)).toBeInTheDocument(); // Media count
  });

  it("hides children until a branch is expanded, then shows them", () => {
    renderTree();

    expect(
      screen.queryByRole("treeitem", { name: /Movies/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand Media" }));

    expect(
      screen.getByRole("treeitem", { name: /Movies/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("treeitem", { name: /Sci-fi/ }),
    ).not.toBeInTheDocument();
  });

  it("selection writes ?dir= to the URL", () => {
    renderTree(["/"]);

    fireEvent.click(
      screen
        .getByRole("treeitem", { name: /\(Root\)/ })
        .querySelector("button[data-tree-key]")!,
    );
    fireEvent.click(
      screen
        .getByRole("treeitem", { name: /Media/ })
        .querySelector("button[data-tree-key]")!,
    );

    expect(screen.getByTestId("location").textContent).toContain(
      `dir=${encodeURIComponent("/Media")}`,
    );
  });

  it("back navigates to the previously selected folder", () => {
    renderTree(["/"]);

    fireEvent.click(
      screen
        .getByRole("treeitem", { name: /Media/ })
        .querySelector("button[data-tree-key]")!,
    );
    expect(screen.getByTestId("location").textContent).toContain("dir=");

    fireEvent.click(
      screen
        .getByRole("treeitem", { name: /\(Unsorted\)/ })
        .querySelector("button[data-tree-key]")!,
    );
    expect(screen.getByTestId("location").textContent).toContain(
      "dir=%28Unsorted%29",
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("location").textContent).toContain(
      `dir=${encodeURIComponent("/Media")}`,
    );
  });

  it("deep-links: a selected key reveals the node and expands its ancestors", async () => {
    renderTree([`/?dir=${encodeURIComponent("/Media/Movies/Sci-fi")}`]);

    expect(screen.getByRole("treeitem", { name: /Sci-fi/ })).toBeVisible();
    expect(screen.getByRole("treeitem", { name: /Movies/ })).toBeVisible();
  });

  it("renders without selection when the key names no known node", () => {
    renderTree(["/?dir=%2Fnope%2Fnot%2Fa%2Ffolder"]);

    expect(
      screen.getByRole("treeitem", { name: /\(Root\)/ }),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-tree-key][aria-current]")).toBeNull();
  });

  it("supports arrow-key navigation through visible nodes", () => {
    renderTree(["/?dir=/Media"]); // Media auto-expanded

    const media = document.querySelector<HTMLElement>(
      "[data-tree-key='/Media']",
    )!;
    media.focus();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    // Media is expanded (selected-key auto-expand) → next visible is Movies.
    const movies = screen
      .getByRole("treeitem", { name: /Movies/ })
      .querySelector<HTMLElement>("[data-tree-key='/Media/Movies']")!;
    expect(movies).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "Home" });
    expect(document.activeElement?.getAttribute("data-tree-key")).toBe("");
  });

  it("arrow keys descend into expanded branches and ascend from leaves", () => {
    renderTree(["/?dir=/Media"]); // Media auto-expanded

    const media = document.querySelector<HTMLElement>(
      "[data-tree-key='/Media']",
    )!;
    media.focus();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    const movies = screen
      .getByRole("treeitem", { name: /Movies/ })
      .querySelector<HTMLElement>("[data-tree-key='/Media/Movies']")!;
    expect(movies).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowRight" });
    expect(
      screen.getByRole("button", { name: "Collapse Movies" }),
    ).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowRight" });
    const scifi = screen
      .getByRole("treeitem", { name: /Sci-fi/ })
      .querySelector<HTMLElement>(
        "[data-tree-key='/Media/Movies/Sci-fi']",
      )!;
    expect(scifi).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowLeft" });
    expect(
      screen.getByRole("treeitem", { name: /Movies/ }),
    ).toBeInTheDocument();
  });

  it("arrow keys from a disclosure button keep the tree position", () => {
    renderTree(["/?dir=/Media"]); // Media auto-expanded

    const disclosure = screen.getByRole("button", { name: "Collapse Media" });
    disclosure.focus();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    const movies = screen
      .getByRole("treeitem", { name: /Movies/ })
      .querySelector<HTMLElement>("[data-tree-key='/Media/Movies']")!;
    expect(movies).toHaveFocus();

    const moviesDisclosure = screen.getByRole("button", {
      name: /Collapse Movies|Expand Movies/,
    });
    moviesDisclosure.focus();
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowUp" });
    const media = document.querySelector<HTMLElement>(
      "[data-tree-key='/Media']",
    )!;
    expect(media).toHaveFocus();
  });

  it("Home/End jump to the first and last visible nodes", () => {
    renderTree(["/?dir=/Media"]); // visible: Root, Media, Movies, (Unsorted)

    const movies = screen
      .getByRole("treeitem", { name: /Movies/ })
      .querySelector<HTMLElement>("[data-tree-key='/Media/Movies']")!;
    movies.focus();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "End" });
    const unsorted = document.querySelector<HTMLElement>(
      "[data-tree-key='(Unsorted)']",
    )!;
    expect(unsorted).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "Home" });
    const root = document.querySelector<HTMLElement>("[data-tree-key='']")!;
    expect(root).toHaveFocus();
  });

  it("carries the accessible label it is given", () => {
    renderWithProviders(
      <FolderTree
        ariaLabel="Library folders"
        nodes={[]}
        selectedKey=""
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByRole("tree", { name: "Library folders" }),
    ).toBeInTheDocument();
  });
});

// --- Identity-pass task 004: index-tab selection, mono tabular counts ---

describe("FolderTree identity styling", () => {
  it("marks the selected node with the 2px amber index-tab bar + raised fill (design tree-row.active)", () => {
    renderTree(["/?dir=/Media"]);

    const selected = document.querySelector<HTMLElement>(
      "[data-tree-key='/Media'][aria-current]",
    )!;
    expect(selected).toHaveClass(
      "shadow-[inset_2px_0_0_var(--color-castify-accent)]",
    );
    expect(selected).toHaveClass("bg-[var(--color-castify-surface-raised)]");
  });

  it("renders counts right-aligned in mono tabular-nums", () => {
    renderTree();

    const counts = screen.getByText(/3 videos/);
    expect(counts).toHaveClass("font-mono", "tabular-nums");
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
      return (
        <button type="button" onClick={() => setDir("")}>
          {dir}
        </button>
      );
    }
    renderWithProviders(<Probe />, {
      initialEntries: [`/?dir=${encodeURIComponent("/Media")}`],
    });

    fireEvent.click(screen.getByRole("button"));
    expect(globalThis.location.search).not.toContain("dir=");
  });
});
