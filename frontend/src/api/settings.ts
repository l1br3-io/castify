// Runtime server settings (Settings page → Transcoding).
//
// The transcode toggle is the first settings-table-backed control: the
// env var only provides the server's default; a PUT persists the owner's
// choice (DB wins across restarts) and flips the in-memory flag without a
// restart. The session cookie is HttpOnly; the CSRF header for the PUT is
// injected by `apiFetch` from the cached token.

import { apiFetch } from "./client";

/** TanStack Query key for the transcode settings query. */
export const TRANSCODE_SETTINGS_QUERY_KEY = ["settings", "transcode"] as const;

export interface TranscodeSettings {
  enabled: boolean;
}

/** Resolve the current transcode toggle via `GET /api/settings/transcode`. */
export async function fetchTranscodeSettings(): Promise<TranscodeSettings> {
  return apiFetch<TranscodeSettings>("/api/settings/transcode");
}

/**
 * Persist the transcode toggle via `PUT /api/settings/transcode`. Returns
 * the server's post-write state; the next stream-url request already
 * honors it.
 */
export async function updateTranscodeSettings(
  enabled: boolean,
): Promise<TranscodeSettings> {
  return apiFetch<TranscodeSettings>("/api/settings/transcode", {
    method: "PUT",
    body: { enabled },
  });
}
