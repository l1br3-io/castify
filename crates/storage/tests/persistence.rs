use castify_storage::{connect, run_migrations};
use sqlx::Row;

async fn fresh_db() -> (tempfile::TempPath, std::path::PathBuf) {
    let file = tempfile::NamedTempFile::new().unwrap().into_temp_path();
    let path = file.to_path_buf();
    (file, path)
}

#[tokio::test]
async fn migrations_create_app_meta_seed_rows() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();

    let instance_id: String =
        sqlx::query_scalar("SELECT value FROM app_meta WHERE key = 'instance_id'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(instance_id.len(), 32, "instance_id should be 32 hex chars");

    let owners: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM owners")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(owners, 0, "owners table starts empty");
}

#[tokio::test]
async fn journal_mode_is_wal() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    let row = sqlx::query("PRAGMA journal_mode")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mode: String = row.get(0);
    assert_eq!(mode.to_lowercase(), "wal");
}

#[tokio::test]
async fn migrations_are_idempotent() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    run_migrations(&pool).await.unwrap();
}

#[tokio::test]
async fn data_survives_pool_recreation() {
    let (_guard, path) = fresh_db().await;

    let pool_a = connect(&path).await.unwrap();
    run_migrations(&pool_a).await.unwrap();
    sqlx::query(
        "INSERT INTO owners (id, created_at, display_name) \
         VALUES ('owner-1', '2026-01-01T00:00:00Z', 'Jane')",
    )
    .execute(&pool_a)
    .await
    .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool_a)
        .await
        .unwrap();
    pool_a.close().await;

    let pool_b = connect(&path).await.unwrap();
    run_migrations(&pool_b).await.unwrap();
    let row = sqlx::query("SELECT display_name FROM owners WHERE id = 'owner-1'")
        .fetch_one(&pool_b)
        .await
        .unwrap();
    let name: String = row.get(0);
    assert_eq!(name, "Jane");
}

#[tokio::test]
async fn connect_creates_missing_parent_dir() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("nested/sub/dir/castify.db");
    let pool = connect(&nested).await.unwrap();
    run_migrations(&pool).await.unwrap();
    assert!(nested.exists());
}

