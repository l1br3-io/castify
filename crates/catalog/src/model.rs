use serde::{Deserialize, Serialize};
use sqlx::Row;

/// Supported cloud storage providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    GoogleDrive,
    Dropbox,
    OneDrive,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::GoogleDrive => "google_drive",
            Provider::Dropbox => "dropbox",
            Provider::OneDrive => "onedrive",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "google_drive" => Ok(Provider::GoogleDrive),
            "dropbox" => Ok(Provider::Dropbox),
            "onedrive" => Ok(Provider::OneDrive),
            other => Err(format!("unknown provider: {other}")),
        }
    }
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
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
    pub token_bundle: crate::crypto::TokenBundle,
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

/// A paginated result from `Provider::list_videos`.
#[derive(Debug, Clone)]
pub struct ListPage {
    pub videos: Vec<DiscoveredVideo>,
    pub next_cursor: Option<String>,
    /// Sidecar subtitle files (`.srt`/`.vtt`) discovered during the same
    /// listing pass. Matched to videos by base name during scanning.
    pub subtitles: Vec<DiscoveredSubtitle>,
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

/// A detected sidecar subtitle track for a video (`.srt` or `.vtt`).
#[derive(Debug, Clone, Serialize)]
pub struct SubtitleTrack {
    pub id: String,
    pub language: Option<String>,
    pub filename: String,
    pub format: String,
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
