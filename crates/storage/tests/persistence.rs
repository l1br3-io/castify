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

    let rating: i64 =
        sqlx::query_scalar("SELECT rating FROM video_ratings WHERE video_id = 'vid-x'")
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
    assert_eq!(
        path_hits, 1,
        "FTS5 should index the video path (case-insensitive)"
    );

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
    assert_eq!(
        old_hits, 0,
        "old name token should leave the index after update"
    );
    let new_hits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM videos_fts WHERE videos_fts MATCH 'symphony'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        new_hits, 1,
        "new name token should enter the index after update"
    );

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
    assert_eq!(
        final_hits, 0,
        "FTS5 index should be empty after video deletion"
    );
}

// ---- Migration 0006: Play ----

#[tokio::test]
async fn migration_0006_creates_play_tables() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    sqlx::query(
        "INSERT INTO playback_progress (owner_id, video_id, position_seconds, duration_seconds, \
         updated_at, completed) \
         VALUES ('owner-x', 'vid-x', 120.5, 3600.0, '2026-01-01T00:02:00Z', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, language, \
         filename, format, format_family) \
         VALUES ('sub-1', 'vid-x', 'conn-x', 'file-sub', 'en', 'movie.en.srt', 'srt', 'text')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let position: f64 = sqlx::query_scalar(
        "SELECT position_seconds FROM playback_progress WHERE video_id = 'vid-x'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(position, 120.5);

    let fmt: String =
        sqlx::query_scalar("SELECT format FROM video_subtitles WHERE video_id = 'vid-x'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(fmt, "srt");
}

#[tokio::test]
async fn migration_0006_cascade_deletes_progress_and_subtitles() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    sqlx::query(
        "INSERT INTO playback_progress (owner_id, video_id, position_seconds, updated_at) \
         VALUES ('owner-x', 'vid-x', 60.0, '2026-01-01T00:01:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, filename, \
         format, format_family) \
         VALUES ('sub-1', 'vid-x', 'conn-x', 'file-sub', 'movie.srt', 'srt', 'text')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Deleting the video cascades to progress + subtitles.
    sqlx::query("DELETE FROM videos WHERE id = 'vid-x'")
        .execute(&pool)
        .await
        .unwrap();

    let progress: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM playback_progress")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(progress, 0, "progress should cascade-delete with video");

    let subs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM video_subtitles")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(subs, 0, "subtitles should cascade-delete with video");
}

#[tokio::test]
async fn migration_0006_cascade_deletes_subtitles_on_connection_delete() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, filename, \
         format, format_family) \
         VALUES ('sub-1', 'vid-x', 'conn-x', 'file-sub', 'movie.srt', 'srt', 'text')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Deleting the connection cascades to videos → subtitles.
    sqlx::query("DELETE FROM provider_connections WHERE id = 'conn-x'")
        .execute(&pool)
        .await
        .unwrap();

    let subs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM video_subtitles")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        subs, 0,
        "subtitles should cascade-delete with connection (via video)"
    );
}

#[tokio::test]
async fn migration_0006_subtitle_format_check_rejects_invalid() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    // Migration 0010 relaxed the CHECK so ASS/SSA/PGS/VobSub are now legal;
    // 'mov_text' is still outside the allowed list and must be rejected.
    let bad_format = sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, filename, \
         format, format_family) \
         VALUES ('sub-1', 'vid-x', 'conn-x', 'file-sub', 'movie.txt', 'mov_text', 'text')",
    )
    .execute(&pool)
    .await;
    assert!(
        bad_format.is_err(),
        "format = 'mov_text' must be rejected by CHECK"
    );

    // 'srt' and 'vtt' are accepted (format_family is NOT NULL since 0010).
    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, filename, \
         format, format_family) \
         VALUES ('sub-1', 'vid-x', 'conn-x', 'file-sub', 'movie.srt', 'srt', 'text')",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, filename, \
         format, format_family) \
         VALUES ('sub-2', 'vid-x', 'conn-x', 'file-sub2', 'movie.vtt', 'vtt', 'text')",
    )
    .execute(&pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn migration_0006_subtitle_unique_constraint() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, filename, \
         format, format_family) \
         VALUES ('sub-1', 'vid-x', 'conn-x', 'file-sub', 'movie.srt', 'srt', 'text')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let dup = sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, filename, \
         format, format_family) \
         VALUES ('sub-2', 'vid-x', 'conn-x', 'file-sub', 'movie.srt', 'srt', 'text')",
    )
    .execute(&pool)
    .await;
    assert!(
        dup.is_err(),
        "duplicate video_id+provider_file_id must reject"
    );
}

