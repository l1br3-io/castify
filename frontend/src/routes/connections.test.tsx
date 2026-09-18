import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, within, act } from "@testing-library/react";

import { ConnectionsPage } from "./connections";
import { setCsrfToken } from "../api/client";
import { jsonResponse, jsonError, renderWithProviders } from "../test/utils";

// Fetch dispatch for the connections page. The page issues two GETs on mount:
// `GET /api/connections` (the list) and `GET /api/connections/available`
// (configured-providers probe). Mutations hit `POST .../start` and
// `DELETE /api/connections/{id}`.

// `GET /api/connections/available` now returns a list: one entry per
// provider with its connect-flow kind and configured flag. ALL_AVAILABLE
// mirrors a fully-configured backend; NONE_AVAILABLE is a defensive
// fixture (a current backend always reports s3 configured) used to pin the
// empty-state branch.

// The S3 entry's credentials schema — mirrors the backend's
// `credentials_schema()` in `crates/catalog/src/providers/s3.rs`. The form
// renders this generically; fixtures below vary it to prove that.
const S3_SCHEMA = {
  fields: [
    {
      key: "endpoint",
      label: "Endpoint",
      secret: false,
      placeholder: "https://<account>.r2.cloudflarestorage.com",
    },
    {
      key: "region",
      label: "Region",
      secret: false,
      placeholder: "auto (Cloudflare R2) · us-east-1 (MinIO)",
    },
    { key: "bucket", label: "Bucket", secret: false, placeholder: "media" },
    {
      key: "access_key_id",
      label: "Access key ID",
      secret: true,
      placeholder: "AKIA…",
    },
    {
      key: "secret_access_key",
      label: "Secret access key",
      secret: true,
      placeholder: "paste the secret access key",
    },
    {
      key: "prefix",
      label: "Key prefix (optional)",
      secret: false,
      placeholder: "media/",
    },
  ],
};

const ALL_AVAILABLE = [
  { id: "google_drive", authMode: "oauth", configured: true },
  { id: "dropbox", authMode: "oauth", configured: true },
  { id: "onedrive", authMode: "oauth", configured: true },
  {
    id: "s3",
    authMode: "credentials",
    configured: true,
    credentials: S3_SCHEMA,
  },
];

const NONE_AVAILABLE = [
  { id: "google_drive", authMode: "oauth", configured: false },
  { id: "dropbox", authMode: "oauth", configured: false },
  { id: "onedrive", authMode: "oauth", configured: false },
  { id: "s3", authMode: "credentials", configured: false },
];

function connectionsFetch(
  connections: unknown,
  available: unknown = ALL_AVAILABLE,
) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/connections" && method === "GET")
      return jsonResponse(connections);
    if (url === "/api/connections/available") return jsonResponse(available);
    return jsonError(404, "unmocked");
  };
}

const GOOGLE_CONNECTED = {
  id: "c1",
  provider: "google_drive",
  provider_account_email: "user@example.com",
  connected_at: "2026-01-01T00:00:00Z",
  scan_status: "idle",
  last_scan_at: "2026-01-02T00:00:00Z",
  video_count: 7,
};

const S3_CONNECTED = {
  id: "c-s3",
  provider: "s3",
  provider_account_email: null,
  connected_at: "2026-01-01T00:00:00Z",
  scan_status: "scanning",
  last_scan_at: null,
  video_count: 0,
};

