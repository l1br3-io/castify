// Route loader guarding protected resources.
//
// Used as the `loader` on routes that require an authenticated session
// (currently `/`). The flow:
//
//   1. Pre-fetch the session into the shared `['session']` query cache so the
//      rendering component reads from cache on first paint (no refetch flicker).
//   2. If a session exists → render the route.
//   3. If no session → pre-fetch owner-existence (`['setup-status']`) and
//      redirect: first boot → `/setup`, subsequent boots → `/login`.
//
// Throwing `redirect(...)` is the react-router v7 data-router convention; the
// router catches it and performs the navigation before rendering.

import { redirect } from "react-router-dom";

import { fetchSetupStatus } from "../api/setup";
import { fetchSession } from "../api/session";
import { SESSION_QUERY_KEY } from "../hooks/use-session";
import { queryClient } from "../query-client";

export const SETUP_STATUS_QUERY_KEY = ["setup-status"] as const;

export async function requireSessionLoader(): Promise<null> {
  const session = await queryClient.fetchQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSession,
  });

  if (session !== null) {
    return null;
  }

  // No session — decide where to send the user based on whether first-run
  // setup is still open. Cache the probe so the destination route doesn't
  // refetch it immediately.
  const setupStatus = await queryClient.fetchQuery({
    queryKey: SETUP_STATUS_QUERY_KEY,
    queryFn: fetchSetupStatus,
  });

  throw redirect(setupStatus === "open" ? "/setup" : "/login");
}

/**
 * Loader for the `/setup` route. Defends against stale bookmarks: if an owner
 * already exists (setup closed), redirect to `/login` rather than rendering a
 * wizard that would 409 on submit. Pre-populates the `['setup-status']` cache
 * so the page doesn't refetch immediately.
 */
export async function setupLoader(): Promise<null> {
  const setupStatus = await queryClient.fetchQuery({
    queryKey: SETUP_STATUS_QUERY_KEY,
    queryFn: fetchSetupStatus,
  });

  if (setupStatus === "closed") {
    throw redirect("/login");
  }
  return null;
}