#[tokio::test]
async fn migration_0006_progress_upsert_via_on_conflict() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    // Initial insert.
    sqlx::query(
        "INSERT INTO playback_progress (owner_id, video_id, position_seconds, updated_at) \
         VALUES ('owner-x', 'vid-x', 30.0, '2026-01-01T00:00:30Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Upsert: position advances, completed flips on.
    sqlx::query(
        "INSERT INTO playback_progress (owner_id, video_id, position_seconds, duration_seconds, \
         updated_at, completed) \
         VALUES ('owner-x', 'vid-x', 3420.0, 3600.0, '2026-01-01T00:57:00Z', 1) \
         ON CONFLICT(owner_id, video_id) DO UPDATE SET \
         position_seconds = excluded.position_seconds, \
         duration_seconds = excluded.duration_seconds, \
         updated_at = excluded.updated_at, \
         completed = excluded.completed",
    )
    .execute(&pool)
    .await
    .unwrap();

    let (position, completed): (f64, i64) = sqlx::query_as(
        "SELECT position_seconds, completed FROM playback_progress WHERE video_id = 'vid-x'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(position, 3420.0);
    assert_eq!(completed, 1);

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM playback_progress")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "upsert should not create a duplicate row");
}

#[tokio::test]
async fn migrations_create_video_cache_entries_table() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM video_cache_entries")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "video_cache_entries starts empty");
}

#[tokio::test]
async fn migrations_create_transcode_cache_entries_table() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcode_cache_entries")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "transcode_cache_entries starts empty");
}

// ---- Migration 0010: Advanced subtitle formats ----

#[tokio::test]
async fn migration_0010_relaxes_format_check_to_allow_advanced_formats() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    // The relaxed CHECK (migration 0010) accepts ASS/SSA/PGS/VobSub
    // alongside the original SRT/VTT.
    for fmt in ["ass", "ssa", "pgs", "vobsub", "srt", "vtt"] {
        sqlx::query(
            "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, \
             filename, format, format_family) \
             VALUES (?, 'vid-x', 'conn-x', ?, ?, ?, 'text')",
        )
        .bind(format!("sub-{fmt}"))
        .bind(format!("file-{fmt}"))
        .bind(format!("movie.{fmt}"))
        .bind(fmt)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("format = '{fmt}' should be accepted: {e}"));
    }

    // Anything outside the CHECK list is still rejected.
    let bad = sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, \
         filename, format, format_family) \
         VALUES ('sub-bad', 'vid-x', 'conn-x', 'file-bad', 'movie.txt', 'mov_text', 'text')",
    )
    .execute(&pool)
    .await;
    assert!(
        bad.is_err(),
        "format = 'mov_text' must be rejected by CHECK"
    );
}

#[tokio::test]
async fn migration_0010_format_family_check_and_not_null() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    // 'text' and 'image' are the only legal families.
    for family in ["text", "image"] {
        sqlx::query(
            "INSERT INTO video_subtitles (id, video_id, provider_file_id, filename, \
             format, format_family) \
             VALUES (?, 'vid-x', ?, ?, 'srt', ?)",
        )
        .bind(format!("sub-{family}"))
        .bind(format!("file-{family}"))
        .bind(format!("m.{family}"))
        .bind(family)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("format_family = '{family}' should be accepted: {e}"));
    }

    // Garbage family rejected.
    let bad = sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, provider_file_id, filename, format, \
         format_family) \
         VALUES ('sub-bad', 'vid-x', 'file-bad', 'm.srt', 'srt', 'unknown')",
    )
    .execute(&pool)
    .await;
    assert!(bad.is_err(), "format_family = 'unknown' must be rejected");

    // NOT NULL: omitting format_family fails.
    let null_family = sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, provider_file_id, filename, format) \
         VALUES ('sub-null', 'vid-x', 'file-null', 'm.srt', 'srt')",
    )
    .execute(&pool)
    .await;
    assert!(null_family.is_err(), "format_family is NOT NULL");
}

