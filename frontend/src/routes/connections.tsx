// Sources page (formerly "Connections", renamed per spec D4/FR-7.2 — the
// `/connections` URL is stable): provider cards, OAuth connect/disconnect,
// callback banner.
//
// Task 010 (Classical reskin): unfilled hairline cards in the demo's 1–2
// column grid; official provider marks on every card (badges.tsx); brand
// sign-in buttons that state the action ("Connect Google Drive") per each
// provider's guidelines; scan state in token tones — accent tint + LED
// pulse while scanning, danger on scan errors — and a neutral "Connected"
// tag with count + last-scanned as the library-ready tell (FR-2.3).
//
// The backend's OAuth callback redirects here with query params:
//   * `?connected={provider}` on success — show a success banner, then strip
//     the param so it doesn't persist on refresh.
//   * `?error=oauth_failed` on failure — show a generic error banner.
//   * `?error=account_id_missing` — the OAuth round-trip succeeded but the
//     provider returned no account_id. Reconnect was refused to avoid
//     orphaning the user's library on a duplicate-row insert; the user
//     should disconnect the stale connection and start fresh.
//
// Card states:
//   * Connected — shows account email, video count, scan status, a Disconnect
//     button (confirm dialog → `DELETE /api/connections/{id}`).
//   * Scanning — shows a live "Found N media…" indicator; the
//     `['connections']` query refetches every few seconds while any connection
//     is in the `scanning` state (see `use-connections.ts`).
//   * Available (not connected) — OAuth providers: Connect button →
//     `POST .../start` → navigate to the returned `auth_url` (full page
//     redirect to the provider). Credentials providers (S3-compatible
//     storage): Connect button reveals the schema-driven form
//     (`CredentialsForm`), which submits to `POST /api/connections/{provider}`.
// Unconfigured OAuth providers (no env vars) are hidden; credentials
// providers are always configured. If nothing is configured the grid shows
// an empty-state hint pointing to `docs/config.md`.
//
// Errors from connect/disconnect surface inline on the relevant card.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import {
  disconnectConnection,
  startConnect,
  triggerRescan,
} from "../api/connections";
import {
  AVAILABLE_PROVIDERS_QUERY_KEY,
  useAvailableProviders,
} from "../hooks/use-available-providers";
import {
  CONNECTIONS_QUERY_KEY,
  useConnections,
} from "../hooks/use-connections";
import { VIDEOS_QUERY_KEY } from "../hooks/use-videos";
import { FOLDER_TREE_QUERY_KEY } from "../hooks/use-folder-tree";
import { FOLDER_CONTENTS_QUERY_KEY } from "../hooks/use-folder-contents";
import { useToast } from "../hooks/use-toast";
import { describeError } from "../lib/format";
import { CredentialsForm } from "../components/credentials-form";
import { ProviderMark } from "../components/badges";
import { Button } from "../components/ui/button";
import { Tooltip } from "../components/ui/tooltip";
import { FOCUS_RING } from "../components/ui/button-classes";
import { EmptyState } from "../components/ui/empty-state";
import { cn } from "../components/ui/cn";
import { ErrorState } from "../components/ui/error-state";
import { Skeleton } from "../components/ui/skeleton";
import {
  PROVIDER_LABELS,
  PROVIDERS,
  type AvailableProviderDto,
  type ConnectionDto,
  type ProviderKey,
} from "../api/types";

export function ConnectionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const connectedProvider = searchParams.get("connected");
  const oauthError = searchParams.get("error");

  function dismissBanner(): void {
    searchParams.delete("connected");
    searchParams.delete("error");
    setSearchParams(searchParams, { replace: true });
  }

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl">Connections</h1>
        <p className="mt-2 text-[var(--color-castify-muted)]">
          Connect a cloud provider to scan it for media. Your tokens are
          encrypted at rest.
        </p>
      </div>

      {oauthError ? (
        <Banner kind="error" onDismiss={dismissBanner}>
          {oauthError === "account_id_missing"
            ? "Reconnect refused: the provider did not return an account identifier, so Castify can't safely rotate the existing source's token. Disconnect the source below and try again."
            : "Connection failed. The provider did not grant access — please try again."}
        </Banner>
      ) : connectedProvider ? (
        <Banner kind="info" onDismiss={dismissBanner}>
          {PROVIDER_LABELS[connectedProvider as ProviderKey] ??
            connectedProvider}{" "}
          connected. Scanning for media…
        </Banner>
      ) : null}

      <ConnectionsGrid />
    </section>
  );
}

