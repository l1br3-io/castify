use std::collections::HashMap;

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::crypto::{TokenBundle, TokenKey};
use crate::model::{
    NewConnection, NewVideo, Provider, ProviderConnection, ScanState, ScanStatus, VideoFilter,
    VideoPage, VideoSource, VideoSummary,
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

    /// Hard-delete a connection row. Cascades to videos and scan_state.
    pub async fn delete_connection(&self, id: &str) -> CatalogResult<bool> {
        let result = sqlx::query("DELETE FROM provider_connections WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
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

    /// Fetch a deduplicated, paginated page of videos across all active
    /// connections. Videos sharing a `dedup_group` appear as one entry with
    /// multiple `sources`.
    pub async fn fetch_video_page(&self, filter: &VideoFilter) -> CatalogResult<VideoPage> {
        let offset = (filter.page - 1) * filter.limit;
        let order = filter.sort.order_clause();

        // Build conditional provider filter for both subquery and count.
        let (count_sql, rep_sql, provider_bindings): (&str, String, Vec<&str>) = match &filter
            .provider
        {
            Some(p) => {
                let cs = "SELECT COUNT(*) FROM ( \
                        SELECT MIN(id) FROM videos WHERE dedup_group IS NOT NULL AND provider = ? GROUP BY dedup_group \
                        UNION ALL \
                        SELECT id FROM videos WHERE dedup_group IS NULL AND provider = ? \
                    )";
                let rs = format!(
                        "SELECT v.id, v.name, v.provider, v.size_bytes, v.mime_type, \
                                v.duration_ms, v.width, v.height, v.dedup_group, \
                                v.connection_id, v.provider_file_id \
                         FROM videos v \
                         WHERE v.id IN ( \
                             SELECT MIN(id) FROM videos WHERE dedup_group IS NOT NULL AND provider = ? GROUP BY dedup_group \
                             UNION ALL \
                             SELECT id FROM videos WHERE dedup_group IS NULL AND provider = ? \
                         ) \
                         ORDER BY v.{order} \
                         LIMIT ? OFFSET ?"
                    );
                (cs, rs, vec![p.as_str(), p.as_str()])
            }
            None => {
                let cs = "SELECT COUNT(*) FROM ( \
                        SELECT MIN(id) FROM videos WHERE dedup_group IS NOT NULL GROUP BY dedup_group \
                        UNION ALL \
                        SELECT id FROM videos WHERE dedup_group IS NULL \
                    )";
                let rs = format!(
                        "SELECT v.id, v.name, v.provider, v.size_bytes, v.mime_type, \
                                v.duration_ms, v.width, v.height, v.dedup_group, \
                                v.connection_id, v.provider_file_id \
                         FROM videos v \
                         WHERE v.id IN ( \
                             SELECT MIN(id) FROM videos WHERE dedup_group IS NOT NULL GROUP BY dedup_group \
                             UNION ALL \
                             SELECT id FROM videos WHERE dedup_group IS NULL \
                         ) \
                         ORDER BY v.{order} \
                         LIMIT ? OFFSET ?"
                    );
                (cs, rs, vec![])
            }
        };

        // 1. Total count.
        let total: i64 = if provider_bindings.is_empty() {
            sqlx::query_scalar(count_sql).fetch_one(&self.pool).await?
        } else {
            sqlx::query_scalar(count_sql)
                .bind(provider_bindings[0])
                .bind(provider_bindings[1])
                .fetch_one(&self.pool)
                .await?
        };

        // 2. Representatives for this page.
        let rep_rows = if provider_bindings.is_empty() {
            sqlx::query(&rep_sql)
                .bind(filter.limit)
                .bind(offset)
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query(&rep_sql)
                .bind(provider_bindings[0])
                .bind(provider_bindings[1])
                .bind(filter.limit)
                .bind(offset)
                .fetch_all(&self.pool)
                .await?
        };

        // 3. Batch-fetch sources for all dedup groups in this page.
        let dedup_groups: Vec<String> = rep_rows
            .iter()
            .filter_map(|r| sqlx::Row::get::<Option<String>, _>(r, "dedup_group"))
            .collect();

        let sources_by_group = if dedup_groups.is_empty() {
            HashMap::new()
        } else {
            self.fetch_sources_by_groups(&dedup_groups).await?
        };

        // 4. Assemble summaries.
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

    /// Fetch all source copies for a set of dedup groups.
    async fn fetch_sources_by_groups(
        &self,
        groups: &[String],
    ) -> CatalogResult<HashMap<String, Vec<VideoSource>>> {
        let placeholders = vec!["?"; groups.len()].join(", ");
        let sql = format!(
            "SELECT connection_id, provider, provider_file_id, dedup_group \
             FROM videos WHERE dedup_group IN ({placeholders})"
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
}

fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{TokenBundle, TokenKey};

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
}
