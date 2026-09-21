// Hook behavior for the library-folders query/mutation layer
// (library-folders task 004): tree fetch, mutation-driven invalidation
// (the server owns the tree — every mutation refetches it), and the
// `?folder=` URL param contract (id | none | absent, push semantics).

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useNavigationType, useSearchParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  useCreateLibraryFolder,
  useLibraryFolderContents,
  useLibraryFolderParam,
  useLibraryFolderTree,
  useMoveLibraryItems,
} from "./use-library-folders";
import { jsonResponse } from "../test/utils";

const TREE = {
  folders: [{ id: "f1", parent_id: null, name: "Trip", position: 0, item_count: 2 }],
  unfiled_count: 3,
};

const EMPTY_PAGE = { entries: [], total: 0, page: 1, limit: 50 };

function harness(initialEntries: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const fetchSpy = vi.fn((_input: RequestInfo | URL) => jsonResponse(TREE));
  vi.stubGlobal("fetch", fetchSpy);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { wrapper, fetchSpy, queryClient };
}

describe("useLibraryFolderTree", () => {
  it("fetches the tree once and exposes the payload", async () => {
    const { wrapper, fetchSpy } = harness(["/"]);
    const { result } = renderHook(() => useLibraryFolderTree(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(TREE));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/library-folders/tree");
  });
});

describe("mutation invalidation", () => {
  it("a create invalidates the tree (server owns the tree)", async () => {
    const { wrapper, fetchSpy } = harness(["/"]);
    const tree = renderHook(() => useLibraryFolderTree(), { wrapper });
    await waitFor(() => expect(tree.result.current.data).toEqual(TREE));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockImplementation(() =>
      jsonResponse({ id: "f2", parent_id: null, name: "New", position: 1 }, 201),
    );
    const created = renderHook(() => useCreateLibraryFolder(), { wrapper });
    await act(() => created.result.current.mutateAsync({ name: "New" }));

    fetchSpy.mockImplementation(() => jsonResponse(TREE));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.filter((c) => c[0] === "/api/library-folders/tree").length,
      ).toBe(2),
    );
  });

  it("a batch move invalidates tree + active contents queries", async () => {
    const { wrapper, fetchSpy } = harness(["/"]);
    // Method-aware: reads answer faithful payloads, the PATCH answers
    // 204. A blanket 204 starves the post-mutation refetch — the queries
    // resolve `undefined` data (TanStack error).
    fetchSpy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response(null, { status: 204 });
      return String(input).includes("/tree") ? jsonResponse(TREE) : jsonResponse(EMPTY_PAGE);
    });
    const tree = renderHook(() => useLibraryFolderTree(), { wrapper });
    const contents = renderHook(
      () => useLibraryFolderContents({ folder_id: "f1", page: 1, limit: 50 }),
      { wrapper },
    );
    await waitFor(() => expect(tree.result.current.data).toEqual(TREE));
    await waitFor(() => expect(contents.result.current.data?.total).toBe(0));
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const move = renderHook(() => useMoveLibraryItems(), { wrapper });
    await act(() =>
      move.result.current.mutateAsync({ items: [{ kind: "video", id: "v1" }], folderId: "f1" }),
    );

    await waitFor(() => {
      const reads = fetchSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((url) => url.includes("/tree") || url.includes("/contents"));
      expect(reads).toHaveLength(4);
    });
  });
});

describe("useLibraryFolderContents", () => {
  it("hits contents with the folder_id param and paginates", async () => {
    const { wrapper, fetchSpy } = harness(["/"]);
    fetchSpy.mockImplementation(() => jsonResponse({ ...EMPTY_PAGE, total: 5, page: 2 }));
    const { result } = renderHook(
      () => useLibraryFolderContents({ folder_id: "f1", page: 2, limit: 2 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data?.total).toBe(5));
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "/api/library-folders/contents?folder_id=f1&page=2&limit=2",
    );
  });
});

describe("useLibraryFolderParam", () => {
  it("absent / empty / none all read as the Unfiled selection (null)", () => {
    for (const entry of ["/", "/?folder=", "/?folder=none"]) {
      const { wrapper } = harness([entry]);
      const { result } = renderHook(() => useLibraryFolderParam(), { wrapper });
      expect(result.current[0], entry).toBeNull();
    }
  });

  it("reads a folder id", () => {
    const { wrapper } = harness(["/?folder=f1"]);
    const { result } = renderHook(() => useLibraryFolderParam(), { wrapper });
    expect(result.current[0]).toBe("f1");
  });

  it("selecting a folder pushes a history entry and preserves other params", async () => {
    const { wrapper } = harness(["/?q=trip"]);
    const { result } = renderHook(
      () => ({ folder: useLibraryFolderParam(), search: useSearchParams()[0] }),
      { wrapper },
    );

    await act(() => result.current.folder[1]("f1"));
    expect(result.current.folder[0]).toBe("f1");
    expect(result.current.search.get("q")).toBe("trip");
  });

  it("clearing removes the param entirely", async () => {
    const { wrapper } = harness(["/?folder=f1"]);
    const { result } = renderHook(() => useLibraryFolderParam(), { wrapper });

    await act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
  });

  it("default navigation pushes; the replace option swaps in place", async () => {
    const { wrapper } = harness(["/?folder=f1"]);
    const { result } = renderHook(
      () => ({ folder: useLibraryFolderParam(), navType: useNavigationType() }),
      { wrapper },
    );

    await act(() => result.current.folder[1]("f2", { replace: true }));
    expect(result.current.folder[0]).toBe("f2");
    expect(result.current.navType).toBe("REPLACE");

    await act(() => result.current.folder[1]("f3"));
    expect(result.current.folder[0]).toBe("f3");
    expect(result.current.navType).toBe("PUSH");
  });
});