#[tokio::test]
async fn migration_0002_creates_auth_tables() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();

    // Each auth table exists and accepts the expected shape.
    sqlx::query(
        "INSERT INTO owners (id, created_at, display_name) \
         VALUES ('owner-A', '2026-01-01T00:00:00Z', 'A')",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO password_credentials (owner_id, password_hash, created_at, updated_at) \
         VALUES ('owner-A', '$argon2id$...', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO sessions (id, owner_id, created_at, expires_at, last_seen_at, user_agent, ip_address) \
         VALUES ('sess-1', 'owner-A', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();

    let session_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(session_count, 1);
}

#[tokio::test]
async fn cascade_delete_removes_owner_credentials() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();

    sqlx::query("INSERT INTO owners (id, created_at) VALUES ('owner-B', '2026-01-01T00:00:00Z')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO sessions (id, owner_id, created_at, expires_at, last_seen_at) \
         VALUES ('sess-B', 'owner-B', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("DELETE FROM owners WHERE id = 'owner-B'")
        .execute(&pool)
        .await
        .unwrap();

    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0, "session should cascade-delete with owner");
}

#[tokio::test]
async fn migration_0003_creates_connect_catalog_tables() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();

    // provider_connections accepts the expected shape.
    sqlx::query(
        "INSERT INTO provider_connections (id, provider, token_bundle, provider_account_id, \
         provider_account_email, connected_at) \
         VALUES ('conn-1', 'google_drive', X'deadbeef', 'acct-1', 'user@example.com', \
         '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // videos accepts the expected shape and cascades on connection delete.
    sqlx::query(
        "INSERT INTO videos (id, connection_id, provider, provider_file_id, name, path, \
         size_bytes, mime_type, duration_ms, width, height, native_hash, native_hash_algo, \
         castify_hash, dedup_group, provider_modified_at, scanned_at, created_at) \
         VALUES ('vid-1', 'conn-1', 'google_drive', 'file-abc', 'movie.mp4', '/Videos', \
         1048576, 'video/mp4', 3600000, 1920, 1080, 'abc123', 'md5', \
         'def456', 'def456:1048576', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', \
         '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // scan_state accepts the expected shape.
    sqlx::query(
        "INSERT INTO scan_state (connection_id, status, cursor, started_at, completed_at, \
         error_message, videos_found) \
         VALUES ('conn-1', 'idle', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', \
         NULL, 42)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Cascade: deleting a connection removes its videos + scan state.
    sqlx::query("DELETE FROM provider_connections WHERE id = 'conn-1'")
        .execute(&pool)
        .await
        .unwrap();

    let videos: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM videos")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(videos, 0, "videos should cascade-delete with connection");

    let scans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_state")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(scans, 0, "scan_state should cascade-delete with connection");
}

#[tokio::test]
async fn migration_0003_unique_constraints() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();

    sqlx::query(
        "INSERT INTO provider_connections (id, provider, token_bundle, provider_account_id, \
         connected_at) VALUES ('c1', 'google_drive', X'aa', 'acct-1', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Same provider + same account ID must fail.
    let dup = sqlx::query(
        "INSERT INTO provider_connections (id, provider, token_bundle, provider_account_id, \
         connected_at) VALUES ('c2', 'google_drive', X'bb', 'acct-1', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await;
    assert!(dup.is_err(), "duplicate provider+account_id must reject");

    // Same connection + same file ID must fail.
    sqlx::query(
        "INSERT INTO videos (id, connection_id, provider, provider_file_id, name, size_bytes, \
         scanned_at, created_at) \
         VALUES ('v1', 'c1', 'google_drive', 'file-x', 'a.mp4', 100, '2026-01-01T00:00:00Z', \
         '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let dup_video = sqlx::query(
        "INSERT INTO videos (id, connection_id, provider, provider_file_id, name, size_bytes, \
         scanned_at, created_at) \
         VALUES ('v2', 'c1', 'google_drive', 'file-x', 'a.mp4', 100, '2026-01-01T00:00:00Z', \
         '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await;
    assert!(
        dup_video.is_err(),
        "duplicate connection_id+provider_file_id must reject"
    );
}

// ---- Migration 0004: Browse ----

async fn seed_owner_connection_video(pool: &sqlx::SqlitePool) {
    sqlx::query("INSERT INTO owners (id, created_at) VALUES ('owner-x', '2026-01-01T00:00:00Z')")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO provider_connections (id, provider, token_bundle, provider_account_id, \
         connected_at) VALUES ('conn-x', 'google_drive', X'aa', 'acct-1', '2026-01-01T00:00:00Z')",
    )
    .execute(pool)
    .await
    .unwrap();
    // Name + path use disjoint tokens so FTS5 update/delete trigger tests can
    // observe a name-only token leaving the index without path-column aliasing.
    sqlx::query(
        "INSERT INTO videos (id, connection_id, provider, provider_file_id, name, path, \
         size_bytes, scanned_at, created_at) \
         VALUES ('vid-x', 'conn-x', 'google_drive', 'file-x', 'concert.mp4', '/Library/footage', \
         100, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn migration_0004_creates_browse_tables() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    sqlx::query(
        "INSERT INTO video_favorites (owner_id, video_id, created_at) \
         VALUES ('owner-x', 'vid-x', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO video_ratings (owner_id, video_id, rating, updated_at) \
         VALUES ('owner-x', 'vid-x', 4, '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let fav_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM video_favorites")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fav_count, 1);

    let rating: i64 = sqlx::query_scalar("SELECT rating FROM video_ratings WHERE video_id = 'vid-x'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rating, 4);
}

#[tokio::test]
async fn migration_0004_thumbnail_status_defaults_to_pending() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();

    // Insert a video without specifying thumbnail_status.
    seed_owner_connection_video(&pool).await;

    let status: String =
        sqlx::query_scalar("SELECT thumbnail_status FROM videos WHERE id = 'vid-x'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "pending");
}

#[tokio::test]
async fn migration_0004_rating_check_constraint_rejects_out_of_range() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    let too_low = sqlx::query(
        "INSERT INTO video_ratings (owner_id, video_id, rating, updated_at) \
         VALUES ('owner-x', 'vid-x', 0, '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await;
    assert!(too_low.is_err(), "rating = 0 must be rejected by CHECK");

    let too_high = sqlx::query(
        "INSERT INTO video_ratings (owner_id, video_id, rating, updated_at) \
         VALUES ('owner-x', 'vid-x', 6, '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await;
    assert!(too_high.is_err(), "rating = 6 must be rejected by CHECK");

    // Boundary values 1 and 5 are accepted.
    sqlx::query(
        "INSERT INTO video_ratings (owner_id, video_id, rating, updated_at) \
         VALUES ('owner-x', 'vid-x', 1, '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn migration_0004_cascade_deletes_favorites_and_ratings() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    sqlx::query(
        "INSERT INTO video_favorites (owner_id, video_id, created_at) \
         VALUES ('owner-x', 'vid-x', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO video_ratings (owner_id, video_id, rating, updated_at) \
         VALUES ('owner-x', 'vid-x', 5, '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Deleting the video cascades to its favorites + ratings.
    sqlx::query("DELETE FROM videos WHERE id = 'vid-x'")
        .execute(&pool)
        .await
        .unwrap();

    let favs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM video_favorites")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(favs, 0, "favorites should cascade-delete with video");

    let ratings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM video_ratings")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(ratings, 0, "ratings should cascade-delete with video");
}

#[tokio::test]
async fn migration_0004_fts5_triggers_keep_index_in_sync() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();

    // Empty index to start.
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM videos_fts WHERE videos_fts MATCH 'concert'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);

    // Insert a video — the AFTER INSERT trigger indexes name + path.
    seed_owner_connection_video(&pool).await;

    let name_hits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM videos_fts WHERE videos_fts MATCH 'concert'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(name_hits, 1, "FTS5 should index the video name");

    // Path tokens are indexed too (case-folded; /Library -> 'library').
    let path_hits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM videos_fts WHERE videos_fts MATCH 'library'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(path_hits, 1, "FTS5 should index the video path (case-insensitive)");

    // Update the name — AFTER UPDATE trigger re-indexes. 'concert' was only in
    // the name (not the path), so it must leave the index entirely.
    sqlx::query("UPDATE videos SET name = 'symphony.mkv' WHERE id = 'vid-x'")
        .execute(&pool)
        .await
        .unwrap();
    let old_hits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM videos_fts WHERE videos_fts MATCH 'concert'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(old_hits, 0, "old name token should leave the index after update");
    let new_hits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM videos_fts WHERE videos_fts MATCH 'symphony'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(new_hits, 1, "new name token should enter the index after update");

    // Delete the video — AFTER DELETE trigger removes it.
    sqlx::query("DELETE FROM videos WHERE id = 'vid-x'")
        .execute(&pool)
        .await
        .unwrap();
    let final_hits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM videos_fts WHERE videos_fts MATCH 'symphony'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(final_hits, 0, "FTS5 index should be empty after video deletion");
}
