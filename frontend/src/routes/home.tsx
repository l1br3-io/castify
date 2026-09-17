// Home page (`/`): first-run connection guide, setup-required notice, or the
// browse experience.
//
// Per FR-9.1, on first visit after login with zero connections the page shows a
// "Connect your first cloud" guide linking to `/connections`. If no providers
// are configured either (no OAuth env vars), that guide is a dead-end, so a
// "Setup required" notice pointing to `docs/config.md` is shown instead.
// Because zero connections implies zero videos (the scanner only runs on
// connections and disconnect cascade-deletes catalog rows), the
// connections-empty check alone is the gate — no separate `/api/videos` probe
// needed.
//
// Once at least one connection exists, the browse page (`BrowsePage`, M2 T7)
// takes over — poster grid with thumbnails, replacing M1's flat `VideoList`.
//
// Design-pass §6: connections query errors now surface via `<ErrorState>` with
// a retry instead of routing to the wrong state (audit: home.tsx ignored
// `isError`).

import { Link } from "react-router-dom";

import { useAvailableProviders } from "../hooks/use-available-providers";
import { useConnections } from "../hooks/use-connections";
import { BrowsePage } from "./browse";
import { ErrorState } from "../components/ui/error-state";
import { Skeleton } from "../components/ui/skeleton";

export function HomePage() {
  const connections = useConnections();
  const available = useAvailableProviders();

  // While connections are still loading we can't yet decide first-run vs.
  // library view — render a small skeleton rather than bare "Loading…" text
  // so the layout doesn't shift on resolution (design-pass §6).
  if (connections.isLoading || available.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="aspect-video w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (connections.isError) {
    return (
      <ErrorState
        title="Couldn't load sources."
        body="Your library can't be reached right now."
        onRetry={() => connections.refetch()}
      />
    );
  }

  const isEmpty = (connections.data ?? []).length === 0;
  if (isEmpty) {
    // Credential-based providers (S3) are always configured, so this is
    // near-unreachable with a current backend — kept as a defensive
    // branch for older backends / partial responses.
    const anyConfigured = available.data
      ? available.data.some((entry) => entry.configured)
      : false;
    if (!anyConfigured) {
      return <SetupRequired />;
    }
    return <FirstRunGuide />;
  }
  return <BrowsePage />;
}

function SetupRequired() {
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Setup required
        </h1>
        <p className="mt-2 opacity-70">
          Castify needs OAuth credentials for at least one cloud provider before
          you can connect an account.
        </p>
        <p className="mt-3 text-xs opacity-70">
          See <code>docs/config.md</code> for setup.
        </p>
      </div>
    </section>
  );
}

function FirstRunGuide() {
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Connect your first cloud
        </h1>
        <p className="mt-2 opacity-70">
          Castify scans your cloud storage for videos and unifies them into one
          library. Connect a provider to get started.
        </p>
      </div>
      <Link
        to="/connections"
        className="inline-block rounded-[var(--radius-button)] bg-[var(--color-castify-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-on-accent)] transition hover:opacity-90"
      >
        Connect a provider
      </Link>
    </section>
  );
}
