use serde::{Deserialize, Serialize};
use sqlx::Row;

/// Supported cloud storage providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    GoogleDrive,
    Dropbox,
    OneDrive,
    /// Any S3-compatible object storage (R2, B2, MinIO, AWS S3, …).
    /// Endpoints/buckets are per-connection data, so one variant covers
    /// every service. Wire form is `"s3"` (explicit rename — snake_case
    /// would emit `"s3_compatible"`).
    #[serde(rename = "s3")]
    S3Compatible,
}

impl Provider {
    /// Every supported provider, in display order. Full-enum iterations
    /// (e.g. the available-connections listing) derive from this rather
    /// than ad-hoc arrays, so adding a variant updates them all at once.
    pub const ALL: [Provider; 4] = [
        Provider::GoogleDrive,
        Provider::Dropbox,
        Provider::OneDrive,
        Provider::S3Compatible,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::GoogleDrive => "google_drive",
            Provider::Dropbox => "dropbox",
            Provider::OneDrive => "onedrive",
            Provider::S3Compatible => "s3",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "google_drive" => Ok(Provider::GoogleDrive),
            "dropbox" => Ok(Provider::Dropbox),
            "onedrive" => Ok(Provider::OneDrive),
            "s3" => Ok(Provider::S3Compatible),
            other => Err(format!("unknown provider: {other}")),
        }
    }
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s3_compatible_round_trips_through_parse() {
        let p = Provider::parse("s3").expect("s3 parses");
        assert_eq!(p, Provider::S3Compatible);
        assert_eq!(p.as_str(), "s3");
        assert_eq!(p.to_string(), "s3");
    }

    /// The serde wire form must be `"s3"` — snake_case auto-rename would
    /// produce `"s3_compatible"`, which the spec pins as `"s3"`
    /// (docs/specs/s3-compatible-storage, §4).
    #[test]
    fn s3_compatible_serde_wire_form_is_s3() {
        let json = serde_json::to_string(&Provider::S3Compatible).unwrap();
        assert_eq!(json, "\"s3\"");
        let back: Provider = serde_json::from_str(&json).unwrap();
        assert_eq!(back, Provider::S3Compatible);
    }

    /// `ALL` is what full-enum iterations (e.g. the available-connections
    /// listing) derive from — every variant must appear exactly once and
    /// round-trip through `parse(as_str())`.
    #[test]
    fn all_covers_every_variant_with_unique_round_trip_keys() {
        let keys: std::collections::HashSet<&str> =
            Provider::ALL.iter().map(|p| p.as_str()).collect();
        assert_eq!(keys.len(), Provider::ALL.len(), "duplicate as_str keys");
        for p in Provider::ALL {
            assert_eq!(Provider::parse(p.as_str()).unwrap(), p);
        }
    }

    #[test]
    fn unknown_provider_string_is_rejected() {
        assert!(Provider::parse("icloud").is_err());
    }
}

/// Scanner status stored in `scan_state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanStatus {
    Idle,
    Scanning,
    Error,
}

impl ScanStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ScanStatus::Idle => "idle",
            ScanStatus::Scanning => "scanning",
            ScanStatus::Error => "error",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "scanning" => ScanStatus::Scanning,
            "error" => ScanStatus::Error,
            _ => ScanStatus::Idle,
        }
    }
}

/// An active OAuth-connected cloud storage provider. Maps to a row in
/// `provider_connections`.
#[derive(Debug, Clone)]
pub struct ProviderConnection {
    pub id: String,
    pub provider: Provider,
    pub provider_account_id: Option<String>,
    pub provider_account_email: Option<String>,
    pub connected_at: String,
    pub disconnected_at: Option<String>,
}

impl ProviderConnection {
    pub fn from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Self, String> {
        let provider_str: String = row.get("provider");
        Ok(Self {
            id: row.get("id"),
            provider: Provider::parse(&provider_str)?,
            provider_account_id: row.get("provider_account_id"),
            provider_account_email: row.get("provider_account_email"),
            connected_at: row.get("connected_at"),
            disconnected_at: row.get("disconnected_at"),
        })
    }
}

/// Data needed to create a new provider connection.
#[derive(Debug, Clone)]
pub struct NewConnection {
    pub provider: Provider,
    pub credential: crate::crypto::Credential,
    pub provider_account_id: Option<String>,
    pub provider_account_email: Option<String>,
}

/// Scan state for a single connection. Maps to a row in `scan_state`.
#[derive(Debug, Clone)]
pub struct ScanState {
    pub connection_id: String,
    pub status: ScanStatus,
    pub cursor: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error_message: Option<String>,
    pub videos_found: i64,
}

