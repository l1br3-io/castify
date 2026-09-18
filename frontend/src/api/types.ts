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
// `"s3"` is any S3-compatible object storage (R2, B2, MinIO, AWS S3, …) —
// endpoints/buckets are per-connection data.
export type ProviderKey = "google_drive" | "dropbox" | "onedrive" | "s3";

export const PROVIDERS: readonly ProviderKey[] = [
  "google_drive",
  "dropbox",
  "onedrive",
  "s3",
] as const;

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
  google_drive: "Google Drive",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
  s3: "S3-Compatible Storage",
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
  // Rows the last completed scan pruned (catalog-prune reconcile); the
  // rescan toast reports them when > 0.
  videos_pruned: number;
  files_pruned: number;
}

// How a provider connects (`AuthMode` in the backend). OAuth providers
// round-trip through the provider's consent screen; credentials providers
// submit a schema-driven form.
export type AuthMode = "oauth" | "credentials";

// One field of a credentials-flow provider's form (`CredentialField` in
// the backend). The frontend renders these generically — adding a field
// (or a whole credentials provider) requires zero frontend code.
export interface CredentialFieldDto {
  // Machine key the API layer expects in the submitted form (snake_case).
  key: string;
  // Human label for the form input.
  label: string;
  // Mask the input (password-style) — true for secrets.
  secret: boolean;
  // Optional placeholder hint; null when the provider sets none.
  placeholder: string | null;
}

// The declarative credentials form a credentials-flow provider renders
// (`CredentialsSchema` in the backend, e.g. `providers/s3.rs`). Present
// only on credentials-mode entries of `GET /api/connections/available`;
// field order is form order.
export interface CredentialsSchemaDto {
  fields: CredentialFieldDto[];
}

// One entry of `GET /api/connections/available`'s list response. Note the
// camelCase `authMode` key — pinned by the s3-compatible-storage spec's
// wire contract (the one non-snake_case key in the API). `credentials`
// carries the renderable form and is skipped (not nulled) on OAuth
// entries, so their wire shape is unchanged.
export interface AvailableProviderDto {
  id: ProviderKey;
  authMode: AuthMode;
  // Server-level setup done? OAuth providers depend on env credentials;
  // credential-based providers (s3) are always configured.
  configured: boolean;
  credentials?: CredentialsSchemaDto;
}

export type AvailableProviders = AvailableProviderDto[];

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
  videos_pruned: number;
  files_pruned: number;
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
  // Saved playback position in seconds, or null if no progress recorded.
  position_seconds: number | null;
  // Whether the owner has marked this video as completed (watched past 95%).
  completed: boolean;
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

// --- M9 — File-aware library DTOs ---

// Non-video file kinds (`FileKind` in the backend, snake_case on the wire).
export type FileKindKey =
  | "audio"
  | "image"
  | "subtitle"
  | "document"
  | "archive"
  | "other";

export const FILE_KIND_LABELS: Record<FileKindKey, string> = {
  audio: "Audio",
  image: "Image",
  subtitle: "Subtitle",
  document: "Document",
  archive: "Archive",
  other: "File",
};

// A non-video file entry (`FileEntry` in the backend) — the flat wire shape
// of a contents entry's file half.
export interface FileEntryDto {
  id: string;
  name: string;
  provider: ProviderKey;
  path: string | null;
  size_bytes: number;
  mime_type: string | null;
  kind: FileKindKey;
  modified_at: string | null;
}

// One node in the folder tree (`FolderNode` in the backend, M9 FR-4).
// Counts are cumulative (subtree). `path` doubles as the contents selector:
// "" = library root, "(Unsorted)" = NULL-path bucket, "/A/B" = folder.
export interface FolderNodeDto {
  name: string;
  path: string;
  video_count: number;
  file_count: number;
  children: FolderNodeDto[];
}

// Discriminated union over the flat contents wire shape: the backend emits
// `{ kind: "video", …VideoSummary fields }` or `{ kind: <fileKind>, …FileEntry
// fields }` (untagged serde flatten), so the TS side narrows on `kind`.
export type FolderEntryDto =
  | ({ kind: "video" } & VideoSummaryDto)
  | ({ kind: FileKindKey } & FileEntryDto);