function ConnectionsGrid() {
  const connections = useConnections();
  const available = useAvailableProviders();

  if (connections.isLoading || available.isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
    );
  }
  if (connections.isError) {
    return (
      <ErrorState
        title="Couldn't load sources."
        body={describeError(connections.error)}
        onRetry={() => connections.refetch()}
      />
    );
  }

  const connectedByProvider = new Map<ProviderKey, ConnectionDto>();
  for (const conn of connections.data ?? []) {
    connectedByProvider.set(conn.provider, conn);
  }

  // The available list is the source of truth for who's connectable and
  // how; PROVIDERS only fixes display order (labels/chips are
  // frontend-owned).
  const availableById = new Map<ProviderKey, AvailableProviderDto>(
    (available.data ?? []).map((entry) => [entry.id, entry]),
  );

  const visibleProviders = PROVIDERS.filter(
    (provider) =>
      (availableById.get(provider)?.configured ?? false) ||
      connectedByProvider.has(provider),
  );

  if (visibleProviders.length === 0) {
    return <NoConfiguredProviders />;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {visibleProviders.map((provider) => (
        <ProviderCard
          key={provider}
          entry={availableById.get(provider)}
          connection={connectedByProvider.get(provider)}
        />
      ))}
    </div>
  );
}

function ProviderCard({
  entry,
  connection,
}: {
  entry: AvailableProviderDto | undefined;
  connection: ConnectionDto | undefined;
}) {
  if (connection) {
    return <ConnectedCard connection={connection} />;
  }
  // Unreachable in practice — visibility requires a configured entry or a
  // connection — but don't render a mislabeled card if the list and the
  // connections query ever disagree.
  if (!entry) {
    return null;
  }
  return <AvailableCard entry={entry} />;
}

function ConnectedCard({ connection }: { connection: ConnectionDto }) {
  const provider = connection.provider;
  return (
    <article className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          {/* Mark in a sunken tile (the design's icon well). Brand color
              appears only on the mark itself — never as a fill. */}
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] border border-[var(--color-castify-rule)] bg-[var(--color-castify-sunken)]">
            <ProviderMark
              provider={provider}
              className={cn("size-5 shrink-0", MARK_TONE[provider])}
            />
          </span>
          <div>
            <h2 className="text-[15px] font-semibold">
              {PROVIDER_LABELS[provider]}
            </h2>
            <p className="text-xs text-[var(--color-castify-muted)]">
              {connection.provider_account_email ?? "Connected"}
            </p>
          </div>
        </div>
        <ScanBadge status={connection.scan_status} />
      </div>
      <ScanDetail connection={connection} />
      <div className="mt-auto flex items-center gap-2">
        <RescanButton connection={connection} />
        <DisconnectButton connection={connection} />
      </div>
    </article>
  );
}

// Brand color on cards appears only on the mark (badge-sized artwork) —
// never as fills or state indicators (spec § Tokens).
const MARK_TONE: Record<ProviderKey, string> = {
  google_drive: "",
  dropbox: "text-[var(--color-brand-dropbox)]",
  onedrive: "",
  s3: "text-[var(--color-castify-muted)]",
};

function ScanBadge({ status }: { status: ConnectionDto["scan_status"] }) {
  if (status === "scanning") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-castify-accent-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--color-castify-accent-strong)]">
        <span
          aria-hidden
          data-testid="scan-led"
          className="size-[6px] shrink-0 rounded-full bg-[var(--color-castify-accent)] animate-scan-pulse"
        />
        Scanning
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="rounded-[var(--radius-pill)] bg-[var(--color-danger-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--color-danger)]">
        Scan error
      </span>
    );
  }
  // The design's teal "Synced" pill — success on its soft fill is an AA
  // pair in both themes (index.css ratio table).
  return (
    <span className="rounded-[var(--radius-pill)] bg-[var(--color-success-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--color-success)]">
      Synced
    </span>
  );
}