#[tokio::test]
async fn migration_0010_routing_columns_are_nullable_for_sidecars() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    // A sidecar row: provider_file_id present, embedded_track_id +
    // extracted_path NULL (the post-migration default for sidecars).
    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, \
         language, filename, format, format_family, embedded_track_id, extracted_path) \
         VALUES ('sub-side', 'vid-x', 'conn-x', 'file-side', 'en', 'movie.en.srt', 'srt', \
         'text', NULL, NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();

    let row = sqlx::query(
        "SELECT embedded_track_id, extracted_path, format_family \
         FROM video_subtitles WHERE id = 'sub-side'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let embedded: Option<i64> = row.get("embedded_track_id");
    let extracted: Option<String> = row.get("extracted_path");
    let family: String = row.get("format_family");
    assert!(embedded.is_none(), "sidecar has NULL embedded_track_id");
    assert!(extracted.is_none(), "sidecar has NULL extracted_path");
    assert_eq!(family, "text");
}

#[tokio::test]
async fn migration_0010_embedded_track_unique_constraint() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    // First embedded track (provider_file_id NULL, embedded_track_id 3) lands.
    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, provider_file_id, embedded_track_id, \
         filename, format, format_family) \
         VALUES ('sub-emb-1', 'vid-x', NULL, 3, 'extracted.3.srt', 'srt', 'text')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Same (NULL, 3) again must collide — COALESCE maps both to '_embedded_3'.
    let dup = sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, provider_file_id, embedded_track_id, \
         filename, format, format_family) \
         VALUES ('sub-emb-2', 'vid-x', NULL, 3, 'extracted.3.srt', 'srt', 'text')",
    )
    .execute(&pool)
    .await;
    assert!(
        dup.is_err(),
        "duplicate (NULL provider_file_id, embedded_track_id=3) must reject"
    );

    // A different embedded index coexists.
    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, provider_file_id, embedded_track_id, \
         filename, format, format_family) \
         VALUES ('sub-emb-4', 'vid-x', NULL, 4, 'extracted.4.srt', 'srt', 'text')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Sidecar dedup still works via the provider_file_id path.
    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, provider_file_id, filename, format, \
         format_family) \
         VALUES ('sub-side', 'vid-x', 'file-side', 'movie.srt', 'srt', 'text')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let dup_side = sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, provider_file_id, filename, format, \
         format_family) \
         VALUES ('sub-side2', 'vid-x', 'file-side', 'movie.srt', 'srt', 'text')",
    )
    .execute(&pool)
    .await;
    assert!(dup_side.is_err(), "duplicate provider_file_id must reject");
}