impl ScanState {
    pub fn from_row(row: &sqlx::sqlite::SqliteRow) -> Self {
        Self {
            connection_id: row.get("connection_id"),
            status: ScanStatus::parse(row.get("status")),
            cursor: row.get("cursor"),
            started_at: row.get("started_at"),
            completed_at: row.get("completed_at"),
            error_message: row.get("error_message"),
            videos_found: row.get("videos_found"),
        }
    }
}

/// A video file discovered during a provider scan. Maps to the provider's file
/// metadata before catalog insertion.
#[derive(Debug, Clone)]
pub struct DiscoveredVideo {
    pub provider_file_id: String,
    pub name: String,
    pub path: Option<String>,
    pub size_bytes: i64,
    pub mime_type: Option<String>,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub native_hash: Option<String>,
    pub native_hash_algo: Option<String>,
    pub provider_modified_at: Option<String>,
}

/// A sidecar subtitle file (`.srt`/`.vtt`) discovered during a provider scan.
/// Matched to a video by base name during the scan.
#[derive(Debug, Clone)]
pub struct DiscoveredSubtitle {
    pub provider_file_id: String,
    pub name: String,
    pub path: Option<String>,
    pub language: Option<String>,
}

/// Broad classification for a non-video catalog file (M9). `video` is
/// deliberately absent: entries matching a video extension go to `videos`
/// via the providers' video gates; only non-video entries are classified
/// into `files`. Mirrors the `files.kind` CHECK in migration 0011.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Audio,
    Image,
    Subtitle,
    Document,
    Archive,
    Other,
}

impl FileKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            FileKind::Audio => "audio",
            FileKind::Image => "image",
            FileKind::Subtitle => "subtitle",
            FileKind::Document => "document",
            FileKind::Archive => "archive",
            FileKind::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "audio" => FileKind::Audio,
            "image" => FileKind::Image,
            "subtitle" => FileKind::Subtitle,
            "document" => FileKind::Document,
            "archive" => FileKind::Archive,
            _ => FileKind::Other,
        }
    }
}

/// A non-video file discovered during a provider scan (M9). Metadata-only —
/// no thumbnails, probe, or FTS. Subtitle sidecars appear both here and in
/// `DiscoveredSubtitle`: the `files` row is organizational (folder tree),
/// the subtitle row drives playback routing.
#[derive(Debug, Clone)]
pub struct DiscoveredFile {
    pub provider_file_id: String,
    pub name: String,
    pub path: Option<String>,
    pub size_bytes: i64,
    pub mime_type: Option<String>,
    pub kind: FileKind,
    pub provider_modified_at: Option<String>,
}

/// A node in the folder tree (M9 FR-4). Counts are cumulative — they include
/// every video/file in the subtree, so the UI can show "Movies · 12" without
/// client-side summation. Synthetic buckets `"(Root)"` (files directly at the
/// library root) and `"(Unsorted)"` (rows with a NULL path) match the
/// conventions of `fetch_folders`.
#[derive(Debug, Clone, Serialize)]
pub struct FolderNode {
    pub name: String,
    /// Folder path — `"/Movies/Sci-fi"` for real folders, `""` for
    /// `"(Root)"`, `"(Unsorted)"` for the NULL-path bucket. Doubles as the
    /// contents API's `path` selector.
    pub path: String,
    pub video_count: i64,
    pub file_count: i64,
    pub children: Vec<FolderNode>,
}

/// A non-video file row shaped for the contents API (M9 FR-5). `provider`
/// comes from the owning connection (joined at read time) so the UI's
/// provider chips work uniformly across videos and files. `kind` lives on
/// the wrapping `FolderFileEntry`, NOT here — this struct is only ever
/// `#[serde(flatten)]`-ed under it, and a field on both would serialize a
/// duplicate `"kind"` key (strict JSON consumers reject that).
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub path: Option<String>,
    pub size_bytes: i64,
    pub mime_type: Option<String>,
    pub modified_at: Option<String>,
}

/// Flat wire shape for one contents entry: `{ kind: "video", …VideoSummary }`
/// or `{ kind: "audio", …FileEntry }` (M9 FR-5.1). Flat (not nested) so the
/// TS side is a simple discriminated union on `kind`.
#[derive(Debug, Clone, Serialize)]
pub struct FolderVideoEntry {
    pub kind: &'static str,
    #[serde(flatten)]
    pub video: VideoSummary,
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderFileEntry {
    pub kind: FileKind,
    #[serde(flatten)]
    pub file: FileEntry,
}

/// One entry in a folder-contents page.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum FolderEntry {
    Video(FolderVideoEntry),
    File(FolderFileEntry),
}

