//! Repository methods for the `transcode_cache_entries` manifest table (M7).
//!
//! M6 created the table but left it unused — the API layer did filesystem
//! checks only. M7 wires this manifest: each method here is the durable
//! counterpart to a filesystem side-effect, so cache state survives
//! restarts and can be enumerated for the master playlist, admin stats,
//! and LRU eviction.
//!
//! Methods live in a dedicated file (rather than inline in `repository.rs`)
//! because the transcode cache has its own vocabulary (statuses, the
//! `(variant, profile)` key) and a clear M7 boundary. The `impl
//! CatalogRepository` block extension is idiomatic Rust — multiple impl
//! blocks in the same crate are fine.

use sqlx::Row;

use crate::model::TranscodeCacheEntry;
use crate::repository::{CatalogRepository, CatalogResult};

/// ISO-8601 UTC timestamp. Local copy matches the pattern in `scanner.rs`
/// and `repository.rs` — keeping the helper next to its callers avoids a
/// cross-module dependency for a one-liner.
fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Parameters for [`CatalogRepository::insert_pending_transcode`]. Grouping
/// these avoids an 8-arg parameter list (clippy::too_many_arguments) and
/// mirrors the `NewVideo` pattern used elsewhere in the catalog.
#[derive(Debug, Clone)]
pub struct NewTranscodeEntry<'a> {
    pub video_id: &'a str,
    pub variant: &'a str,
    pub profile: &'a str,
    pub output_dir: &'a str,
    pub segment_duration_secs: u32,
    pub bitrate: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Status string written to `transcode_cache_entries.status` when a row is
/// inserted but ffmpeg hasn't produced any segments yet.
pub const TRANSCODE_STATUS_PENDING: &str = "pending";
/// ffmpeg is running; segments are landing on disk.
pub const TRANSCODE_STATUS_IN_PROGRESS: &str = "in_progress";
/// ffmpeg exited successfully; all segments produced.
pub const TRANSCODE_STATUS_COMPLETED: &str = "completed";
/// ffmpeg exited with an error, or the transcode was cancelled.
pub const TRANSCODE_STATUS_FAILED: &str = "failed";

/// Per-rung aggregation returned by [`CatalogRepository::transcode_stats_per_rung`].
/// One row per distinct `variant` value present in `transcode_cache_entries`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TranscodeRungStats {
    pub variant: String,
    /// Count of rows with `status = 'completed'`.
    pub cached_count: i64,
    /// Count of rows with `status IN ('pending', 'in_progress')`.
    pub in_progress_count: i64,
    /// Count of rows with `status = 'failed'`.
    pub failed_count: i64,
    /// Approximate bytes for completed rows: `SUM(bitrate * completed_segments
    /// * segment_duration_secs / 8)`. NULL bitrates contribute 0.
    pub total_bytes: i64,
}

