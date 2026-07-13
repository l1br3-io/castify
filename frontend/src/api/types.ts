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
// `crates/catalog/src/model.rs`). The backend parses unknown values back to
// `date-desc`, but we send the canonical string to be explicit.
//
// NOTE: the backend's base-name convention is *inconsistent* — `size` parses
// to `SizeDesc` (largest first) but `duration` parses to `DurationAsc`
// (shortest first). The labels below describe the *actual* sort direction
// produced by each key, not a syntactic pattern.
export type VideoSortKey =
  | "date-desc"
  | "date"
  | "name"
  | "name-desc"
  | "size"
  | "size-asc"
  | "duration"
  | "duration-desc"
  | "rating";

export const VIDEO_SORT_LABELS: Record<VideoSortKey, string> = {
  "date-desc": "Newest",
  date: "Oldest",
  name: "Name A–Z",
  "name-desc": "Name Z–A",
  size: "Largest",
  "size-asc": "Smallest",
  duration: "Shortest",
  "duration-desc": "Longest",
  rating: "Top Rated",
};

// Display order for sort dropdowns — grouped by category, with the default
// (`date-desc`) first. UITs should iterate this rather than the raw keys.
export const VIDEO_SORT_OPTIONS: readonly VideoSortKey[] = [
  "date-desc",
  "date",
  "name",
  "name-desc",
  "size",
  "size-asc",
  "duration-desc",
  "duration",
  "rating",
] as const;

// One source copy of a deduplicated video (`VideoSource` in the backend).
export interface VideoSourceDto {
  connection_id: string;
  provider: ProviderKey;
  provider_file_id: string;
}

// A deduplicated video summary (`VideoSummary` in the backend).
//
// The enriched fields (`created_at`, `path`, `is_favorite`, `my_rating`,
// `thumbnail_status`) were added in M2 T3 and are always present in the
// response from `GET /api/videos` — `is_favorite`/`my_rating` are owner-scoped
// via LEFT JOINs.
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
  created_at: string;
  path: string | null;
  is_favorite: boolean;
  my_rating: number | null;
  // "pending" | "cached" | "failed" | "unsupported" — see PRD FR-1.4/1.5.
  thumbnail_status: string;
}

// Paginated response from `GET /api/videos` (`VideoPage` in the backend).
export interface VideoPageDto {
  videos: VideoSummaryDto[];
  total: number;
  page: number;
  limit: number;
}

// Folder enumeration row from `GET /api/videos/folders` (`FolderCount` in the
// backend). `folder` is the top-level path segment; NULL paths are grouped
// under "(Unsorted)" server-side. Sorted by `video_count` descending.
export interface FolderDto {
  folder: string;
  video_count: number;
}

// Mutation response bodies — the backend echoes the post-mutation state so
// the client can update its cache without a refetch (M2 T6 deviation #33).
export interface FavoriteResponseDto {
  is_favorite: boolean;
}

export interface RatingRequestDto {
  rating: number;
}

export interface RatingResponseDto {
  my_rating: number | null;
}