describe("ConnectionsPage", () => {
  beforeEach(() => setCsrfToken("csrf-test"));
  afterEach(() => setCsrfToken(null));

  /** The S3 card in its revealed-form state, helper for the fill-and-submit
   * tests below. Resolves once the form's first input is rendered. */
  async function openS3Form(): Promise<HTMLElement> {
    const card = (await screen.findByText("S3-Compatible Storage")).closest(
      "article",
    );
    expect(card).not.toBeNull();
    fireEvent.click(
      within(card as HTMLElement).getByRole("button", { name: /^connect$/i }),
    );
    expect(
      await within(card as HTMLElement).findByLabelText("Endpoint"),
    ).toBeInTheDocument();
    return card as HTMLElement;
  }

  function fillCredentials(card: HTMLElement): void {
    fireEvent.change(within(card).getByLabelText("Endpoint"), {
      target: { value: "http://127.0.0.1:9000" },
    });
    fireEvent.change(within(card).getByLabelText("Region"), {
      target: { value: "us-east-1" },
    });
    fireEvent.change(within(card).getByLabelText("Bucket"), {
      target: { value: "media" },
    });
    fireEvent.change(within(card).getByLabelText("Access key ID"), {
      target: { value: "minioadmin" },
    });
    fireEvent.change(within(card).getByLabelText("Secret access key"), {
      target: { value: "miniosecret" },
    });
  }

  it("renders a connected card with email, video count, and disconnect", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([GOOGLE_CONNECTED]),
    });

    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByText(/7 media/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /disconnect/i }),
    ).toBeInTheDocument();
    const card = screen.getByText("user@example.com").closest("article");
    expect(
      within(card as HTMLElement).getAllByTestId("provider-mark").length,
    ).toBeGreaterThan(0);
  });

  it("tells the user the library is ready once a scan has settled", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([GOOGLE_CONNECTED]),
    });

    await screen.findByText("user@example.com");
    // Idle + count + last-scanned date = the "library ready" tell (FR-2.3);
    // no LED while nothing is scanning.
    expect(screen.getByText("Synced")).toBeInTheDocument();
    expect(screen.getByText(/scanned/i)).toBeInTheDocument();
    expect(screen.queryByTestId("scan-led")).not.toBeInTheDocument();
  });

  it("pins the scan LED to scanning cards only", async () => {
    const scanning = {
      ...GOOGLE_CONNECTED,
      scan_status: "scanning",
      video_count: 4,
    };
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([scanning]),
    });

    expect(await screen.findByText("Scanning")).toBeInTheDocument();
    expect(screen.getByTestId("scan-led")).toBeInTheDocument();
  });

  it("presents scan errors with the danger tone, not the accent", async () => {
    const errored = {
      ...GOOGLE_CONNECTED,
      scan_status: "error",
      last_scan_at: null,
    };
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([errored]),
    });

    expect(await screen.findByText("Scan error")).toBeInTheDocument();
    expect(
      screen.getByText("Scan failed. Try reconnecting the provider."),
    ).toHaveClass("text-[var(--color-danger)]");
  });

  it("renders an available (not connected) card with a connect button", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([]),
    });

    // Four provider cards, none connected: the three OAuth providers get
    // brand sign-in buttons that state the action (task 010), S3 gets a
    // Connect button that reveals the credentials form instead.
    expect(
      await screen.findByText("S3-Compatible Storage"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(4);
    expect(
      screen.getByRole("button", { name: "Connect Google Drive" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect Dropbox" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect OneDrive" }),
    ).toBeInTheDocument();
    // S3 has no brand guidelines — the standard primary, exact "Connect"
    // (string name matches the full accessible name only; e2e selectors
    // depend on this name — see s3-connect.spec.ts).
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("pairs every provider card with its mark — identity is never color alone", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([]),
    });

    for (const label of [
      "Google Drive",
      "Dropbox",
      "OneDrive",
      "S3-Compatible Storage",
    ]) {
      const card = (await screen.findByText(label)).closest("article");
      expect(card).not.toBeNull();
      expect(
        within(card as HTMLElement).getAllByTestId("provider-mark").length,
      ).toBeGreaterThan(0);
    }
  });

  it("carries each provider's brand treatment on its sign-in button", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([]),
    });

    // Dropbox's guideline is the brand-blue fill…
    const dropbox = await screen.findByRole("button", {
      name: "Connect Dropbox",
    });
    expect(dropbox.className).toContain("--color-brand-dropbox");
    expect(within(dropbox).getByTestId("brand-mark")).toBeInTheDocument();
    // …Google and Microsoft guidelines are the light surface with the
    // official multicolor mark and dark ink label.
    const google = screen.getByRole("button", { name: "Connect Google Drive" });
    expect(google.className).toContain("--color-castify-surface");
    expect(within(google).getByTestId("brand-mark")).toBeInTheDocument();
    const onedrive = screen.getByRole("button", { name: "Connect OneDrive" });
    expect(onedrive.className).toContain("--color-castify-surface");
    expect(within(onedrive).getByTestId("brand-mark")).toBeInTheDocument();
  });

  it("reveals the schema-driven form on the S3 card, never the OAuth /start flow", async () => {
    const { fetchSpy } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([]),
    });

    // Credentials-mode connect: a Connect button reveals the generic form…
    const card = await openS3Form();
    // …with every schema field rendered by its label.
    for (const label of [
      "Endpoint",
      "Region",
      "Bucket",
      "Access key ID",
      "Secret access key",
      "Key prefix (optional)",
    ]) {
      expect(within(card).getByLabelText(label)).toBeInTheDocument();
    }

    // …and no call to the OAuth-only `/start` endpoint.
    const startCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("/start"),
    );
    expect(startCall).toBeUndefined();
  });

  it("renders a schema with an extra field without component changes", async () => {
    // The schema-driven acceptance check: a backend that grows a field (or
    // a future credentials provider with different fields) must render
    // through the same generic form — zero component edits.
    const withExtraField = ALL_AVAILABLE.map((entry) =>
      entry.id === "s3"
        ? {
            ...entry,
            credentials: {
              fields: [
                ...S3_SCHEMA.fields,
                {
                  key: "vault_token",
                  label: "Vault token",
                  secret: false,
                  placeholder: null,
                },
              ],
            },
          }
        : entry,
    );
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([], withExtraField),
    });

    const card = await openS3Form();
    expect(within(card).getByLabelText("Vault token")).toBeInTheDocument();
    expect(within(card).getByLabelText("Endpoint")).toBeInTheDocument();
  });

  it("masks secret inputs and toggles reveal per field", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([]),
    });

    const card = await openS3Form();
    const accessKey = within(card).getByLabelText("Access key ID");
    expect(accessKey).toHaveAttribute("type", "password");
    expect(within(card).getByLabelText("Endpoint")).toHaveAttribute(
      "type",
      "text",
    );

    fireEvent.click(
      within(card).getByRole("button", { name: "Show Access key ID" }),
    );
    expect(accessKey).toHaveAttribute("type", "text");
    fireEvent.click(
      within(card).getByRole("button", { name: "Hide Access key ID" }),
    );
    expect(accessKey).toHaveAttribute("type", "password");

    // Revealing one secret leaves the other masked.
    expect(within(card).getByLabelText("Secret access key")).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("submits the credentials form and flips the card to connected", async () => {
    let connections: unknown[] = [];
    const { fetchSpy } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse(connections);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/s3" && method === "POST") {
          connections = [S3_CONNECTED];
          return jsonResponse(S3_CONNECTED, 201);
        }
        return jsonError(404, "unmocked");
      },
    });

    const card = await openS3Form();
    fillCredentials(card);
    fireEvent.click(within(card).getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      const post = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/connections/s3" &&
          (init as RequestInit)?.method === "POST",
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        endpoint: "http://127.0.0.1:9000",
        region: "us-east-1",
        bucket: "media",
        access_key_id: "minioadmin",
        secret_access_key: "miniosecret",
        prefix: "",
      });
    });

    // The refreshed list flips the card to its connected state and the
    // existing scan-status UI takes over.
    expect(await screen.findByText("Scanning")).toBeInTheDocument();
    // Secrets never render back: the form (and its inputs) is gone.
    expect(screen.queryByLabelText("Access key ID")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Secret access key"),
    ).not.toBeInTheDocument();
  });

  it("invalidates the browse caches on a successful credentials connect", async () => {
    // The initial scan populates videos and folder paths — the browse
    // caches must not serve the pre-connect (empty) state for their
    // staleTime window. Pins the invalidation set the form's onSuccess
    // claims; a dropped key here means Browse shows a stale empty grid.
    let connections: unknown[] = [];
    const { queryClient } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse(connections);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/s3" && method === "POST") {
          connections = [S3_CONNECTED];
          return jsonResponse(S3_CONNECTED, 201);
        }
        return jsonError(404, "unmocked");
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const card = await openS3Form();
    fillCredentials(card);
    fireEvent.click(within(card).getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["videos"] }),
      );
    });
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["folder-tree"] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["folder-contents"] }),
    );
  });

  it("shows the backend's verify error inline and adds no row", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/s3" && method === "POST")
          return jsonError(
            400,
            "the object store rejected these credentials — check the access key ID and secret access key",
          );
        return jsonError(404, "unmocked");
      },
    });

    const card = await openS3Form();
    fillCredentials(card);
    fireEvent.click(within(card).getByRole("button", { name: /^connect$/i }));

    // The backend's actionable message surfaces inline on the card,
    // framed by what failed…
    expect(
      await within(card).findByText(
        /Verification failed: .*rejected these credentials/,
      ),
    ).toBeInTheDocument();
    // …the form stays available for correction, and no connection row
    // appeared (the card is still in its not-connected state).
    expect(within(card).getByLabelText("Endpoint")).toBeInTheDocument();
    expect(screen.queryByText("Scanning")).not.toBeInTheDocument();
  });

  it("names the network when the connect fetch itself fails", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/s3" && method === "POST")
          return Promise.reject(new TypeError("Failed to fetch"));
        return jsonError(404, "unmocked");
      },
    });

    const card = await openS3Form();
    fillCredentials(card);
    fireEvent.click(within(card).getByRole("button", { name: /^connect$/i }));

    expect(
      await within(card).findByText(
        "Can't reach the server. Check your connection and try again.",
      ),
    ).toBeInTheDocument();
    expect(within(card).getByLabelText("Endpoint")).toBeInTheDocument();
  });

  it("shows an empty state instead of disabled cards when no providers are configured", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([], NONE_AVAILABLE),
    });

    expect(
      await screen.findByText(/No cloud providers configured/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /connect/i }),
    ).not.toBeInTheDocument();
  });

  it("still shows a connected card whose provider config was removed", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([GOOGLE_CONNECTED], NONE_AVAILABLE),
    });

    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /disconnect/i }),
    ).toBeInTheDocument();
  });

  it("shows a scanning badge and found-videos detail while scanning", async () => {
    const scanning = {
      ...GOOGLE_CONNECTED,
      scan_status: "scanning",
      video_count: 4,
    };
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([scanning]),
    });

    expect(await screen.findByText("Scanning")).toBeInTheDocument();
    expect(screen.getByText(/Found 4 media/)).toBeInTheDocument();
  });

  it("navigates to the auth_url on connect", async () => {
    const originalLocation = window.location;
    const hrefSetter = vi.fn();
    // Stub window.location.href setter to observe the redirect.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        set href(value: string) {
          hrefSetter(value);
        },
      },
    });

    const { fetchSpy } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (
          url === "/api/connections/google_drive/start" &&
          method === "POST"
        ) {
          return jsonResponse({
            auth_url: "https://accounts.google.com/o/oauth2/auth?scope=...",
          });
        }
        return jsonError(404, "unmocked");
      },
    });

    // Click the Google Drive sign-in button by its stated action.
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Google Drive" }),
    );

    await waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith(
        "https://accounts.google.com/o/oauth2/auth?scope=...",
      );
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/connections/google_drive/start",
      expect.objectContaining({ method: "POST" }),
    );

    // Restore.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("disconnects after confirmation and clears the card", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const { fetchSpy } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([GOOGLE_CONNECTED]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/c1" && method === "DELETE")
          return new Response(null, { status: 204 });
        return jsonError(404, "unmocked");
      },
    });

    await screen.findByText("user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));

    await waitFor(() => {
      const deleteCall = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/connections/c1" &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeDefined();
    });
    expect(confirmSpy).toHaveBeenCalled();
    expect(
      (fetchSpy.mock.calls.at(-1)?.[1] as RequestInit).headers,
    ).toBeInstanceOf(Headers);

    confirmSpy.mockRestore();
  });

  it("does not disconnect when the confirm dialog is cancelled", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const { fetchSpy } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([GOOGLE_CONNECTED]),
    });

    await screen.findByText("user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));

    const deleteCall = fetchSpy.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/connections/c1" &&
        (init as RequestInit)?.method === "DELETE",
    );
    expect(deleteCall).toBeUndefined();
    confirmSpy.mockRestore();
  });

  it("shows a success banner on the ?connected={provider} callback", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections?connected=google_drive"],
      fetchImplementation: connectionsFetch([GOOGLE_CONNECTED]),
    });

    expect(
      await screen.findByText(/Google Drive connected. Scanning/),
    ).toBeInTheDocument();
  });

  it("shows an error banner on the ?error=oauth_failed callback", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections?error=oauth_failed"],
      fetchImplementation: connectionsFetch([]),
    });

    expect(await screen.findByText(/Connection failed/)).toBeInTheDocument();
  });

  it("surfaces a specific message on the ?error=account_id_missing callback", async () => {
    // Distinct from the generic `oauth_failed`: the OAuth round-trip
    // succeeded but the provider returned no account_id, so reconnecting
    // again would just hit the same wall. The banner must say so rather
    // than invite another retry.
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections?error=account_id_missing"],
      fetchImplementation: connectionsFetch([]),
    });

    expect(
      await screen.findByText(/did not return an account identifier/),
    ).toBeInTheDocument();
  });

  it("shows a Rescan button on connected cards", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([GOOGLE_CONNECTED]),
    });

    expect(
      await screen.findByRole("button", { name: /rescan/i }),
    ).toBeInTheDocument();
  });

  it("marks the Rescan button unavailable while scanning, with the reason on focus", async () => {
    const scanning = {
      ...GOOGLE_CONNECTED,
      scan_status: "scanning",
      video_count: 4,
    };
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: connectionsFetch([scanning]),
    });

    // Task 019: the reason is known (a scan is already running) — the
    // button stays focusable (aria-disabled) so the tooltip is reachable.
    const rescanBtn = await screen.findByRole("button", { name: /scanning/i });
    expect(rescanBtn).toHaveAttribute("aria-disabled", "true");
    fireEvent.focus(rescanBtn);
    expect(
      screen.getByRole("tooltip", { name: "A scan is already running." }),
    ).toBeInTheDocument();
  });

  it("triggers a rescan POST on click", async () => {
    const { fetchSpy } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([GOOGLE_CONNECTED]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/c1/scan" && method === "POST")
          return new Response(null, { status: 202 });
        return jsonError(404, "unmocked");
      },
    });

    await screen.findByText("user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));

    await waitFor(() => {
      const rescanCall = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/connections/c1/scan" &&
          (init as RequestInit)?.method === "POST",
      );
      expect(rescanCall).toBeDefined();
    });
  });

  // Catalog prune: once a triggered rescan settles, removals earn a
  // follow-up toast; a clean rescan stays quiet (the initial
  // "Rescanning…" info toast is the only messaging).
  it("toasts removals when the triggered rescan prunes rows", async () => {
    let scanSettled = false;
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([GOOGLE_CONNECTED]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/c1/scan" && method === "POST")
          return new Response(null, { status: 202 });
        if (url === "/api/connections/c1/scan") {
          // First status poll still sees the scan running; the next one
          // reports the settled outcome with pruned counts.
          const body = scanSettled
            ? {
                status: "idle",
                videos_found: 5,
                started_at: "2026-01-01T00:00:00Z",
                completed_at: "2026-01-01T00:01:00Z",
                error_message: null,
                videos_pruned: 2,
                files_pruned: 1,
              }
            : {
                status: "scanning",
                videos_found: 3,
                started_at: "2026-01-01T00:00:00Z",
                completed_at: null,
                error_message: null,
                videos_pruned: 0,
                files_pruned: 0,
              };
          scanSettled = true;
          return jsonResponse(body);
        }
        return jsonError(404, "unmocked");
      },
    });

    // Resolve initial state under real timers — findBy's polling uses
    // setTimeout, which fake timers would freeze.
    await screen.findByText("user@example.com");
    const button = screen.getByRole("button", { name: /rescan/i });

    vi.useFakeTimers();
    try {
      fireEvent.click(button);

      // Two poll intervals: the first observes "scanning", the second the
      // settled state with removals.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 2000 + 100);
      });

      expect(
        screen.getByText("Rescanned Google Drive — 2 videos and 1 file removed"),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a clean rescan quiet beyond the Rescanning… toast", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([GOOGLE_CONNECTED]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/c1/scan" && method === "POST")
          return new Response(null, { status: 202 });
        if (url === "/api/connections/c1/scan")
          return jsonResponse({
            status: "idle",
            videos_found: 7,
            started_at: "2026-01-01T00:00:00Z",
            completed_at: "2026-01-01T00:01:00Z",
            error_message: null,
            videos_pruned: 0,
            files_pruned: 0,
          });
        return jsonError(404, "unmocked");
      },
    });

    await screen.findByText("user@example.com");
    const button = screen.getByRole("button", { name: /rescan/i });

    vi.useFakeTimers();
    try {
      fireEvent.click(button);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 2000 + 100);
      });

      expect(screen.queryByText(/removed/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an error when rescan returns 409 conflict", async () => {
    renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([GOOGLE_CONNECTED]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/c1/scan" && method === "POST")
          return jsonError(409, "a scan is already in progress");
        return jsonError(404, "unmocked");
      },
    });

    await screen.findByText("user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));

    expect(await screen.findByText(/already in progress/i)).toBeInTheDocument();
  });

  // ── Cache invalidation after connection state changes ─────────────────
  //
  // Disconnecting or rescanning a connection can change which /stream-url
  // responses are valid (the grant may have been rotated, the connection
  // may be gone entirely). Any cached /stream-url error — including the
  // structured `reauth_required` that routed the user here — must be
  // invalidated so a stale Reconnect card doesn't keep rendering on the
  // watch page after the user reconnects. The M9 folder tree + contents
  // caches must be invalidated too: scans mutate the paths/counts the tree
  // is derived from, and disconnect cascades the connection's rows away.

  it("invalidates cached stream-url queries on disconnect", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const { queryClient } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([GOOGLE_CONNECTED]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/c1" && method === "DELETE")
          return new Response(null, { status: 204 });
        return jsonError(404, "unmocked");
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await screen.findByText("user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["videos"] }),
      );
    });

    confirmSpy.mockRestore();
  });

  it("invalidates the folder tree and contents caches on disconnect", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const { queryClient } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([GOOGLE_CONNECTED]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/c1" && method === "DELETE")
          return new Response(null, { status: 204 });
        return jsonError(404, "unmocked");
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await screen.findByText("user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["folder-tree"] }),
      );
    });
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["folder-contents"] }),
    );

    confirmSpy.mockRestore();
  });

  it("invalidates cached stream-url queries on rescan", async () => {
    const { queryClient, fetchSpy } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([GOOGLE_CONNECTED]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/c1/scan" && method === "POST")
          return new Response(null, { status: 202 });
        return jsonError(404, "unmocked");
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await screen.findByText("user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));

    await waitFor(() => {
      const rescanCall = fetchSpy.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/connections/c1/scan" &&
          (init as RequestInit)?.method === "POST",
      );
      expect(rescanCall).toBeDefined();
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["videos"] }),
    );
  });

  it("invalidates the folder tree and contents caches on rescan", async () => {
    const { queryClient } = renderWithProviders(<ConnectionsPage />, {
      initialEntries: ["/connections"],
      fetchImplementation: (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/connections" && method === "GET")
          return jsonResponse([GOOGLE_CONNECTED]);
        if (url === "/api/connections/available")
          return jsonResponse(ALL_AVAILABLE);
        if (url === "/api/connections/c1/scan" && method === "POST")
          return new Response(null, { status: 202 });
        return jsonError(404, "unmocked");
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await screen.findByText("user@example.com");
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["folder-tree"] }),
      );
    });
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["folder-contents"] }),
    );
  });
});