/// A mixed, paginated folder listing (M9 FR-5). Default sort: name ascending
/// (file-browser mental model); direct children only.
#[derive(Debug, Clone, Serialize, Default)]
pub struct FolderContentsPage {
    pub entries: Vec<FolderEntry>,
    pub total: i64,
    pub page: i64,
    pub limit: i64,
}

/// Filters for [`crate::repository::CatalogRepository::fetch_folder_contents`].
///
/// `path` semantics: `""` → library root (files directly at `/`);
/// `"(Unsorted)"` → rows with a NULL path; `"/A/B"` → direct children of
/// that folder. `kind` matches file kinds (`audio` … `other`) or `video`.
#[derive(Debug, Clone)]
pub struct FolderContentsFilter {
    pub path: String,
    pub page: i64,
    pub limit: i64,
    /// Owner for the video-half enrichment joins (favorites/ratings/progress).
    pub owner_id: String,
    pub provider: Option<String>,
    pub kind: Option<String>,
    pub q: Option<String>,
}

impl Default for FolderContentsFilter {
    fn default() -> Self {
        Self {
            path: String::new(),
            page: 1,
            limit: 50,
            owner_id: String::new(),
            provider: None,
            kind: None,
            q: None,
        }
    }
}

impl FolderContentsFilter {
    /// `q` with `%`/`_`/`\\` escaped and wrapped in `%…%` for LIKE, or None
    /// when empty. Escaping keeps user input literal (a `%` in a filename
    /// query must not act as a wildcard).
    pub fn q_filter(&self) -> Option<String> {
        let q = self.q.as_deref()?.trim();
        if q.is_empty() {
            return None;
        }
        let escaped = q
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        Some(format!("%{escaped}%"))
    }

    /// Closed kind set accepted by the contents filter: the six file kinds
    /// plus `video`. Values outside the set are ignored (no filtering)
    /// rather than interpolated into SQL.
    pub fn is_valid_kind(kind: &str) -> bool {
        matches!(
            kind,
            "video" | "audio" | "image" | "subtitle" | "document" | "archive" | "other"
        )
    }
}

/// A paginated result from `Provider::list_videos`.
#[derive(Debug, Clone)]
pub struct ListPage {
    pub videos: Vec<DiscoveredVideo>,
    pub next_cursor: Option<String>,
    /// Sidecar subtitle files (`.srt`/`.vtt`) discovered during the same
    /// listing pass. Matched to videos by base name during scanning.
    pub subtitles: Vec<DiscoveredSubtitle>,
    /// Non-video files discovered during the same listing pass (M9).
    /// Metadata-only catalog rows for the folder organizer.
    pub files: Vec<DiscoveredFile>,
}

/// Data needed to insert or upsert a video row.
#[derive(Debug, Clone)]
pub struct NewVideo {
    pub provider_file_id: String,
    pub name: String,
    pub path: Option<String>,
    pub size_bytes: i64,
    pub mime_type: Option<String>,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub native_hash: Option<String>,
    pub native_hash_algo: Option<String>,
    pub provider_modified_at: Option<String>,
}

impl NewVideo {
    pub fn from_discovered(d: &DiscoveredVideo) -> Self {
        Self {
            provider_file_id: d.provider_file_id.clone(),
            name: d.name.clone(),
            path: d.path.clone(),
            size_bytes: d.size_bytes,
            mime_type: d.mime_type.clone(),
            duration_ms: d.duration_ms,
            width: d.width,
            height: d.height,
            native_hash: d.native_hash.clone(),
            native_hash_algo: d.native_hash_algo.clone(),
            provider_modified_at: d.provider_modified_at.clone(),
        }
    }
}

/// Sort order for the unified video list. Direction-aware variants per
/// PRD FR-4.1. All variants use `NULLS LAST` so that missing values
/// (null duration, unrated) sink to the bottom regardless of direction —
/// more intuitive than SQLite's default (nulls first on ASC).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoSort {
    NameAsc,
    NameDesc,
    SizeAsc,
    SizeDesc,
    DateAsc,
    DateDesc,
    DurationAsc,
    DurationDesc,
    RatingDesc,
}

