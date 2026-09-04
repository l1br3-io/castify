// Connections page: provider cards, OAuth connect/disconnect, callback banner.
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
        <h1 className="text-3xl font-semibold tracking-tight">Connections</h1>
        <p className="mt-2 opacity-70">
          Connect a cloud provider to scan it for media. Your tokens are
          encrypted at rest.
        </p>
      </div>

      {oauthError ? (
        <Banner kind="error" onDismiss={dismissBanner}>
          {oauthError === "account_id_missing"
            ? "Reconnect refused: the provider did not return an account identifier, so Castify can't safely rotate the existing connection's token. Disconnect the connection below and try again."
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
    );
  }
  if (connections.isError) {
    return (
      <ErrorState
        title="Couldn't load connections."
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
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
        <div>
          <h2 className="font-semibold">{PROVIDER_LABELS[provider]}</h2>
          <p className="text-sm opacity-60">
            {connection.provider_account_email ?? "Connected"}
          </p>
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

function ScanBadge({ status }: { status: ConnectionDto["scan_status"] }) {
  if (status === "scanning") {
    return (
      <span className="rounded-full bg-[var(--color-castify-accent)]/20 px-2 py-0.5 text-xs font-medium text-[var(--color-castify-accent)]">
        Scanning
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="rounded-full bg-[var(--color-castify-accent-dim)]/20 px-2 py-0.5 text-xs font-medium text-[var(--color-castify-accent-dim)]">
        Scan error
      </span>
    );
  }
  return (
    <span className="rounded-full bg-[var(--color-castify-rule)] px-2 py-0.5 text-xs font-medium opacity-70">
      Idle
    </span>
  );
}

function ScanDetail({ connection }: { connection: ConnectionDto }) {
  const videos = connection.video_count;
  if (connection.scan_status === "scanning") {
    return (
      <p className="text-sm opacity-70">
        {videos > 0 ? `Found ${videos} media…` : "Starting scan…"}
      </p>
    );
  }
  if (connection.scan_status === "error") {
    return (
      <p className="text-sm text-[var(--color-castify-accent-dim)]">
        Scan failed. Try reconnecting the provider.
      </p>
    );
  }
  return (
    <p className="text-sm opacity-70">
      {videos} media
      {connection.last_scan_at
        ? ` · last scanned ${formatDate(connection.last_scan_at)}`
        : ""}
    </p>
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

  const disabled = connection.scan_status === "scanning" || rescan.isPending;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          rescan.mutate();
        }}
        disabled={disabled}
        className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-3 py-1.5 text-xs transition hover:bg-[var(--color-castify-accent-subtle)] disabled:opacity-50"
      >
        {connection.scan_status === "scanning"
          ? "Scanning…"
          : rescan.isPending
            ? "Starting…"
            : "Rescan"}
      </button>
      {error && (
        <p className="text-xs text-[var(--color-castify-accent-dim)]">
          {error}
        </p>
      )}
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
      <button
        type="button"
        onClick={handleDisconnect}
        disabled={disconnect.isPending}
        className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-3 py-1.5 text-xs transition hover:bg-[var(--color-castify-accent-subtle)] disabled:opacity-50"
      >
        {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
      </button>
      {error && (
        <p className="mt-1 text-xs text-[var(--color-castify-accent-dim)]">
          {error}
        </p>
      )}
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
        <div>
          <h2 className="font-semibold">{PROVIDER_LABELS[provider]}</h2>
          <p className="text-sm opacity-60">Not connected</p>
        </div>
        <p className="text-sm opacity-70">
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
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setFormOpen(true);
                }}
                className="w-full rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 disabled:opacity-50"
              >
                Connect
              </button>
            ))}
        </div>
      </article>
    );
  }

  return (
    <article className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-4">
      <div>
        <h2 className="font-semibold">{PROVIDER_LABELS[provider]}</h2>
        <p className="text-sm opacity-60">Not connected</p>
      </div>
      <p className="text-sm opacity-70">
        Connect to scan your {PROVIDER_LABELS[provider]} for media.
      </p>
      <div className="mt-auto">
        <button
          type="button"
          onClick={() => {
            setError(null);
            connect.mutate();
          }}
          disabled={connect.isPending}
          className="w-full rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 disabled:opacity-50"
        >
          {connect.isPending ? "Connecting…" : "Connect"}
        </button>
        {error && (
          <p className="mt-1 text-xs text-[var(--color-castify-accent-dim)]">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}

function NoConfiguredProviders() {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] p-8 text-center">
      <p className="text-lg font-medium">No cloud providers configured</p>
      <p className="mt-2 text-sm opacity-60">
        Add OAuth credentials for Google Drive, Dropbox, or OneDrive to start
        connecting accounts.
      </p>
      <p className="mt-3 text-xs opacity-70">
        See <code>docs/config.md</code> for setup.
      </p>
    </div>
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
      ? "border-[var(--color-castify-accent)]/40 bg-[var(--color-castify-accent-subtle)]"
      : kind === "error"
        ? "border-[var(--color-castify-accent-dim)]/40 bg-[var(--color-castify-accent-dim)]/10"
        : "border-[var(--color-castify-muted)]/25 bg-[var(--color-castify-muted)]/10";
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-[var(--radius-button)] border ${tone} px-4 py-2.5 text-sm`}
    >
      <span>{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 opacity-60 transition hover:opacity-100"
        aria-label="Dismiss"
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
