// Shared DTO types mirroring the Rust DTOs across `/api` routes.
// OwnerDto + OwnerEnvelope come from `crates/api/src/dto.rs`; the connection
// DTOs come from `crates/api/src/routes/connections.rs`.

export interface OwnerDto {
  id: string;
  display_name: string | null;
}

export interface OwnerEnvelope {
  owner: OwnerDto;
}

// Provider identifiers as serialized by the `Provider` enum
// (`crates/catalog/src/model.rs`, `#[serde(rename_all = "snake_case")]`).
export type ProviderKey = "google_drive" | "dropbox" | "onedrive";

export const PROVIDERS: readonly ProviderKey[] = [
  "google_drive",
  "dropbox",
  "onedrive",
] as const;

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
  google_drive: "Google Drive",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
};

// Scan status as serialized by `ScanStatus` (`#[serde(rename_all = "lowercase")]`).
export type ScanStatus = "idle" | "scanning" | "error";

export interface ConnectionDto {
  id: string;
  provider: ProviderKey;
  provider_account_email: string | null;
  connected_at: string;
  scan_status: ScanStatus;
  last_scan_at: string | null;
  video_count: number;
}

export interface AvailableProviders {
  google_drive: boolean;
  dropbox: boolean;
  onedrive: boolean;
}

export interface StartResponse {
  auth_url: string;
}

// Scan status from `GET /api/connections/{id}/scan` (FR-7.3).
export interface ScanStatusDto {
  status: ScanStatus;
  videos_found: number;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

// Sort keys accepted by `GET /api/videos?sort=` (see `VideoSort::parse` in
// `crates/catalog/src/model.rs`). Anything not "name" or "size" falls back to
// date-desc, but we send the canonical string to be explicit.
export type VideoSortKey = "date-desc" | "name" | "size";

export const VIDEO_SORT_LABELS: Record<VideoSortKey, string> = {
  "date-desc": "Newest",
  name: "Name",
  size: "Size",
};

// One source copy of a deduplicated video (`VideoSource` in the backend).
export interface VideoSourceDto {
  connection_id: string;
  provider: ProviderKey;
  provider_file_id: string;
}

// A deduplicated video summary (`VideoSummary` in the backend).
export interface VideoSummaryDto {
  id: string;
  name: string;
  provider: ProviderKey;
  size_bytes: number;
  mime_type: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  sources: VideoSourceDto[];
}

// Paginated response from `GET /api/videos` (`VideoPage` in the backend).
export interface VideoPageDto {
  videos: VideoSummaryDto[];
  total: number;
  page: number;
  limit: number;
}
