// Shares API client coverage (sharing tasks 002-004 contract, plus the
// share-management append client, task 003).
//
// Asserts the exact paths/methods each client function hits (the share
// surface is the security boundary — a wrong path silently changes which
// auth regime applies) plus the error mapping the landing page branches
// on: 401 locked (password gate), 410 terminal (revoked/expired), 404
// unknown token.

import { describe, expect, it, vi } from "vitest";

import {
  appendToShare,
  createShare,
  deleteShare,
  fetchShareItems,
  fetchShareItemsOwned,
  fetchShares,
  resolveShare,
  replaceShareItems,
  revokeShare,
  unlockShare,
} from "./shares";
import { ApiError } from "./client";
import { jsonResponse } from "../test/utils";

function lastCall(fetchSpy: ReturnType<typeof vi.fn>): string {
  const input = fetchSpy.mock.calls.at(-1)![0] as RequestInfo | URL;
  return input.toString();
}

function lastInit(fetchSpy: ReturnType<typeof vi.fn>): RequestInit {
  return fetchSpy.mock.calls.at(-1)![1] as RequestInit;
}

describe("shares owner client", () => {
  it("createShare POSTs the request body to /api/shares", async () => {
    const fetchSpy = vi.fn(() =>
      jsonResponse(
        { id: "s1", title: "Trip", token: "tok_abc", share_url: "/share/tok_abc" },
        201,
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const created = await createShare({
      video_ids: ["v1", "v2"],
      title: "Trip",
      password: "hunter2222",
      expires_at: "2027-01-01T00:00:00Z",
    });

    expect(lastCall(fetchSpy)).toBe("/api/shares");
    expect(lastInit(fetchSpy).method).toBe("POST");
    expect(JSON.parse(lastInit(fetchSpy).body as string)).toEqual({
      video_ids: ["v1", "v2"],
      title: "Trip",
      password: "hunter2222",
      expires_at: "2027-01-01T00:00:00Z",
    });
    expect(created.token).toBe("tok_abc");
    expect(created.share_url).toBe("/share/tok_abc");
  });

  it("fetchShares GETs /api/shares and returns the list DTOs", async () => {
    const fetchSpy = vi.fn(() =>
      jsonResponse([
        {
          id: "s1",
          title: "Trip",
          item_count: 2,
          created_at: "2026-08-01T00:00:00Z",
          expires_at: null,
          revoked_at: null,
          status: "active",
        },
        {
          id: "s2",
          title: "Old",
          item_count: 1,
          created_at: "2026-07-01T00:00:00Z",
          expires_at: "2026-07-15T00:00:00Z",
          revoked_at: null,
          status: "expired",
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const shares = await fetchShares();

    expect(lastCall(fetchSpy)).toBe("/api/shares");
    expect(lastInit(fetchSpy).method).toBe("GET");
    expect(shares).toHaveLength(2);
    expect(shares[0].status).toBe("active");
    expect(shares[1].item_count).toBe(1);
  });

  it("revokeShare DELETEs /api/shares/{id} and resolves on 204", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await revokeShare("s1");

    expect(lastCall(fetchSpy)).toBe("/api/shares/s1");
    expect(lastInit(fetchSpy).method).toBe("DELETE");
  });

  it("revokeShare encodes the id", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await revokeShare("id/with/slash");

    expect(lastCall(fetchSpy)).toBe("/api/shares/id%2Fwith%2Fslash");
  });

  it("deleteShare DELETEs with purge=true and resolves on 204", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await deleteShare("s1");

    expect(lastCall(fetchSpy)).toBe("/api/shares/s1?purge=true");
    expect(lastInit(fetchSpy).method).toBe("DELETE");
  });

  it("deleteShare encodes the id", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await deleteShare("id/with/slash");

    expect(lastCall(fetchSpy)).toBe("/api/shares/id%2Fwith%2Fslash?purge=true");
  });

  it("replaceShareItems PUTs the full replacement list and resolves on 204", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await replaceShareItems("s1", ["v2", "v1"]);

    expect(lastCall(fetchSpy)).toBe("/api/shares/s1/items");
    expect(lastInit(fetchSpy).method).toBe("PUT");
    expect(JSON.parse(lastInit(fetchSpy).body as string)).toEqual({
      video_ids: ["v2", "v1"],
    });
  });

  it("replaceShareItems encodes the id", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await replaceShareItems("id/with/slash", ["v1"]);

    expect(lastCall(fetchSpy)).toBe("/api/shares/id%2Fwith%2Fslash/items");
  });

  it("appendToShare POSTs the fresh ids to /api/shares/{id}/items and resolves on 204", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await appendToShare("s1", ["v3", "v4"]);

    expect(lastCall(fetchSpy)).toBe("/api/shares/s1/items");
    expect(lastInit(fetchSpy).method).toBe("POST");
    expect(JSON.parse(lastInit(fetchSpy).body as string)).toEqual({
      video_ids: ["v3", "v4"],
    });
  });

  it("appendToShare encodes the id", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await appendToShare("id/with/slash", ["v1"]);

    expect(lastCall(fetchSpy)).toBe("/api/shares/id%2Fwith%2Fslash/items");
  });

  it("fetchShareItemsOwned GETs /api/shares/{id}/items and returns the wrapped tree payload", async () => {
    const payload = {
      folders: [{ id: "f1", parent_id: null, name: "Trip", position: 0 }],
      items: [{ id: "v1", folder_id: "f1" }],
    };
    const fetchSpy = vi.fn(() => jsonResponse(payload));
    vi.stubGlobal("fetch", fetchSpy);

    const resolved = await fetchShareItemsOwned("s1");

    expect(lastCall(fetchSpy)).toBe("/api/shares/s1/items");
    expect(lastInit(fetchSpy).method).toBe("GET");
    expect(resolved).toEqual(payload);
  });
});

