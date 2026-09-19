// App shell layout: the design's frame interior (castify-design.html).
//
// A topbar — menu button (mobile), brand, library search, scan status,
// theme toggle, account menu — sits above a 220px sidebar (primary nav +
// the Library's folder tree) beside the routed view. The sidebar scrolls
// independently; the view scrolls in its own pane, like the design's
// frame-body grid.
//
// Responsive (the design's two breakpoints):
//   * ≤860px — the sidebar becomes an overlay drawer sliding in from the
//     left over a backdrop; the hamburger opens it, Escape / backdrop /
//     navigation closes it.
//   * ≤600px — the search field, scan status, and account name drop out
//     (compact topbar; the hamburger + brand + icon controls remain).
//
// The FOLDERS section mounts only on the Library route ("/", the design's
// `on-library` state) via SidebarFolders, which owns the `?dir=` tree
// semantics.
//
// Session-aware: the shell waits for the session query to settle before
// rendering either variant — swapping bare ↔ full chrome after the outlet
// has mounted would remount the whole page beneath it. With NO session
// (logged out, `/setup`, `/login`) the shell renders bare — auth screens
// own their chrome — and mounts no fetches (ScanIndicator's
// useConnections lives below the session gate).
//
// Theme: the initial theme is applied before first paint by the inline
// script in index.html.

import { useEffect, useRef, useState } from "react";
import {
  Outlet,
  Link,
  NavLink,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { logout } from "../api/session";
import { PROVIDER_LABELS } from "../api/types";
import { SESSION_QUERY_KEY, useSession } from "../hooks/use-session";
import { hasScanning, useConnections } from "../hooks/use-connections";
import { useTheme } from "../hooks/use-theme";
import { useToast } from "../hooks/use-toast";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import {
  CloudIcon,
  GearIcon,
  LibraryIcon,
  MenuIcon,
  MoonIcon,
  ShareNodesIcon,
  StackIcon,
  SunIcon,
} from "../components/icons";
import { SearchBar } from "../components/search-bar";
import { SidebarFolders } from "../components/sidebar-folders";
import { Menu, MenuItem } from "../components/ui/menu";
import { IconButton } from "../components/ui/icon-button";
import { OfflineBanner } from "../components/ui/offline-banner";

const NAV_ITEMS = [
  { to: "/", label: "Library", Icon: LibraryIcon, end: true },
  { to: "/collections", label: "Collections", Icon: StackIcon, end: false },
  { to: "/connections", label: "Connections", Icon: CloudIcon, end: false },
  { to: "/shares", label: "Shares", Icon: ShareNodesIcon, end: false },
  { to: "/settings", label: "Settings", Icon: GearIcon, end: false },
] as const;

const NAV_LINK_CLASS = ({ isActive }: { isActive: boolean }) =>
  [
    "flex items-center gap-2.5 rounded-[var(--radius-button)] px-2.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-sunken)]",
    isActive
      ? "bg-[var(--color-castify-accent-subtle)] font-semibold text-[var(--color-castify-accent-strong)]"
      : "text-[var(--color-castify-muted)] hover:bg-[var(--color-castify-hover)] hover:text-[var(--color-castify-text)]",
  ].join(" ");

/** Brand mark — the design's rounded-square + lens glyph, accent stroked. */
function BrandMark() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0" aria-hidden>
      <rect
        x="1"
        y="1"
        width="18"
        height="18"
        rx="5"
        fill="none"
        stroke="var(--color-castify-accent)"
        strokeWidth="1.5"
      />
      <circle cx="10" cy="10" r="3" fill="var(--color-castify-accent)" />
    </svg>
  );
}

/** Scan indicator: pulsing dot + provider name while any connection scans.
 * See header comment for why this must stay a child component gated on
 * session. */
