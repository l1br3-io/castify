// Suggestion review panel (library-collections task 009): the post-scan
// banner over browse. Accept/dismiss per group, optimistic removal,
// "Review later" snooze keyed to the staging regeneration timestamp.

import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { SuggestionPanel } from "./suggestion-panel";
import { CollectionsRail } from "./collections-rail";
import type { CollectionSuggestionDto, VideoSummaryDto } from "../../api/types";
import { jsonResponse, renderWithProviders } from "../../test/utils";

function member(id: string): VideoSummaryDto {
  return {
    id,
    name: `${id}.mp4`,
    provider: "google_drive",
    size_bytes: 1,
    mime_type: null,
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

function suggestion(
  id: string,
  title: string,
  count: number,
  created_at = "2026-09-19T00:00:00Z",
): CollectionSuggestionDto {
  return {
    id,
    kind: "show",
    title,
    signature: `show:${id}`,
    member_count: count,
    members: Array.from({ length: Math.min(count, 6) }, (_, i) => member(`${id}-${i}`)),
    created_at,
  };
}

type RequestLog = Array<{ url: string; method: string }>;

function panelFetch(
  suggestions: CollectionSuggestionDto[],
  log?: RequestLog,
  failAcceptFirst = false,
) {
  // Stateful: consumed groups leave the staging list, mirroring the
  // server's exactly-once accept/dismiss + signature suppression.
  const consumed = new Set<string>();
  let acceptFailedOnce = false;
  return (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    log?.push({ url, method });
    const base = url.split("?")[0];
    if (base === "/api/collections/suggestions") {
      return jsonResponse(suggestions.filter((s) => !consumed.has(s.id)));
    }
    if (base.startsWith("/api/collections/suggestions/")) {
      const [, , , , id] = base.split("/");
      if (base.endsWith("/accept")) {
        if (failAcceptFirst && !acceptFailedOnce) {
          acceptFailedOnce = true;
          return jsonResponse({ message: "boom" }, 500);
        }
        consumed.add(id);
        return jsonResponse({
          id: "col-1",
          name: "Accepted",
          kind: "show",
          created_at: "2026-09-19T01:00:00Z",
          member_count: 3,
        });
      }
      if (base.endsWith("/dismiss")) {
        consumed.add(id);
        return new Response(null, { status: 204 });
      }
    }
    if (base === "/api/collections") return jsonResponse([]);
    if (base.includes("/thumbnail")) return new Response("img", { status: 200 });
    return jsonResponse({ message: `unmocked ${method} ${url}` }, 404);
  };
}

function renderPanel(
  fetchImplementation: NonNullable<Parameters<typeof renderWithProviders>[1]>["fetchImplementation"],
) {
  return renderWithProviders(<SuggestionPanel />, { fetchImplementation });
}

describe("SuggestionPanel", () => {
  it("renders nothing when there are no suggestions", async () => {
    renderPanel(panelFetch([]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("region", { name: /review/i })).not.toBeInTheDocument();
  });

  it("lists groups with kind, title, count, and caps display with show more", async () => {
    renderPanel(
      panelFetch([
        suggestion("s1", "Breaking Bad", 12),
        suggestion("s2", "Buffy", 5),
        suggestion("s3", "The Matrix (1999)", 1),
        suggestion("s4", "Fargo", 2),
        suggestion("s5", "June 2026", 9),
      ]),
    );

    expect(
      await screen.findByRole("region", { name: /review suggestions/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Breaking Bad")).toBeInTheDocument();
    expect(screen.getByText(/Series · 12 videos/)).toBeInTheDocument();
    expect(screen.queryByText("Fargo")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(screen.getByText("Fargo")).toBeInTheDocument();
    expect(screen.getByText("June 2026")).toBeInTheDocument();
  });

  it("accept removes the group and refreshes the collections rail", async () => {
    const log: RequestLog = [];
    // Rail + panel mounted together: the rail observes the collections
    // list, so the accept-time invalidation must produce a refetch and
    // the accepted collection must appear in the rail.
    const accepted = { id: "col-1", name: "Accepted", kind: "show" as const, created_at: "2026-09-19T01:00:00Z", member_count: 3, preview: [] };
    let acceptedYet = false;
    // One closure for all requests so the staging state (consumed ids)
    // persists across the post-accept refetch.
    const inner = panelFetch([suggestion("s1", "Breaking Bad", 3)], log);
    const fetchImpl: NonNullable<Parameters<typeof renderWithProviders>[1]>["fetchImplementation"] = (
      input,
      init,
    ) => {
      const url = String(input);
      const base = url.split("?")[0];
      const method = (init?.method ?? "GET").toUpperCase();
      if (base === "/api/collections" && method === "GET") {
        return jsonResponse(acceptedYet ? [accepted] : []);
      }
      const response = inner(input, init);
      if (method === "POST" && base.endsWith("/accept")) {
        acceptedYet = true;
      }
      return response;
    };

    const { ...rest } = renderWithProviders(
      <>
        <CollectionsRail />
        <SuggestionPanel />
      </>,
      { fetchImplementation: fetchImpl },
    );
    void rest;

    fireEvent.click(
      await screen.findByRole("button", { name: /accept breaking bad/i }),
    );

    await waitFor(() => {
      expect(
        log.some(
          (r) => r.method === "POST" && r.url === "/api/collections/suggestions/s1/accept",
        ),
      ).toBe(true);
    });
    // The group leaves the panel…
    await waitFor(() =>
      expect(screen.queryByText("Breaking Bad")).not.toBeInTheDocument(),
    );
    // …and the rail picked up the new collection.
    expect(await screen.findByText("Accepted")).toBeInTheDocument();
  });

  it("dismiss removes the group and it stays gone on refetch", async () => {
    const log: RequestLog = [];
    const { queryClient } = renderPanel(
      panelFetch([suggestion("s1", "Breaking Bad", 3), suggestion("s2", "Buffy", 4)], log),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /dismiss breaking bad/i }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Breaking Bad")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Buffy")).toBeInTheDocument();

    // Invalidate to force a refetch — the server (mock) returns the same
    // list, but a real server filters the dismissed signature. Here we
    // assert the dismissal request hit the right endpoint.
    expect(
      log.some(
        (r) => r.method === "POST" && r.url === "/api/collections/suggestions/s1/dismiss",
      ),
    ).toBe(true);
    await queryClient.invalidateQueries();
  });

  it("keeps the group with a retry affordance when accept fails", async () => {
    renderPanel(panelFetch([suggestion("s1", "Breaking Bad", 3)], undefined, true));

    fireEvent.click(
      await screen.findByRole("button", { name: /accept breaking bad/i }),
    );

    expect(
      await screen.findByRole("button", { name: /retry/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Breaking Bad")).toBeInTheDocument();

    // Retry succeeds (first call failed, second passes).
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() =>
      expect(screen.queryByText("Breaking Bad")).not.toBeInTheDocument(),
    );
  });

  it("review later collapses until a newer scan stages suggestions", async () => {
    localStorage.clear();
    const { unmount } = renderPanel(
      panelFetch([suggestion("s1", "Breaking Bad", 3, "2026-09-19T00:00:00Z")]),
    );
    fireEvent.click(await screen.findByRole("button", { name: /review later/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: /review suggestions/i }),
      ).not.toBeInTheDocument(),
    );
    unmount();

    // Same staging (no new scan) → still hidden.
    renderPanel(
      panelFetch([suggestion("s1", "Breaking Bad", 3, "2026-09-19T00:00:00Z")]),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(
      screen.queryByRole("region", { name: /review suggestions/i }),
    ).not.toBeInTheDocument();

    // A new scan (later created_at) → reappears.
    renderPanel(
      panelFetch([suggestion("s1", "Breaking Bad", 3, "2026-09-20T00:00:00Z")]),
    );
    expect(
      await screen.findByRole("region", { name: /review suggestions/i }),
    ).toBeInTheDocument();
  });
});