describe("shares recipient client", () => {
  it("resolveShare GETs /api/share/{token}", async () => {
    const fetchSpy = vi.fn(() =>
      jsonResponse({ title: "Trip", item_count: 2, locked: true, status: "active" }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const resolved = await resolveShare("tok_abc");

    expect(lastCall(fetchSpy)).toBe("/api/share/tok_abc");
    expect(resolved.locked).toBe(true);
    expect(resolved.item_count).toBe(2);
  });

  it("resolveShare encodes the token", async () => {
    const fetchSpy = vi.fn(() =>
      jsonResponse({ title: "T", item_count: 0, locked: false, status: "active" }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await resolveShare("tok/with/slash");

    expect(lastCall(fetchSpy)).toBe("/api/share/tok%2Fwith%2Fslash");
  });

  it("fetchShareItems GETs /api/share/{token}/items and returns the wrapped tree payload", async () => {
    const payload = {
      folders: [{ id: "f1", parent_id: null, name: "Trip", position: 0 }],
      items: [{ id: "v1", folder_id: "f1" }],
    };
    const fetchSpy = vi.fn(() => jsonResponse(payload));
    vi.stubGlobal("fetch", fetchSpy);

    const resolved = await fetchShareItems("tok_abc");

    expect(lastCall(fetchSpy)).toBe("/api/share/tok_abc/items");
    expect(resolved).toEqual(payload);
  });

  it("unlockShare POSTs the password to /api/share/{token}/unlock and resolves on 204", async () => {
    const fetchSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await unlockShare("tok_abc", "hunter2222");

    expect(lastCall(fetchSpy)).toBe("/api/share/tok_abc/unlock");
    expect(lastInit(fetchSpy).method).toBe("POST");
    expect(JSON.parse(lastInit(fetchSpy).body as string)).toEqual({
      password: "hunter2222",
    });
  });
});

describe("shares error mapping", () => {
  it.each([
    [401, "share locked — password gate not passed"],
    [410, "share terminal — revoked or expired"],
    [404, "unknown token"],
  ])("resolveShare surfaces %d as an ApiError the landing page can branch on",
    async (status, label) => {
      const fetchSpy = vi.fn(() =>
        jsonResponse({ code: `share_${status === 401 ? "locked" : "unavailable"}`, message: label }, status),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const err = await resolveShare("tok_abc").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
    },
  );

  it("unlockShare surfaces 429 from the rate limiter", async () => {
    const fetchSpy = vi.fn(() => jsonResponse({ message: "too many attempts" }, 429));
    vi.stubGlobal("fetch", fetchSpy);

    const err = await unlockShare("tok_abc", "wrong").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
  });
});