function ScanIndicator() {
  const { data: connections } = useConnections();
  const scanning = connections?.find((c) => c.scan_status === "scanning");

  if (!hasScanning(connections) || !scanning) return null;

  return (
    <p role="status" className="flex items-center gap-2 px-1 text-xs">
      <span
        aria-hidden="true"
        className="size-[7px] shrink-0 rounded-full bg-[var(--color-castify-accent)] animate-scan-pulse"
      />
      <span className="text-[var(--color-castify-muted)]">
        Scanning{" "}
        <span className="text-[var(--color-castify-text)]">
          {PROVIDER_LABELS[scanning.provider] ?? scanning.provider}
        </span>
        …
      </span>
    </p>
  );
}

/** Topbar search — the design puts the library search in the topbar. The
 * raw input is local; the debounced value writes the URL `q` param that
 * the browse page reads. From a non-library route, a query navigates to
 * `/?q=…` first. The "/" shortcut focuses the field. */
function TopbarSearch() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  // The library's `q` is the topbar's own — other routes may carry a
  // `q` of theirs (share manage's whole-share search). Adopting it here
  // would type into the topbar uninvited and, once its debounce
  // settles, hijack the navigation to `/?q=…`.
  const ownQuery = location.pathname === "/" ? searchParams.get("q") ?? "" : "";
  const [raw, setRaw] = useState(ownQuery);
  const debounced = useDebouncedValue(raw, 300);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcut: "/" focuses the search field. Ignored when the user
  // is already typing in an input/textarea or holding a modifier. (Below
  // 600px the field is compacted away and focus() is a browser no-op, so
  // no width guard is needed.)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable
      )
        return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Debounced input → URL `q`. From a non-library route, a non-empty
  // query jumps to the library with the query applied.
  useEffect(() => {
    const current = searchParams.get("q") ?? "";
    if (debounced === current) return;
    if (location.pathname !== "/") {
      if (debounced !== "") navigate(`/?q=${encodeURIComponent(debounced)}`);
      return;
    }
    const params = new URLSearchParams(searchParams);
    if (debounced === "") {
      params.delete("q");
    } else {
      params.set("q", debounced);
    }
    setSearchParams(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  // URL → input: back/forward, the page's clear-search action, and any
  // other `q` writer stay reflected in the field — scoped to the
  // library route per `ownQuery` above.
  useEffect(() => {
    setRaw(ownQuery);
  }, [ownQuery]);

  return <SearchBar ref={inputRef} value={raw} onChange={setRaw} />;
}

export function AppLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session, isLoading: sessionLoading } = useSession();
  const { theme, toggle } = useTheme();
  const toast = useToast();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isLibrary = location.pathname === "/";

  const logoutMutation = useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      navigate("/login", { replace: true });
    },
  });

  // Route changes dismiss the drawer — selecting a nav item included.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Escape closes the drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // Settle first: rendering the outlet under the bare shell and then
  // swapping in the full chrome would remount the whole page beneath it.
  if (sessionLoading) {
    return (
      <div className="min-h-screen">
        <OfflineBanner />
      </div>
    );
  }

  // Logged out: bare shell — auth screens own their chrome (login and
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
    <div className="flex h-screen supports-[height:100dvh]:h-dvh flex-col overflow-hidden">
      <OfflineBanner />

      {/* Topbar — menu (mobile), brand, search, scan status, theme,
          account. Compact below 600px: search, scan status, and the
          account name drop out. */}
      <header className="z-20 flex shrink-0 items-center gap-2 border-b border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] px-3 py-2.5 min-[600px]:gap-3 min-[600px]:px-5">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation menu"
          aria-controls="app-sidebar"
          aria-expanded={drawerOpen}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] text-[var(--color-castify-muted)] transition hover:bg-[var(--color-castify-hover)] hover:text-[var(--color-castify-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)] min-[861px]:hidden"
        >
          <MenuIcon className="h-[17px] w-[17px]" />
        </button>

        <Link
          to="/"
          className="flex shrink-0 items-center gap-2 text-base font-bold tracking-tight text-[var(--color-castify-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)]"
        >
          <BrandMark />
          Castify
        </Link>

        <div className="hidden min-w-0 flex-1 min-[600px]:block min-[600px]:max-w-[380px]">
          <TopbarSearch />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 min-[600px]:gap-2.5">
          {/* Scan status — desktop-width topbar only (design). */}
          <div className="hidden min-[600px]:block">
            <ScanIndicator />
          </div>
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
          <Menu
            label="Account"
            align="end"
            triggerClassName="flex items-center gap-2 rounded-full py-1 pl-1 pr-2.5 transition hover:bg-[var(--color-castify-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-castify-surface)]"
            trigger={
              <>
                <span
                  aria-hidden="true"
                  className="h-[26px] w-[26px] shrink-0 rounded-full bg-gradient-to-br from-[var(--color-castify-accent)] to-[var(--color-success)]"
                />
                <span className="hidden text-sm font-semibold min-[600px]:block">
                  {session.display_name ?? "owner"}
                </span>
              </>
            }
          >
            {(close) => (
              <>
                <p className="px-3 pb-1.5 pt-1.5 text-xs text-[var(--color-castify-muted)]">
                  Signed in as{" "}
                  <strong className="font-semibold text-[var(--color-castify-text)]">
                    {session.display_name ?? "owner"}
                  </strong>
                </p>
                <MenuItem
                  onSelect={() => {
                    close();
                    logoutMutation.mutate();
                    toast.info("Signed out.");
                  }}
                >
                  {logoutMutation.isPending ? "Signing out…" : "Sign out"}
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </header>

      {/* Frame body: sidebar + scrolling view pane (the design's
          frame-body grid, flexed). `relative` anchors the mobile drawer +
          backdrop. */}
      <div className="relative flex min-h-0 flex-1">
        {/* Backdrop — mobile drawer only. A real button so click/tap and
            assistive tech both dismiss. */}
        {drawerOpen && (
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation menu"
            className="absolute inset-0 z-30 bg-[rgb(10_12_16_/_0.4)] min-[861px]:hidden"
          />
        )}

        <aside
          id="app-sidebar"
          className={[
            // Mobile: overlay drawer sliding from the left. visibility
            // (not display) gates it so the slide-out transition plays
            // and closed content never lands in the tab order.
            "absolute inset-y-0 left-0 z-40 flex w-60 max-w-[80%] flex-col overflow-y-auto border-r border-[var(--color-castify-rule)] bg-[var(--color-castify-sunken)] px-3 py-4",
            "transition-[transform,visibility,box-shadow] duration-200 ease-out motion-reduce:transition-none",
            drawerOpen
              ? "visible translate-x-0 shadow-lg"
              : "invisible -translate-x-full",
            // Desktop: static rail (the design's 220px column).
            "min-[861px]:static min-[861px]:z-auto min-[861px]:w-[220px] min-[861px]:max-w-none min-[861px]:shrink-0 min-[861px]:translate-x-0 min-[861px]:visible min-[861px]:shadow-none min-[861px]:transition-none",
          ].join(" ")}
        >
          <nav aria-label="Primary">
            <ul className="flex flex-col gap-0.5">
              {NAV_ITEMS.map(({ to, label, Icon, end }) => (
                <li key={to}>
                  <NavLink to={to} end={end} className={NAV_LINK_CLASS}>
                    <Icon className="h-[17px] w-[17px] shrink-0 opacity-80" />
                    {label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          {/* FOLDERS live in the sidebar on the Library view only (the
              design's `on-library` state). */}
          {isLibrary && <SidebarFolders />}
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 min-[600px]:px-6">
            <Outlet />
          </div>
          <footer className="border-t border-[var(--color-castify-rule)] py-4 text-center text-xs text-[var(--color-castify-muted)]">
            Castify · AGPL-3.0 · by l1br3
          </footer>
        </main>
      </div>
    </div>
  );
}
