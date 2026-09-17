// Router route-tree coverage (sharing task 008).
//
// The share routes are the SPA's only public entry points besides
// setup/login: they must match without a session loader, while every
// owner route keeps `requireSessionLoader` (unauthenticated users are
// redirected to login). Asserting on the exported route tree keeps this
// a pure config check — no router instance or component mounting needed.

import { matchRoutes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { routeTree } from "./route-tree";
import { requireSessionLoader } from "./auth/require-session";

function deepestRoute(pathname: string) {
  const matches = matchRoutes(routeTree, pathname);
  expect(matches, `no route matched ${pathname}`).not.toBeNull();
  return matches!.at(-1)!.route;
}

describe("share routes are public", () => {
  it("serves /share/:token with no session loader", () => {
    const route = deepestRoute("/share/tok_abc");
    expect(route.path).toBe("/share/:token");
    expect(route.loader).toBeUndefined();
  });

  it("serves /share/:token/watch/:videoId with no session loader", () => {
    const route = deepestRoute("/share/tok_abc/watch/v1");
    expect(route.path).toBe("/share/:token/watch/:videoId");
    expect(route.loader).toBeUndefined();
  });
});

describe("owner routes keep the session loader", () => {
  it.each(["/", "/shares", "/connections", "/settings", "/watch/v1"])(
    "%s still requires a session",
    (pathname) => {
      expect(deepestRoute(pathname).loader).toBe(requireSessionLoader);
    },
  );
});
