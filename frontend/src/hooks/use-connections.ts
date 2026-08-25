// `useConnections` — active provider connections with live scan feedback.
//
// The query keys `['connections']` (the list) and `['available-providers']`
// (the configured-providers probe) are invalidated after connect/disconnect so
// the cards reflect current state. While any connection is `scanning`, the
// list refetches every few seconds so the owner sees video counts climb
// without a manual refresh — T14 formalizes dedicated scan-status polling; this
// lightweight interval covers the post-connect experience in T12.

import { useQuery } from "@tanstack/react-query";
import { fetchConnections } from "../api/connections";
import type { ConnectionDto } from "../api/types";

export const CONNECTIONS_QUERY_KEY = ["connections"] as const;

const SCAN_POLL_MS = 4000;

/** True when any connection is mid-scan. Shared with the header ScanLed. */
export function hasScanning(connections: ConnectionDto[] | undefined): boolean {
  return Array.isArray(connections) && connections.some((c) => c.scan_status === "scanning");
}

export function useConnections() {
  return useQuery<ConnectionDto[]>({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: fetchConnections,
    refetchInterval: (query) => (hasScanning(query.state.data) ? SCAN_POLL_MS : false),
  });
}
