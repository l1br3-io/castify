// Tests for the share-creation dialog (task 012, extended by
// share-management tasks 001 and 003).
//
// Behavior under test, per the task acceptance criteria:
//   * the title field opens prefilled with a generated name; a reroll
//     control replaces it with a fresh draw; the prefill runs once per
//     mount and never fights the user's typing (share-management task
//     001 — the generator itself is unit-tested in lib/share-names.test,
//     and is mocked here so dialog behavior is decoupled from RNG draws);
//   * password field enforces the 8..=256 policy client-side — an invalid
//     password shows an inline error and blocks the POST entirely (the
//     server remains the enforcer; this is UX, not security);
//   * creation is exactly one POST /api/shares whose body carries the
//     video ids (curation order preserved), trimmed title, password, and
//     an RFC3339 expires_at computed from the chosen preset;
//   * omitting optional fields sends them omitted — no empty strings, no
//     never-expiry timestamp; clearing the prefilled title restores that
//     omission (server default backstop unchanged);
//   * on success the dialog shows the absolute link exactly once with a
//     copy button and a "created once" warning, and stores the link in the
//     per-device IndexedDB store so Settings can re-copy it later;
//   * a failed POST surfaces the error and stays on the form for retry;
//   * "Add to existing" mode (share-management task 003) — the picker
//     lists only active shares, filters by title substring client-side
//     (zero extra requests), and after selecting a share surfaces the
//     already-member overlap ("k of N already in this share"). Add POSTs
//     exactly the fresh ids in one request, is disabled when nothing is
//     new, surfaces errors inline for retry, and closes on success after
//     invalidating the shares cache. Typed new-share fields survive a
//     mode round-trip; Escape/backdrop stay guarded while the POST is
//     pending (parity with creation).
//
// The IndexedDB link store is mocked at the module boundary (jsdom has no
// IndexedDB); fetch is stubbed through renderWithProviders' fetchSpy.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";

import { ShareDialog } from "./share-dialog";
import {
  jsonResponse,
  jsonError,
  renderWithProviders,
  type FetchHandler,
} from "../test/utils";
import { setCsrfToken } from "../api/client";
import { getShortLink, saveShareLink } from "../lib/share-links-db";
import { generateShareName } from "../lib/share-names";
import type { ShareDto } from "../api/shares";

vi.mock("../lib/share-links-db", () => ({
  getShareLinkMap: vi.fn(),
  saveShareLink: vi.fn(),
  deleteShareLink: vi.fn(),
  getShortLink: vi.fn(),
  saveShortLink: vi.fn(),
}));

vi.mock("../lib/share-names", () => ({
  generateShareName: vi.fn(),
}));

const CREATED_BODY = {
  id: "s1",
  title: "Trip footage",
  token: "tok_abc",
  share_url: "/share/tok_abc",
};

function createShareFetch() {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/shares" && method === "POST")
      return jsonResponse(CREATED_BODY, 201);
    return jsonError(404, `unmocked ${method} ${url}`);
  };
}

type SharePostBody = {
  video_ids?: string[];
  title?: string;
  password?: string;
  expires_at?: string;
};

function postCalls(fetchSpy: {
  mock: { calls: [unknown, RequestInit?][] };
}): { body: SharePostBody }[] {
  return fetchSpy.mock.calls
    .filter(([input]) => String(input) === "/api/shares")
    .map(([, init]) => ({
      body: JSON.parse(String(init?.body ?? "{}")) as SharePostBody,
    }));
}

function setupDialog(
  videoIds: string[],
  fetchImplementation: FetchHandler,
  itemLabel = "cat.mp4",
) {
  const onClose = vi.fn();
  const rendered = renderWithProviders(
    <ShareDialog videoIds={videoIds} itemLabel={itemLabel} onClose={onClose} />,
    { fetchImplementation },
  );
  return { ...rendered, onClose };
}