// Runs the actual 0010 migration SQL against a pre-0010 `video_subtitles`
// table seeded with rows. Every other test runs 0010 against an empty table
// (0006 creates it empty), so the `INSERT INTO … SELECT FROM` data-copy
// branch is only exercised here. Uses `include_str!` so the test runs the
// real migration file — no duplicated SQL to drift.
#[tokio::test]
async fn migration_0010_preserves_existing_sidecar_rows() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();

    // Minimal parent-table stubs: migration 0010's `CREATE TABLE _new` has
    // `REFERENCES videos(id)` / `provider_connections(id)`, and sqlx enables
    // `foreign_keys` by default so those tables must exist at CREATE time.
    sqlx::query("CREATE TABLE provider_connections (id TEXT PRIMARY KEY NOT NULL)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE videos (id TEXT PRIMARY KEY NOT NULL)")
        .execute(&pool)
        .await
        .unwrap();
    // Parent rows referenced by the seeded subtitles (FKs are enforced).
    sqlx::query("INSERT INTO provider_connections (id) VALUES ('conn-a')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO videos (id) VALUES ('vid-a')")
        .execute(&pool)
        .await
        .unwrap();

    // Reconstruct the pre-0010 `video_subtitles` shape (migration 0006).
    sqlx::query(
        "CREATE TABLE video_subtitles ( \
         id TEXT PRIMARY KEY NOT NULL, \
         video_id TEXT NOT NULL, \
         connection_id TEXT NOT NULL, \
         provider_file_id TEXT NOT NULL, \
         language TEXT, \
         filename TEXT NOT NULL, \
         format TEXT NOT NULL CHECK (format IN ('srt', 'vtt')), \
         created_at TEXT NOT NULL DEFAULT (datetime('now')), \
         UNIQUE(video_id, provider_file_id))",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Seed two sidecar rows — one per legacy format.
    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, language, \
         filename, format, created_at) \
         VALUES ('sub-a', 'vid-a', 'conn-a', 'file-a', 'en', 'movie.en.srt', 'srt', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO video_subtitles (id, video_id, connection_id, provider_file_id, language, \
         filename, format, created_at) \
         VALUES ('sub-b', 'vid-a', 'conn-a', 'file-b', 'fr', 'movie.fr.vtt', 'vtt', '2026-01-02T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Apply the real 0010 migration SQL (rebuild + copy + rename).
    sqlx::raw_sql(include_str!("../migrations/0010_subtitle_formats.sql"))
        .execute(&pool)
        .await
        .unwrap();

    // Both rows survived; gained format_family='text', NULL routing columns.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM video_subtitles")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2, "both pre-existing sidecar rows must survive");

    let rows = sqlx::query(
        "SELECT id, language, filename, format, format_family, embedded_track_id, extracted_path, \
         created_at FROM video_subtitles ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    let a = &rows[0];
    assert_eq!(a.get::<String, _>("id"), "sub-a");
    assert_eq!(a.get::<String, _>("filename"), "movie.en.srt");
    assert_eq!(a.get::<String, _>("format"), "srt");
    assert_eq!(a.get::<String, _>("format_family"), "text");
    assert!(a.get::<Option<i64>, _>("embedded_track_id").is_none());
    assert!(a.get::<Option<String>, _>("extracted_path").is_none());
    assert_eq!(a.get::<String, _>("created_at"), "2026-01-01T00:00:00Z");

    let b = &rows[1];
    assert_eq!(b.get::<String, _>("id"), "sub-b");
    assert_eq!(b.get::<String, _>("format"), "vtt");
    assert_eq!(b.get::<String, _>("format_family"), "text");
    assert_eq!(b.get::<String, _>("language"), "fr");
}

// ---- Migration 0011: Files (M9 — file-aware library) ----

/// The `files.kind` CHECK accepts exactly the six non-video kinds and
/// rejects anything else — including 'video', which by construction only
/// ever belongs in `videos`.
#[tokio::test]
async fn migration_0011_files_kind_check() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    for kind in ["audio", "image", "subtitle", "document", "archive", "other"] {
        sqlx::query(
            "INSERT INTO files (id, connection_id, provider_file_id, name, kind) \
             VALUES (?, 'conn-x', ?, ?, ?)",
        )
        .bind(format!("file-{kind}"))
        .bind(format!("pid-{kind}"))
        .bind(format!("item.{kind}"))
        .bind(kind)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("kind = '{kind}' should be accepted: {e}"));
    }

    for bad in ["video", "unknown", "Audio"] {
        let res = sqlx::query(
            "INSERT INTO files (id, connection_id, provider_file_id, name, kind) \
             VALUES ('file-bad', 'conn-x', 'pid-bad', 'item.bad', ?)",
        )
        .bind(bad)
        .execute(&pool)
        .await;
        assert!(res.is_err(), "kind = '{bad}' must be rejected");
    }
}

/// `(connection_id, provider_file_id)` is the scan upsert identity — the
/// same provider file listed twice must not create two rows.
#[tokio::test]
async fn migration_0011_files_connection_file_unique() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    sqlx::query(
        "INSERT INTO files (id, connection_id, provider_file_id, name, kind) \
         VALUES ('f-a', 'conn-x', 'pid-1', 'song.mp3', 'audio')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let dup = sqlx::query(
        "INSERT INTO files (id, connection_id, provider_file_id, name, kind) \
         VALUES ('f-b', 'conn-x', 'pid-1', 'song.mp3', 'audio')",
    )
    .execute(&pool)
    .await;
    assert!(
        dup.is_err(),
        "duplicate connection_id+provider_file_id must reject"
    );
}

