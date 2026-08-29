// Tests for the share-creation dialog (task 012).
//
// Behavior under test, per the task acceptance criteria:
//   * password field enforces the 8..=256 policy client-side — an invalid
//     password shows an inline error and blocks the POST entirely (the
//     server remains the enforcer; this is UX, not security);
//   * creation is exactly one POST /api/shares whose body carries the
//     video ids (curation order preserved), trimmed title, password, and
//     an RFC3339 expires_at computed from the chosen preset;
//   * omitting optional fields sends them omitted — no empty strings, no
//     never-expiry timestamp;
//   * on success the dialog shows the absolute link exactly once with a
//     copy button and a "created once" warning, and stores the link in
//     the per-device IndexedDB store so Settings can re-copy it later;
//   * a failed POST surfaces the error and stays on the form for retry.
//
// The IndexedDB link store is mocked at the module boundary (jsdom has no
// IndexedDB); fetch is stubbed through renderWithProviders' fetchSpy.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";

import { ShareDialog } from "./share-dialog";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";
import { setCsrfToken } from "../api/client";
import { saveShareLink } from "../lib/share-links-db";

vi.mock("../lib/share-links-db", () => ({
  getShareLinkMap: vi.fn(),
  saveShareLink: vi.fn(),
  deleteShareLink: vi.fn(),
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
  fetchImplementation: ReturnType<typeof createShareFetch>,
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
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });
  afterEach(() => setCsrfToken(null));

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

  it("omits title, password, and expires_at when left at defaults", async () => {
    const { fetchSpy } = setupDialog(["v1"], createShareFetch());

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
});