describe("ShareDialog", () => {
  beforeEach(() => {
    setCsrfToken("csrf-test");
    vi.mocked(saveShareLink).mockResolvedValue(undefined);
    vi.mocked(getShortLink).mockResolvedValue(null);
    // Deterministic prefill for every test; reroll tests layer
    // mockReturnValueOnce sequences on top after resetting.
    vi.mocked(generateShareName).mockReturnValue("quiet-harbor-42");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });
  afterEach(() => setCsrfToken(null));

  // --- generated-name prefill + reroll (share-management task 001) ---

  it("opens with the title prefilled by the generator", () => {
    setupDialog(["v1"], createShareFetch());

    expect(screen.getByLabelText(/title/i)).toHaveValue("quiet-harbor-42");
  });

  it("keeps the user's edit — prefill never fights typing on rerender", () => {
    setupDialog(["v1"], createShareFetch());

    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "quiet-harbor-42!" },
    });
    // Force an unrelated rerender; the title must survive it.
    fireEvent.change(screen.getByLabelText(/expires/i), {
      target: { value: "7" },
    });
    expect(screen.getByLabelText(/title/i)).toHaveValue("quiet-harbor-42!");
  });

  it("reroll replaces the prefilled name with a fresh draw", () => {
    vi.mocked(generateShareName)
      .mockReset()
      .mockReturnValueOnce("quiet-harbor-42")
      .mockReturnValueOnce("amber-lantern-07");
    setupDialog(["v1"], createShareFetch());

    fireEvent.click(screen.getByRole("button", { name: /reroll/i }));

    expect(screen.getByLabelText(/title/i)).toHaveValue("amber-lantern-07");
  });

  it("submits the prefilled title as-is", async () => {
    const { fetchSpy } = setupDialog(["v1"], createShareFetch());

    fireEvent.click(screen.getByRole("button", { name: /create share/i }));

    await screen.findByText(/only once/i);
    const calls = postCalls(fetchSpy);
    expect(calls[0].body.title).toBe("quiet-harbor-42");
  });

  // --- client-side password policy (8..=256) ---

  it("rejects a password shorter than 8 characters without POSTing", async () => {
    const { fetchSpy } = setupDialog(["v1"], createShareFetch());

    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "short" },
    });
    expect(
      await screen.findByText(/at least 8 characters/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /create share/i }));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.filter(([i]) => String(i) === "/api/shares"),
      ).toHaveLength(0),
    );
  });

  it("rejects a password longer than 256 characters without POSTing", () => {
    setupDialog(["v1"], createShareFetch());

    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "x".repeat(257) },
    });

    expect(screen.getByText(/at most 256 characters/i)).toBeInTheDocument();
  });

  // --- creation flow: one POST, correct body ---

  it("sends exactly one POST with ids, trimmed title, password, and preset expiry", async () => {
    const { fetchSpy } = setupDialog(["v1", "v2"], createShareFetch(), "2 videos");
    const before = Date.now();

    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "  Trip footage  " },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "hunter22" },
    });
    fireEvent.change(screen.getByLabelText(/expires/i), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create share/i }));

    await screen.findByText(/only once/i);
    const calls = postCalls(fetchSpy);
    expect(calls).toHaveLength(1);

    const body = calls[0].body;
    expect(body.video_ids).toEqual(["v1", "v2"]);
    expect(body.title).toBe("Trip footage");
    expect(body.password).toBe("hunter22");

    // 7-day preset → RFC3339 expires_at ~ now + 7 days (±5 min slop).
    expect(typeof body.expires_at).toBe("string");
    const expiresAt = new Date(body.expires_at as string);
    const expectedMin = before + 7 * 86_400_000 - 300_000;
    const expectedMax = Date.now() + 7 * 86_400_000 + 300_000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  it("omits title, password, and expires_at when the prefill is cleared", async () => {
    const { fetchSpy } = setupDialog(["v1"], createShareFetch());

    // Clearing the generated name restores the title-less body — the
    // server's DEFAULT_TITLE backstop applies, exactly as before prefill.
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /create share/i }));

    await screen.findByText(/only once/i);
    const calls = postCalls(fetchSpy);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ video_ids: ["v1"] });
  });

  // --- link shown once + per-device persistence ---

  it("shows the absolute link once with copy + warning, and stores it in the link DB", async () => {
    setupDialog(["v1"], createShareFetch());

    fireEvent.click(screen.getByRole("button", { name: /create share/i }));

    expect(
      await screen.findByText(`${window.location.origin}/share/tok_abc`),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy link/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/only once/i)).toBeInTheDocument();

    await waitFor(() =>
      expect(saveShareLink).toHaveBeenCalledWith("s1", "/share/tok_abc"),
    );
  });

  it("copies the link and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    setupDialog(["v1"], createShareFetch());

    fireEvent.click(screen.getByRole("button", { name: /create share/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /copy link/i }),
    );

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/share/tok_abc`,
      ),
    );
    expect(
      await screen.findByRole("button", { name: /^copied$/i }),
    ).toBeInTheDocument();
  });

  // --- short link (short-links task 004) ---

  /** Creation POST plus the spoo.me mint — both over the one fetch stub. */
  function createShareAndShortenFetch(): FetchHandler {
    return (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "https://spoo.me/" && method === "POST")
        return jsonResponse({ short_url: "https://spoo.me/U1b05Y" });
      if (url === "/api/shares" && method === "POST")
        return jsonResponse(CREATED_BODY, 201);
      return jsonError(404, `unmocked ${method} ${url}`);
    };
  }

  it("post-creation view offers Copy short link; a mint renders the short URL as text", async () => {
    setupDialog(["v1"], createShareAndShortenFetch());

    fireEvent.click(screen.getByRole("button", { name: /create share/i }));
    expect(await screen.findByText(/only once/i)).toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: /copy short link/i }),
    ).toBeInTheDocument();
    // The dialog already displays the canonical link as text…
    expect(
      screen.getByText(`${window.location.origin}/share/tok_abc`),
    ).toBeInTheDocument();
    // …but the minted alias appears only after the explicit click.
    expect(screen.queryByText(/spoo\.me/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /copy short link/i }));

    expect(await screen.findByText("https://spoo.me/U1b05Y")).toBeInTheDocument();
    expect(screen.getByText(/third.part/i)).toBeInTheDocument();
  });

  it("the warning notes the short link's third-party dependency even before minting", async () => {
    setupDialog(["v1"], createShareFetch());

    fireEvent.click(screen.getByRole("button", { name: /create share/i }));

    expect(await screen.findByText(/third.part/i)).toBeInTheDocument();
  });

  // --- failure + retry ---

  it("surfaces a failed POST and allows retry from the same form", async () => {
    let fails = true;
    const { fetchSpy } = setupDialog(
      ["v1"],
      (input, init) => {
        const url = String(input);
        if (url === "/api/shares" && (init?.method ?? "GET") === "POST") {
          if (fails) return jsonError(500, "database is locked");
          return jsonResponse(CREATED_BODY, 201);
        }
        return jsonError(404, "unmocked");
      },
    );

    fireEvent.click(screen.getByRole("button", { name: /create share/i }));
    expect(await screen.findByText(/database is locked/i)).toBeInTheDocument();

    // Form is still up — retry succeeds.
    fails = false;
    fireEvent.click(screen.getByRole("button", { name: /create share/i }));
    expect(await screen.findByText(/only once/i)).toBeInTheDocument();
    expect(postCalls(fetchSpy)).toHaveLength(2);
  });

  // --- close behavior ---

  it("closes via Cancel before creation and via Done after", async () => {
    const { onClose } = setupDialog(["v1"], createShareFetch());

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /create share/i }));
    fireEvent.click(await screen.findByRole("button", { name: /done/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  it("ignores Escape while the create POST is in flight", async () => {
    // A share created behind a closed dialog is recoverable only via
    // Settings, so Escape must not close mid-POST (parity with the
    // backdrop click guard).
    let release: (value: Response) => void = () => {};
    const inFlight = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { onClose } = setupDialog(["v1"], (input, init) => {
      const url = String(input);
      if (url === "/api/shares" && (init?.method ?? "GET") === "POST")
        return inFlight;
      return jsonError(404, `unmocked ${init?.method ?? "GET"} ${url}`);
    });

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /create share/i }));
    expect(await screen.findByRole("button", { name: /creating/i })).toBeDisabled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // The POST still completes into the created view once it resolves.
    release(jsonResponse(CREATED_BODY, 201));
    expect(await screen.findByText(/only once/i)).toBeInTheDocument();
  });

  it("uses singular copy for a single video and plural for many", async () => {
    setupDialog(["v1"], createShareFetch());
    await screen.findByRole("dialog");
    expect(screen.getByText(/watch this video without an account/i)).toBeInTheDocument();

    setupDialog(["v1", "v2", "v3"], createShareFetch());
    expect(
      await screen.findByText(/watch these 3 videos without an account/i),
    ).toBeInTheDocument();
  });

  // --- add-to-existing mode (share-management task 003) ---

  function shareDto(
    overrides: Partial<ShareDto> & Pick<ShareDto, "id" | "title" | "status">,
  ): ShareDto {
    return {
      item_count: 0,
      created_at: "2026-08-01T00:00:00Z",
      expires_at: null,
      revoked_at: null,
      ...overrides,
    };
  }

  const PICKER_SHARES: ShareDto[] = [
    shareDto({ id: "s1", title: "Movie night", status: "active", item_count: 2 }),
    shareDto({ id: "s2", title: "Grandma's visit", status: "active", item_count: 1 }),
    shareDto({ id: "s3", title: "Old trip", status: "revoked" }),
    shareDto({ id: "s4", title: "Stale", status: "expired" }),
  ];

  /** Fetch handler for the existing-mode surface: GET /api/shares, GET
   * members per share id, POST append (204 unless overridden). */
  function pickerFetch(opts: {
    shares?: ShareDto[];
    /** shareId -> member video ids. */
    members?: Record<string, string[]>;
    /** GET /api/shares/{id}/items override (e.g. a held response). */
    membersResponse?: () => Response | Promise<Response>;
    /** POST /api/shares/{id}/items override (default: 204). */
    appendResponse?: () => Response | Promise<Response>;
  }): FetchHandler {
    const shares = opts.shares ?? PICKER_SHARES;
    return (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/shares" && method === "GET") return jsonResponse(shares);
      const items = url.match(/^\/api\/shares\/([^/]+)\/items$/);
      if (items) {
        const shareId = decodeURIComponent(items[1]!);
        if (method === "GET") {
          if (opts.membersResponse) return opts.membersResponse();
          const ids = opts.members?.[shareId] ?? [];
          // Wrapped tree payload (share-folders task 004 shape).
          return jsonResponse({ folders: [], items: ids.map((id) => ({ id })) });
        }
        if (method === "POST") {
          return opts.appendResponse ? opts.appendResponse() : new Response(null, { status: 204 });
        }
      }
      return jsonError(404, `unmocked ${method} ${url}`);
    };
  }

  function countRequests(
    fetchSpy: { mock: { calls: [unknown, RequestInit?][] } },
    predicate: (url: string, method: string) => boolean,
  ): number {
    return fetchSpy.mock.calls.filter(([input, init]) => {
      const url = String(input);
      const method = (init?.method as string | undefined) ?? "GET";
      return predicate(url, method);
    }).length;
  }

  function appendPostBodies(fetchSpy: {
    mock: { calls: [unknown, RequestInit?][] };
  }): { shareId: string; body: { video_ids?: string[] } }[] {
    return fetchSpy.mock.calls
      .map(([input, init]) => {
        const url = String(input);
        const method = (init?.method as string | undefined) ?? "GET";
        const match = url.match(/^\/api\/shares\/([^/]+)\/items$/);
        if (!match || method !== "POST") return null;
        return {
          shareId: decodeURIComponent(match[1]!),
          body: JSON.parse(String(init?.body ?? "{}")) as { video_ids?: string[] },
        };
      })
      .filter((c): c is { shareId: string; body: { video_ids?: string[] } } => c !== null);
  }

  async function openPicker(
    fetchImplementation: FetchHandler,
    videoIds = ["v1", "v2"],
  ) {
    const rendered = setupDialog(videoIds, fetchImplementation);
    fireEvent.click(screen.getByRole("button", { name: "Add to existing" }));
    return rendered;
  }

  async function selectShare(name: RegExp): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name }));
  }

  it("defaults to the new-share form; the toggle switches modes", () => {
    setupDialog(["v1"], pickerFetch({}));
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/search shares/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add to existing" }));
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/search shares/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New share" }));
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
  });

  it("lists only active shares with title + item count", async () => {
    await openPicker(pickerFetch({}));
    await screen.findByRole("button", { name: /movie night/i });

    expect(screen.getByRole("button", { name: /grandma's visit/i })).toBeInTheDocument();
    expect(screen.queryByText(/old trip/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
    // Per-row item counts (title + count render as one button label).
    expect(screen.getByRole("button", { name: /movie night.*2 videos/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /grandma's visit.*1 video/i })).toBeInTheDocument();
  });

  it("filters by title substring case-insensitively, with zero extra requests", async () => {
    const { fetchSpy } = await openPicker(pickerFetch({}));
    await screen.findByRole("button", { name: /movie night/i });

    fireEvent.change(screen.getByLabelText(/search shares/i), {
      target: { value: "GRANDMA" },
    });

    expect(screen.getByRole("button", { name: /grandma's visit/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /movie night/i })).not.toBeInTheDocument();
    // Client-side only: the shares list was fetched once, filtering added none.
    expect(
      countRequests(fetchSpy, (url, method) => url === "/api/shares" && method === "GET"),
    ).toBe(1);
  });

  it("shows an empty state when no share matches the search", async () => {
    await openPicker(pickerFetch({}));
    await screen.findByRole("button", { name: /movie night/i });

    fireEvent.change(screen.getByLabelText(/search shares/i), {
      target: { value: "zzz" },
    });

    expect(screen.getByText(/no shares match/i)).toBeInTheDocument();
  });

  it("shows an empty state when the owner has no active shares", async () => {
    await openPicker(
      pickerFetch({
        shares: [shareDto({ id: "s3", title: "Old trip", status: "revoked" })],
      }),
    );

    expect(await screen.findByText(/no active shares/i)).toBeInTheDocument();
  });

  it("surfaces already-member videos and adds only the fresh ids in one POST", async () => {
    const { fetchSpy, onClose } = await openPicker(
      pickerFetch({ members: { s1: ["v9", "v1"] } }),
    );
    await selectShare(/movie night/i);

    // v1 of {v1, v2} is already a member — the note says so.
    expect(await screen.findByText(/1 of 2 already in this share/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add to share" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const posts = appendPostBodies(fetchSpy);
    expect(posts).toHaveLength(1);
    expect(posts[0].shareId).toBe("s1");
    expect(posts[0].body.video_ids).toEqual(["v2"]);

    // Success invalidates the still-active shares query — Settings sees
    // the new item_count without another server-side nudge.
    await waitFor(() =>
      expect(
        countRequests(fetchSpy, (url, method) => url === "/api/shares" && method === "GET"),
      ).toBe(2),
    );
  });

  it("keeps Add disabled until the selected share's members load", async () => {
    let release: (value: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { fetchSpy } = await openPicker(
      pickerFetch({ membersResponse: () => held }),
    );
    await selectShare(/movie night/i);

    const add = screen.getByRole("button", { name: /add to share/i });
    expect(add).toBeDisabled();

    release(jsonResponse({ folders: [], items: [{ id: "v9" }] }));
    // No overlap with {v1, v2} — both are fresh, so Add unlocks.
    expect(
      await screen.findByText(/not in this share yet/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add to share/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /add to share/i }));
    await waitFor(() => expect(appendPostBodies(fetchSpy)).toHaveLength(1));
  });

  it("disables Add when every video is already a member", async () => {
    const { fetchSpy } = await openPicker(
      pickerFetch({ members: { s1: ["v1", "v2"] } }),
    );
    await selectShare(/movie night/i);

    expect(await screen.findByText(/2 of 2 already in this share/i)).toBeInTheDocument();
    const add = screen.getByRole("button", { name: /add to share/i });
    expect(add).toBeDisabled();

    fireEvent.click(add);
    expect(appendPostBodies(fetchSpy)).toHaveLength(0);
  });

  it("surfaces an append error inline and stays open for retry", async () => {
    let fails = true;
    const { fetchSpy, onClose } = await openPicker(
      pickerFetch({
        members: { s1: ["v1"] },
        appendResponse: () =>
          fails ? jsonError(409, "share is revoked") : new Response(null, { status: 204 }),
      }),
    );
    await selectShare(/movie night/i);
    expect(await screen.findByText(/1 of 2 already in this share/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add to share/i }));
    expect(await screen.findByText(/share is revoked/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Retry from the same picker state succeeds.
    fails = false;
    fireEvent.click(screen.getByRole("button", { name: /add to share/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(appendPostBodies(fetchSpy)).toHaveLength(2);
  });

  it("preserves typed new-share fields across a mode round-trip", async () => {
    setupDialog(["v1"], pickerFetch({}));

    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "my custom name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to existing" }));
    await screen.findByLabelText(/search shares/i);

    fireEvent.click(screen.getByRole("button", { name: "New share" }));

    expect(screen.getByLabelText(/title/i)).toHaveValue("my custom name");
  });

  it("ignores Escape while the append POST is in flight", async () => {
    let release: (value: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { onClose } = await openPicker(
      pickerFetch({
        members: { s1: ["v1"] },
        appendResponse: () => held,
      }),
    );
    await selectShare(/movie night/i);
    expect(await screen.findByText(/1 of 2 already in this share/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add to share/i }));
    expect(await screen.findByRole("button", { name: /adding/i })).toBeDisabled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // The POST still completes — success closes the dialog.
    release(new Response(null, { status: 204 }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
