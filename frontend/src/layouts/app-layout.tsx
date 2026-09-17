// App shell layout: Classical sidebar + outlet + footer (D5/task 009).
//
// Session-aware: with an owner, a 220px rail (demo `cf-side`) carries the
// wordmark, the primary nav (Library / Sources / Shares / Settings, icon +
// label), and a bottom cluster — scan indicator, theme toggle, signed-in
// name, sign-out. On <sm widths the rail becomes a top strip (same nav,
// horizontal). On sign-out, the session cache is set to `null` and the user
// is redirected to `/login`.
//
// With NO session (logged out, `/setup`, `/login`) the shell renders bare
// — auth screens own their chrome (demo login/setup are standalone centered
// cards), so no sidebar, no nav, no fetches.
//
// Scan indicator (identity-pass T2 → Classical): the bottom cluster shows a
// pulsing gold dot + "Scanning <provider>…" while any connection scans. It
// mounts ONLY when a session exists — `useConnections()` lives inside it, so
// `/login` / `/setup` never fire `GET /api/connections`
// (docs/data-storage-principles.md fetch-avoidance; for session users the
// query dedupes into the existing `['connections']` cache).
//
// Theme toggle: a sun/moon IconButton in the bottom cluster. The initial
// theme is applied before first paint by the inline script in index.html.

import { Outlet, Link, NavLink, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { logout } from "../api/session";
import { PROVIDER_LABELS } from "../api/types";
import { SESSION_QUERY_KEY, useSession } from "../hooks/use-session";
import { hasScanning, useConnections } from "../hooks/use-connections";
import { useTheme } from "../hooks/use-theme";
import { useToast } from "../hooks/use-toast";
import {
  CloudIcon,
  GearIcon,
  LibraryIcon,
  MoonIcon,
  ShareNodesIcon,
  SunIcon,
} from "../components/icons";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { OfflineBanner } from "../components/ui/offline-banner";

const NAV_ITEMS = [
  { to: "/", label: "Library", Icon: LibraryIcon, end: true },
  { to: "/connections", label: "Sources", Icon: CloudIcon, end: false },
  { to: "/shares", label: "Shares", Icon: ShareNodesIcon, end: false },
  { to: "/settings", label: "Settings", Icon: GearIcon, end: false },
] as const;

const NAV_LINK_CLASS = ({ isActive }: { isActive: boolean }) =>
  [
    "flex items-center gap-2.5 rounded-[var(--radius-button)] px-2.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-canvas)]",
    isActive
      ? "text-[var(--color-castify-accent-strong)] bg-[var(--color-castify-accent-subtle)]"
      : "text-[var(--color-castify-text)] hover:bg-[var(--color-castify-hover)]",
  ].join(" ");

/** Scan indicator: gold dot + provider name while any connection scans.
 * See header comment for why this must stay a child component gated on
 * session. */
function ScanIndicator() {
  const { data: connections } = useConnections();
  const scanning = connections?.find((c) => c.scan_status === "scanning");

  if (!hasScanning(connections) || !scanning) return null;

  return (
    <p role="status" className="flex items-center gap-2 px-2.5 text-xs">
      <span
        aria-hidden="true"
        className="size-[7px] shrink-0 rounded-full bg-[var(--color-castify-accent)] animate-scan-pulse"
      />
      <span className="text-[var(--color-castify-muted)]">
        Scanning {PROVIDER_LABELS[scanning.provider] ?? scanning.provider}…
      </span>
    </p>
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

  // Logged out: bare shell — auth screens own their chrome (demo login and
  // setup are standalone centered cards with their own brand).
  if (!session) {
    return (
      <div className="min-h-screen">
        <OfflineBanner />
        <main>
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col sm:flex-row">
      <OfflineBanner />
      <aside className="flex flex-col gap-4 border-b border-[var(--color-castify-rule)] px-3 py-4 sm:w-[220px] sm:shrink-0 sm:border-b-0 sm:border-r">
        <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-stretch">
          <div>
            {/* Copy freeze: DOM text stays `Castify`; the lowercase mono
                wordmark is pure CSS (spec § Copy freeze). */}
            <Link
              to="/"
              className="font-mono text-lg font-medium lowercase tracking-tight text-[var(--color-castify-text)]"
            >
              Castify
            </Link>
          </div>
          <nav aria-label="Primary" className="contents">
            <ul className="flex flex-wrap items-center gap-1 sm:flex-col sm:items-stretch sm:gap-0.5">
              {NAV_ITEMS.map(({ to, label, Icon, end }) => (
                <li key={to}>
                  <NavLink to={to} end={end} className={NAV_LINK_CLASS}>
                    <Icon className="size-[17px] shrink-0" />
                    {label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div className="mt-auto flex flex-col gap-3 border-t border-[var(--color-castify-rule)] pt-3">
          <ScanIndicator />
          <div className="flex items-center gap-2 px-2.5">
            <IconButton
              label={
                theme === "dark"
                  ? "Switch to light theme"
                  : "Switch to dark theme"
              }
              onClick={toggle}
            >
              {theme === "dark" ? (
                <SunIcon className="h-4 w-4" />
              ) : (
                <MoonIcon className="h-4 w-4" />
              )}
            </IconButton>
            <span className="hidden min-w-0 truncate text-xs text-[var(--color-castify-muted)] sm:block">
              Signed in as{" "}
              <strong className="font-medium text-[var(--color-castify-text)]">
                {session.display_name ?? "owner"}
              </strong>
            </span>
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              pending={logoutMutation.isPending}
              onClick={() => {
                logoutMutation.mutate();
                toast.info("Signed out.");
              }}
            >
              {logoutMutation.isPending ? "Signing out…" : "Sign out"}
            </Button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-7xl px-4 py-8">
          <Outlet />
        </div>
        <footer className="border-t border-[var(--color-castify-rule)] py-4 text-center text-xs text-[var(--color-castify-muted)]">
          Castify · AGPL-3.0 · by l1br3
        </footer>
      </main>
    </div>
  );
}
