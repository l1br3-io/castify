// Home page (`/`): first-run connection guide or the video library.
//
// Per FR-9.1, on first visit after login with zero connections the page shows a
// "Connect your first cloud" guide linking to `/connections`. Because zero
// connections implies zero videos (the scanner only runs on connections and
// disconnect cascade-deletes catalog rows), the connections-empty check alone
// is the gate — no separate `/api/videos` probe needed.
//
// Once at least one connection exists, the video library (`VideoList`) takes
// over. The M0 health-probe placeholder was removed — `/api/health` remains
// available as an API endpoint and via logs.

import { Link } from "react-router-dom";

import { useConnections } from "../hooks/use-connections";
import { VideoList } from "./videos";

export function HomePage() {
  const connections = useConnections();

  // While connections are still loading we can't yet decide first-run vs.
  // library view — avoid a flash of the wrong state.
  if (connections.isLoading) {
    return <p className="opacity-60">Loading…</p>;
  }

  const isEmpty = (connections.data ?? []).length === 0;
  if (isEmpty) {
    return <FirstRunGuide />;
  }
  return <VideoList />;
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
