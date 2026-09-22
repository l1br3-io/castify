// Test utilities for component-level testing.
//
// `renderWithProviders` wraps a component in a fresh QueryClient (retry:
// false, gcTime: 0 — no persisted cache between tests) and a MemoryRouter with
// configurable initial entries. A fetch spy is installed on globalThis and
// returned so tests can assert on calls. `restoreMocks: true` in the vitest
// config ensures the spy is removed between tests automatically.
//
// Response helpers (`jsonResponse`, `jsonError`) build `Response` objects with
// JSON bodies matching what the API returns, so `apiFetch` can parse them.

import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, type InitialEntry } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";

import { ToastProvider } from "../components/ui/toast";
import { DragProvider } from "../components/drag-context";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonError(status: number, message: string): Response {
  return jsonResponse({ message }, status);
}

export type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

interface RenderWithProvidersOptions {
  // Accepts strings ("/watch/v1") or location objects ({ pathname, state })
  // so callers can seed router state for queue-aware tests (M3 T11).
  initialEntries?: InitialEntry[];
  fetchImplementation?: FetchHandler;
  // Override the default throwaway QueryClient — e.g. to mirror the
  // production client's staleTime/gcTime when a test is specifically
  // about cache behavior across mounts.
  queryClient?: QueryClient;
}

function defaultFetch(): Response {
  return jsonError(404, "unmocked");
}

export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
) {
  const {
    initialEntries = ["/"],
    fetchImplementation = defaultFetch,
    queryClient: providedClient,
  } = options;

  const queryClient =
    providedClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });

  const fetchSpy = vi.fn(fetchImplementation);
  vi.stubGlobal("fetch", fetchSpy);

  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <DragProvider>
          <ToastProvider>{ui}</ToastProvider>
        </DragProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { ...renderResult, fetchSpy, queryClient };
}