impl VideoSort {
    /// SQL `ORDER BY` fragment. Column names reference the outer query's `v`
    /// alias (including the `my_rating` join alias for `RatingDesc`).
    pub fn order_clause(&self) -> &'static str {
        match self {
            VideoSort::NameAsc => "v.name ASC NULLS LAST",
            VideoSort::NameDesc => "v.name DESC NULLS LAST",
            VideoSort::SizeAsc => "v.size_bytes ASC",
            VideoSort::SizeDesc => "v.size_bytes DESC",
            VideoSort::DateAsc => "v.created_at ASC",
            VideoSort::DateDesc => "v.created_at DESC",
            VideoSort::DurationAsc => "v.duration_ms ASC NULLS LAST",
            VideoSort::DurationDesc => "v.duration_ms DESC NULLS LAST",
            VideoSort::RatingDesc => "my_rating DESC NULLS LAST",
        }
    }

    /// Parse a sort key from the query string. Accepts the PRD FR-4.1 strings.
    /// Unknown values fall back to `DateDesc` (the default).
    pub fn parse(s: &str) -> Self {
        match s {
            "name" => Self::NameAsc,
            "name-desc" => Self::NameDesc,
            "size" => Self::SizeDesc,
            "size-asc" => Self::SizeAsc,
            "date" => Self::DateAsc,
            "date-desc" => Self::DateDesc,
            "duration" => Self::DurationAsc,
            "duration-desc" => Self::DurationDesc,
            "rating" => Self::RatingDesc,
            _ => Self::DateDesc,
        }
    }
}

/// Query filter for the unified video list. All extended fields (PRD FR-2/FR-3)
/// are optional; only `owner_id` is required (for favorites/ratings joins).
#[derive(Debug, Clone)]
pub struct VideoFilter {
    pub page: i64,
    pub limit: i64,
    pub provider: Option<Provider>,
    pub sort: VideoSort,
    /// FTS5 full-text search across `name` and `path`.
    pub q: Option<String>,
    /// Duration range filter in milliseconds (inclusive). Null-duration videos
    /// are excluded when either bound is set.
    pub duration_min: Option<i64>,
    pub duration_max: Option<i64>,
    /// Resolution floor: `height >= min_height` (e.g. 720 for HD+).
    pub min_height: Option<i64>,
    /// Restrict to the current owner's favorited videos.
    pub favorites_only: bool,
    /// Restrict to videos the current owner rated ≥ `min_rating` (1–5).
    pub min_rating: Option<i32>,
    /// Top-level path segment prefix (e.g. `"Movies"` matches `/Movies/...`).
    pub folder: Option<String>,
    /// Restrict to videos the current owner has in-progress playback
    /// (position > 0, not completed).
    pub in_progress: bool,
    /// Current owner — required for `is_favorite` / `my_rating` joins.
    pub owner_id: String,
}

impl Default for VideoFilter {
    fn default() -> Self {
        Self {
            page: 1,
            limit: 50,
            provider: None,
            sort: VideoSort::DateDesc,
            q: None,
            duration_min: None,
            duration_max: None,
            min_height: None,
            favorites_only: false,
            min_rating: None,
            folder: None,
            in_progress: false,
            owner_id: String::new(),
        }
    }
}

/// One source copy of a deduplicated video.
#[derive(Debug, Clone, Serialize)]
pub struct VideoSource {
    pub connection_id: String,
    pub provider: String,
    pub provider_file_id: String,
}

/// A deduplicated video summary returned by the unified video list API.
/// Enriched per PRD M2: `created_at`, `path`, `is_favorite`, `my_rating`,
/// and `thumbnail_status`.
#[derive(Debug, Clone, Serialize)]
pub struct VideoSummary {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub size_bytes: i64,
    pub mime_type: Option<String>,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub sources: Vec<VideoSource>,
    /// ISO timestamp of when the video row was first inserted.
    pub created_at: String,
    /// Resolved folder path (e.g. `/Movies/Action/movie.mp4`). `None` if the
    /// provider didn't populate it (e.g. Google Drive before path resolution).
    pub path: Option<String>,
    /// Whether the current owner has favorited this video.
    pub is_favorite: bool,
    /// The current owner's 1–5 star rating, or `None` if unrated.
    pub my_rating: Option<i32>,
    /// Thumbnail cache state: `"pending"` / `"cached"` / `"failed"` / `"unsupported"`.
    pub thumbnail_status: String,
    /// Saved playback position in seconds, or `None` if no progress recorded.
    pub position_seconds: Option<f64>,
    /// Whether the owner has marked this video as completed (watched past 95%).
    pub completed: bool,
}

/// Paginated response for the unified video list.
#[derive(Debug, Serialize)]
pub struct VideoPage {
    pub videos: Vec<VideoSummary>,
    pub total: i64,
    pub page: i64,
    pub limit: i64,
}