// Response from `GET /api/folders/contents` (`FolderContentsPage`).
export interface FolderContentsPageDto {
  entries: FolderEntryDto[];
  total: number;
  page: number;
  limit: number;
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

// --- M3 — Play DTOs ---

// M3 introduced the sidecar subtitle shape; M8 widened it with `format_family`
// (the routing key — `"text"` serves to browser, `"image"` triggers burn-in)
// and `embedded_track_id` (muxed stream index for extracted-embedded text
// tracks; null for sidecars). See `docs/specs/advanced-subtitles/spec.md`.
export interface SubtitleTrackDto {
  id: string;
  language: string | null;
  filename: string;
  format: string;
  format_family: "text" | "image";
  embedded_track_id: number | null;
}

export interface VideoDetailDto {
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
  thumbnail_status: string;
  position_seconds: number | null;
  duration_seconds: number | null;
  completed: boolean;
  subtitle_tracks: SubtitleTrackDto[];
}

export interface PlaybackProgressDto {
  position_seconds: number;
  duration_seconds: number | null;
  completed: boolean;
  updated_at: string;
}

// Request body for `POST /api/videos/{id}/progress` (FR-3.1).
// `duration_seconds` and `completed` are optional on the wire — the backend
// upserts whatever is provided. The owner auto-mark-completed flag is set
// here when the player crosses the 95% threshold (T10).
export interface ProgressRequestDto {
  position_seconds: number;
  duration_seconds?: number | null;
  completed?: boolean;
}

// Response from `GET /api/videos/{id}/stream-url` (T12 — direct CDN
// streaming). Per-provider strategy picks the smoothest path:
//
// - OneDrive + Dropbox: short-lived preauthenticated CDN URL the browser hits
//   directly (`strategy: "direct"`). Provider-native URLs are smooth.
// - Google Drive: tries `?alt=media` redirect first; falls back to the
//   `/stream` proxy (`strategy: "proxy"`) when Drive serves bytes inline.
// - Hot video disk cache (M4): when the video has been cached to local disk,
//   the strategy is `"cached"` and the URL points at `/cached-stream`.
//
// Self-hosted posture: pick the path that delivers best UX per provider, not
// the path that minimizes server load. The proxy is a tool, not a last
// resort. See `docs/prds/m3.5-streaming-posture-refactor.md` and
// `docs/data-storage-principles.md` anti-pattern #2 for the rationale.
//
// `expires_at` is an ISO-8601 UTC string when known, else null — the
// frontend uses it to pre-emptively refresh before a Direct URL expires.
export interface StreamUrlDto {
  url: string;
  strategy: "direct" | "proxy" | "cached" | "transcode";
  expires_at: string | null;
}

// ── Library collections (docs/specs/library-collections) ────────────────
//
// Shapes mirror `crates/api/src/routes/collections.rs` DTOs. `kind` maps the
// backend's `CollectionKind`: show/movie/time arrive via suggestion
// acceptance, manual via explicit creation.

export type CollectionKind = "show" | "movie" | "time" | "manual";

// Bare collection row (rename/accept responses).
export interface CollectionMetaDto {
  id: string;
  name: string;
  kind: CollectionKind;
  created_at: string;
}

// `GET /api/collections` row: meta + rail-card fields. `contains_video`
// appears only when the list was scoped with `?video_id=` (picker state).
export interface CollectionDto extends CollectionMetaDto {
  member_count: number;
  // First few members for thumbnails (bounded by the backend).
  preview: VideoSummaryDto[];
  contains_video?: boolean;
}

// `GET /api/collections/{id}`: the full ordered member list.
export interface CollectionDetailDto extends CollectionMetaDto {
  members: VideoSummaryDto[];
}

// `POST …/suggestions/{id}/accept` response.
export interface AcceptedCollectionDto extends CollectionMetaDto {
  member_count: number;
}

// `GET /api/collections/suggestions` row (spec F2). `members` is a bounded
// preview in curation order; `member_count` is the full group size.
// `created_at` is the staging regeneration time — the panel's snooze
// compares against it ("reappears only after another scan").
export interface CollectionSuggestionDto {
  id: string;
  kind: CollectionKind;
  title: string;
  signature: string;
  member_count: number;
  members: VideoSummaryDto[];
  created_at: string;
}
