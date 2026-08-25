// App shell layout: header + outlet + footer.
//
// Session-aware: when `useSession()` resolves an owner, the header shows their
// display name and a "Sign out" button. On sign-out, the session cache is set
// to `null` (no refetch needed — we just deleted the cookie) and the user is
// redirected to `/login`. When no session (logged out, on `/setup` or
// `/login`), the header shows just the brand.
//
// Scan LED (identity-pass T2): the header carries a 3px amber signal bar that
// pulses while any connection scans. `ScanLed` is a child component that
// mounts ONLY when a session exists — `useConnections()` lives inside it, so
// mounting the layout on `/login` or `/setup` never fires `GET
// /api/connections`. This is the fetch-avoidance contract from
// docs/data-storage-principles.md (cheapest request is the one never made);
// for session users the query dedupes into the existing `['connections']`
// cache that the Connections page already reads.
//
// Theme toggle (Phase 1 design-pass): a sun/moon button in the header. The
// initial theme is applied before first paint by the inline script in
// index.html; this hook manages subsequent user-driven changes.

import { Outlet, Link, NavLink, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { logout } from "../api/session";
import { SESSION_QUERY_KEY, useSession } from "../hooks/use-session";
import { hasScanning, useConnections } from "../hooks/use-connections";
import { useTheme } from "../hooks/use-theme";
import { useToast } from "../hooks/use-toast";
import { MoonIcon, SunIcon } from "../components/icons";
import { OfflineBanner } from "../components/ui/offline-banner";

const NAV_LINK_CLASS = ({ isActive }: { isActive: boolean }) =>
  [
    "font-mono text-xs tracking-wide border-b pb-0.5 -mb-px transition-colors",
    isActive
      ? "text-[var(--color-castify-text)] border-[var(--color-castify-accent)]"
      : "text-[var(--color-castify-muted)] border-transparent hover:text-[var(--color-castify-text)] hover:border-[var(--color-castify-rule)]",
  ].join(" ");

/** Amber signal bar: pulses only while any connection scans. See header
 *  comment for why this must stay a child component gated on session. */
function ScanLed() {
  const { data: connections } = useConnections();

  if (!hasScanning(connections)) {
    return (
      <span
        aria-hidden="true"
        className="h-5 w-[3px] shrink-0 rounded-full bg-[var(--color-castify-rule)]"
      />
    );
  }

  return (
    <span role="status" className="shrink-0">
      <span
        aria-hidden="true"
        className="block h-5 w-[3px] rounded-full bg-[var(--color-castify-accent)] animate-scan-pulse"
      />
      <span className="sr-only">Scanning your cloud</span>
    </span>
  );
}

export function AppLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const { theme, toggle } = useTheme();
  const toast = useToast();

  const logoutMutation = useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      navigate("/login", { replace: true });
    },
  });

  return (
    <div className="min-h-screen flex flex-col">
      <OfflineBanner />
      <header className="border-b border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)]">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-6 min-w-0">
            {/* Copy freeze: DOM text stays `Castify`; the lowercase mono
                wordmark is pure CSS (spec § Copy freeze). */}
            <Link
              to="/"
              className="font-mono text-lg font-medium lowercase tracking-tight text-[var(--color-castify-text)]"
            >
              Castify
            </Link>
            {session && (
              <>
                <ScanLed />
                <nav className="flex items-center gap-4">
                  <NavLink to="/connections" className={NAV_LINK_CLASS}>
                    Connections
                  </NavLink>
                  <NavLink to="/settings" className={NAV_LINK_CLASS}>
                    Settings
                  </NavLink>
                </nav>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              onClick={toggle}
              aria-label={
                theme === "dark"
                  ? "Switch to light theme"
                  : "Switch to dark theme"
              }
              title={
                theme === "dark"
                  ? "Switch to light theme"
                  : "Switch to dark theme"
              }
              className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] text-[var(--color-castify-text)] transition hover:bg-[var(--color-castify-accent-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)]"
            >
              {theme === "dark" ? (
                <SunIcon className="h-4 w-4" />
              ) : (
                <MoonIcon className="h-4 w-4" />
              )}
            </button>
            {session ? (
              <>
                <span className="hidden sm:inline opacity-70">
                  Signed in as{" "}
                  <strong className="font-medium">
                    {session.display_name ?? "owner"}
                  </strong>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    logoutMutation.mutate();
                    toast.info("Signed out.");
                  }}
                  disabled={logoutMutation.isPending}
                  className="font-mono rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-3 py-1.5 text-xs text-[var(--color-castify-muted)] transition-colors hover:bg-[var(--color-castify-accent-subtle)] hover:text-[var(--color-castify-text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-castify-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)] disabled:opacity-50"
                >
                  {logoutMutation.isPending ? "Signing out…" : "Sign out"}
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>
      <main className="flex-1 mx-auto max-w-7xl w-full px-4 py-8">
        <Outlet />
      </main>
      <footer className="border-t border-[var(--color-castify-rule)] py-4 text-center text-xs opacity-75">
        Castify · AGPL-3.0 · by l1br3
      </footer>
    </div>
  );
}
