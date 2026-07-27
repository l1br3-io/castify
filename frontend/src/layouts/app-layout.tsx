// App shell layout: header + outlet + footer.
//
// Session-aware: when `useSession()` resolves an owner, the header shows their
// display name and a "Sign out" button. On sign-out, the session cache is set
// to `null` (no refetch needed — we just deleted the cookie) and the user is
// redirected to `/login`. When no session (logged out, on `/setup` or
// `/login`), the header shows just the brand.
//
// Theme toggle (Phase 1 design-pass): a sun/moon button in the header. The
// initial theme is applied before first paint by the inline script in
// index.html; this hook manages subsequent user-driven changes.

import { Outlet, Link, NavLink, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { logout } from "../api/session";
import { SESSION_QUERY_KEY, useSession } from "../hooks/use-session";
import { useTheme } from "../hooks/use-theme";
import { useToast } from "../hooks/use-toast";
import { MoonIcon, SunIcon } from "../components/icons";
import { OfflineBanner } from "../components/ui/offline-banner";

const NAV_LINK_CLASS = ({ isActive }: { isActive: boolean }) =>
  [
    "text-sm transition hover:opacity-100",
    isActive ? "opacity-100" : "opacity-75",
  ].join(" ");

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
            <Link
              to="/"
              className="text-lg font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Castify
            </Link>
            {session && (
              <nav className="flex items-center gap-4">
                <NavLink to="/connections" className={NAV_LINK_CLASS}>
                  Connections
                </NavLink>
              </nav>
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
                  className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-3 py-1.5 text-xs transition hover:bg-[var(--color-castify-accent-subtle)] disabled:opacity-50"
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