/// Saved playback progress for a single video + owner pair.
#[derive(Debug, Clone, Serialize)]
pub struct PlaybackProgress {
    pub position_seconds: f64,
    pub duration_seconds: Option<f64>,
    pub completed: bool,
    pub updated_at: String,
}

/// A detected subtitle track for a video — sidecar or extracted-embedded.
/// Surfaced via `GET /api/videos/{id}/subtitles` and the player's track list.
///
/// M8 widened this from a sidecar-only shape: `format_family` is the routing
/// key (`"text"` → serve to browser, `"image"` → burn-in), and
/// `embedded_track_id` links an extracted-embedded text track back to its
/// muxed stream index (`None` for sidecars). See
/// `docs/specs/advanced-subtitles/spec.md`.
#[derive(Debug, Clone, Serialize)]
pub struct SubtitleTrack {
    pub id: String,
    pub language: Option<String>,
    pub filename: String,
    pub format: String,
    /// `"text"` (srt/vtt/ass/ssa) or `"image"` (pgs/vobsub). Drives the
    /// burn-vs-serve decision without a format-string lookup.
    pub format_family: String,
    /// Muxed stream index for extracted-embedded text tracks; `None` for
    /// sidecars and image tracks (image tracks stay in `video_subtitle_tracks`).
    pub embedded_track_id: Option<i64>,
}

/// An embedded subtitle track row from `video_subtitle_tracks` (populated at
/// probe time, M5). Image-family tracks (PGS/VobSub) stay here — they are
/// never extracted to `video_subtitles` because burn-in reads them directly
/// from the source file via ffmpeg.
///
/// Looked up by id when a burn-in request arrives (`?burn_subtitles=<id>`)
/// to resolve the ffmpeg stream index (`embedded_index`) and verify the
/// track is image-based (`format_family = "image"`).
#[derive(Debug, Clone)]
pub struct EmbeddedSubtitleTrack {
    pub id: String,
    pub embedded_index: i64,
    pub codec: String,
    /// `"text"` or `"image"` — burn-in rejects text tracks.
    pub format_family: String,
    pub language: Option<String>,
    pub title: Option<String>,
}

/// Full video metadata for the player page. Enriched with personalization
/// state, playback progress, and subtitle tracks (FR-4.1).
#[derive(Debug, Serialize)]
pub struct VideoDetail {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub size_bytes: i64,
    pub mime_type: Option<String>,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub sources: Vec<VideoSource>,
    pub created_at: String,
    pub path: Option<String>,
    pub is_favorite: bool,
    pub my_rating: Option<i32>,
    pub thumbnail_status: String,
    pub position_seconds: Option<f64>,
    pub duration_seconds: Option<f64>,
    pub completed: bool,
    pub subtitle_tracks: Vec<SubtitleTrack>,
}

/// Manifest row for a hot-video cache entry (M4). Tracks which videos have
/// been cached to local disk, their size, last-access time, and pin state.
/// The bytes themselves live on disk under the `DiskCache` root; this row
/// is the manifest the cache layer consults.
#[derive(Debug, Clone)]
pub struct VideoCacheEntry {
    pub video_id: String,
    pub connection_id: String,
    pub provider_file_id: String,
    pub size_bytes: i64,
    pub last_accessed_at: String,
    pub pinned: bool,
    pub created_at: String,
}

/// Manifest row for a transcode cache entry (M7). One row per
/// `(video_id, variant, profile)` — the HLS segments + playlist live on
/// disk under `output_dir`; this row is the manifest the API layer
/// consults to enumerate variants, drive LRU eviction, and report stats.
///
/// M6 left this table unused (filesystem checks only). M7 wires it.
#[derive(Debug, Clone)]
pub struct TranscodeCacheEntry {
    pub video_id: String,
    pub variant: String,
    pub profile: String,
    pub output_dir: String,
    /// `NULL` until ffmpeg finishes successfully; then the total segment
    /// count it produced.
    pub total_segments: Option<i64>,
    /// Number of segments currently on disk. Updated as ffmpeg produces
    /// them; equals `total_segments` once `status = "completed"`.
    pub completed_segments: i64,
    pub segment_duration_secs: i64,
    /// Target bitrate in bits/sec (from `VariantRung::target_bitrate_kbps`
    /// × 1000). `NULL` for the `'source'` variant where we don't transcode.
    pub bitrate: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// One of `pending`, `in_progress`, `completed`, `failed`.
    pub status: String,
    pub last_error: Option<String>,
    pub created_at: String,
    pub last_accessed_at: String,
}
