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
// The M0 health-probe placeholder was removed — `/api/health` remains
// available as an API endpoint and via logs.

import { Link } from "react-router-dom";

import { useAvailableProviders } from "../hooks/use-available-providers";
import { useConnections } from "../hooks/use-connections";
import { BrowsePage } from "./browse";

export function HomePage() {
  const connections = useConnections();
  const available = useAvailableProviders();

  // While connections are still loading we can't yet decide first-run vs.
  // library view — avoid a flash of the wrong state.
  if (connections.isLoading || available.isLoading) {
    return <p className="opacity-60">Loading…</p>;
  }

  const isEmpty = (connections.data ?? []).length === 0;
  if (isEmpty) {
    const anyConfigured = available.data
      ? Object.values(available.data).some(Boolean)
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
        <h1 className="text-3xl font-semibold tracking-tight">Setup required</h1>
        <p className="mt-2 opacity-70">
          Castify needs OAuth credentials for at least one cloud provider before
          you can connect an account.
        </p>
        <p className="mt-3 text-xs opacity-50">
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
        className="inline-block rounded-md bg-[var(--color-castify-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-castify-canvas)] transition hover:opacity-90"
      >
        Connect a provider
      </Link>
    </section>
  );
}
