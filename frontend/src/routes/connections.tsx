// Connections page: provider cards, OAuth connect/disconnect, callback banner.
//
// The backend's OAuth callback redirects here with query params:
//   * `?connected={provider}` on success — show a success banner, then strip
//     the param so it doesn't persist on refresh.
//   * `?error=oauth_failed` on failure — show an error banner.
//
// Card states:
//   * Connected — shows account email, video count, scan status, a Disconnect
//     button (confirm dialog → `DELETE /api/connections/{id}`).
//   * Scanning — shows a live "Found N videos…" indicator; the
//     `['connections']` query refetches every few seconds while any connection
//     is in the `scanning` state (see `use-connections.ts`).
//   * Available (not connected) — Connect button → `POST .../start` → navigate
//     to the returned `auth_url` (full page redirect to the provider).
//   * Unconfigured — Connect button disabled with a `docs/config.md` hint.
//
// Errors from connect/disconnect surface inline on the relevant card.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { disconnectConnection, startConnect, triggerRescan } from "../api/connections";
import { ApiError } from "../api/client";
import {
  AVAILABLE_PROVIDERS_QUERY_KEY,
  useAvailableProviders,
} from "../hooks/use-available-providers";
import { CONNECTIONS_QUERY_KEY, useConnections } from "../hooks/use-connections";
import {
  PROVIDER_LABELS,
  PROVIDERS,
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
          Connect a cloud provider to scan it for videos. Your tokens are
          encrypted at rest.
        </p>
      </div>

      {oauthError ? (
        <Banner kind="error" onDismiss={dismissBanner}>
          Connection failed. The provider did not grant access — please try again.
        </Banner>
      ) : connectedProvider ? (
        <Banner kind="success" onDismiss={dismissBanner}>
          {PROVIDER_LABELS[connectedProvider as ProviderKey] ?? connectedProvider} connected. Scanning for videos…
        </Banner>
      ) : null}

      <ConnectionsGrid />
    </section>
  );
}

function ConnectionsGrid() {
  const connections = useConnections();
  const available = useAvailableProviders();

  if (connections.isLoading) {
    return <p className="opacity-60">Loading connections…</p>;
  }
  if (connections.isError) {
    return (
      <p className="text-red-400">
        Couldn't load connections. {describeError(connections.error)}
      </p>
    );
  }

  const connectedByProvider = new Map<ProviderKey, ConnectionDto>();
  for (const conn of connections.data ?? []) {
    connectedByProvider.set(conn.provider, conn);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {PROVIDERS.map((provider) => {
        const conn = connectedByProvider.get(provider);
        return (
          <ProviderCard
            key={provider}
            provider={provider}
            connection={conn}
            configured={available.data?.[provider] ?? false}
          />
        );
      })}
    </div>
  );
}

interface ProviderCardProps {
  provider: ProviderKey;
  connection: ConnectionDto | undefined;
  configured: boolean;
}

function ProviderCard({ provider, connection, configured }: ProviderCardProps) {
  if (connection) {
    return <ConnectedCard provider={provider} connection={connection} />;
  }
  if (!configured) {
    return <UnconfiguredCard provider={provider} />;
  }
  return <AvailableCard provider={provider} />;
}

function ConnectedCard({
  provider,
  connection,
}: {
  provider: ProviderKey;
  connection: ConnectionDto;
}) {
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-4">
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
      <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">
        Scan error
      </span>
    );
  }
  return (
    <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium opacity-70">
      Idle
    </span>
  );
}

function ScanDetail({ connection }: { connection: ConnectionDto }) {
  const videos = connection.video_count;
  if (connection.scan_status === "scanning") {
    return (
      <p className="text-sm opacity-70">
        {videos > 0 ? `Found ${videos} videos…` : "Starting scan…"}
      </p>
    );
  }
  if (connection.scan_status === "error") {
    return (
      <p className="text-sm text-red-400">
        Scan failed. Try reconnecting the provider.
      </p>
    );
  }
  return (
    <p className="text-sm opacity-70">
      {videos} {videos === 1 ? "video" : "videos"}
      {connection.last_scan_at
        ? ` · last scanned ${formatDate(connection.last_scan_at)}`
        : ""}
    </p>
  );
}

function RescanButton({ connection }: { connection: ConnectionDto }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const rescan = useMutation({
    mutationFn: () => triggerRescan(connection.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
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
        className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:bg-white/5 disabled:opacity-50"
      >
        {connection.scan_status === "scanning"
          ? "Scanning…"
          : rescan.isPending
            ? "Starting…"
            : "Rescan"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </>
  );
}

function DisconnectButton({ connection }: { connection: ConnectionDto }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const disconnect = useMutation({
    mutationFn: () => disconnectConnection(connection.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: AVAILABLE_PROVIDERS_QUERY_KEY,
      });
    },
    onError: (err: unknown) => setError(describeError(err)),
  });

  function handleDisconnect(): void {
    if (window.confirm(`Disconnect ${PROVIDER_LABELS[connection.provider]}? Your videos will be removed from the catalog.`)) {
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
        className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:bg-white/5 disabled:opacity-50"
      >
        {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
      </button>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

function AvailableCard({ provider }: { provider: ProviderKey }) {
  const [error, setError] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: () => startConnect(provider),
    onSuccess: (res) => {
      // Full-page redirect to the provider's consent screen. The backend
      // callback returns the browser here with `?connected={provider}`.
      window.location.href = res.auth_url;
    },
    onError: (err: unknown) => setError(describeError(err)),
  });

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-4">
      <div>
        <h2 className="font-semibold">{PROVIDER_LABELS[provider]}</h2>
        <p className="text-sm opacity-60">Not connected</p>
      </div>
      <p className="text-sm opacity-70">
        Connect to scan your {PROVIDER_LABELS[provider]} for videos.
      </p>
      <div className="mt-auto">
        <button
          type="button"
          onClick={() => {
            setError(null);
            connect.mutate();
          }}
          disabled={connect.isPending}
          className="w-full rounded-md bg-[var(--color-castify-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90 disabled:opacity-50"
        >
          {connect.isPending ? "Connecting…" : "Connect"}
        </button>
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </div>
    </article>
  );
}

function UnconfiguredCard({ provider }: { provider: ProviderKey }) {
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-dashed border-white/10 bg-[var(--color-castify-surface)]/50 p-4 opacity-80">
      <div>
        <h2 className="font-semibold">{PROVIDER_LABELS[provider]}</h2>
        <p className="text-sm opacity-60">Not configured</p>
      </div>
      <p className="text-sm opacity-70">
        Ask the administrator to add {PROVIDER_LABELS[provider]} OAuth credentials.
      </p>
      <div className="mt-auto">
        <button
          type="button"
          disabled
          className="w-full cursor-not-allowed rounded-md border border-white/10 px-3 py-2 text-sm opacity-50"
        >
          Connect
        </button>
        <p className="mt-1 text-xs opacity-50">
          See <code>docs/config.md</code> for setup.
        </p>
      </div>
    </article>
  );
}

function Banner({
  kind,
  onDismiss,
  children,
}: {
  kind: "success" | "error";
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  const tone =
    kind === "success"
      ? "border-[var(--color-castify-accent)]/40 bg-[var(--color-castify-accent)]/10"
      : "border-red-500/40 bg-red-500/10";
  return (
    <div className={`flex items-center justify-between gap-3 rounded-md border ${tone} px-4 py-2.5 text-sm`}>
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

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
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