/// M9 FR-1.2: hard-deleting a connection cascades to its `files` rows,
/// mirroring the videos lifecycle. (Disconnect is a soft-delete — rows
/// stay but become invisible via active-connection filters, exactly like
/// videos; the cascade here is the eventual hard-delete path.)
#[tokio::test]
async fn migration_0011_files_cascade_on_connection_hard_delete() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    sqlx::query(
        "INSERT INTO files (id, connection_id, provider_file_id, name, kind) \
         VALUES ('f-a', 'conn-x', 'pid-1', 'song.mp3', 'audio')",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("DELETE FROM provider_connections WHERE id = 'conn-x'")
        .execute(&pool)
        .await
        .unwrap();

    let remaining: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM files WHERE connection_id = 'conn-x'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(remaining, 0, "files rows cascade away with the connection");
}

// ---- Migration 0014: Catalog prune (tombstone + grace counter) ----

/// 0014 adds tombstone columns to `videos`/`files` and pruned counters to
/// `scan_state`. Rows written without the new columns land on the defaults:
/// present (`missing_since IS NULL`, `missing_scan_count = 0`) and zero
/// prunes — a catalog upgraded in place must not look half-deleted.
#[tokio::test]
async fn migration_0014_prune_columns_default_on_existing_rows() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    sqlx::query(
        "INSERT INTO files (id, connection_id, provider_file_id, name, kind) \
         VALUES ('f-1', 'conn-x', 'pid-f1', 'doc.pdf', 'document')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO scan_state (connection_id, status, videos_found) \
         VALUES ('conn-x', 'idle', 3)",
    )
    .execute(&pool)
    .await
    .unwrap();

    let video =
        sqlx::query("SELECT missing_since, missing_scan_count FROM videos WHERE id = 'vid-x'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(video.get::<Option<String>, _>("missing_since").is_none());
    assert_eq!(video.get::<i64, _>("missing_scan_count"), 0);

    let file = sqlx::query("SELECT missing_since, missing_scan_count FROM files WHERE id = 'f-1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(file.get::<Option<String>, _>("missing_since").is_none());
    assert_eq!(file.get::<i64, _>("missing_scan_count"), 0);

    let scan = sqlx::query(
        "SELECT videos_pruned, files_pruned FROM scan_state WHERE connection_id = 'conn-x'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(scan.get::<i64, _>("videos_pruned"), 0);
    assert_eq!(scan.get::<i64, _>("files_pruned"), 0);
}

/// The scan_state prune counters persist non-zero values — the API surface
/// reads them after every completed scan.
#[tokio::test]
async fn migration_0014_scan_state_pruned_counts_round_trip() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    sqlx::query(
        "INSERT INTO scan_state (connection_id, status, videos_found, videos_pruned, files_pruned) \
         VALUES ('conn-x', 'idle', 5, 2, 1)",
    )
    .execute(&pool)
    .await
    .unwrap();

    let (videos_pruned, files_pruned): (i64, i64) = sqlx::query_as(
        "SELECT videos_pruned, files_pruned FROM scan_state WHERE connection_id = 'conn-x'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(videos_pruned, 2);
    assert_eq!(files_pruned, 1);
}

// ---- Migration 0015: Library collections ----
// ---- Migration 0016: Suggestion staging tables dropped (purge-collection-suggestions) ----

/// The persistent collections tables accept their intended shapes:
/// collections (all four kinds incl. `manual`) and membership.
#[tokio::test]
async fn migration_0015_collections_tables_accept_rows() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    for (i, kind) in ["show", "movie", "time", "manual"].iter().enumerate() {
        sqlx::query(
            "INSERT INTO collections (id, name, kind, created_at) \
             VALUES (?, ?, ?, '2026-09-19T00:00:00Z')",
        )
        .bind(format!("col-{kind}"))
        .bind(format!("Collection {i}"))
        .bind(kind)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("kind = '{kind}' should be accepted: {e}"));
    }

    sqlx::query(
        "INSERT INTO collection_items (collection_id, video_id, position) \
         VALUES ('col-show', 'vid-x', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
}

/// `collections.kind` accepts exactly the four designed kinds.
#[tokio::test]
async fn migration_0015_kind_check_rejects_unknown_kind() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    let bad_collection = sqlx::query(
        "INSERT INTO collections (id, name, kind, created_at) \
         VALUES ('col-bad', 'X', 'playlist', '2026-09-19T00:00:00Z')",
    )
    .execute(&pool)
    .await;
    assert!(
        bad_collection.is_err(),
        "kind = 'playlist' must be rejected"
    );
}

