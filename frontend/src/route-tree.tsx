// Route configuration as pure data (no `createBrowserRouter` side effect).
//
// Split from `router.tsx` so tests can assert on the tree — matching,
// loaders, publicity — without initializing a browser router, which starts
// a navigation and invokes loaders at import time (unwelcome in jsdom).
//
// Publicity rules:
//   * `/share/*` routes are recipient-facing and deliberately loaderless —
//     recipients hold no session (docs/specs/sharing). Their auth is
//     per-request against the share token, server-side.
//   * Every owner route keeps `requireSessionLoader` (redirects
//     unauthenticated users to login) or `setupLoader` (first-boot wizard).

import type { RouteObject } from "react-router-dom";
import { AppLayout } from "./layouts/app-layout";
import { ConnectionsPage } from "./routes/connections";
import { HomePage } from "./routes/home";
import { LoginPage } from "./routes/login";
import { NotFoundPage } from "./routes/not-found";
import { SettingsPage } from "./routes/settings";
import { SetupPage } from "./routes/setup";
import { ShareManagePage } from "./routes/share-manage";
import { SharePage } from "./routes/share";
import { ShareWatchPage } from "./routes/share-watch";
import { WatchPage } from "./routes/watch";
import { requireSessionLoader, setupLoader } from "./auth/require-session";

export const routeTree: RouteObject[] = [
  // Recipient-facing share routes — public (pre-auth), standalone (no
  // AppLayout: recipients get no owner navigation).
  {
    path: "/share/:token",
    element: <SharePage />,
  },
  {
    path: "/share/:token/watch/:videoId",
    element: <ShareWatchPage />,
  },
  {
    path: "/",
    element: <AppLayout />,
    children: [
      {
        index: true,
        element: <HomePage />,
        loader: requireSessionLoader,
      },
      {
        path: "connections",
        element: <ConnectionsPage />,
        loader: requireSessionLoader,
      },
      {
        path: "settings",
        element: <SettingsPage />,
        loader: requireSessionLoader,
      },
      {
        // Share detail (share-manage-page task 003) — the owner's manage
        // surface for one share. Sibling of `settings`, not a child, so
        // the page owns its own layout width (wide grid).
        path: "settings/shares/:id",
        element: <ShareManagePage />,
        loader: requireSessionLoader,
      },
      {
        path: "watch/:id",
        element: <WatchPage />,
        loader: requireSessionLoader,
      },
      { path: "setup", element: <SetupPage />, loader: setupLoader },
      { path: "login", element: <LoginPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