function ScanDetail({ connection }: { connection: ConnectionDto }) {
  const videos = connection.video_count;
  // The design's pcard-stats row: hairline-topped strip, mono metadata.
  if (connection.scan_status === "scanning") {
    return (
      <div className="flex items-center justify-between border-t border-[var(--color-castify-rule)] pt-3 text-xs text-[var(--color-castify-muted)]">
        <span>{videos > 0 ? `Found ${videos} media…` : "Starting scan…"}</span>
      </div>
    );
  }
  if (connection.scan_status === "error") {
    return (
      <div className="flex items-center justify-between border-t border-[var(--color-castify-rule)] pt-3 text-xs">
        <span className="text-[var(--color-danger)]">
          Scan failed. Try reconnecting the provider.
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 border-t border-[var(--color-castify-rule)] pt-3 text-xs text-[var(--color-castify-muted)]">
      <span className="figure">{videos} media</span>
      {connection.last_scan_at && (
        <span className="figure font-mono">
          Scanned {formatDate(connection.last_scan_at)}
        </span>
      )}
    </div>
  );
}

function RescanButton({ connection }: { connection: ConnectionDto }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  const rescan = useMutation({
    mutationFn: () => triggerRescan(connection.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
      // A rescan re-establishes the provider grant (and may rotate the
      // access/refresh tokens). Any cached `/stream-url` error — including
      // a stale `reauth_required` from a previously-dead grant — must be
      // cleared so the watch page re-fetches with the live token state.
      void queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
      // The M9 backfill rescan is what fills the `files` table and updates
      // folder paths — the tree (counts) and every cached folder view must
      // refetch, or Browse shows fresh videos beside a stale tree within
      // the 30s staleTime window.
      void queryClient.invalidateQueries({ queryKey: FOLDER_TREE_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: FOLDER_CONTENTS_QUERY_KEY,
      });
      toast.info(`Rescanning ${PROVIDER_LABELS[connection.provider]}…`);
    },
    onError: (err: unknown) => setError(describeError(err)),
  });

  return (
    <>
      {/* While a scan is running the reason is known — keep the button
          focusable (aria-disabled) so the tooltip is keyboard-reachable
          (task 019 disabled-action contract). */}
      {connection.scan_status === "scanning" ? (
        <Tooltip content="A scan is already running.">
          <Button
            variant="secondary"
            size="sm"
            aria-disabled
            className="cursor-not-allowed opacity-50"
            onClick={() => {}}
          >
            Scanning…
          </Button>
        </Tooltip>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setError(null);
            rescan.mutate();
          }}
          pending={rescan.isPending}
        >
          {rescan.isPending ? "Starting…" : "Rescan"}
        </Button>
      )}
      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
    </>
  );
}

function DisconnectButton({ connection }: { connection: ConnectionDto }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  const disconnect = useMutation({
    mutationFn: () => disconnectConnection(connection.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: AVAILABLE_PROVIDERS_QUERY_KEY,
      });
      // Disconnecting kills the grant for every video owned by this
      // connection. Invalidate any cached `/stream-url` responses (including
      // the `reauth_required` error that prompted the user to disconnect) so
      // the watch page doesn't keep rendering a stale Reconnect card or
      // serving a now-invalid CDN URL after the user reconnects.
      void queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
      // Cascading delete removes the connection's file rows and hides its
      // videos — the folder tree (counts) and cached folder views must
      // follow, or the dead provider's folders linger for the staleTime
      // window.
      void queryClient.invalidateQueries({ queryKey: FOLDER_TREE_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: FOLDER_CONTENTS_QUERY_KEY,
      });
      toast.success(
        `Disconnected from ${PROVIDER_LABELS[connection.provider]}.`,
      );
    },
    onError: (err: unknown) => setError(describeError(err)),
  });

  function handleDisconnect(): void {
    if (
      window.confirm(
        `Disconnect ${PROVIDER_LABELS[connection.provider]}? Your media will be removed from the catalog.`,
      )
    ) {
      setError(null);
      disconnect.mutate();
    }
  }

  return (
    <div>
      <Button
        variant="destructive"
        size="sm"
        onClick={handleDisconnect}
        pending={disconnect.isPending}
      >
        {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
      </Button>
      {error && (
        <p className="mt-1 text-xs text-[var(--color-danger)]">{error}</p>
      )}
    </div>
  );
}

// Brand sign-in buttons — each provider's official treatment (FR-1.1):
// Google and Microsoft brand guidelines specify a light surface button with
// the multicolor mark and dark ink; Dropbox specifies its brand-blue fill
// with a white label (≥4.5:1 AA). Labels state the action ("Connect Google
// Drive"). S3 has no brand — the standard primary (ink fill). The
// embedded mark is re-tagged `brand-mark`: the card header already carries
// the canonical decorative mark.
const BRAND_BUTTON_CLASSES: Record<ProviderKey, string> = {
  google_drive:
    "border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] text-[var(--color-castify-text)] hover:bg-[var(--color-castify-hover)] active:bg-[var(--color-castify-press)]",
  dropbox:
    "border border-transparent bg-[var(--color-brand-dropbox)] text-white hover:opacity-90 active:opacity-80",
  onedrive:
    "border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] text-[var(--color-castify-text)] hover:bg-[var(--color-castify-hover)] active:bg-[var(--color-castify-press)]",
  s3: "",
};