/// Membership is a set relation: the same video twice in one collection
/// must reject (spec F3).
#[tokio::test]
async fn migration_0015_duplicate_collection_item_rejected() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    sqlx::query(
        "INSERT INTO collections (id, name, kind, created_at) \
         VALUES ('col-1', 'My List', 'manual', '2026-09-19T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO collection_items (collection_id, video_id, position) \
         VALUES ('col-1', 'vid-x', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();

    let dup = sqlx::query(
        "INSERT INTO collection_items (collection_id, video_id, position) \
         VALUES ('col-1', 'vid-x', 1)",
    )
    .execute(&pool)
    .await;
    assert!(dup.is_err(), "duplicate collection membership must reject");
}

/// Durability mirror of the share_items pattern: deleting a video or a
/// collection cascades membership away rather than orphaning rows.
#[tokio::test]
async fn migration_0015_cascades_remove_membership() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    sqlx::query(
        "INSERT INTO collections (id, name, kind, created_at) \
         VALUES ('col-1', 'My List', 'manual', '2026-09-19T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO collection_items (collection_id, video_id, position) \
         VALUES ('col-1', 'vid-x', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Video delete clears membership.
    sqlx::query("DELETE FROM videos WHERE id = 'vid-x'")
        .execute(&pool)
        .await
        .unwrap();
    let items: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collection_items")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(items, 0, "membership should cascade with the video");

    // Collection delete clears membership (fresh membership row).
    sqlx::query(
        "INSERT INTO videos (id, connection_id, provider, provider_file_id, name, size_bytes, \
         scanned_at, created_at) \
         VALUES ('vid-2', 'conn-x', 'google_drive', 'file-2', 'b.mp4', 100, \
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO collection_items (collection_id, video_id, position) \
         VALUES ('col-1', 'vid-2', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM collections WHERE id = 'col-1'")
        .execute(&pool)
        .await
        .unwrap();
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collection_items")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 0,
        "membership should cascade with the collection"
    );
}

/// The purge: after migrating through 0016 the three suggestion staging
/// tables are gone, while a pre-purge accepted collection (legacy kind
/// `show`) and its membership still read back — the survival guarantee
/// for user-created state (effort purge-collection-suggestions).
#[tokio::test]
async fn migration_0016_drops_staging_tables_and_keeps_accepted_collections() {
    let (_guard, path) = fresh_db().await;
    let pool = connect(&path).await.unwrap();
    run_migrations(&pool).await.unwrap();
    seed_owner_connection_video(&pool).await;

    for table in [
        "collection_suggestions",
        "collection_suggestion_items",
        "collection_suggestion_dismissals",
    ] {
        let probe = sqlx::query(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&pool)
            .await;
        assert!(probe.is_err(), "table {table} should not exist post-0016");
    }

    // Pre-purge accepted collections (kind show/movie/time) survive with
    // full membership.
    sqlx::query(
        "INSERT INTO collections (id, name, kind, created_at) \
         VALUES ('col-legacy', 'Breaking Bad', 'show', '2026-09-19T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO collection_items (collection_id, video_id, position) \
         VALUES ('col-legacy', 'vid-x', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();

    let (name, kind): (String, String) =
        sqlx::query_as("SELECT name, kind FROM collections WHERE id = 'col-legacy'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(name, "Breaking Bad");
    assert_eq!(kind, "show");

    let members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collection_items WHERE collection_id = 'col-legacy'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(members, 1, "accepted collection membership reads back");
}
