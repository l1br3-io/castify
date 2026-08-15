use std::collections::HashMap;

use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::crypto::{TokenBundle, TokenKey};
use crate::model::{
    DiscoveredFile, FolderNode, NewConnection, NewVideo, PlaybackProgress, Provider,
    ProviderConnection, ScanState, ScanStatus, SubtitleTrack, VideoCacheEntry, VideoDetail,
    VideoFilter, VideoPage, VideoSource, VideoSummary,
};

#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("crypto error: {0}")]
    Crypto(#[from] crate::crypto::CryptoError),
    #[error("connection not found: {0}")]
    ConnectionNotFound(String),
    #[error("{0}")]
    Other(String),
}

pub type CatalogResult<T> = Result<T, CatalogError>;

/// A folder with its dedup-aware video count, returned by `fetch_folders`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FolderCount {
    pub folder: String,
    pub video_count: i64,
}

/// Minimal video fields needed by the thumbnail proxy endpoint. Avoids the
/// full [`VideoSummary`] with its joins — just enough to resolve the
/// connection, provider, and file ID for `Provider::fetch_thumbnail`.
#[derive(Debug, Clone)]
pub struct VideoThumbnailInfo {
    pub id: String,
    pub connection_id: String,
    pub provider: Provider,
    pub provider_file_id: String,
    pub thumbnail_status: String,
}

/// Minimal video fields needed by the stream/download proxy endpoints.
/// Includes `mime_type`, `size_bytes`, and `name` for response headers and
/// the download filename.
#[derive(Debug, Clone)]
pub struct VideoStreamInfo {
    pub id: String,
    pub connection_id: String,
    pub provider: Provider,
    pub provider_file_id: String,
    pub mime_type: Option<String>,
    pub size_bytes: i64,
    pub name: String,
}

/// Shared SQL predicate that restricts catalog rows to those belonging to an
/// **active** connection (one whose `disconnected_at` is NULL). Applied to
/// every user-facing and per-id catalog query so a soft-deleted connection's
/// videos stay hidden until revived. Defined once here and reused everywhere —
/// no copy-pasted subselects — so a new query added without the filter is
/// caught by the Phase-1 invisibility test (FR-3.4).
pub const ACTIVE_CONNECTION_FILTER: &str = "connection_id IN (SELECT id FROM provider_connections \
     WHERE disconnected_at IS NULL)";

/// Build an active-connection filter scoped to a specific column reference.
/// Use this for queries that alias the `videos` table (e.g. `"v.connection_id"`);
/// the un-aliased default is [`ACTIVE_CONNECTION_FILTER`]. Reusing either form —
/// rather than pasting the subselect into each query — is what the Phase-1
/// invisibility test guards (FR-3.4).
fn active_connection_filter_for(column: &str) -> String {
    format!("{column} IN (SELECT id FROM provider_connections WHERE disconnected_at IS NULL)")
}

/// Push the shared WHERE predicates (provider, search, duration, resolution,
/// folder, favorites, rating) onto the representative subquery builder. The
/// predicates reference the un-aliased `videos` table (the subquery scope).
///
/// Empty/None predicates are skipped. Duration predicates automatically
/// exclude null-duration rows (NULL comparisons yield false in SQL).
fn push_video_predicates(qb: &mut sqlx::QueryBuilder<'_, sqlx::Sqlite>, filter: &VideoFilter) {
    // Always restrict to active connections first — a soft-deleted connection's
    // videos must never surface in browse (FR-3.1). Applied to both the dedup
    // and non-dedup halves of the representative subquery via this single hook.
    qb.push(" AND ");
    qb.push(ACTIVE_CONNECTION_FILTER);
    if let Some(p) = &filter.provider {
        qb.push(" AND provider = ");
        qb.push_bind(p.as_str());
    }
    if let Some(q) = &filter.q {
        let trimmed = q.trim();
        if !trimmed.is_empty() {
            // Wrap each whitespace-separated token in double quotes so FTS5
            // treats them as string literals (immune to syntax errors from
            // special characters), and append `*` to make it a *prefix* term
            // so "vid" matches "video"/"videos" and "screen" matches
            // "screens". The `unicode61` tokenizer does no stemming, so without
            // the prefix glob the search would be exact-token-only. Multiple
            // tokens are implicit AND.
            let sanitized: String = trimmed
                .split_whitespace()
                .map(|w| w.replace('"', ""))
                .filter(|w| !w.is_empty())
                .map(|w| format!("\"{}\"*", w))
                .collect::<Vec<_>>()
                .join(" ");
            if !sanitized.is_empty() {
                qb.push(" AND rowid IN (SELECT rowid FROM videos_fts WHERE videos_fts MATCH ");
                qb.push_bind(sanitized);
                qb.push(")");
            }
        }
    }
    if let Some(min) = filter.duration_min {
        qb.push(" AND duration_ms >= ");
        qb.push_bind(min);
    }
    if let Some(max) = filter.duration_max {
        qb.push(" AND duration_ms <= ");
        qb.push_bind(max);
    }
    if let Some(h) = filter.min_height {
        qb.push(" AND height >= ");
        qb.push_bind(h);
    }
    if let Some(folder) = &filter.folder {
        // Top-level segment: match paths starting with /{folder}/.
        qb.push(" AND path LIKE ");
        qb.push_bind(format!("/{folder}/%"));
    }
    if filter.favorites_only {
        qb.push(" AND EXISTS (SELECT 1 FROM video_favorites vf WHERE vf.video_id = videos.id AND vf.owner_id = ");
        qb.push_bind(filter.owner_id.clone());
        qb.push(")");
    }
    if let Some(min_r) = filter.min_rating {
        qb.push(" AND EXISTS (SELECT 1 FROM video_ratings vr WHERE vr.video_id = videos.id AND vr.owner_id = ");
        qb.push_bind(filter.owner_id.clone());
        qb.push(" AND vr.rating >= ");
        qb.push_bind(min_r);
        qb.push(")");
    }
    if filter.in_progress {
        qb.push(" AND EXISTS (SELECT 1 FROM playback_progress pp WHERE pp.video_id = videos.id AND pp.owner_id = ");
        qb.push_bind(filter.owner_id.clone());
        qb.push(" AND pp.position_seconds > 0 AND pp.completed = 0)");
    }
}

/// Data access for `provider_connections`, `videos`, and `scan_state`.
/// Holds the encryption key so token bundles are transparently
/// encrypted/decrypted at the repository boundary.
#[derive(Clone)]
pub struct CatalogRepository {
    pool: SqlitePool,
    token_key: TokenKey,
}