function BrandConnectButton({
  provider,
  pending,
  onClick,
}: {
  provider: ProviderKey;
  pending: boolean;
  onClick: () => void;
}) {
  // Exact "Connect" — the e2e credentials-flow selectors (s3-connect.spec.ts)
  // key on this name.
  if (provider === "s3") {
    return (
      <Button className="w-full" pending={pending} onClick={onClick}>
        {pending ? "Connecting…" : "Connect"}
      </Button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-busy={pending || undefined}
      className={cn(
        "inline-flex w-full items-center justify-center gap-2 rounded-[var(--radius-button)] px-5 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress aria-busy:opacity-70",
        FOCUS_RING,
        BRAND_BUTTON_CLASSES[provider],
      )}
    >
      <ProviderMark
        provider={provider}
        testId="brand-mark"
        className={cn(
          "size-4 shrink-0",
          provider === "dropbox" ? "text-white" : "",
        )}
      />
      {pending ? "Connecting…" : `Connect ${PROVIDER_LABELS[provider]}`}
    </button>
  );
}

function AvailableCardHeader({ provider }: { provider: ProviderKey }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] border border-[var(--color-castify-rule)] bg-[var(--color-castify-sunken)]">
        <ProviderMark
          provider={provider}
          className={cn("size-5 shrink-0", MARK_TONE[provider])}
        />
      </span>
      <div>
        <h2 className="text-[15px] font-semibold">
          {PROVIDER_LABELS[provider]}
        </h2>
        <p className="text-xs text-[var(--color-castify-muted)]">
          Not connected
        </p>
      </div>
    </div>
  );
}

function AvailableCard({ entry }: { entry: AvailableProviderDto }) {
  const provider = entry.id;
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const connect = useMutation({
    mutationFn: () => startConnect(provider),
    onSuccess: (res) => {
      // Full-page redirect to the provider's consent screen. The backend
      // callback returns the browser here with `?connected={provider}`.
      window.location.href = res.auth_url;
    },
    onError: (err: unknown) => setError(describeError(err)),
  });

  // Credentials providers connect through the schema-driven form
  // (`CredentialsForm`) instead of the OAuth redirect. A missing schema is
  // a wire-contract violation — fall back to the info-only card rather
  // than a form with nothing to render.
  if (entry.authMode === "credentials") {
    return (
      <article className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-4">
        <AvailableCardHeader provider={provider} />
        <p className="text-sm text-[var(--color-castify-muted)]">
          Connects with storage credentials — an endpoint, bucket, and access
          keys you already have.
        </p>
        <div className="mt-auto">
          {entry.credentials &&
            (formOpen ? (
              <CredentialsForm
                provider={provider}
                schema={entry.credentials}
                onCancel={() => setFormOpen(false)}
              />
            ) : (
              <BrandConnectButton
                provider={provider}
                pending={false}
                onClick={() => {
                  setError(null);
                  setFormOpen(true);
                }}
              />
            ))}
        </div>
      </article>
    );
  }

  return (
    <article className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-4">
      <AvailableCardHeader provider={provider} />
      <p className="text-sm text-[var(--color-castify-muted)]">
        Connect to scan your {PROVIDER_LABELS[provider]} for media.
      </p>
      <div className="mt-auto">
        <BrandConnectButton
          provider={provider}
          pending={connect.isPending}
          onClick={() => {
            setError(null);
            connect.mutate();
          }}
        />
        {error && (
          <p className="mt-1 text-xs text-[var(--color-danger)]">{error}</p>
        )}
      </div>
    </article>
  );
}

function NoConfiguredProviders() {
  return (
    <EmptyState
      title="No cloud providers configured"
      body="Add OAuth credentials for Google Drive, Dropbox, or OneDrive to start connecting accounts — see docs/config.md for setup."
    />
  );
}

function Banner({
  kind,
  onDismiss,
  children,
}: {
  kind: "info" | "success" | "error";
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  const tone =
    kind === "success"
      ? "border-[var(--color-success)]/40 bg-[var(--color-success-subtle)]"
      : kind === "error"
        ? "border-[var(--color-danger)]/40 bg-[var(--color-danger-subtle)]"
        : "border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)]";
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`flex items-center justify-between gap-3 rounded-[var(--radius-button)] border px-4 py-2.5 text-sm ${tone}`}
    >
      <span>{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className={cn(
          "shrink-0 px-1 opacity-60 transition hover:opacity-100",
          FOCUS_RING,
        )}
      >
        ×
      </button>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
