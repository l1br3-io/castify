// Route configuration as pure data (no `createBrowserRouter` side effect).
//
// Split from `router.tsx` so tests can assert on the tree — matching,
// loaders, publicity — without initializing a browser router, which starts
// a navigation and invokes loaders at import time (unwelcome in jsdom).
//
// Publicity rules:
//   * `/share/*` routes are recipient-facing and deliberately loaderless —
//     recipients hold no session (sharing). Their auth is
//     per-request against the share token, server-side.
//   * Every owner route keeps `requireSessionLoader` (redirects
//     unauthenticated users to login) or `setupLoader` (first-boot wizard).

import type { RouteObject } from "react-router-dom";
import { AppLayout } from "./layouts/app-layout";
import { CollectionDetailPage } from "./components/collections/collection-detail";
import { CollectionsPage } from "./routes/collections";
import { ConnectionsPage } from "./routes/connections";
import { HomePage } from "./routes/home";
import { LoginPage } from "./routes/login";
import { NotFoundPage } from "./routes/not-found";
import { SettingsPage } from "./routes/settings";
import { SetupPage } from "./routes/setup";
import { ShareManagePage } from "./routes/share-manage";
import { SharesPage } from "./routes/shares";
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
    // Watch is standalone too (task 009/D5): the demo's watch page is a
    // dark editorial spread with its own back-to-library chrome — it does
    // not live inside the sidebar shell, and full-bleed playback wants the
    // width. Session still required.
    path: "/watch/:id",
    element: <WatchPage />,
    loader: requireSessionLoader,
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
        // Shares list (task 005): promoted from a Settings section to a
        // top-level route per spec D4. Share-manage stays at the stable
        // `/settings/shares/:id` path below.
        path: "shares",
        element: <SharesPage />,
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
        // Collections index (collections-page task 002): the overview
        // grid for the whole set. Sits before `collections/:id` so the
        // static path wins matching.
        path: "collections",
        element: <CollectionsPage />,
        loader: requireSessionLoader,
      },
      {
        // Collection detail (library-collections task 008): the ordered
        // member grid for one collection, inside the app shell like the
        // other library surfaces.
        path: "collections/:id",
        element: <CollectionDetailPage />,
        loader: requireSessionLoader,
      },
      { path: "setup", element: <SetupPage />, loader: setupLoader },
      { path: "login", element: <LoginPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
