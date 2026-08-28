// `useStreamUrl` scope seam (sharing task 008).
//
// The owner watch page calls the hook with no scope and must keep hitting
// `/api/videos/{id}/stream-url`. The share watch page (task 010) passes
// `{ kind: "share", token }` and gets strategy URLs rooted at the share
// mirror — the backend returns them pre-rooted, so the hook's job is only
// to hit the scoped endpoint and keep the query cache from colliding with
// the owner entry for the same video id.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { streamUrlQueryKey, useStreamUrl } from "./use-stream-url";
import { jsonResponse } from "../test/utils";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper: Wrapper, queryClient };
}

function fetchSpyReturning(body: unknown) {
  return vi.fn(() => jsonResponse(body));
}

function requestedUrl(spy: ReturnType<typeof vi.fn>): string {
  return (spy.mock.calls.at(-1)![0] as RequestInfo).toString();
}

describe("useStreamUrl", () => {
  it("defaults to the owner stream-url route", async () => {
    const spy = fetchSpyReturning({
      url: "/api/videos/v1/stream",
      strategy: "proxy",
      expires_at: null,
    });
    vi.stubGlobal("fetch", spy);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useStreamUrl("v1"), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedUrl(spy)).toBe("/api/videos/v1/stream-url");
    expect(result.current.data?.url).toBe("/api/videos/v1/stream");
  });

  it("hits the share mirror and returns share-rooted URLs when scoped", async () => {
    const spy = fetchSpyReturning({
      url: "/api/share/tok_abc/videos/v1/transcode/master.m3u8",
      strategy: "transcode",
      expires_at: null,
    });
    vi.stubGlobal("fetch", spy);
    const { wrapper } = createWrapper();

    const { result } = renderHook(
      () => useStreamUrl("v1", { kind: "share", token: "tok_abc" }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedUrl(spy)).toBe("/api/share/tok_abc/videos/v1/stream-url");
    expect(result.current.data?.url).toBe(
      "/api/share/tok_abc/videos/v1/transcode/master.m3u8",
    );
    expect(result.current.data?.strategy).toBe("transcode");
  });

  it("does not query while the id is undefined", async () => {
    const spy = fetchSpyReturning({ url: "/x", strategy: "proxy", expires_at: null });
    vi.stubGlobal("fetch", spy);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useStreamUrl(undefined), { wrapper });

    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("streamUrlQueryKey", () => {
  it("keeps the owner key shape unchanged", () => {
    expect(streamUrlQueryKey("v1")).toEqual(["videos", "v1", "stream-url"]);
  });

  it("namespaces the share key by token so scopes never share cache", () => {
    expect(streamUrlQueryKey("v1", { kind: "share", token: "tok_abc" })).toEqual([
      "share",
      "tok_abc",
      "videos",
      "v1",
      "stream-url",
    ]);
    expect(streamUrlQueryKey("v1")).not.toEqual(
      streamUrlQueryKey("v1", { kind: "share", token: "tok_abc" }),
    );
  });
});
