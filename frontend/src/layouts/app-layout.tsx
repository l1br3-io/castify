// App shell layout: header + outlet + footer.
//
// Session-aware: when `useSession()` resolves an owner, the header shows their
// display name and a "Sign out" button. On sign-out, the session cache is set
// to `null` (no refetch needed — we just deleted the cookie) and the user is
// redirected to `/login`. When no session (logged out, on `/setup` or
// `/login`), the header shows just the brand.

import { Outlet, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { logout } from "../api/session";
import { SESSION_QUERY_KEY, useSession } from "../hooks/use-session";

export function AppLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  const logoutMutation = useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      navigate("/login", { replace: true });
    },
  });

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-white/10 bg-[var(--color-castify-surface)]">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <a href="/" className="text-lg font-semibold tracking-tight">
            Castify
          </a>
          {session ? (
            <div className="flex items-center gap-3 text-sm">
              <span className="opacity-70">
                Signed in as{" "}
                <strong className="font-medium">
                  {session.display_name ?? "owner"}
                </strong>
              </span>
              <button
                type="button"
                onClick={() => logoutMutation.mutate()}
                disabled={logoutMutation.isPending}
                className="rounded-md border border-white/15 px-3 py-1 text-xs transition hover:bg-white/5 disabled:opacity-50"
              >
                {logoutMutation.isPending ? "Signing out…" : "Sign out"}
              </button>
            </div>
          ) : (
            <span className="text-xs opacity-60">M0 · Foundation</span>
          )}
        </div>
      </header>
      <main className="flex-1 mx-auto max-w-6xl w-full px-4 py-8">
        <Outlet />
      </main>
      <footer className="border-t border-white/10 py-4 text-center text-xs opacity-60">
        Castify · AGPL-3.0 · by l1br3
      </footer>
    </div>
  );
}
