// Add-to-collection picker (library-collections task 010): list with
// checkmarks, toggle add/remove, inline create-and-add, lazy query.

import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { AddToCollectionMenu } from "./add-to-collection";
import type { CollectionDto } from "../../api/types";
import { jsonResponse, renderWithProviders } from "../../test/utils";

type RequestLog = Array<{ url: string; method: string; body?: unknown }>;

function collection(id: string, name: string, contains: boolean): CollectionDto {
  return {
    id,
    name,
    kind: "manual",
    created_at: "2026-09-19T00:00:00Z",
    member_count: contains ? 1 : 0,
    preview: [],
    contains_video: contains,
  };
}

function pickerFetch(collections: CollectionDto[], log?: RequestLog) {
  let scoped: CollectionDto[] | null = null;
  return (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    log?.push({ url: url.split("?")[0], method, body });
    if (url.includes("/api/collections") && url.includes("video_id=v1")) {
      return jsonResponse(scoped ?? collections);
    }
    if (url === "/api/collections" && method === "POST") {
      scoped = [
        ...collections,
        collection("c-new", body.name, true),
      ];
      return jsonResponse({
        id: "c-new",
        name: body.name,
        kind: "manual",
        created_at: "2026-09-19T01:00:00Z",
        member_count: 0,
        preview: [],
      });
    }
    if (method === "POST" && url === "/api/collections/c2/items/v1") {
      scoped = collections.map((c) =>
        c.id === "c2" ? { ...c, contains_video: true } : c,
      );
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE" && url === "/api/collections/c1/items/v1") {
      scoped = collections.map((c) =>
        c.id === "c1" ? { ...c, contains_video: false } : c,
      );
      return new Response(null, { status: 204 });
    }
    if (url.includes("/thumbnail")) return new Response("img", { status: 200 });
    return jsonResponse({ message: `unmocked ${method} ${url}` }, 404);
  };
}

function openPicker(
  fetchImplementation: NonNullable<
    Parameters<typeof renderWithProviders>[1]
  >["fetchImplementation"],
) {
  const result = renderWithProviders(
    <AddToCollectionMenu video={{ id: "v1", name: "alpha.mp4" }} />,
    { fetchImplementation },
  );
  fireEvent.click(
    screen.getByRole("button", { name: /add alpha.mp4 to collection/i }),
  );
  return result;
}

describe("AddToCollectionMenu", () => {
  it("lists collections with checkmarks for current members", async () => {
    openPicker(pickerFetch([collection("c1", "Weekend", true), collection("c2", "Empty", false)]));

    expect(await screen.findByRole("menuitem", { name: /weekend/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: /empty/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("menuitem", { name: /new collection/i })).toBeInTheDocument();
  });

  it("defers the membership query until the menu opens", async () => {
    const log: RequestLog = [];
    renderWithProviders(
      <AddToCollectionMenu video={{ id: "v1", name: "alpha.mp4" }} />,
      { fetchImplementation: pickerFetch([collection("c1", "Weekend", false)], log) },
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(
      log.filter((r) => r.url.includes("/api/collections")),
    ).toHaveLength(0);
  });

  it("adds the video to an unchecked collection", async () => {
    const log: RequestLog = [];
    openPicker(pickerFetch([collection("c1", "Weekend", true), collection("c2", "Empty", false)], log));

    fireEvent.click(await screen.findByRole("menuitem", { name: /empty/i }));

    await waitFor(() => {
      expect(
        log.some(
          (r) => r.method === "POST" && r.url === "/api/collections/c2/items/v1",
        ),
      ).toBe(true);
    });
  });

  it("removes the video from a checked collection", async () => {
    const log: RequestLog = [];
    openPicker(pickerFetch([collection("c1", "Weekend", true)], log));

    fireEvent.click(await screen.findByRole("menuitem", { name: /weekend/i }));

    await waitFor(() => {
      expect(
        log.some(
          (r) => r.method === "DELETE" && r.url === "/api/collections/c1/items/v1",
        ),
      ).toBe(true);
    });
  });

  it("creates a collection inline and adds the video to it", async () => {
    const log: RequestLog = [];
    openPicker(pickerFetch([], log));

    fireEvent.click(await screen.findByRole("menuitem", { name: /new collection/i }));
    const input = screen.getByLabelText(/new collection name/i);
    fireEvent.change(input, { target: { value: "My List" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(
        log.find(
          (r) => r.method === "POST" && r.url === "/api/collections" && r.body,
        ),
      ).toMatchObject({ body: { name: "My List" } });
    });
    await waitFor(() => {
      expect(
        log.some(
          (r) => r.method === "POST" && r.url === "/api/collections/c-new/items/v1",
        ),
      ).toBe(true);
    });
  });
});
