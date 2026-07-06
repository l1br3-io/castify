import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireSessionLoader } from "./require-session";
import { queryClient } from "../query-client";
import { jsonError, jsonResponse } from "../test/utils";

describe("requireSessionLoader", () => {
  beforeEach(() => {
    queryClient.clear();
  });

  it("redirects to /login when no session and setup is closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/session"))
          return jsonError(401, "unauthorized");
        if (url.includes("/api/setup")) return jsonError(409, "exists");
        return jsonError(404, "unmocked");
      }),
    );

    try {
      await requireSessionLoader();
      expect.fail("loader should have thrown a redirect");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      const response = error as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/login");
    }
  });

  it("returns null when a session exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/session"))
          return jsonResponse({
            owner: { id: "1", display_name: "Alex" },
          });
        return jsonError(404, "unmocked");
      }),
    );

    await expect(requireSessionLoader()).resolves.toBe(null);
  });
});
