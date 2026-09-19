// Fetcher URL/method/body construction for the collections API
// (library-collections task 007). Mirrors folders.test.ts: asserts the
// exact request each helper builds — method, path, and JSON body — plus
// error mapping through the shared client.

import { describe, expect, it, vi } from "vitest";

import {
  addCollectionItem,
  createCollection,
  deleteCollection,
  fetchCollection,
  fetchCollections,
  removeCollectionItem,
  renameCollection,
  replaceCollectionItems,
} from "./collections";
import { jsonResponse } from "../test/utils";

function lastCall(fetchSpy: ReturnType<typeof vi.fn>): {
  url: string;
  method: string;
  body?: unknown;
} {
  const [input, init] = fetchSpy.mock.calls.at(-1)! as [
    RequestInfo | URL,
    RequestInit | undefined,
  ];
  return {
    url: input.toString(),
    method: (init?.method ?? "GET").toUpperCase(),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

const emptyList = jsonResponse([]);

describe("collections API", () => {
  it("fetchCollections hits /api/collections", async () => {
    const fetchSpy = vi.fn(() => emptyList);
    vi.stubGlobal("fetch", fetchSpy);

    await fetchCollections();

    expect(lastCall(fetchSpy)).toMatchObject({
      url: "/api/collections",
      method: "GET",
    });
  });

  it("fetchCollection encodes the id", async () => {
    const fetchSpy = vi.fn(() =>
      jsonResponse({ id: "a b", name: "X", kind: "manual", created_at: "t", members: [] }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await fetchCollection("a b");

    expect(lastCall(fetchSpy).url).toBe("/api/collections/a%20b");
  });

  it("createCollection posts the name as JSON", async () => {
    const fetchSpy = vi.fn(() =>
      jsonResponse({ id: "c1", name: "My List", kind: "manual", created_at: "t", member_count: 0, preview: [] }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await createCollection("My List");

    expect(lastCall(fetchSpy)).toMatchObject({
      url: "/api/collections",
      method: "POST",
      body: { name: "My List" },
    });
  });

  it("renameCollection patches the new name", async () => {
    const fetchSpy = vi.fn(() =>
      jsonResponse({ id: "c1", name: "Renamed", kind: "manual", created_at: "t" }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await renameCollection("c1", "Renamed");

    expect(lastCall(fetchSpy)).toMatchObject({
      url: "/api/collections/c1",
      method: "PATCH",
      body: { name: "Renamed" },
    });
  });

  it("deleteCollection issues a DELETE", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await deleteCollection("c1");

    expect(lastCall(fetchSpy)).toMatchObject({
      url: "/api/collections/c1",
      method: "DELETE",
    });
  });

  it("add/remove item target the nested membership route", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await addCollectionItem("c1", "v/1");
    expect(lastCall(fetchSpy)).toMatchObject({
      url: "/api/collections/c1/items/v%2F1",
      method: "POST",
    });

    await removeCollectionItem("c1", "v/1");
    expect(lastCall(fetchSpy)).toMatchObject({
      url: "/api/collections/c1/items/v%2F1",
      method: "DELETE",
    });
  });

  it("replaceCollectionItems puts the ordered id list", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await replaceCollectionItems("c1", ["v3", "v1"]);

    expect(lastCall(fetchSpy)).toMatchObject({
      url: "/api/collections/c1/items",
      method: "PUT",
      body: { video_ids: ["v3", "v1"] },
    });
  });

  it("surfaces ApiError with status for failed requests", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ message: "not found" }, 404));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchCollection("nope")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
    });
  });
});
