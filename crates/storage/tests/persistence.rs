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