impl CatalogRepository {
    /// Insert a pending row, or revive an existing one back to pending.
    /// Called when a transcode starts (or restarts after server reboot).
    ///
    /// Uses `ON CONFLICT DO UPDATE` so a re-request for an already-tracked
    /// `(video_id, variant, profile)` resets progress rather than failing.
    /// The caller has already decided to (re)start the transcode.
    pub async fn insert_pending_transcode(
        &self,
        entry: &NewTranscodeEntry<'_>,
    ) -> CatalogResult<()> {
        let now = iso_now();
        sqlx::query(
            r#"INSERT INTO transcode_cache_entries
               (video_id, variant, profile, output_dir,
                segment_duration_secs, bitrate, width, height,
                status, completed_segments, total_segments, last_error,
                created_at, last_accessed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
               ON CONFLICT(video_id, variant, profile) DO UPDATE SET
                 output_dir = excluded.output_dir,
                 segment_duration_secs = excluded.segment_duration_secs,
                 bitrate = excluded.bitrate,
                 width = excluded.width,
                 height = excluded.height,
                 status = 'pending',
                 completed_segments = 0,
                 total_segments = NULL,
                 last_error = NULL,
                 created_at = excluded.created_at,
                 last_accessed_at = excluded.last_accessed_at"#,
        )
        .bind(entry.video_id)
        .bind(entry.variant)
        .bind(entry.profile)
        .bind(entry.output_dir)
        .bind(entry.segment_duration_secs as i64)
        .bind(entry.bitrate.map(|b| b as i64))
        .bind(entry.width.map(|w| w as i64))
        .bind(entry.height.map(|h| h as i64))
        .bind(&now)
        .bind(&now)
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// Mark a transcode as in-progress: ffmpeg is producing segments.
    pub async fn mark_transcode_in_progress(
        &self,
        video_id: &str,
        variant: &str,
        profile: &str,
    ) -> CatalogResult<()> {
        sqlx::query(
            r#"UPDATE transcode_cache_entries
               SET status = 'in_progress'
               WHERE video_id = ? AND variant = ? AND profile = ?"#,
        )
        .bind(video_id)
        .bind(variant)
        .bind(profile)
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// Mark a transcode completed: ffmpeg exited successfully and produced
    /// `total_segments` segments.
    pub async fn mark_transcode_completed(
        &self,
        video_id: &str,
        variant: &str,
        profile: &str,
        total_segments: u64,
    ) -> CatalogResult<()> {
        let now = iso_now();
        sqlx::query(
            r#"UPDATE transcode_cache_entries
               SET status = 'completed',
                   total_segments = ?,
                   completed_segments = ?,
                   last_error = NULL,
                   last_accessed_at = ?
               WHERE video_id = ? AND variant = ? AND profile = ?"#,
        )
        .bind(total_segments as i64)
        .bind(total_segments as i64)
        .bind(&now)
        .bind(video_id)
        .bind(variant)
        .bind(profile)
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// Insert a `completed` row only if no row exists yet. Used by the
    /// resume path in `ensure_transcode_started` when segments are found on
    /// disk from a previous server session but no manifest row was written
    /// (or this is the first run after the M6→M7 migration that wires the
    /// manifest). Existing rows in any state are left untouched — the
    /// caller has already verified that segments exist on disk and is just
    /// catching the manifest up.
    pub async fn seed_completed_transcode_if_missing(
        &self,
        entry: &NewTranscodeEntry<'_>,
        total_segments: u64,
    ) -> CatalogResult<()> {
        let now = iso_now();
        sqlx::query(
            r#"INSERT INTO transcode_cache_entries
               (video_id, variant, profile, output_dir,
                segment_duration_secs, bitrate, width, height,
                status, completed_segments, total_segments, last_error,
                created_at, last_accessed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, NULL, ?, ?)
               ON CONFLICT(video_id, variant, profile) DO NOTHING"#,
        )
        .bind(entry.video_id)
        .bind(entry.variant)
        .bind(entry.profile)
        .bind(entry.output_dir)
        .bind(entry.segment_duration_secs as i64)
        .bind(entry.bitrate.map(|b| b as i64))
        .bind(entry.width.map(|w| w as i64))
        .bind(entry.height.map(|h| h as i64))
        .bind(total_segments as i64)
        .bind(total_segments as i64)
        .bind(&now)
        .bind(&now)
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// Mark a transcode failed. `error` is surfaced via the admin endpoint
    /// and the variant playlist response (503).
    pub async fn mark_transcode_failed(
        &self,
        video_id: &str,
        variant: &str,
        profile: &str,
        error: &str,
    ) -> CatalogResult<()> {
        let now = iso_now();
        sqlx::query(
            r#"UPDATE transcode_cache_entries
               SET status = 'failed',
                   last_error = ?,
                   last_accessed_at = ?
               WHERE video_id = ? AND variant = ? AND profile = ?"#,
        )
        .bind(error)
        .bind(&now)
        .bind(video_id)
        .bind(variant)
        .bind(profile)
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// Update `completed_segments` and bump `last_accessed_at`. Called
    /// periodically while ffmpeg produces segments.
    pub async fn update_transcode_progress(
        &self,
        video_id: &str,
        variant: &str,
        profile: &str,
        completed_segments: u64,
    ) -> CatalogResult<()> {
        let now = iso_now();
        sqlx::query(
            r#"UPDATE transcode_cache_entries
               SET completed_segments = ?, last_accessed_at = ?
               WHERE video_id = ? AND variant = ? AND profile = ?"#,
        )
        .bind(completed_segments as i64)
        .bind(&now)
        .bind(video_id)
        .bind(variant)
        .bind(profile)
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// Bump `last_accessed_at` to now. Called on every segment hit so LRU
    /// eviction sees fresh activity.
    pub async fn touch_transcode(
        &self,
        video_id: &str,
        variant: &str,
        profile: &str,
    ) -> CatalogResult<()> {
        let now = iso_now();
        sqlx::query(
            r#"UPDATE transcode_cache_entries
               SET last_accessed_at = ?
               WHERE video_id = ? AND variant = ? AND profile = ?"#,
        )
        .bind(&now)
        .bind(video_id)
        .bind(variant)
        .bind(profile)
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// Fetch the manifest row for a specific variant, if any.
    pub async fn fetch_transcode_entry(
        &self,
        video_id: &str,
        variant: &str,
        profile: &str,
    ) -> CatalogResult<Option<TranscodeCacheEntry>> {
        let row = sqlx::query(
            r#"SELECT video_id, variant, profile, output_dir,
                      total_segments, completed_segments, segment_duration_secs,
                      bitrate, width, height, status, last_error,
                      created_at, last_accessed_at
               FROM transcode_cache_entries
               WHERE video_id = ? AND variant = ? AND profile = ?"#,
        )
        .bind(video_id)
        .bind(variant)
        .bind(profile)
        .fetch_optional(self.pool())
        .await?;
        Ok(row.map(map_transcode_row))
    }

    /// Fetch all variant rows for a video, ordered by height descending
    /// (highest quality first — hls.js convention for the master playlist).
    /// Excludes failed entries; the master playlist only lists variants the
    /// player can actually load.
    pub async fn fetch_transcodes_for_video(
        &self,
        video_id: &str,
    ) -> CatalogResult<Vec<TranscodeCacheEntry>> {
        let rows = sqlx::query(
            r#"SELECT video_id, variant, profile, output_dir,
                      total_segments, completed_segments, segment_duration_secs,
                      bitrate, width, height, status, last_error,
                      created_at, last_accessed_at
               FROM transcode_cache_entries
               WHERE video_id = ? AND status != 'failed'
               ORDER BY
                 CASE variant
                   WHEN 'source' THEN 9999
                   ELSE CAST(
                     SUBSTR(variant, 1, LENGTH(variant) - 1) AS INTEGER
                   )
                 END DESC"#,
        )
        .bind(video_id)
        .fetch_all(self.pool())
        .await?;
        Ok(rows.into_iter().map(map_transcode_row).collect())
    }

    /// Return completed entries ordered oldest-first for LRU eviction.
    /// Skips `pending`/`in_progress` (never evict a running transcode).
    /// Each row's size is approximated as
    /// `bitrate * completed_segments * segment_duration_secs / 8` (bits → bytes);
    /// the caller sums these until the eviction target is met.
    pub async fn fetch_transcode_eviction_candidates(
        &self,
    ) -> CatalogResult<Vec<(TranscodeCacheEntry, i64)>> {
        let rows = sqlx::query(
            r#"SELECT video_id, variant, profile, output_dir,
                      total_segments, completed_segments, segment_duration_secs,
                      bitrate, width, height, status, last_error,
                      created_at, last_accessed_at,
                      COALESCE(
                        (bitrate * completed_segments * segment_duration_secs) / 8,
                        0
                      ) AS approx_bytes
               FROM transcode_cache_entries
               WHERE status = 'completed'
               ORDER BY last_accessed_at ASC, rowid ASC"#,
        )
        .fetch_all(self.pool())
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let approx_bytes: i64 = row.get("approx_bytes");
                (map_transcode_row(row), approx_bytes)
            })
            .collect())
    }

    /// Delete one manifest row. Does NOT delete bytes on disk — the caller
    /// removes the `output_dir` after this returns.
    pub async fn delete_transcode_entry(
        &self,
        video_id: &str,
        variant: &str,
        profile: &str,
    ) -> CatalogResult<bool> {
        let result = sqlx::query(
            r#"DELETE FROM transcode_cache_entries
               WHERE video_id = ? AND variant = ? AND profile = ?"#,
        )
        .bind(video_id)
        .bind(variant)
        .bind(profile)
        .execute(self.pool())
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Per-rung aggregation for the admin endpoint. One row per distinct
    /// `variant`. Approximates `total_bytes` from
    /// `bitrate * completed_segments * segment_duration_secs / 8`.
    pub async fn transcode_stats_per_rung(&self) -> CatalogResult<Vec<TranscodeRungStats>> {
        let rows = sqlx::query(
            r#"SELECT variant,
                      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS cached_count,
                      SUM(CASE WHEN status IN ('pending', 'in_progress') THEN 1 ELSE 0 END) AS in_progress_count,
                      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
                      SUM(CASE
                            WHEN status = 'completed' AND bitrate IS NOT NULL
                            THEN (bitrate * completed_segments * segment_duration_secs) / 8
                            ELSE 0
                          END) AS total_bytes
               FROM transcode_cache_entries
               GROUP BY variant
               ORDER BY
                 CASE variant
                   WHEN 'source' THEN 9999
                   ELSE CAST(SUBSTR(variant, 1, LENGTH(variant) - 1) AS INTEGER)
                 END DESC"#,
        )
        .fetch_all(self.pool())
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| TranscodeRungStats {
                variant: row.get("variant"),
                cached_count: row.get("cached_count"),
                in_progress_count: row.get("in_progress_count"),
                failed_count: row.get("failed_count"),
                total_bytes: row.get("total_bytes"),
            })
            .collect())
    }

    /// Total count of completed variants across all videos (for admin summary).
    pub async fn transcode_total_cached(&self) -> CatalogResult<i64> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM transcode_cache_entries WHERE status = 'completed'",
        )
        .fetch_one(self.pool())
        .await?;
        Ok(count)
    }
}

fn map_transcode_row(row: sqlx::sqlite::SqliteRow) -> TranscodeCacheEntry {
    use sqlx::Row;
    TranscodeCacheEntry {
        video_id: row.get("video_id"),
        variant: row.get("variant"),
        profile: row.get("profile"),
        output_dir: row.get("output_dir"),
        total_segments: row.get("total_segments"),
        completed_segments: row.get("completed_segments"),
        segment_duration_secs: row.get("segment_duration_secs"),
        bitrate: row.get("bitrate"),
        width: row.get("width"),
        height: row.get("height"),
        status: row.get("status"),
        last_error: row.get("last_error"),
        created_at: row.get("created_at"),
        last_accessed_at: row.get("last_accessed_at"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{Credential, TokenBundle, TokenKey};
    use crate::model::{NewConnection, NewVideo, Provider};
    use sqlx::SqlitePool;

    fn test_key() -> TokenKey {
        TokenKey::from_bytes(vec![42u8; 32]).unwrap()
    }

    fn sample_credential() -> Credential {
        Credential::OAuth(sample_bundle())
    }

    fn sample_bundle() -> TokenBundle {
        TokenBundle {
            access_token: "ya29.test".into(),
            refresh_token: Some("refresh".into()),
            expires_at: None,
            token_type: "Bearer".into(),
            scope: None,
        }
    }

    async fn fresh_pool() -> SqlitePool {
        use std::str::FromStr;
        let file = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        let path = file.to_path_buf();
        std::mem::forget(file); // keep file alive for test
        let options =
            sqlx::sqlite::SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
                .unwrap()
                .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await
            .unwrap();

        // Run migrations manually (storage crate not available as dep).
        for sql in [
            "CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL, display_name TEXT)",
            "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
            include_str!("../../storage/migrations/0003_connect_catalog.sql"),
            include_str!("../../storage/migrations/0004_browse.sql"),
            include_str!("../../storage/migrations/0005_browse_perf.sql"),
            include_str!("../../storage/migrations/0006_play.sql"),
            include_str!("../../storage/migrations/0007_video_cache.sql"),
            include_str!("../../storage/migrations/0008_video_codec.sql"),
            include_str!("../../storage/migrations/0009_transcode_cache.sql"),
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        pool
    }

    async fn seed_video(repo: &CatalogRepository) -> String {
        let conn = repo
            .create_connection(&NewConnection {
                provider: Provider::GoogleDrive,
                credential: sample_credential(),
                provider_account_id: Some(format!("acct-{}", uuid::Uuid::new_v4())),
                provider_account_email: None,
            })
            .await
            .unwrap();
        // Use a unique provider_file_id per call so multiple seeds don't
        // collide on the (connection_id, provider_file_id) natural key.
        let provider_file_id = format!("file-{}", uuid::Uuid::new_v4());
        repo.upsert_video(
            &conn.id,
            Provider::GoogleDrive,
            &NewVideo {
                provider_file_id: provider_file_id.clone(),
                name: "test.mp4".into(),
                path: None,
                size_bytes: 1_000_000,
                mime_type: Some("video/mp4".into()),
                duration_ms: Some(60_000),
                width: Some(1920),
                height: Some(1080),
                native_hash: Some("abc".into()),
                native_hash_algo: Some("md5".into()),
                provider_modified_at: None,
            },
        )
        .await
        .unwrap();
        // upsert_video generates the UUID internally; fetch it back.
        let row: (String,) = sqlx::query_as("SELECT id FROM videos WHERE provider_file_id = ?")
            .bind(&provider_file_id)
            .fetch_one(repo.pool())
            .await
            .unwrap();
        row.0
    }

    /// Test helper: build a `NewTranscodeEntry` with sensible defaults.
    /// Tests override only the fields they care about.
    fn new_entry<'a>(video_id: &'a str, variant: &'a str) -> NewTranscodeEntry<'a> {
        NewTranscodeEntry {
            video_id,
            variant,
            profile: "prof",
            output_dir: "/tmp/out",
            segment_duration_secs: 10,
            bitrate: None,
            width: None,
            height: None,
        }
    }

    #[tokio::test]
    async fn insert_pending_then_fetch_round_trips() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let vid = seed_video(&repo).await;

        let mut entry = new_entry(&vid, "720p");
        entry.profile = "h264-high-40-aac128-cpu";
        entry.bitrate = Some(3_000_000);
        entry.width = Some(1280);
        entry.height = Some(720);
        repo.insert_pending_transcode(&entry).await.unwrap();

        let entry = repo
            .fetch_transcode_entry(&vid, "720p", "h264-high-40-aac128-cpu")
            .await
            .unwrap()
            .expect("row should exist");
        assert_eq!(entry.variant, "720p");
        assert_eq!(entry.status, "pending");
        assert_eq!(entry.completed_segments, 0);
        assert_eq!(entry.bitrate, Some(3_000_000));
        assert_eq!(entry.height, Some(720));
        assert!(entry.last_error.is_none());
    }

    #[tokio::test]
    async fn insert_pending_is_idempotent_and_resets_progress() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let vid = seed_video(&repo).await;

        let e = new_entry(&vid, "720p");
        repo.insert_pending_transcode(&e).await.unwrap();
        repo.mark_transcode_completed(&vid, "720p", "prof", 42)
            .await
            .unwrap();
        // Re-insert resets.
        repo.insert_pending_transcode(&e).await.unwrap();
        let entry = repo
            .fetch_transcode_entry(&vid, "720p", "prof")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.status, "pending");
        assert_eq!(entry.completed_segments, 0);
        assert!(entry.total_segments.is_none());
    }

    #[tokio::test]
    async fn lifecycle_pending_in_progress_completed_round_trips() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let vid = seed_video(&repo).await;

        let mut e = new_entry(&vid, "480p");
        e.segment_duration_secs = 6;
        e.bitrate = Some(1_500_000);
        e.width = Some(854);
        e.height = Some(480);
        repo.insert_pending_transcode(&e).await.unwrap();
        repo.mark_transcode_in_progress(&vid, "480p", "prof")
            .await
            .unwrap();
        repo.update_transcode_progress(&vid, "480p", "prof", 3)
            .await
            .unwrap();
        let mid = repo
            .fetch_transcode_entry(&vid, "480p", "prof")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(mid.status, "in_progress");
        assert_eq!(mid.completed_segments, 3);

        repo.mark_transcode_completed(&vid, "480p", "prof", 10)
            .await
            .unwrap();
        let done = repo
            .fetch_transcode_entry(&vid, "480p", "prof")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(done.status, "completed");
        assert_eq!(done.completed_segments, 10);
        assert_eq!(done.total_segments, Some(10));
    }

    #[tokio::test]
    async fn mark_failed_records_error() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let vid = seed_video(&repo).await;

        repo.insert_pending_transcode(&new_entry(&vid, "720p"))
            .await
            .unwrap();
        repo.mark_transcode_failed(&vid, "720p", "prof", "ffmpeg died")
            .await
            .unwrap();
        let entry = repo
            .fetch_transcode_entry(&vid, "720p", "prof")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.status, "failed");
        assert_eq!(entry.last_error.as_deref(), Some("ffmpeg died"));
    }

    #[tokio::test]
    async fn touch_bumps_last_accessed_at() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let vid = seed_video(&repo).await;

        repo.insert_pending_transcode(&new_entry(&vid, "720p"))
            .await
            .unwrap();
        let before = repo
            .fetch_transcode_entry(&vid, "720p", "prof")
            .await
            .unwrap()
            .unwrap();
        // Sleep so the timestamp differs (SQLite datetime('now') is second-resolution).
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        repo.touch_transcode(&vid, "720p", "prof").await.unwrap();
        let after = repo
            .fetch_transcode_entry(&vid, "720p", "prof")
            .await
            .unwrap()
            .unwrap();
        assert_ne!(before.last_accessed_at, after.last_accessed_at);
    }

    #[tokio::test]
    async fn fetch_for_video_orders_by_height_desc_and_excludes_failed() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let vid = seed_video(&repo).await;

        for variant in ["360p", "720p", "480p", "1080p"] {
            repo.insert_pending_transcode(&new_entry(&vid, variant))
                .await
                .unwrap();
            repo.mark_transcode_completed(&vid, variant, "prof", 5)
                .await
                .unwrap();
        }
        // Add a failed variant — must be excluded.
        repo.insert_pending_transcode(&new_entry(&vid, "240p"))
            .await
            .unwrap();
        repo.mark_transcode_failed(&vid, "240p", "prof", "broken")
            .await
            .unwrap();

        let entries = repo.fetch_transcodes_for_video(&vid).await.unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.variant.as_str()).collect();
        assert_eq!(names, vec!["1080p", "720p", "480p", "360p"]);
    }

    #[tokio::test]
    async fn delete_removes_row_returns_true_when_existed() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let vid = seed_video(&repo).await;

        repo.insert_pending_transcode(&new_entry(&vid, "720p"))
            .await
            .unwrap();
        let removed = repo
            .delete_transcode_entry(&vid, "720p", "prof")
            .await
            .unwrap();
        assert!(removed);
        let after = repo
            .fetch_transcode_entry(&vid, "720p", "prof")
            .await
            .unwrap();
        assert!(after.is_none());

        let again = repo
            .delete_transcode_entry(&vid, "720p", "prof")
            .await
            .unwrap();
        assert!(!again, "second delete returns false");
    }

    #[tokio::test]
    async fn stats_per_rung_aggregates_correctly() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let vid1 = seed_video(&repo).await;
        let vid2 = seed_video(&repo).await;

        // vid1: one completed 720p at 3 Mbps, 10 segments, 10s each → 3,000,000 * 10 * 10 / 8 = 37,500,000 bytes
        let mut e = new_entry(&vid1, "720p");
        e.bitrate = Some(3_000_000);
        repo.insert_pending_transcode(&e).await.unwrap();
        repo.mark_transcode_completed(&vid1, "720p", "prof", 10)
            .await
            .unwrap();

        // vid1: one in_progress 480p
        let mut e = new_entry(&vid1, "480p");
        e.bitrate = Some(1_500_000);
        repo.insert_pending_transcode(&e).await.unwrap();
        repo.mark_transcode_in_progress(&vid1, "480p", "prof")
            .await
            .unwrap();

        // vid1: one failed 360p
        repo.insert_pending_transcode(&new_entry(&vid1, "360p"))
            .await
            .unwrap();
        repo.mark_transcode_failed(&vid1, "360p", "prof", "err")
            .await
            .unwrap();

        // vid2: another completed 720p (same rung, different video)
        let mut e = new_entry(&vid2, "720p");
        e.bitrate = Some(3_000_000);
        repo.insert_pending_transcode(&e).await.unwrap();
        repo.mark_transcode_completed(&vid2, "720p", "prof", 10)
            .await
            .unwrap();

        let stats = repo.transcode_stats_per_rung().await.unwrap();
        let by_variant: std::collections::HashMap<&str, &TranscodeRungStats> =
            stats.iter().map(|s| (s.variant.as_str(), s)).collect();

        let s720 = by_variant.get("720p").expect("720p rung present");
        assert_eq!(s720.cached_count, 2);
        assert_eq!(s720.in_progress_count, 0);
        assert_eq!(s720.failed_count, 0);
        assert_eq!(s720.total_bytes, 75_000_000); // 2 * 37,500,000

        let s480 = by_variant.get("480p").expect("480p rung present");
        assert_eq!(s480.cached_count, 0);
        assert_eq!(s480.in_progress_count, 1);

        let s360 = by_variant.get("360p").expect("360p rung present");
        assert_eq!(s360.failed_count, 1);
    }

    #[tokio::test]
    async fn eviction_candidates_skip_in_progress_and_failed() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let vid1 = seed_video(&repo).await;
        let vid2 = seed_video(&repo).await;
        let vid3 = seed_video(&repo).await;

        // completed, oldest
        let mut e = new_entry(&vid1, "720p");
        e.bitrate = Some(3_000_000);
        e.output_dir = "/old";
        repo.insert_pending_transcode(&e).await.unwrap();
        repo.mark_transcode_completed(&vid1, "720p", "prof", 10)
            .await
            .unwrap();
        // sleep to ensure last_accessed_at differs
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        // completed, newer
        let mut e = new_entry(&vid2, "720p");
        e.bitrate = Some(3_000_000);
        e.output_dir = "/new";
        repo.insert_pending_transcode(&e).await.unwrap();
        repo.mark_transcode_completed(&vid2, "720p", "prof", 10)
            .await
            .unwrap();
        // in_progress — must be skipped
        let mut e = new_entry(&vid3, "720p");
        e.bitrate = Some(3_000_000);
        e.output_dir = "/running";
        repo.insert_pending_transcode(&e).await.unwrap();
        repo.mark_transcode_in_progress(&vid3, "720p", "prof")
            .await
            .unwrap();

        let candidates = repo.fetch_transcode_eviction_candidates().await.unwrap();
        // Only the two completed entries; in_progress excluded.
        assert_eq!(candidates.len(), 2);
        // Oldest first.
        assert_eq!(candidates[0].0.video_id, vid1);
        assert_eq!(candidates[1].0.video_id, vid2);
        // approx_bytes = 3_000_000 * 10 * 10 / 8 = 37_500_000
        assert_eq!(candidates[0].1, 37_500_000);
    }

    #[tokio::test]
    async fn total_cached_counts_completed_only() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let vid = seed_video(&repo).await;

        assert_eq!(repo.transcode_total_cached().await.unwrap(), 0);
        repo.insert_pending_transcode(&new_entry(&vid, "720p"))
            .await
            .unwrap();
        assert_eq!(repo.transcode_total_cached().await.unwrap(), 0);
        repo.mark_transcode_completed(&vid, "720p", "prof", 5)
            .await
            .unwrap();
        assert_eq!(repo.transcode_total_cached().await.unwrap(), 1);
    }

    #[tokio::test]
    async fn seed_completed_if_missing_is_non_destructive() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let vid = seed_video(&repo).await;

        // Seed first — row should appear as completed.
        repo.seed_completed_transcode_if_missing(&new_entry(&vid, "720p"), 12)
            .await
            .unwrap();
        let row = repo
            .fetch_transcode_entry(&vid, "720p", "prof")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "completed");
        assert_eq!(row.total_segments, Some(12));

        // Now mark failed. Seed again — must NOT overwrite (non-destructive).
        repo.mark_transcode_failed(&vid, "720p", "prof", "err")
            .await
            .unwrap();
        repo.seed_completed_transcode_if_missing(&new_entry(&vid, "720p"), 99)
            .await
            .unwrap();
        let row = repo
            .fetch_transcode_entry(&vid, "720p", "prof")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "failed", "seed must not overwrite existing row");
        assert_eq!(
            row.total_segments,
            Some(12),
            "seed must not change total_segments"
        );
    }
}