impl CatalogRepository {
    pub fn new(pool: SqlitePool, token_key: TokenKey) -> Self {
        Self { pool, token_key }
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    // ── Connections ──────────────────────────────────────────────────

    pub async fn create_connection(
        &self,
        conn: &NewConnection,
    ) -> CatalogResult<ProviderConnection> {
        let id = Uuid::new_v4().to_string();
        let now = iso_now();
        let token_bytes = conn.token_bundle.encrypt_to_bytes(&self.token_key)?;

        sqlx::query(
            "INSERT INTO provider_connections \
             (id, provider, token_bundle, provider_account_id, provider_account_email, connected_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(conn.provider.as_str())
        .bind(&token_bytes)
        .bind(&conn.provider_account_id)
        .bind(&conn.provider_account_email)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        let scan_state = ScanState {
            connection_id: id.clone(),
            status: ScanStatus::Idle,
            cursor: None,
            started_at: None,
            completed_at: None,
            error_message: None,
            videos_found: 0,
        };
        self.upsert_scan_state(&scan_state).await?;

        Ok(ProviderConnection {
            id,
            provider: conn.provider,
            provider_account_id: conn.provider_account_id.clone(),
            provider_account_email: conn.provider_account_email.clone(),
            connected_at: now,
            disconnected_at: None,
        })
    }

    pub async fn fetch_connection(&self, id: &str) -> CatalogResult<Option<ProviderConnection>> {
        let row = sqlx::query(
            "SELECT id, provider, provider_account_id, provider_account_email, \
             connected_at, disconnected_at \
             FROM provider_connections WHERE id = ? AND disconnected_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            None => Ok(None),
            Some(row) => Ok(Some(
                ProviderConnection::from_row(&row).map_err(CatalogError::Other)?,
            )),
        }
    }

    pub async fn list_active_connections(&self) -> CatalogResult<Vec<ProviderConnection>> {
        let rows = sqlx::query(
            "SELECT id, provider, provider_account_id, provider_account_email, \
             connected_at, disconnected_at \
             FROM provider_connections WHERE disconnected_at IS NULL \
             ORDER BY connected_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        rows.iter()
            .map(|row| ProviderConnection::from_row(row).map_err(CatalogError::Other))
            .collect()
    }

    /// Look up the active connection for a given `(provider, provider_account_id)`
    /// pair. Used by the OAuth callback to detect a reconnect (same account,
    /// new token) vs a fresh connect — letting us UPDATE the token on the
    /// existing row (preserving the library + connection_id) instead of
    /// INSERTing a duplicate and hitting `UNIQUE(provider, provider_account_id)`.
    /// Returns `None` when no active connection matches, including when
    /// `provider_account_id` is `None` (those rows aren't reconnectable by
    /// account match — they round-trip through the normal connect flow).
    pub async fn find_active_connection_by_account(
        &self,
        provider: Provider,
        provider_account_id: &str,
    ) -> CatalogResult<Option<ProviderConnection>> {
        let row = sqlx::query(
            "SELECT id, provider, provider_account_id, provider_account_email, \
             connected_at, disconnected_at \
             FROM provider_connections \
             WHERE provider = ? AND provider_account_id = ? AND disconnected_at IS NULL",
        )
        .bind(provider.as_str())
        .bind(provider_account_id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            None => Ok(None),
            Some(row) => Ok(Some(
                ProviderConnection::from_row(&row).map_err(CatalogError::Other)?,
            )),
        }
    }

    /// Cheap active-state check for a connection. Returns `true` when the row
    /// exists and `disconnected_at IS NULL`, `false` otherwise (disconnected or
    /// no such row). Used by the scanner's per-page cancel check (Task 5) and
    /// any code that needs a cheap gate without fetching the full row.
    pub async fn is_connection_active(&self, connection_id: &str) -> CatalogResult<bool> {
        let active: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM provider_connections \
             WHERE id = ? AND disconnected_at IS NULL)",
        )
        .bind(connection_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(active)
    }

    /// Look up a connection by `(provider, provider_account_id)` **including**
    /// soft-deleted rows. Distinct from [`find_active_connection_by_account`],
    /// which filters out soft-deleted rows. The OAuth callback uses this to
    /// revive a soft-deleted connection on reconnect (clearing
    /// `disconnected_at`) instead of inserting a duplicate — the
    /// `UNIQUE(provider, provider_account_id)` constraint makes the revive
    /// mandatory while the soft-deleted row exists.
    pub async fn find_connection_by_account(
        &self,
        provider: Provider,
        provider_account_id: &str,
    ) -> CatalogResult<Option<ProviderConnection>> {
        let row = sqlx::query(
            "SELECT id, provider, provider_account_id, provider_account_email, \
             connected_at, disconnected_at \
             FROM provider_connections \
             WHERE provider = ? AND provider_account_id = ?",
        )
        .bind(provider.as_str())
        .bind(provider_account_id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            None => Ok(None),
            Some(row) => Ok(Some(
                ProviderConnection::from_row(&row).map_err(CatalogError::Other)?,
            )),
        }
    }

    /// Soft-delete a connection (set `disconnected_at`). Videos and scan_state
    /// remain until a hard delete (cascade) is performed via [`delete_connection`].
    pub async fn disconnect(&self, id: &str) -> CatalogResult<bool> {
        let now = iso_now();
        let result = sqlx::query(
            "UPDATE provider_connections SET disconnected_at = ? WHERE id = ? \
             AND disconnected_at IS NULL",
        )
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Revive a soft-deleted connection: clear `disconnected_at` so the row is
    /// active again. The OAuth callback calls this on reconnect when
    /// [`find_connection_by_account`] returns a soft-deleted row. Returns
    /// `true` when a soft-deleted row was revived, `false` when the row was
    /// already active or does not exist. The connection `id` — and therefore
    /// every video UUID — is unchanged, making disconnect→reconnect lossless.
    pub async fn revive_connection(&self, id: &str) -> CatalogResult<bool> {
        let result = sqlx::query(
            "UPDATE provider_connections SET disconnected_at = NULL \
             WHERE id = ? AND disconnected_at IS NOT NULL",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Hard-delete a connection row. Cascades to videos and scan_state.
    pub async fn delete_connection(&self, id: &str) -> CatalogResult<bool> {
        let result = sqlx::query("DELETE FROM provider_connections WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Hard-delete all connections with the given `(provider, provider_account_id)`.
    /// Kept as a repository primitive — no production route calls it after the
    /// soft-delete change, but it remains available for admin/maintenance paths.
    /// Returns the number of rows deleted.
    pub async fn delete_connections_by_account(
        &self,
        provider: Provider,
        provider_account_id: &str,
    ) -> CatalogResult<u64> {
        let result = sqlx::query(
            "DELETE FROM provider_connections \
             WHERE provider = ? AND provider_account_id = ?",
        )
        .bind(provider.as_str())
        .bind(provider_account_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Fetch and decrypt the token bundle for a connection.
    pub async fn fetch_token_bundle(
        &self,
        connection_id: &str,
    ) -> CatalogResult<Option<TokenBundle>> {
        let row = sqlx::query_scalar::<_, Option<Vec<u8>>>(
            "SELECT token_bundle FROM provider_connections WHERE id = ?",
        )
        .bind(connection_id)
        .fetch_optional(&self.pool)
        .await?;

        match row.flatten() {
            None => Ok(None),
            Some(bytes) => Ok(Some(TokenBundle::decrypt_from_bytes(
                &self.token_key,
                &bytes,
            )?)),
        }
    }

    /// Re-encrypt and store a refreshed token bundle.
    pub async fn update_token_bundle(
        &self,
        connection_id: &str,
        bundle: &TokenBundle,
    ) -> CatalogResult<()> {
        let token_bytes = bundle.encrypt_to_bytes(&self.token_key)?;
        sqlx::query("UPDATE provider_connections SET token_bundle = ? WHERE id = ?")
            .bind(&token_bytes)
            .bind(connection_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ── Videos ───────────────────────────────────────────────────────

    pub async fn upsert_video(
        &self,
        connection_id: &str,
        provider: Provider,
        video: &NewVideo,
    ) -> CatalogResult<()> {
        let id = Uuid::new_v4().to_string();
        let now = iso_now();

        sqlx::query(
            "INSERT INTO videos \
             (id, connection_id, provider, provider_file_id, name, path, size_bytes, \
              mime_type, duration_ms, width, height, native_hash, native_hash_algo, \
              castify_hash, dedup_group, provider_modified_at, scanned_at, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(connection_id, provider_file_id) DO UPDATE SET \
              name = excluded.name, path = excluded.path, \
              size_bytes = excluded.size_bytes, mime_type = excluded.mime_type, \
              duration_ms = excluded.duration_ms, width = excluded.width, \
              height = excluded.height, native_hash = excluded.native_hash, \
              native_hash_algo = excluded.native_hash_algo, \
              provider_modified_at = excluded.provider_modified_at, \
              scanned_at = excluded.scanned_at",
        )
        .bind(&id)
        .bind(connection_id)
        .bind(provider.as_str())
        .bind(&video.provider_file_id)
        .bind(&video.name)
        .bind(&video.path)
        .bind(video.size_bytes)
        .bind(&video.mime_type)
        .bind(video.duration_ms)
        .bind(video.width)
        .bind(video.height)
        .bind(&video.native_hash)
        .bind(&video.native_hash_algo)
        .bind(None::<String>)
        .bind(None::<String>)
        .bind(&video.provider_modified_at)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn upsert_videos(
        &self,
        connection_id: &str,
        provider: Provider,
        videos: &[NewVideo],
    ) -> CatalogResult<()> {
        for video in videos {
            self.upsert_video(connection_id, provider, video).await?;
        }
        Ok(())
    }

    pub async fn delete_videos_by_connection(&self, connection_id: &str) -> CatalogResult<u64> {
        let result = sqlx::query("DELETE FROM videos WHERE connection_id = ?")
            .bind(connection_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected())
    }

    pub async fn video_count(&self) -> CatalogResult<i64> {
        Ok(sqlx::query_scalar("SELECT COUNT(*) FROM videos")
            .fetch_one(&self.pool)
            .await?)
    }

    pub async fn video_count_by_connection(&self, connection_id: &str) -> CatalogResult<i64> {
        Ok(
            sqlx::query_scalar("SELECT COUNT(*) FROM videos WHERE connection_id = ?")
                .bind(connection_id)
                .fetch_one(&self.pool)
                .await?,
        )
    }

    /// Upsert a non-video file row (M9). Metadata-only — no thumbnail,
    /// probe, or FTS side effects. Identity is `(connection_id,
    /// provider_file_id)`, mirroring `upsert_video`, so rescans refresh
    /// rather than duplicate.
    pub async fn upsert_file(
        &self,
        connection_id: &str,
        file: &DiscoveredFile,
    ) -> CatalogResult<()> {
        let id = Uuid::new_v4().to_string();
        let now = iso_now();

        sqlx::query(
            "INSERT INTO files \
             (id, connection_id, provider_file_id, name, path, size_bytes, mime_type, kind, \
              provider_modified_at, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(connection_id, provider_file_id) DO UPDATE SET \
              name = excluded.name, path = excluded.path, \
              size_bytes = excluded.size_bytes, mime_type = excluded.mime_type, \
              kind = excluded.kind, provider_modified_at = excluded.provider_modified_at",
        )
        .bind(&id)
        .bind(connection_id)
        .bind(&file.provider_file_id)
        .bind(&file.name)
        .bind(&file.path)
        .bind(file.size_bytes)
        .bind(&file.mime_type)
        .bind(file.kind.as_str())
        .bind(&file.provider_modified_at)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// Count of file rows for a connection (test/diagnostic helper, M9).
    pub async fn file_count_by_connection(&self, connection_id: &str) -> CatalogResult<i64> {
        Ok(
            sqlx::query_scalar("SELECT COUNT(*) FROM files WHERE connection_id = ?")
                .bind(connection_id)
                .fetch_one(&self.pool)
                .await?,
        )
    }

    /// Fetch the minimal fields needed by the thumbnail proxy: connection_id
    /// (to resolve the token), provider + provider_file_id (to call
    /// `fetch_thumbnail`), and thumbnail_status (to check the cache state).
    pub async fn fetch_video_thumbnail_info(
        &self,
        video_id: &str,
    ) -> CatalogResult<Option<VideoThumbnailInfo>> {
        let row = sqlx::query(&format!(
            "SELECT id, connection_id, provider, provider_file_id, thumbnail_status \
             FROM videos WHERE id = ? AND {ACTIVE_CONNECTION_FILTER}"
        ))
        .bind(video_id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            None => Ok(None),
            Some(row) => {
                let provider_str: String = row.get("provider");
                Ok(Some(VideoThumbnailInfo {
                    id: row.get("id"),
                    connection_id: row.get("connection_id"),
                    provider: Provider::parse(&provider_str).map_err(CatalogError::Other)?,
                    provider_file_id: row.get("provider_file_id"),
                    thumbnail_status: row.get("thumbnail_status"),
                }))
            }
        }
    }

    /// Fetch the minimal fields needed by the stream/download proxy:
    /// connection_id, provider, provider_file_id (to call `open_stream`),
    /// plus mime_type, size_bytes, and name (for response headers + download
    /// filename).
    pub async fn fetch_video_stream_info(
        &self,
        video_id: &str,
    ) -> CatalogResult<Option<VideoStreamInfo>> {
        let row = sqlx::query(&format!(
            "SELECT id, connection_id, provider, provider_file_id, mime_type, size_bytes, name \
             FROM videos WHERE id = ? AND {ACTIVE_CONNECTION_FILTER}"
        ))
        .bind(video_id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            None => Ok(None),
            Some(row) => {
                let provider_str: String = row.get("provider");
                Ok(Some(VideoStreamInfo {
                    id: row.get("id"),
                    connection_id: row.get("connection_id"),
                    provider: Provider::parse(&provider_str).map_err(CatalogError::Other)?,
                    provider_file_id: row.get("provider_file_id"),
                    mime_type: row.get("mime_type"),
                    size_bytes: row.get("size_bytes"),
                    name: row.get("name"),
                }))
            }
        }
    }

    /// Update the thumbnail cache state for a video. The caller is responsible
    /// for passing one of the four convention values: `"pending"`, `"cached"`,
    /// `"failed"`, `"unsupported"`.
    pub async fn update_thumbnail_status(&self, video_id: &str, status: &str) -> CatalogResult<()> {
        sqlx::query("UPDATE videos SET thumbnail_status = ? WHERE id = ?")
            .bind(status)
            .bind(video_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Fetch a deduplicated, paginated page of videos across all active
    /// connections. Videos sharing a `dedup_group` appear as one entry with
    /// multiple `sources`. Supports FTS5 search, filters, and owner-scoped
    /// favorites/ratings enrichment (PRD FR-2/FR-3/FR-4/FR-5/FR-6).
    ///
    /// The representative subquery (`MIN(id) … GROUP BY dedup_group` unioned
    /// with ungrouped ids) receives the objective predicates (provider, search,
    /// duration, resolution, folder, favorites, rating). The outer query LEFT
    /// JOINs `video_favorites` / `video_ratings` for enrichment and applies
    /// `ORDER BY` / `LIMIT` / `OFFSET`.
    pub async fn fetch_video_page(&self, filter: &VideoFilter) -> CatalogResult<VideoPage> {
        let offset = (filter.page - 1) * filter.limit;
        let order = filter.sort.order_clause();

        // ── Count query ───────────────────────────────────────────────
        let mut count_qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT COUNT(*) FROM (SELECT MIN(id) FROM videos WHERE dedup_group IS NOT NULL",
        );
        push_video_predicates(&mut count_qb, filter);
        count_qb.push(
            " GROUP BY dedup_group UNION ALL SELECT id FROM videos WHERE dedup_group IS NULL",
        );
        push_video_predicates(&mut count_qb, filter);
        count_qb.push(")");
        let total: i64 = count_qb
            .build_query_scalar::<i64>()
            .fetch_one(&self.pool)
            .await?;

        // ── Page query ────────────────────────────────────────────────
        let mut page_qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT v.id, v.name, v.provider, v.size_bytes, v.mime_type, \
                    v.duration_ms, v.width, v.height, v.dedup_group, \
                    v.connection_id, v.provider_file_id, v.created_at, v.path, v.thumbnail_status, \
                    (vf.video_id IS NOT NULL) AS is_favorite, vr.rating AS my_rating, \
                    pp.position_seconds AS position_seconds, \
                    (COALESCE(pp.completed, 0)) AS completed \
             FROM videos v \
             LEFT JOIN video_favorites vf ON vf.video_id = v.id AND vf.owner_id = ",
        );
        page_qb.push_bind(filter.owner_id.clone());
        page_qb.push(" LEFT JOIN video_ratings vr ON vr.video_id = v.id AND vr.owner_id = ");
        page_qb.push_bind(filter.owner_id.clone());
        page_qb.push(" LEFT JOIN playback_progress pp ON pp.video_id = v.id AND pp.owner_id = ");
        page_qb.push_bind(filter.owner_id.clone());
        page_qb.push(" WHERE v.id IN (SELECT MIN(id) FROM videos WHERE dedup_group IS NOT NULL");
        push_video_predicates(&mut page_qb, filter);
        page_qb.push(
            " GROUP BY dedup_group UNION ALL SELECT id FROM videos WHERE dedup_group IS NULL",
        );
        push_video_predicates(&mut page_qb, filter);
        page_qb.push(") ORDER BY ");
        page_qb.push(order);
        page_qb.push(" LIMIT ");
        page_qb.push_bind(filter.limit);
        page_qb.push(" OFFSET ");
        page_qb.push_bind(offset);

        let rep_rows = page_qb.build().fetch_all(&self.pool).await?;

        // ── Batch-fetch sources for dedup groups on this page ─────────
        let dedup_groups: Vec<String> = rep_rows
            .iter()
            .filter_map(|r| sqlx::Row::get::<Option<String>, _>(r, "dedup_group"))
            .collect();

        let sources_by_group = if dedup_groups.is_empty() {
            HashMap::new()
        } else {
            self.fetch_sources_by_groups(&dedup_groups).await?
        };

        // ── Assemble summaries ────────────────────────────────────────
        let videos = rep_rows
            .iter()
            .map(|row| {
                let dedup_group: Option<String> = sqlx::Row::get(row, "dedup_group");
                let own_source = VideoSource {
                    connection_id: sqlx::Row::get(row, "connection_id"),
                    provider: sqlx::Row::get::<String, _>(row, "provider"),
                    provider_file_id: sqlx::Row::get(row, "provider_file_id"),
                };

                let sources = match &dedup_group {
                    Some(group) => sources_by_group
                        .get(group)
                        .cloned()
                        .unwrap_or_else(|| vec![own_source.clone()]),
                    None => vec![own_source],
                };

                VideoSummary {
                    id: sqlx::Row::get(row, "id"),
                    name: sqlx::Row::get(row, "name"),
                    provider: sqlx::Row::get(row, "provider"),
                    size_bytes: sqlx::Row::get(row, "size_bytes"),
                    mime_type: sqlx::Row::get(row, "mime_type"),
                    duration_ms: sqlx::Row::get(row, "duration_ms"),
                    width: sqlx::Row::get(row, "width"),
                    height: sqlx::Row::get(row, "height"),
                    sources,
                    created_at: sqlx::Row::get(row, "created_at"),
                    path: sqlx::Row::get(row, "path"),
                    is_favorite: sqlx::Row::get(row, "is_favorite"),
                    my_rating: sqlx::Row::get(row, "my_rating"),
                    thumbnail_status: sqlx::Row::get(row, "thumbnail_status"),
                    position_seconds: sqlx::Row::get(row, "position_seconds"),
                    completed: sqlx::Row::get(row, "completed"),
                }
            })
            .collect();

        Ok(VideoPage {
            videos,
            total,
            page: filter.page,
            limit: filter.limit,
        })
    }

    /// Enumerate top-level folder paths with dedup-aware video counts
    /// (PRD FR-7). Videos with a `NULL` path are grouped under `"(Unsorted)"`;
    /// root-level files (`/filename.ext`, no directory) under `"(Root)"`.
    /// Sorted by `video_count` descending.
    pub async fn fetch_folders(&self) -> CatalogResult<Vec<FolderCount>> {
        let rows = sqlx::query(&format!(
            "SELECT \
                CASE \
                    WHEN path IS NULL THEN '(Unsorted)' \
                    WHEN substr(path, 2) LIKE '%/%' \
                        THEN substr(path, 2, instr(substr(path, 2), '/') - 1) \
                    ELSE '(Root)' \
                END AS folder, \
                COUNT(*) AS video_count \
             FROM ( \
                SELECT path FROM videos WHERE id IN ( \
                    SELECT MIN(id) FROM videos \
                    WHERE dedup_group IS NOT NULL AND {ACTIVE_CONNECTION_FILTER} \
                    GROUP BY dedup_group \
                    UNION ALL \
                    SELECT id FROM videos \
                    WHERE dedup_group IS NULL AND {ACTIVE_CONNECTION_FILTER} \
                ) \
             ) \
             GROUP BY folder \
             ORDER BY video_count DESC",
        ))
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .iter()
            .map(|r| FolderCount {
                folder: sqlx::Row::get(r, "folder"),
                video_count: sqlx::Row::get(r, "video_count"),
            })
            .collect())
    }

    /// Build the full folder tree over active connections' `videos ∪ files`
    /// (M9 FR-4). One DB round-trip (two path queries) + O(paths) assembly
    /// in [`build_folder_tree`]. Video counts are dedup-aware (same
    /// representative subquery as `fetch_folders`); file counts are raw.
    pub async fn fetch_folder_tree(&self) -> CatalogResult<Vec<FolderNode>> {
        let video_paths: Vec<(Option<String>,)> = sqlx::query_as(&format!(
            "SELECT path FROM videos WHERE id IN ( \
                 SELECT MIN(id) FROM videos \
                 WHERE dedup_group IS NOT NULL AND {ACTIVE_CONNECTION_FILTER} \
                 GROUP BY dedup_group \
                 UNION ALL \
                 SELECT id FROM videos \
                 WHERE dedup_group IS NULL AND {ACTIVE_CONNECTION_FILTER} \
             )"
        ))
        .fetch_all(&self.pool)
        .await?;

        let file_paths: Vec<(Option<String>,)> = sqlx::query_as(
            "SELECT path FROM files WHERE connection_id IN \
             (SELECT id FROM provider_connections WHERE disconnected_at IS NULL)",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(build_folder_tree(
            video_paths.into_iter().map(|(p,)| p),
            file_paths.into_iter().map(|(p,)| p),
        ))
    }

    /// Returns true if a video row with the given id exists. Used by mutation
    /// handlers to map a missing-video write attempt to 404 rather than letting
    /// the FK constraint surface as a generic 500.
    pub async fn video_exists(&self, video_id: &str) -> CatalogResult<bool> {
        let exists: bool = sqlx::query_scalar(&format!(
            "SELECT EXISTS(SELECT 1 FROM videos WHERE id = ? AND {ACTIVE_CONNECTION_FILTER})"
        ))
        .bind(video_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(exists)
    }

    /// Mark a video as favorited by `owner_id` (PRD FR-5.1). Idempotent —
    /// `INSERT OR IGNORE` is a no-op if the row already exists.
    pub async fn set_favorite(&self, owner_id: &str, video_id: &str) -> CatalogResult<()> {
        sqlx::query(
            "INSERT OR IGNORE INTO video_favorites (owner_id, video_id, created_at) \
             VALUES (?, ?, ?)",
        )
        .bind(owner_id)
        .bind(video_id)
        .bind(iso_now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Remove the owner's favorite for a video (PRD FR-5.2). Idempotent —
    /// deleting a non-existent row is a no-op (0 rows affected).
    pub async fn delete_favorite(&self, owner_id: &str, video_id: &str) -> CatalogResult<()> {
        sqlx::query("DELETE FROM video_favorites WHERE owner_id = ? AND video_id = ?")
            .bind(owner_id)
            .bind(video_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Set or update the owner's rating for a video (PRD FR-6.1). The caller
    /// MUST validate `1 <= rating <= 5` (FR-6.4) — the DB CHECK is a backstop
    /// and would surface as a generic 500 if hit. Upsert via composite PK.
    pub async fn upsert_rating(
        &self,
        owner_id: &str,
        video_id: &str,
        rating: i32,
    ) -> CatalogResult<()> {
        sqlx::query(
            "INSERT INTO video_ratings (owner_id, video_id, rating, updated_at) \
             VALUES (?, ?, ?, ?) \
             ON CONFLICT (owner_id, video_id) DO UPDATE \
             SET rating = excluded.rating, updated_at = excluded.updated_at",
        )
        .bind(owner_id)
        .bind(video_id)
        .bind(rating)
        .bind(iso_now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Clear the owner's rating for a video (PRD FR-6.2). Idempotent — deleting
    /// a non-existent row is a no-op (0 rows affected).
    pub async fn delete_rating(&self, owner_id: &str, video_id: &str) -> CatalogResult<()> {
        sqlx::query("DELETE FROM video_ratings WHERE owner_id = ? AND video_id = ?")
            .bind(owner_id)
            .bind(video_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ── Playback progress (T4) ────────────────────────────────────────

    /// Upsert playback progress for a video (PRD M3 FR-3.1). Uses
    /// `INSERT ... ON CONFLICT DO UPDATE` so repeated saves (e.g. periodic
    /// progress tracking from the player) update in place.
    pub async fn upsert_progress(
        &self,
        owner_id: &str,
        video_id: &str,
        position_seconds: f64,
        duration_seconds: Option<f64>,
        completed: bool,
    ) -> CatalogResult<()> {
        sqlx::query(
            "INSERT INTO playback_progress \
                (owner_id, video_id, position_seconds, duration_seconds, updated_at, completed) \
             VALUES (?, ?, ?, ?, ?, ?) \
             ON CONFLICT (owner_id, video_id) DO UPDATE \
             SET position_seconds = excluded.position_seconds, \
                 duration_seconds = excluded.duration_seconds, \
                 updated_at = excluded.updated_at, \
                 completed = excluded.completed",
        )
        .bind(owner_id)
        .bind(video_id)
        .bind(position_seconds)
        .bind(duration_seconds)
        .bind(iso_now())
        .bind(if completed { 1 } else { 0 })
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Fetch saved playback progress for a video (PRD M3 FR-3.2). Returns
    /// `None` if no progress row exists.
    pub async fn fetch_progress(
        &self,
        owner_id: &str,
        video_id: &str,
    ) -> CatalogResult<Option<PlaybackProgress>> {
        let row = sqlx::query(
            "SELECT position_seconds, duration_seconds, completed, updated_at \
             FROM playback_progress WHERE owner_id = ? AND video_id = ?",
        )
        .bind(owner_id)
        .bind(video_id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            None => Ok(None),
            Some(row) => Ok(Some(PlaybackProgress {
                position_seconds: row.get("position_seconds"),
                duration_seconds: row.get("duration_seconds"),
                completed: row.get::<i64, _>("completed") != 0,
                updated_at: row.get("updated_at"),
            })),
        }
    }

    /// Fetch the owner's in-progress videos for the continue-watching shelf
    /// (PRD M3 T13). Returns videos with `position_seconds > 0 AND completed = 0`,
    /// sorted by `updated_at DESC` (most recently watched first). Enriched
    /// with favorites/ratings/sources via the same LEFT JOIN pattern as
    /// `fetch_video_page`.
    pub async fn fetch_in_progress_videos(
        &self,
        owner_id: &str,
        limit: i64,
    ) -> CatalogResult<Vec<VideoSummary>> {
        let active = active_connection_filter_for("v.connection_id");
        let rows = sqlx::query(&format!(
            "SELECT v.id, v.name, v.provider, v.size_bytes, v.mime_type, \
                    v.duration_ms, v.width, v.height, v.dedup_group, \
                    v.connection_id, v.provider_file_id, v.created_at, v.path, v.thumbnail_status, \
                    (vf.video_id IS NOT NULL) AS is_favorite, vr.rating AS my_rating, \
                    pp.position_seconds AS position_seconds, \
                    (pp.completed) AS completed \
             FROM videos v \
             INNER JOIN playback_progress pp ON pp.video_id = v.id AND pp.owner_id = ? \
             LEFT JOIN video_favorites vf ON vf.video_id = v.id AND vf.owner_id = ? \
             LEFT JOIN video_ratings vr ON vr.video_id = v.id AND vr.owner_id = ? \
             WHERE pp.position_seconds > 0 AND pp.completed = 0 AND {active} \
             ORDER BY pp.updated_at DESC \
             LIMIT ?",
        ))
        .bind(owner_id)
        .bind(owner_id)
        .bind(owner_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        // ── Batch-fetch sources for dedup groups ──────────────────────
        let dedup_groups: Vec<String> = rows
            .iter()
            .filter_map(|r| sqlx::Row::get::<Option<String>, _>(r, "dedup_group"))
            .collect();

        let sources_by_group = if dedup_groups.is_empty() {
            HashMap::new()
        } else {
            self.fetch_sources_by_groups(&dedup_groups).await?
        };

        rows.iter()
            .map(|row| {
                let dedup_group: Option<String> = sqlx::Row::get(row, "dedup_group");
                let own_source = VideoSource {
                    connection_id: sqlx::Row::get(row, "connection_id"),
                    provider: sqlx::Row::get::<String, _>(row, "provider"),
                    provider_file_id: sqlx::Row::get(row, "provider_file_id"),
                };

                let sources = match &dedup_group {
                    Some(group) => sources_by_group
                        .get(group)
                        .cloned()
                        .unwrap_or_else(|| vec![own_source.clone()]),
                    None => vec![own_source],
                };

                Ok(VideoSummary {
                    id: sqlx::Row::get(row, "id"),
                    name: sqlx::Row::get(row, "name"),
                    provider: sqlx::Row::get(row, "provider"),
                    size_bytes: sqlx::Row::get(row, "size_bytes"),
                    mime_type: sqlx::Row::get(row, "mime_type"),
                    duration_ms: sqlx::Row::get(row, "duration_ms"),
                    width: sqlx::Row::get(row, "width"),
                    height: sqlx::Row::get(row, "height"),
                    sources,
                    created_at: sqlx::Row::get(row, "created_at"),
                    path: sqlx::Row::get(row, "path"),
                    is_favorite: sqlx::Row::get(row, "is_favorite"),
                    my_rating: sqlx::Row::get(row, "my_rating"),
                    thumbnail_status: sqlx::Row::get(row, "thumbnail_status"),
                    position_seconds: sqlx::Row::get(row, "position_seconds"),
                    completed: sqlx::Row::get(row, "completed"),
                })
            })
            .collect()
    }

    /// Fetch full video detail for the player page. Enriched with favorites,
    /// ratings, playback progress, and subtitle tracks (FR-4.1).
    pub async fn fetch_video_detail(
        &self,
        video_id: &str,
        owner_id: &str,
    ) -> CatalogResult<Option<VideoDetail>> {
        let active = active_connection_filter_for("v.connection_id");
        let row = sqlx::query(&format!(
            "SELECT v.id, v.name, v.provider, v.size_bytes, v.mime_type, \
                    v.duration_ms, v.width, v.height, v.dedup_group, \
                    v.connection_id, v.provider_file_id, v.created_at, v.path, v.thumbnail_status, \
                    (vf.video_id IS NOT NULL) AS is_favorite, vr.rating AS my_rating, \
                    pp.position_seconds AS position_seconds, \
                    pp.duration_seconds AS duration_seconds, \
                    (COALESCE(pp.completed, 0)) AS completed \
             FROM videos v \
             LEFT JOIN video_favorites vf ON vf.video_id = v.id AND vf.owner_id = ? \
             LEFT JOIN video_ratings vr ON vr.video_id = v.id AND vr.owner_id = ? \
             LEFT JOIN playback_progress pp ON pp.video_id = v.id AND pp.owner_id = ? \
             WHERE v.id = ? AND {active}",
        ))
        .bind(owner_id)
        .bind(owner_id)
        .bind(owner_id)
        .bind(video_id)
        .fetch_optional(&self.pool)
        .await?;

        let Some(row) = row else {
            return Ok(None);
        };

        let dedup_group: Option<String> = sqlx::Row::get(&row, "dedup_group");
        let own_source = VideoSource {
            connection_id: sqlx::Row::get(&row, "connection_id"),
            provider: sqlx::Row::get::<String, _>(&row, "provider"),
            provider_file_id: sqlx::Row::get(&row, "provider_file_id"),
        };

        let sources = match &dedup_group {
            Some(group) => {
                let mut map = self
                    .fetch_sources_by_groups(std::slice::from_ref(group))
                    .await?;
                map.remove(group)
                    .unwrap_or_else(|| vec![own_source.clone()])
            }
            None => vec![own_source],
        };

        let subtitle_tracks = self.fetch_subtitles(video_id).await?;

        Ok(Some(VideoDetail {
            id: sqlx::Row::get(&row, "id"),
            name: sqlx::Row::get(&row, "name"),
            provider: sqlx::Row::get(&row, "provider"),
            size_bytes: sqlx::Row::get(&row, "size_bytes"),
            mime_type: sqlx::Row::get(&row, "mime_type"),
            duration_ms: sqlx::Row::get(&row, "duration_ms"),
            width: sqlx::Row::get(&row, "width"),
            height: sqlx::Row::get(&row, "height"),
            sources,
            created_at: sqlx::Row::get(&row, "created_at"),
            path: sqlx::Row::get(&row, "path"),
            is_favorite: sqlx::Row::get(&row, "is_favorite"),
            my_rating: sqlx::Row::get(&row, "my_rating"),
            thumbnail_status: sqlx::Row::get(&row, "thumbnail_status"),
            position_seconds: sqlx::Row::get(&row, "position_seconds"),
            duration_seconds: sqlx::Row::get(&row, "duration_seconds"),
            completed: sqlx::Row::get(&row, "completed"),
            subtitle_tracks,
        }))
    }

    /// Fetch subtitle tracks for a video. M8: surfaces `format_family` and
    /// `embedded_track_id` so the frontend can route by family without
    /// inferring from the `format` string. Sidecar rows always come back with
    /// `format_family = "text"` and `embedded_track_id = None`; extracted
    /// text rows (inserted by Task 006) carry their stream index.
    pub async fn fetch_subtitles(&self, video_id: &str) -> CatalogResult<Vec<SubtitleTrack>> {
        let rows = sqlx::query(
            "SELECT id, language, filename, format, format_family, embedded_track_id \
             FROM video_subtitles WHERE video_id = ? ORDER BY filename",
        )
        .bind(video_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .iter()
            .map(|r| SubtitleTrack {
                id: r.get("id"),
                language: r.get("language"),
                filename: r.get("filename"),
                format: r.get("format"),
                format_family: r.get("format_family"),
                embedded_track_id: r.get("embedded_track_id"),
            })
            .collect())
    }

    /// Upsert a discovered sidecar subtitle track for a video. Idempotent by
    /// `UNIQUE(video_id, provider_file_id)`. Sidecars are always text-family
    /// (srt/vtt/ass/ssa), so `format_family` is fixed at `'text'` here.
    ///
    /// The `id` includes the `video_id` so two connections that share the same
    /// `provider_file_id` (e.g. the same file in two Google Drive accounts) don't
    /// collide on the PRIMARY KEY after one is soft-deleted — the old subtitle
    /// row lingers (no cascade on soft-delete), so a `sub-{provider_file_id}`
    /// id would conflict. Including `video_id` makes the id globally unique
    /// without weakening the `(video_id, provider_file_id)` dedup target.
    pub async fn upsert_subtitle(
        &self,
        video_id: &str,
        connection_id: &str,
        provider_file_id: &str,
        language: Option<&str>,
        filename: &str,
        format: &str,
    ) -> CatalogResult<()> {
        sqlx::query(
            "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, language, filename, format, format_family) \
             VALUES (?, ?, ?, ?, ?, ?, ?, 'text') \
             ON CONFLICT(video_id, provider_file_id) DO UPDATE SET \
                language = excluded.language, filename = excluded.filename, format = excluded.format, format_family = 'text'",
        )
        .bind(format!("sub-{video_id}-{provider_file_id}"))
        .bind(video_id)
        .bind(connection_id)
        .bind(provider_file_id)
        .bind(language)
        .bind(filename)
        .bind(format)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Clear extracted-embedded subtitle rows for a video (those with
    /// `provider_file_id IS NULL`). Used before re-extracting on re-probe so
    /// the operation is idempotent. Sidecar rows (`provider_file_id` non-NULL)
    /// are untouched.
    pub async fn clear_extracted_subtitles(&self, video_id: &str) -> CatalogResult<()> {
        sqlx::query("DELETE FROM video_subtitles WHERE video_id = ? AND provider_file_id IS NULL")
            .bind(video_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Insert an extracted-embedded text subtitle track. `provider_file_id` is
    /// NULL — the bytes live on local disk at `extracted_path`, not at the
    /// provider, so the serving layer reads from disk and never calls the
    /// provider. `format_family` is fixed at `'text'` (image tracks are never
    /// extracted; they stay muxed for burn-in).
    ///
    /// Idempotency is clear-then-insert (see [`clear_extracted_subtitles`]):
    /// SQLite can't target an expressional unique index with `ON CONFLICT`,
    /// so the caller clears the video's extracted rows before inserting.
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_extracted_subtitle(
        &self,
        id: &str,
        video_id: &str,
        embedded_track_id: i64,
        language: Option<&str>,
        filename: &str,
        format: &str,
        extracted_path: &str,
    ) -> CatalogResult<()> {
        sqlx::query(
            "INSERT INTO video_subtitles \
             (id, video_id, connection_id, provider_file_id, embedded_track_id, \
              language, filename, format, format_family, extracted_path) \
             VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, 'text', ?)",
        )
        .bind(id)
        .bind(video_id)
        .bind(embedded_track_id)
        .bind(language)
        .bind(filename)
        .bind(format)
        .bind(extracted_path)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Fetch a single subtitle track with serving metadata.
    ///
    /// Returns `(track, connection_id, provider_file_id, extracted_path)`.
    /// For **sidecar** tracks, `connection_id` + `provider_file_id` are
    /// `Some(...)` (bytes live at the provider) and `extracted_path` is
    /// `None`. For **extracted-embedded** tracks, `extracted_path` is
    /// `Some(...)` (bytes on local disk) and `connection_id` +
    /// `provider_file_id` are `None` — the provider must never be called.
    pub async fn fetch_subtitle_track(
        &self,
        video_id: &str,
        track_id: &str,
    ) -> CatalogResult<
        Option<(
            SubtitleTrack,
            Option<String>,
            Option<String>,
            Option<String>,
        )>,
    > {
        let row = sqlx::query(
            "SELECT id, language, filename, format, format_family, embedded_track_id, \
                    connection_id, provider_file_id, extracted_path \
             FROM video_subtitles WHERE id = ? AND video_id = ?",
        )
        .bind(track_id)
        .bind(video_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| {
            (
                SubtitleTrack {
                    id: r.get("id"),
                    language: r.get("language"),
                    filename: r.get("filename"),
                    format: r.get("format"),
                    format_family: r.get("format_family"),
                    embedded_track_id: r.get("embedded_track_id"),
                },
                r.get("connection_id"),
                r.get("provider_file_id"),
                r.get("extracted_path"),
            )
        }))
    }

    /// Fetch video names for subtitle matching within a connection.
    /// Returns `(video_id, name)` pairs.
    pub(crate) async fn fetch_video_names_for_connection(
        &self,
        connection_id: &str,
    ) -> CatalogResult<Vec<(String, String)>> {
        let rows = sqlx::query("SELECT id, name FROM videos WHERE connection_id = ?")
            .bind(connection_id)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.iter().map(|r| (r.get("id"), r.get("name"))).collect())
    }

    /// Fetch all source copies for a set of dedup groups. Filters to active
    /// connections so a soft-deleted connection's copy doesn't leak into the
    /// `sources` array of a deduplicated video (FR-3.1/FR-3.4).
    async fn fetch_sources_by_groups(
        &self,
        groups: &[String],
    ) -> CatalogResult<HashMap<String, Vec<VideoSource>>> {
        let placeholders = vec!["?"; groups.len()].join(", ");
        let sql = format!(
            "SELECT connection_id, provider, provider_file_id, dedup_group \
             FROM videos WHERE dedup_group IN ({placeholders}) AND {ACTIVE_CONNECTION_FILTER}"
        );
        let mut query = sqlx::query(&sql);
        for g in groups {
            query = query.bind(g);
        }
        let rows = query.fetch_all(&self.pool).await?;

        let mut map: HashMap<String, Vec<VideoSource>> = HashMap::new();
        for row in &rows {
            let group: String = sqlx::Row::get(row, "dedup_group");
            let source = VideoSource {
                connection_id: sqlx::Row::get(row, "connection_id"),
                provider: sqlx::Row::get(row, "provider"),
                provider_file_id: sqlx::Row::get(row, "provider_file_id"),
            };
            map.entry(group).or_default().push(source);
        }
        Ok(map)
    }

    /// Update the castify prefix hash and dedup group for a video.
    pub async fn update_video_dedup(
        &self,
        video_id: &str,
        castify_hash: &str,
        dedup_group: &str,
    ) -> CatalogResult<()> {
        sqlx::query("UPDATE videos SET castify_hash = ?, dedup_group = ? WHERE id = ?")
            .bind(castify_hash)
            .bind(dedup_group)
            .bind(video_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Fetch videos that haven't been prefix-hashed yet (for the dedup pass).
    pub async fn fetch_unhashed_videos(
        &self,
        connection_id: &str,
        min_size: i64,
    ) -> CatalogResult<Vec<(String, String, i64)>> {
        let rows = sqlx::query(
            "SELECT id, provider_file_id, size_bytes FROM videos \
             WHERE connection_id = ? AND castify_hash IS NULL AND size_bytes >= ?",
        )
        .bind(connection_id)
        .bind(min_size)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .iter()
            .map(|row| {
                (
                    sqlx::Row::get(row, "id"),
                    sqlx::Row::get(row, "provider_file_id"),
                    sqlx::Row::get(row, "size_bytes"),
                )
            })
            .collect())
    }

    // ── Scan state ───────────────────────────────────────────────────

    pub async fn upsert_scan_state(&self, state: &ScanState) -> CatalogResult<()> {
        sqlx::query(
            "INSERT INTO scan_state \
             (connection_id, status, cursor, started_at, completed_at, error_message, videos_found) \
             VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(connection_id) DO UPDATE SET \
              status = excluded.status, cursor = excluded.cursor, \
              started_at = excluded.started_at, completed_at = excluded.completed_at, \
              error_message = excluded.error_message, videos_found = excluded.videos_found",
        )
        .bind(&state.connection_id)
        .bind(state.status.as_str())
        .bind(&state.cursor)
        .bind(&state.started_at)
        .bind(&state.completed_at)
        .bind(&state.error_message)
        .bind(state.videos_found)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn fetch_scan_state(&self, connection_id: &str) -> CatalogResult<Option<ScanState>> {
        let row = sqlx::query(
            "SELECT connection_id, status, cursor, started_at, completed_at, \
             error_message, videos_found FROM scan_state WHERE connection_id = ?",
        )
        .bind(connection_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|row| ScanState::from_row(&row)))
    }

    // ── Video cache manifest (M4) ──────────────────────────────────────

    /// Fetch the cache entry for a video, if one exists. Returns `None` when
    /// the video has never been cached or was evicted. The caller is
    /// responsible for verifying `provider_file_id` matches the current
    /// video's file ID (re-scan may have replaced it).
    pub async fn fetch_video_cache_entry(
        &self,
        video_id: &str,
    ) -> CatalogResult<Option<VideoCacheEntry>> {
        let row = sqlx::query(
            r#"SELECT video_id, connection_id, provider_file_id, size_bytes,
                      last_accessed_at, pinned, created_at
               FROM video_cache_entries
               WHERE video_id = ?"#,
        )
        .bind(video_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| VideoCacheEntry {
            video_id: row.get("video_id"),
            connection_id: row.get("connection_id"),
            provider_file_id: row.get("provider_file_id"),
            size_bytes: row.get("size_bytes"),
            last_accessed_at: row.get("last_accessed_at"),
            pinned: row.get::<i64, _>("pinned") != 0,
            created_at: row.get("created_at"),
        }))
    }

    /// Insert or replace a cache entry. Called by the stream-through tee
    /// when a video finishes streaming successfully.
    pub async fn upsert_video_cache_entry(
        &self,
        video_id: &str,
        connection_id: &str,
        provider_file_id: &str,
        size_bytes: u64,
    ) -> CatalogResult<()> {
        let now = iso_now();
        sqlx::query(
            r#"INSERT INTO video_cache_entries
               (video_id, connection_id, provider_file_id, size_bytes,
                last_accessed_at, pinned)
               VALUES (?, ?, ?, ?, ?, 0)
               ON CONFLICT(video_id) DO UPDATE SET
                 connection_id = excluded.connection_id,
                 provider_file_id = excluded.provider_file_id,
                 size_bytes = excluded.size_bytes,
                 last_accessed_at = excluded.last_accessed_at"#,
        )
        .bind(video_id)
        .bind(connection_id)
        .bind(provider_file_id)
        .bind(size_bytes as i64)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Update `last_accessed_at` to now. Called on every cache hit (cheap:
    /// single SQL UPDATE).
    pub async fn touch_video_cache_entry(&self, video_id: &str) -> CatalogResult<()> {
        let now = iso_now();
        sqlx::query("UPDATE video_cache_entries SET last_accessed_at = ? WHERE video_id = ?")
            .bind(now)
            .bind(video_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Toggle the pinned state of a cache entry. Pinned entries survive LRU
    /// eviction. Returns `Ok(false)` if the entry doesn't exist (caller
    /// surfaces as 404 — can't pin what isn't there).
    pub async fn set_video_cache_pinned(
        &self,
        video_id: &str,
        pinned: bool,
    ) -> CatalogResult<bool> {
        let result = sqlx::query("UPDATE video_cache_entries SET pinned = ? WHERE video_id = ?")
            .bind(if pinned { 1i64 } else { 0i64 })
            .bind(video_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Delete the manifest row for a cache entry. Does NOT delete the bytes
    /// on disk — the caller does that via `DiskCache::delete`.
    pub async fn delete_video_cache_entry(&self, video_id: &str) -> CatalogResult<()> {
        sqlx::query("DELETE FROM video_cache_entries WHERE video_id = ?")
            .bind(video_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Total size in bytes of all cache entries (pinned + unpinned).
    pub async fn video_cache_total_size(&self) -> CatalogResult<i64> {
        let total: i64 =
            sqlx::query_scalar("SELECT COALESCE(SUM(size_bytes), 0) FROM video_cache_entries")
                .fetch_one(&self.pool)
                .await?;
        Ok(total)
    }

    /// Count of cache entries (pinned + unpinned).
    pub async fn video_cache_entry_count(&self) -> CatalogResult<i64> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM video_cache_entries")
            .fetch_one(&self.pool)
            .await?;
        Ok(count)
    }

    /// Return unpinned cache entries ordered oldest-first, until their
    /// cumulative size is enough to free `bytes_to_evict`. Used by the LRU
    /// eviction sweep when total cache size exceeds the configured limit.
    /// Returns video_ids + sizes; the caller deletes files + manifest rows.
    pub async fn video_cache_eviction_candidates(
        &self,
        bytes_to_evict: i64,
    ) -> CatalogResult<Vec<(String, i64)>> {
        let rows = sqlx::query(
            r#"SELECT video_id, size_bytes,
                      SUM(size_bytes) OVER (ORDER BY last_accessed_at ASC, rowid ASC) AS running_total
               FROM video_cache_entries
               WHERE pinned = 0
               ORDER BY last_accessed_at ASC, rowid ASC"#,
        )
        .fetch_all(&self.pool)
        .await?;

        let mut candidates = Vec::new();
        for row in rows {
            let video_id: String = row.get("video_id");
            let size_bytes: i64 = row.get("size_bytes");
            let running_total: i64 = row.get("running_total");
            candidates.push((video_id, size_bytes));
            // Stop once we've accumulated enough to evict the target.
            if running_total >= bytes_to_evict {
                break;
            }
        }
        Ok(candidates)
    }

    /// Return the top N cache entries by size (for the admin endpoint).
    pub async fn video_cache_top_entries(&self, limit: i64) -> CatalogResult<Vec<VideoCacheEntry>> {
        let rows = sqlx::query(
            r#"SELECT video_id, connection_id, provider_file_id, size_bytes,
                      last_accessed_at, pinned, created_at
               FROM video_cache_entries
               ORDER BY size_bytes DESC
               LIMIT ?"#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|row| VideoCacheEntry {
                video_id: row.get("video_id"),
                connection_id: row.get("connection_id"),
                provider_file_id: row.get("provider_file_id"),
                size_bytes: row.get("size_bytes"),
                last_accessed_at: row.get("last_accessed_at"),
                pinned: row.get::<i64, _>("pinned") != 0,
                created_at: row.get("created_at"),
            })
            .collect())
    }

    /// Count of pinned entries.
    pub async fn video_cache_pinned_count(&self) -> CatalogResult<i64> {
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM video_cache_entries WHERE pinned = 1")
                .fetch_one(&self.pool)
                .await?;
        Ok(count)
    }

    // ── Probe data (M5) ────────────────────────────────────────────────

    /// Update a video's codec info from a successful ffprobe. Sets all
    /// codec columns + `probe_status = 'probed'` + `probed_at = now`.
    pub async fn update_video_probe_info(
        &self,
        video_id: &str,
        video_codec: Option<&str>,
        audio_codec: Option<&str>,
        bitrate: Option<u64>,
        framerate: Option<f64>,
    ) -> CatalogResult<()> {
        let now = iso_now();
        sqlx::query(
            r#"UPDATE videos SET
                 video_codec = ?,
                 audio_codec = ?,
                 bitrate = ?,
                 framerate = ?,
                 probed_at = ?,
                 probe_status = 'probed'
               WHERE id = ?"#,
        )
        .bind(video_codec)
        .bind(audio_codec)
        .bind(bitrate.map(|b| b as i64))
        .bind(framerate)
        .bind(now)
        .bind(video_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Mark a video's probe as failed with an optional error message.
    /// Sets `probe_status = 'failed'`; the `probed_at` timestamp is set so
    /// the admin endpoint can see when it was last attempted.
    pub async fn mark_probe_failed(&self, video_id: &str, status: &str) -> CatalogResult<()> {
        let now = iso_now();
        sqlx::query(
            r#"UPDATE videos SET
                 probe_status = ?,
                 probed_at = ?
               WHERE id = ?"#,
        )
        .bind(status)
        .bind(now)
        .bind(video_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Reset a video's probe status to 'pending' so it gets re-probed.
    /// Used by the admin re-probe endpoints.
    pub async fn reset_probe_status(&self, video_id: &str) -> CatalogResult<()> {
        sqlx::query(
            r#"UPDATE videos SET probe_status = 'pending', probed_at = NULL
               WHERE id = ?"#,
        )
        .bind(video_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Return up to `limit` video IDs that still need probing. Used by
    /// the eager post-scan worker.
    pub async fn fetch_pending_probe_ids(
        &self,
        limit: i64,
    ) -> CatalogResult<Vec<(String, String, String)>> {
        let rows = sqlx::query(
            r#"SELECT v.id, v.connection_id, v.provider_file_id
               FROM videos v
               WHERE v.probe_status = 'pending'
               LIMIT ?"#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                (
                    row.get("id"),
                    row.get("connection_id"),
                    row.get("provider_file_id"),
                )
            })
            .collect())
    }

    /// Probe statistics for the admin endpoint.
    pub async fn probe_stats(&self) -> CatalogResult<ProbeStats> {
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM videos")
            .fetch_one(&self.pool)
            .await?;
        let probed: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM videos WHERE probe_status = 'probed'")
                .fetch_one(&self.pool)
                .await?;
        let pending: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM videos WHERE probe_status = 'pending'")
                .fetch_one(&self.pool)
                .await?;
        let failed: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM videos WHERE probe_status = 'failed'")
                .fetch_one(&self.pool)
                .await?;
        let needs_more: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM videos WHERE probe_status = 'needs_more_bytes'",
        )
        .fetch_one(&self.pool)
        .await?;
        let unsupported: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM videos WHERE probe_status = 'unsupported_container'",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(ProbeStats {
            total,
            probed,
            pending,
            failed,
            needs_more_bytes: needs_more,
            unsupported_container: unsupported,
        })
    }

    /// Insert an embedded subtitle track discovered at probe time.
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_subtitle_track(
        &self,
        id: &str,
        video_id: &str,
        embedded_index: i64,
        codec: &str,
        format_family: &str,
        language: Option<&str>,
        title: Option<&str>,
    ) -> CatalogResult<()> {
        sqlx::query(
            r#"INSERT INTO video_subtitle_tracks
               (id, video_id, embedded_index, codec, format_family, language, title)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(video_id, embedded_index) DO UPDATE SET
                 codec = excluded.codec,
                 format_family = excluded.format_family,
                 language = excluded.language,
                 title = excluded.title"#,
        )
        .bind(id)
        .bind(video_id)
        .bind(embedded_index)
        .bind(codec)
        .bind(format_family)
        .bind(language)
        .bind(title)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Delete all embedded subtitle tracks for a video (used before
    /// re-inserting during re-probe).
    pub async fn clear_subtitle_tracks(&self, video_id: &str) -> CatalogResult<()> {
        sqlx::query("DELETE FROM video_subtitle_tracks WHERE video_id = ?")
            .bind(video_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Fetch a single embedded subtitle track by its id. Used by the burn-in
    /// path to resolve the ffmpeg stream index (`embedded_index`) and by
    /// Task 009's master-playlist routing to validate `format_family`.
    /// Returns `None` if the track id doesn't exist for this video.
    pub async fn fetch_embedded_subtitle_track(
        &self,
        video_id: &str,
        track_id: &str,
    ) -> CatalogResult<Option<crate::model::EmbeddedSubtitleTrack>> {
        let row = sqlx::query(
            "SELECT id, embedded_index, codec, format_family, language, title \
             FROM video_subtitle_tracks WHERE id = ? AND video_id = ?",
        )
        .bind(track_id)
        .bind(video_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| crate::model::EmbeddedSubtitleTrack {
            id: r.get("id"),
            embedded_index: r.get("embedded_index"),
            codec: r.get("codec"),
            format_family: r.get("format_family"),
            language: r.get("language"),
            title: r.get("title"),
        }))
    }
}

/// Probe statistics returned by `probe_stats()`.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ProbeStats {
    pub total: i64,
    pub probed: i64,
    pub pending: i64,
    pub failed: i64,
    pub needs_more_bytes: i64,
    pub unsupported_container: i64,
}

fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

// ── Folder tree assembly (M9 FR-4) ──────────────────────────────────

/// Synthetic bucket names, shared with `fetch_folders`'s conventions.
/// Byte order puts `'('` before letters, so they sort first as tree
/// children for free.
const ROOT_BUCKET: &str = "(Root)";
const UNSORTED_BUCKET: &str = "(Unsorted)";

/// Assembly accumulator. `BTreeMap` children keep the output deterministically
/// name-sorted without a separate sort pass.
#[derive(Default)]
struct TreeNode {
    video_count: i64,
    file_count: i64,
    children: std::collections::BTreeMap<String, TreeNode>,
}

/// Accumulate one path into the tree. Every folder ancestor of the file gets
/// +1 (cumulative counts); root-level files (`/name.ext`) and NULL paths go
/// to their synthetic buckets.
fn accumulate_path(root: &mut TreeNode, path: Option<&str>, is_video: bool) {
    let Some(path) = path else {
        bump(bucket_child(root, UNSORTED_BUCKET), is_video);
        return;
    };
    let trimmed = path.strip_prefix('/').unwrap_or(path);
    let segments: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    match segments.as_slice() {
        [] => {}
        [_] => {
            bump(bucket_child(root, ROOT_BUCKET), is_video);
        }
        _ => {
            let mut node = root;
            for seg in &segments[..segments.len() - 1] {
                node = node.children.entry((*seg).to_string()).or_default();
                bump(node, is_video);
            }
        }
    }
}

fn bucket_child<'a>(root: &'a mut TreeNode, name: &str) -> &'a mut TreeNode {
    root.children.entry(name.to_string()).or_default()
}

fn bump(node: &mut TreeNode, is_video: bool) {
    if is_video {
        node.video_count += 1;
    } else {
        node.file_count += 1;
    }
}

/// Convert an accumulator node into its public shape (single node, children
/// sorted by name). `path` for the synthetic buckets is mapped by the caller
/// for root-level buckets and here for nested ones.
fn tree_node_to_folder_node(node: &TreeNode, name: &str, path: &str) -> FolderNode {
    let mut children: Vec<FolderNode> = node
        .children
        .iter()
        .map(|(child_name, child)| {
            let child_path = if path.is_empty() {
                format!("/{child_name}")
            } else {
                format!("{path}/{child_name}")
            };
            tree_node_to_folder_node(child, child_name, &child_path)
        })
        .collect();
    children.sort_by_key(|c| c.name.to_lowercase());
    FolderNode {
        name: name.to_string(),
        path: path.to_string(),
        video_count: node.video_count,
        file_count: node.file_count,
        children,
    }
}

/// Pure tree assembly over video + file paths (unit-testable without a DB).
/// NULL paths land in the `"(Unsorted)"` bucket; single-segment paths in
/// `"(Root)"`. See [`CatalogRepository::fetch_folder_tree`] for the query
/// side.
fn build_folder_tree<Iv, If>(video_paths: Iv, file_paths: If) -> Vec<FolderNode>
where
    Iv: IntoIterator<Item = Option<String>>,
    If: IntoIterator<Item = Option<String>>,
{
    let mut root = TreeNode::default();
    for path in video_paths {
        accumulate_path(&mut root, path.as_deref(), true);
    }
    for path in file_paths {
        accumulate_path(&mut root, path.as_deref(), false);
    }

    let mut top: Vec<FolderNode> = root
        .children
        .iter()
        .map(|(name, child)| {
            // Synthetic buckets keep their name as the selector path is
            // ""/(Unsorted); real top-level folders are "/name".
            let path = match name.as_str() {
                ROOT_BUCKET => String::new(),
                UNSORTED_BUCKET => UNSORTED_BUCKET.to_string(),
                n => format!("/{n}"),
            };
            tree_node_to_folder_node(child, name, &path)
        })
        .collect();
    top.sort_by_key(|n| n.name.to_lowercase());
    top
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{TokenBundle, TokenKey};
    use crate::model::FileKind;

    fn test_key() -> TokenKey {
        TokenKey::from_bytes(vec![42u8; 32]).unwrap()
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
            include_str!("../../storage/migrations/0010_subtitle_formats.sql"),
            include_str!("../../storage/migrations/0011_files.sql"),
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        pool
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

    #[tokio::test]
    async fn create_and_fetch_connection() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());

        let conn = repo
            .create_connection(&NewConnection {
                provider: Provider::GoogleDrive,
                token_bundle: sample_bundle(),
                provider_account_id: Some("acct-1".into()),
                provider_account_email: Some("user@example.com".into()),
            })
            .await
            .unwrap();

        let fetched = repo.fetch_connection(&conn.id).await.unwrap();
        assert!(fetched.is_some());
        let fetched = fetched.unwrap();
        assert_eq!(fetched.provider, Provider::GoogleDrive);
        assert_eq!(
            fetched.provider_account_email.as_deref(),
            Some("user@example.com")
        );
    }

    #[tokio::test]
    async fn token_bundle_encrypts_and_decrypts() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());

        let conn = repo
            .create_connection(&NewConnection {
                provider: Provider::Dropbox,
                token_bundle: sample_bundle(),
                provider_account_id: Some("db-acct".into()),
                provider_account_email: None,
            })
            .await
            .unwrap();

        let bundle = repo.fetch_token_bundle(&conn.id).await.unwrap().unwrap();
        assert_eq!(bundle.access_token, "ya29.test");
        assert_eq!(bundle.refresh_token.as_deref(), Some("refresh"));
    }

    #[tokio::test]
    async fn list_active_connections_excludes_disconnected() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());

        repo.create_connection(&NewConnection {
            provider: Provider::GoogleDrive,
            token_bundle: sample_bundle(),
            provider_account_id: Some("a1".into()),
            provider_account_email: None,
        })
        .await
        .unwrap();

        let conn2 = repo
            .create_connection(&NewConnection {
                provider: Provider::Dropbox,
                token_bundle: sample_bundle(),
                provider_account_id: Some("a2".into()),
                provider_account_email: None,
            })
            .await
            .unwrap();

        repo.disconnect(&conn2.id).await.unwrap();

        let active = repo.list_active_connections().await.unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].provider, Provider::GoogleDrive);
    }

    #[tokio::test]
    async fn is_connection_active_reflects_disconnect() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());

        let conn = repo
            .create_connection(&NewConnection {
                provider: Provider::GoogleDrive,
                token_bundle: sample_bundle(),
                provider_account_id: Some("acct-active".into()),
                provider_account_email: None,
            })
            .await
            .unwrap();

        assert!(
            repo.is_connection_active(&conn.id).await.unwrap(),
            "freshly created connection should be active"
        );

        repo.disconnect(&conn.id).await.unwrap();

        assert!(
            !repo.is_connection_active(&conn.id).await.unwrap(),
            "disconnected connection should be inactive"
        );
    }

    #[tokio::test]
    async fn find_connection_by_account_includes_soft_deleted() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());

        let conn = repo
            .create_connection(&NewConnection {
                provider: Provider::GoogleDrive,
                token_bundle: sample_bundle(),
                provider_account_id: Some("acct-revive".into()),
                provider_account_email: None,
            })
            .await
            .unwrap();

        // Active lookup finds it before disconnect.
        assert!(repo
            .find_active_connection_by_account(Provider::GoogleDrive, "acct-revive")
            .await
            .unwrap()
            .is_some());

        repo.disconnect(&conn.id).await.unwrap();

        // Active lookup no longer sees it.
        assert!(repo
            .find_active_connection_by_account(Provider::GoogleDrive, "acct-revive")
            .await
            .unwrap()
            .is_none());

        // But the inclusive lookup still finds the soft-deleted row.
        let found = repo
            .find_connection_by_account(Provider::GoogleDrive, "acct-revive")
            .await
            .unwrap()
            .expect("soft-deleted row should still be found");
        assert_eq!(found.id, conn.id);
        assert!(found.disconnected_at.is_some());
    }

    #[tokio::test]
    async fn revive_connection_clears_disconnected_at() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());

        let conn = repo
            .create_connection(&NewConnection {
                provider: Provider::GoogleDrive,
                token_bundle: sample_bundle(),
                provider_account_id: Some("acct-revive-2".into()),
                provider_account_email: None,
            })
            .await
            .unwrap();

        repo.disconnect(&conn.id).await.unwrap();
        assert!(!repo.is_connection_active(&conn.id).await.unwrap());

        assert!(
            repo.revive_connection(&conn.id).await.unwrap(),
            "revive should report it revived a soft-deleted row"
        );

        // fetch_connection filters disconnected_at IS NULL, so it sees the
        // revived row again.
        assert!(repo.fetch_connection(&conn.id).await.unwrap().is_some());
        assert!(
            repo.is_connection_active(&conn.id).await.unwrap(),
            "revived connection should be active"
        );

        // Active account lookup sees it again, with the same id preserved.
        let active = repo
            .find_active_connection_by_account(Provider::GoogleDrive, "acct-revive-2")
            .await
            .unwrap()
            .expect("revived connection should be findable by active account lookup");
        assert_eq!(active.id, conn.id);
    }

    #[test]
    fn active_connection_filter_predicate_is_stable() {
        assert_eq!(
            ACTIVE_CONNECTION_FILTER,
            "connection_id IN (SELECT id FROM provider_connections \
             WHERE disconnected_at IS NULL)"
        );
    }

    /// FR-3.4 — the Phase-1 invisibility gate. A soft-deleted connection's
    /// videos must not surface on ANY user-facing or per-id access path. Every
    /// catalog read is enumerated here: a future query added without the shared
    /// predicate will leak and must be added to this test, which is why the
    /// predicate is defined once and reused (no copy-pasted subselects).
    #[tokio::test]
    async fn disconnected_connection_videos_are_invisible_everywhere() {
        use crate::model::VideoFilter;

        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());

        let (owner, conn, video) = seed_owner_conn_video(&repo).await;

        // Give the video in-progress playback so it would show on the
        // continue-watching shelf while the connection is active.
        repo.upsert_progress(&owner, &video, 30.0, Some(120.0), false)
            .await
            .unwrap();

        let filter = VideoFilter {
            owner_id: owner.clone(),
            ..VideoFilter::default()
        };

        // ── While active: every path sees the video (filter is a no-op). ──
        let page = repo.fetch_video_page(&filter).await.unwrap();
        assert_eq!(page.total, 1, "active video appears in browse count");
        assert_eq!(page.videos.len(), 1, "active video appears in browse rows");
        assert!(
            !repo.fetch_folders().await.unwrap().is_empty(),
            "active video appears in folders"
        );
        assert_eq!(
            repo.fetch_in_progress_videos(&owner, 10)
                .await
                .unwrap()
                .len(),
            1,
            "active video appears in continue-watching"
        );
        assert!(
            repo.fetch_video_detail(&video, &owner)
                .await
                .unwrap()
                .is_some(),
            "active video detail resolves"
        );
        assert!(
            repo.fetch_video_stream_info(&video)
                .await
                .unwrap()
                .is_some(),
            "active video stream-info resolves"
        );
        assert!(
            repo.fetch_video_thumbnail_info(&video)
                .await
                .unwrap()
                .is_some(),
            "active video thumbnail-info resolves"
        );
        assert!(
            repo.video_exists(&video).await.unwrap(),
            "active video exists"
        );

        // ── Soft-delete (disconnect) the connection. ──
        repo.disconnect(&conn).await.unwrap();
        // The row + its video stay in place (Task-1 contract); only visibility
        // changes — that is the whole point of soft-delete.
        assert_eq!(
            repo.video_count().await.unwrap(),
            1,
            "soft-delete keeps the video row"
        );

        // ── While disconnected: every access path hides the video. ──
        let page = repo.fetch_video_page(&filter).await.unwrap();
        assert_eq!(page.total, 0, "browse count excludes disconnected");
        assert!(page.videos.is_empty(), "browse rows exclude disconnected");

        assert!(
            repo.fetch_folders().await.unwrap().is_empty(),
            "folders exclude disconnected"
        );

        assert!(
            repo.fetch_in_progress_videos(&owner, 10)
                .await
                .unwrap()
                .is_empty(),
            "continue-watching excludes disconnected"
        );

        assert!(
            repo.fetch_video_detail(&video, &owner)
                .await
                .unwrap()
                .is_none(),
            "video detail 404s for disconnected"
        );
        assert!(
            repo.fetch_video_stream_info(&video)
                .await
                .unwrap()
                .is_none(),
            "stream-info 404s for disconnected"
        );
        assert!(
            repo.fetch_video_thumbnail_info(&video)
                .await
                .unwrap()
                .is_none(),
            "thumbnail-info 404s for disconnected"
        );
        assert!(
            !repo.video_exists(&video).await.unwrap(),
            "video_exists is false for disconnected (mutations 404 cleanly)"
        );

        // ── After revive: everything visible again, same ids (FR-3.3). ──
        repo.revive_connection(&conn).await.unwrap();

        let page = repo.fetch_video_page(&filter).await.unwrap();
        assert_eq!(page.total, 1, "revived video reappears in browse");
        assert_eq!(page.videos[0].id, video, "revive preserves the video UUID");
        assert!(
            !repo.fetch_folders().await.unwrap().is_empty(),
            "revived video reappears in folders"
        );
        assert_eq!(
            repo.fetch_in_progress_videos(&owner, 10)
                .await
                .unwrap()
                .len(),
            1,
            "revived video reappears in continue-watching"
        );
        assert!(repo
            .fetch_video_detail(&video, &owner)
            .await
            .unwrap()
            .is_some());
        assert!(repo
            .fetch_video_stream_info(&video)
            .await
            .unwrap()
            .is_some());
        assert!(repo
            .fetch_video_thumbnail_info(&video)
            .await
            .unwrap()
            .is_some());
        assert!(repo.video_exists(&video).await.unwrap());
    }

    #[tokio::test]
    async fn delete_connection_cascades() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());

        let conn = repo
            .create_connection(&NewConnection {
                provider: Provider::OneDrive,
                token_bundle: sample_bundle(),
                provider_account_id: Some("ms-1".into()),
                provider_account_email: None,
            })
            .await
            .unwrap();

        repo.upsert_video(
            &conn.id,
            Provider::OneDrive,
            &NewVideo {
                provider_file_id: "file-1".into(),
                name: "video.mp4".into(),
                path: Some("/Videos".into()),
                size_bytes: 1000,
                mime_type: Some("video/mp4".into()),
                duration_ms: None,
                width: None,
                height: None,
                native_hash: None,
                native_hash_algo: None,
                provider_modified_at: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(repo.video_count().await.unwrap(), 1);
        assert!(repo.delete_connection(&conn.id).await.unwrap());
        assert_eq!(repo.video_count().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn upsert_video_is_idempotent() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());

        let conn = repo
            .create_connection(&NewConnection {
                provider: Provider::GoogleDrive,
                token_bundle: sample_bundle(),
                provider_account_id: Some("a1".into()),
                provider_account_email: None,
            })
            .await
            .unwrap();

        let video = NewVideo {
            provider_file_id: "file-x".into(),
            name: "v1.mp4".into(),
            path: None,
            size_bytes: 500,
            mime_type: None,
            duration_ms: None,
            width: None,
            height: None,
            native_hash: None,
            native_hash_algo: None,
            provider_modified_at: None,
        };

        repo.upsert_video(&conn.id, Provider::GoogleDrive, &video)
            .await
            .unwrap();
        repo.upsert_video(&conn.id, Provider::GoogleDrive, &video)
            .await
            .unwrap();

        assert_eq!(repo.video_count().await.unwrap(), 1);
    }

    #[tokio::test]
    async fn fetch_video_page_deduplicates() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());

        // Two connections (simulating two providers).
        let conn1 = repo
            .create_connection(&NewConnection {
                provider: Provider::GoogleDrive,
                token_bundle: sample_bundle(),
                provider_account_id: Some("a1".into()),
                provider_account_email: None,
            })
            .await
            .unwrap();
        let conn2 = repo
            .create_connection(&NewConnection {
                provider: Provider::Dropbox,
                token_bundle: sample_bundle(),
                provider_account_id: Some("a2".into()),
                provider_account_email: None,
            })
            .await
            .unwrap();

        // Same file in both providers → same dedup group.
        for conn_id in [&conn1.id, &conn2.id] {
            repo.upsert_video(
                conn_id,
                if conn_id == &conn1.id {
                    Provider::GoogleDrive
                } else {
                    Provider::Dropbox
                },
                &NewVideo {
                    provider_file_id: format!("file-{conn_id}"),
                    name: "duplicated.mp4".into(),
                    path: None,
                    size_bytes: 9999,
                    mime_type: Some("video/mp4".into()),
                    duration_ms: None,
                    width: None,
                    height: None,
                    native_hash: None,
                    native_hash_algo: None,
                    provider_modified_at: None,
                },
            )
            .await
            .unwrap();
        }

        // Set the same dedup group on both.
        let vids = repo.fetch_unhashed_videos(&conn1.id, 0).await.unwrap();
        repo.update_video_dedup(&vids[0].0, "hash123", "hash123:9999")
            .await
            .unwrap();
        let vids2 = repo.fetch_unhashed_videos(&conn2.id, 0).await.unwrap();
        repo.update_video_dedup(&vids2[0].0, "hash123", "hash123:9999")
            .await
            .unwrap();

        let page = repo
            .fetch_video_page(&VideoFilter::default())
            .await
            .unwrap();

        assert_eq!(page.total, 1, "two copies should deduplicate to one entry");
        assert_eq!(page.videos.len(), 1);
        assert_eq!(page.videos[0].sources.len(), 2, "should have two sources");
    }

    #[tokio::test]
    async fn scan_state_round_trips() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());

        let conn = repo
            .create_connection(&NewConnection {
                provider: Provider::GoogleDrive,
                token_bundle: sample_bundle(),
                provider_account_id: Some("a1".into()),
                provider_account_email: None,
            })
            .await
            .unwrap();

        // create_connection initializes scan_state as idle.
        let state = repo.fetch_scan_state(&conn.id).await.unwrap().unwrap();
        assert_eq!(state.status, ScanStatus::Idle);

        // Update to scanning.
        repo.upsert_scan_state(&ScanState {
            connection_id: conn.id.clone(),
            status: ScanStatus::Scanning,
            cursor: Some("page3".into()),
            started_at: Some("2026-01-01T00:00:00Z".into()),
            completed_at: None,
            error_message: None,
            videos_found: 42,
        })
        .await
        .unwrap();

        let state = repo.fetch_scan_state(&conn.id).await.unwrap().unwrap();
        assert_eq!(state.status, ScanStatus::Scanning);
        assert_eq!(state.cursor.as_deref(), Some("page3"));
        assert_eq!(state.videos_found, 42);
    }

    /// Seed an owner, a connection, and a single video. Returns the
    /// `(owner_id, connection_id, video_id)` triple needed by the
    /// favorites/ratings tests (the `video_favorites` / `video_ratings` FKs
    /// require both rows to exist before any insert).
    async fn seed_owner_conn_video(repo: &CatalogRepository) -> (String, String, String) {
        let pool = repo.pool().clone();
        sqlx::query(
            "INSERT INTO owners (id, created_at) VALUES ('owner-x', '2026-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let conn = repo
            .create_connection(&NewConnection {
                provider: Provider::GoogleDrive,
                token_bundle: sample_bundle(),
                provider_account_id: Some("a1".into()),
                provider_account_email: None,
            })
            .await
            .unwrap();

        repo.upsert_video(
            &conn.id,
            Provider::GoogleDrive,
            &NewVideo {
                provider_file_id: "file-1".into(),
                name: "v1.mp4".into(),
                path: Some("/Videos".into()),
                size_bytes: 1000,
                mime_type: Some("video/mp4".into()),
                duration_ms: None,
                width: None,
                height: None,
                native_hash: None,
                native_hash_algo: None,
                provider_modified_at: None,
            },
        )
        .await
        .unwrap();

        let video_id: String = sqlx::query_scalar(
            "SELECT id FROM videos WHERE connection_id = ? AND provider_file_id = ?",
        )
        .bind(&conn.id)
        .bind("file-1")
        .fetch_one(&pool)
        .await
        .unwrap();

        ("owner-x".into(), conn.id, video_id)
    }

    async fn favorite_count(repo: &CatalogRepository, owner_id: &str, video_id: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM video_favorites WHERE owner_id = ? AND video_id = ?",
        )
        .bind(owner_id)
        .bind(video_id)
        .fetch_one(repo.pool())
        .await
        .unwrap()
    }

    /// M9 task 006: the folder tree derives from `videos ∪ files` paths —
    /// nesting, cumulative counts, dedup-aware video counting, and the
    /// `(Root)`/`(Unsorted)` conventions shared with `fetch_folders`.
    #[tokio::test]
    async fn fetch_folder_tree_builds_nested_tree_with_dedup_aware_counts() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let (_owner, conn, _vid) = seed_owner_conn_video(&repo).await;

        // seed_owner_conn_video placed one video at /Videos. Additional
        // videos: nested, root-level, NULL path, and a dedup pair.
        async fn seed_video(repo: &CatalogRepository, conn: &str, id: &str, path: Option<&str>) {
            repo.upsert_video(
                conn,
                Provider::GoogleDrive,
                &NewVideo {
                    provider_file_id: id.into(),
                    name: format!("{id}.mp4"),
                    path: path.map(str::to_string),
                    size_bytes: 1,
                    mime_type: None,
                    duration_ms: None,
                    width: None,
                    height: None,
                    native_hash: None,
                    native_hash_algo: None,
                    provider_modified_at: None,
                },
            )
            .await
            .unwrap();
        }

        seed_video(&repo, &conn, "f-mkv", Some("/Movies/Sci-fi/b.mkv")).await;
        seed_video(&repo, &conn, "f-root", Some("/root-vid.mp4")).await;
        seed_video(&repo, &conn, "f-null", None).await;
        seed_video(&repo, &conn, "f-dup1", Some("/Movies/dup1.mp4")).await;
        seed_video(&repo, &conn, "f-dup2", Some("/Movies/dup2.mp4")).await;
        sqlx::query(
            "UPDATE videos SET dedup_group = 'g1' \
             WHERE provider_file_id IN ('f-dup1','f-dup2')",
        )
        .execute(repo.pool())
        .await
        .unwrap();

        async fn seed_file(
            repo: &CatalogRepository,
            conn: &str,
            id: &str,
            path: Option<&str>,
            kind: FileKind,
        ) {
            repo.upsert_file(
                conn,
                &DiscoveredFile {
                    provider_file_id: id.into(),
                    name: format!("{id}.bin"),
                    path: path.map(str::to_string),
                    size_bytes: 1,
                    mime_type: None,
                    kind,
                    provider_modified_at: None,
                },
            )
            .await
            .unwrap();
        }

        seed_file(
            &repo,
            &conn,
            "x-mp3",
            Some("/Media/Music/song.mp3"),
            FileKind::Audio,
        )
        .await;
        seed_file(&repo, &conn, "x-dat", Some("/Misc/x.dat"), FileKind::Other).await;
        seed_file(&repo, &conn, "x-null", None, FileKind::Image).await;

        let tree = repo.fetch_folder_tree().await.unwrap();
        let by_name = |n: &str| {
            tree.iter()
                .find(|t| t.name == n)
                .unwrap_or_else(|| panic!("missing top-level node {n}: {tree:?}"))
        };

        // Synthetic buckets sort first ('(' < letters in byte order).
        // (Root) holds f-root plus the seed fixture's "/Videos" path — a
        // single-segment path IS a root-level file (real provider paths
        // always append the filename).
        let root = by_name("(Root)");
        assert_eq!(root.video_count, 2, "root-level videos");
        assert_eq!(root.file_count, 0);
        assert_eq!(root.path, "");

        let unsorted = by_name("(Unsorted)");
        assert_eq!(unsorted.video_count, 1);
        assert_eq!(unsorted.file_count, 1);
        assert_eq!(unsorted.path, "(Unsorted)");

        let media = by_name("Media");
        assert_eq!(media.video_count, 0);
        assert_eq!(media.file_count, 1, "cumulative: Music's file");
        assert_eq!(media.path, "/Media");
        assert_eq!(media.children.len(), 1);
        assert_eq!(media.children[0].name, "Music");
        assert_eq!(media.children[0].file_count, 1);

        let movies = by_name("Movies");
        // Sci-fi's b.mkv + ONE representative from the dedup pair = 2.
        assert_eq!(movies.video_count, 2, "dedup pair counts once");
        assert_eq!(movies.file_count, 0);
        let sci_fi = movies
            .children
            .iter()
            .find(|c| c.name == "Sci-fi")
            .expect("Sci-fi child");
        assert_eq!(sci_fi.video_count, 1);
        assert_eq!(sci_fi.path, "/Movies/Sci-fi");

        assert_eq!(by_name("Misc").file_count, 1);
    }

    async fn fetch_rating(repo: &CatalogRepository, owner_id: &str, video_id: &str) -> Option<i32> {
        sqlx::query_scalar("SELECT rating FROM video_ratings WHERE owner_id = ? AND video_id = ?")
            .bind(owner_id)
            .bind(video_id)
            .fetch_optional(repo.pool())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn video_exists_reflects_presence() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let (_owner, _conn, video_id) = seed_owner_conn_video(&repo).await;

        assert!(repo.video_exists(&video_id).await.unwrap());
        assert!(!repo.video_exists("does-not-exist").await.unwrap());
    }

    #[tokio::test]
    async fn favorite_round_trips_and_is_idempotent() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let (owner, _conn, video) = seed_owner_conn_video(&repo).await;

        // Set, then set again — both succeed, exactly one row.
        repo.set_favorite(&owner, &video).await.unwrap();
        repo.set_favorite(&owner, &video).await.unwrap();
        assert_eq!(favorite_count(&repo, &owner, &video).await, 1);

        // Delete, then delete again — both succeed, zero rows.
        repo.delete_favorite(&owner, &video).await.unwrap();
        repo.delete_favorite(&owner, &video).await.unwrap();
        assert_eq!(favorite_count(&repo, &owner, &video).await, 0);
    }

    #[tokio::test]
    async fn rating_upserts_and_clears() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let (owner, _conn, video) = seed_owner_conn_video(&repo).await;

        // Initial set.
        repo.upsert_rating(&owner, &video, 3).await.unwrap();
        assert_eq!(fetch_rating(&repo, &owner, &video).await, Some(3));

        // Update existing.
        repo.upsert_rating(&owner, &video, 5).await.unwrap();
        assert_eq!(fetch_rating(&repo, &owner, &video).await, Some(5));

        // Clear, then clear again (idempotent).
        repo.delete_rating(&owner, &video).await.unwrap();
        repo.delete_rating(&owner, &video).await.unwrap();
        assert_eq!(fetch_rating(&repo, &owner, &video).await, None);
    }

    #[tokio::test]
    async fn favorite_and_rating_cascade_with_video_delete() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let (owner, conn, video) = seed_owner_conn_video(&repo).await;

        repo.set_favorite(&owner, &video).await.unwrap();
        repo.upsert_rating(&owner, &video, 4).await.unwrap();
        assert_eq!(favorite_count(&repo, &owner, &video).await, 1);
        assert_eq!(fetch_rating(&repo, &owner, &video).await, Some(4));

        // Deleting the connection cascades to videos → favorites/ratings.
        assert!(repo.delete_connection(&conn).await.unwrap());

        let total_favs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM video_favorites")
            .fetch_one(repo.pool())
            .await
            .unwrap();
        let total_ratings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM video_ratings")
            .fetch_one(repo.pool())
            .await
            .unwrap();
        assert_eq!(
            total_favs, 0,
            "favorites should cascade-delete with the video"
        );
        assert_eq!(
            total_ratings, 0,
            "ratings should cascade-delete with the video"
        );
    }

    // ── Search (FTS5 prefix matching) ────────────────────────────────────

    #[tokio::test]
    async fn video_search_matches_prefix_tokens() {
        use crate::model::VideoFilter;

        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let (owner, _conn, _video) = seed_owner_conn_video(&repo).await;

        // The seeded video's path "/Videos" indexes the token "videos".
        // A prefix query for "vid" must match it — before the prefix glob
        // (`"token"*`) the search was exact-token-only and this returned 0.
        let page = repo
            .fetch_video_page(&VideoFilter {
                q: Some("vid".into()),
                owner_id: owner.clone(),
                ..VideoFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(
            page.total, 1,
            "prefix query 'vid' should match the 'videos' token"
        );

        // Exact token still matches.
        let page = repo
            .fetch_video_page(&VideoFilter {
                q: Some("videos".into()),
                owner_id: owner.clone(),
                ..VideoFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(page.total, 1, "exact query 'videos' matches");

        // A token that is not a prefix of any indexed token matches nothing.
        let page = repo
            .fetch_video_page(&VideoFilter {
                q: Some("xyz".into()),
                owner_id: owner,
                ..VideoFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(page.total, 0, "non-matching query returns nothing");
    }

    // ── Video cache manifest tests (M4) ────────────────────────────────

    #[tokio::test]
    async fn video_cache_upsert_and_fetch_round_trip() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let (_owner, conn, video) = seed_owner_conn_video(&repo).await;

        // Initially no cache entry.
        assert!(repo
            .fetch_video_cache_entry(&video)
            .await
            .unwrap()
            .is_none());

        // Upsert creates the entry.
        repo.upsert_video_cache_entry(&video, &conn, "file-123", 1_000_000)
            .await
            .unwrap();
        let entry = repo.fetch_video_cache_entry(&video).await.unwrap().unwrap();
        assert_eq!(entry.video_id, video);
        assert_eq!(entry.connection_id, conn);
        assert_eq!(entry.provider_file_id, "file-123");
        assert_eq!(entry.size_bytes, 1_000_000);
        assert!(!entry.pinned);

        // Upsert replaces (new size, new file_id).
        repo.upsert_video_cache_entry(&video, &conn, "file-456", 2_000_000)
            .await
            .unwrap();
        let entry = repo.fetch_video_cache_entry(&video).await.unwrap().unwrap();
        assert_eq!(entry.provider_file_id, "file-456");
        assert_eq!(entry.size_bytes, 2_000_000);
    }

    #[tokio::test]
    async fn video_cache_pin_unpin() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let (_owner, conn, video) = seed_owner_conn_video(&repo).await;
        repo.upsert_video_cache_entry(&video, &conn, "f", 100)
            .await
            .unwrap();

        // Pin.
        assert!(repo.set_video_cache_pinned(&video, true).await.unwrap());
        let entry = repo.fetch_video_cache_entry(&video).await.unwrap().unwrap();
        assert!(entry.pinned);

        // Unpin.
        assert!(repo.set_video_cache_pinned(&video, false).await.unwrap());
        let entry = repo.fetch_video_cache_entry(&video).await.unwrap().unwrap();
        assert!(!entry.pinned);

        // Pin on non-existent entry returns false.
        assert!(!repo
            .set_video_cache_pinned("no-such-video", true)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn video_cache_delete() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let (_owner, conn, video) = seed_owner_conn_video(&repo).await;
        repo.upsert_video_cache_entry(&video, &conn, "f", 500)
            .await
            .unwrap();
        assert!(repo
            .fetch_video_cache_entry(&video)
            .await
            .unwrap()
            .is_some());

        repo.delete_video_cache_entry(&video).await.unwrap();
        assert!(repo
            .fetch_video_cache_entry(&video)
            .await
            .unwrap()
            .is_none());

        // Delete again is a no-op.
        repo.delete_video_cache_entry(&video).await.unwrap();
    }

    #[tokio::test]
    async fn video_cache_total_size_and_count() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let (_owner, conn, v1) = seed_owner_conn_video(&repo).await;
        // Create two more videos to have 3 cache entries.
        let v2 = seed_extra_video(&repo, &conn, "v2").await;
        let v3 = seed_extra_video(&repo, &conn, "v3").await;

        repo.upsert_video_cache_entry(&v1, &conn, "f1", 100)
            .await
            .unwrap();
        repo.upsert_video_cache_entry(&v2, &conn, "f2", 200)
            .await
            .unwrap();
        repo.upsert_video_cache_entry(&v3, &conn, "f3", 300)
            .await
            .unwrap();

        assert_eq!(repo.video_cache_total_size().await.unwrap(), 600);
        assert_eq!(repo.video_cache_entry_count().await.unwrap(), 3);
    }

    #[tokio::test]
    async fn video_cache_eviction_candidates_respects_pin() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let (_owner, conn, v1) = seed_owner_conn_video(&repo).await;
        let v2 = seed_extra_video(&repo, &conn, "v2").await;
        let v3 = seed_extra_video(&repo, &conn, "v3").await;

        // v1 = 100 bytes, v2 = 200 bytes (pinned), v3 = 300 bytes.
        repo.upsert_video_cache_entry(&v1, &conn, "f1", 100)
            .await
            .unwrap();
        repo.upsert_video_cache_entry(&v2, &conn, "f2", 200)
            .await
            .unwrap();
        repo.upsert_video_cache_entry(&v3, &conn, "f3", 300)
            .await
            .unwrap();
        repo.set_video_cache_pinned(&v2, true).await.unwrap();

        // Evict 50 bytes. v1 alone (100 bytes) is enough — running_total
        // crosses 50 at v1.
        let candidates = repo.video_cache_eviction_candidates(50).await.unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].0, v1);

        // Evict 150 bytes. v1 (100) alone isn't enough; v3 (300) is also
        // needed. v2 (pinned) must never appear.
        let candidates = repo.video_cache_eviction_candidates(150).await.unwrap();
        assert_eq!(candidates.len(), 2, "v1 + v3 needed to free 150 bytes");
        assert!(candidates.iter().any(|(id, _)| *id == v1));
        assert!(candidates.iter().any(|(id, _)| *id == v3));
        assert!(
            !candidates.iter().any(|(id, _)| *id == v2),
            "pinned entries must never be evicted"
        );
    }

    /// M8 Task 002: `fetch_subtitles` must surface the new routing columns
    /// for sidecar rows so the frontend can branch on `format_family` rather
    /// than inferring from the `format` string. Sidecars are always
    /// `format_family = 'text'` and `embedded_track_id = NULL` (those columns
    /// only carry meaning for extracted-embedded tracks, inserted by Task 006).
    #[tokio::test]
    async fn fetch_subtitles_surfaces_format_family_for_sidecars() {
        let pool = fresh_pool().await;
        let repo = CatalogRepository::new(pool, test_key());
        let (_owner, conn, vid) = seed_owner_conn_video(&repo).await;

        // Seed one srt + one vtt sidecar, the two legacy formats. Goes through
        // the public upsert path so the row shape matches what scan produces.
        repo.upsert_subtitle(&vid, &conn, "side-srt", Some("en"), "movie.en.srt", "srt")
            .await
            .unwrap();
        repo.upsert_subtitle(&vid, &conn, "side-vtt", None, "movie.vtt", "vtt")
            .await
            .unwrap();

        let tracks = repo.fetch_subtitles(&vid).await.unwrap();
        assert_eq!(tracks.len(), 2, "both sidecars should surface");
        // Ordered by filename — "movie.en.srt" < "movie.vtt".
        assert_eq!(tracks[0].filename, "movie.en.srt");
        assert_eq!(tracks[0].format, "srt");
        assert_eq!(tracks[0].format_family, "text");
        assert!(tracks[0].embedded_track_id.is_none());

        assert_eq!(tracks[1].filename, "movie.vtt");
        assert_eq!(tracks[1].format, "vtt");
        assert_eq!(tracks[1].format_family, "text");
        assert!(tracks[1].embedded_track_id.is_none());
    }

    /// Helper: insert an additional video under an existing connection.
    async fn seed_extra_video(repo: &CatalogRepository, conn: &str, id: &str) -> String {
        use crate::model::NewVideo;
        let video = NewVideo {
            provider_file_id: format!("{id}-file"),
            name: format!("{id}.mp4"),
            path: Some(format!("/{id}.mp4")),
            size_bytes: 5_000_000,
            mime_type: Some("video/mp4".to_string()),
            duration_ms: Some(120_000),
            width: Some(1920),
            height: Some(1080),
            native_hash: None,
            native_hash_algo: None,
            provider_modified_at: None,
        };
        repo.upsert_video(conn, Provider::GoogleDrive, &video)
            .await
            .unwrap();
        // Fetch the generated UUID.
        let row: (String,) = sqlx::query_as("SELECT id FROM videos WHERE provider_file_id = ?")
            .bind(format!("{id}-file"))
            .fetch_one(repo.pool())
            .await
            .unwrap();
        row.0
    }
}
