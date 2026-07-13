//! bench-seed: populate a 10K-video catalog, then verify query plans + FTS5 health.
//!
//! Connects directly to the SQLite database at `$CASTIFY_DATA_DIR/castify.db`
//! (same convention as the API), wipes existing catalog data, and inserts a
//! deterministic 10,000-video dataset across 3 providers (with dedup groups,
//! favorites, ratings, and cached thumbnails). Then runs:
//!
//!   * EXPLAIN QUERY PLAN on the four core query shapes (no-filter page, FTS5
//!     search, composed filters, folder enumeration) — flags full-table scans.
//!   * FTS5 bloat check — re-UPDATEs all rows (firing the AFTER UPDATE trigger)
//!     and asserts the FTS5 row count stays stable.
//!
//! Usage:
//!   CASTIFY_DATA_DIR=/tmp/castify-bench cargo run -p castify-bench --bin seed

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, TimeZone, Utc};
use sqlx::{Row, SqlitePool};

// ── Dataset constants ───────────────────────────────────────────────

const TOTAL_VIDEOS: usize = 10_000;
const DEDUP_GROUPS: usize = 200;

const FAVORITE_COUNT: usize = 500;
const RATING_COUNT: usize = 300;
const CACHED_THUMB_COUNT: usize = 200;

const CONN_GD: &str = "bench-conn-google-drive";
const CONN_DB: &str = "bench-conn-dropbox";
const CONN_OD: &str = "bench-conn-onedrive";

const WORDS: &[&str] = &[
    "concert",
    "vacation",
    "family",
    "drone",
    "wedding",
    "birthday",
    "travel",
    "hiking",
    "sunset",
    "beach",
    "city",
    "nature",
    "sport",
    "cooking",
    "tutorial",
    "review",
    "gameplay",
    "interview",
    "podcast",
    "music",
];

const FOLDER_WEIGHTS: &[(u32, &str)] = &[
    (40, "Movies"),
    (25, "Photos"),
    (20, "Clips"),
    (10, "Music"),
    (5, "Docs"),
];

const RESOLUTIONS: &[(i64, i64)] = &[
    (640, 480),
    (1280, 720),
    (1920, 1080),
    (2560, 1440),
    (3840, 2160),
];

fn folder_for(i: usize) -> &'static str {
    let m = (i % 100) as u32;
    let mut acc = 0u32;
    for &(weight, name) in FOLDER_WEIGHTS {
        acc += weight;
        if m < acc {
            return name;
        }
    }
    "Movies"
}

fn size_for(i: usize) -> i64 {
    1_000_000 + ((i as i64).wrapping_mul(33_377) % 4_999_000_000)
}

fn duration_ms_for(i: usize) -> i64 {
    30_000 + ((i as i64).wrapping_mul(7) % 7_170_000)
}

fn resolution_for(i: usize) -> (i64, i64) {
    RESOLUTIONS[i % RESOLUTIONS.len()]
}

fn iso_ts(base: &DateTime<Utc>, i: usize) -> String {
    (*base + chrono::Duration::seconds(i as i64))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

struct BenchVideo {
    id: String,
    connection_id: &'static str,
    provider: &'static str,
    provider_file_id: String,
    name: String,
    path: String,
    size_bytes: i64,
    duration_ms: i64,
    width: i64,
    height: i64,
    native_hash: Option<String>,
    dedup_group: Option<String>,
    created_at: String,
}

impl BenchVideo {
    #[allow(clippy::too_many_arguments)]
    fn build(
        i: usize,
        connection_id: &'static str,
        provider: &'static str,
        name: String,
        path: String,
        size: i64,
        duration: i64,
        width: i64,
        height: i64,
        native_hash: Option<String>,
        dedup_group: Option<String>,
        base: &DateTime<Utc>,
    ) -> Self {
        Self {
            id: format!("bench-vid-{i:05}"),
            connection_id,
            provider,
            provider_file_id: format!("bench-file-{i:05}"),
            name,
            path,
            size_bytes: size,
            duration_ms: duration,
            width,
            height,
            native_hash,
            dedup_group,
            created_at: iso_ts(base, i),
        }
    }
}

fn generate_videos(base: &DateTime<Utc>) -> Vec<BenchVideo> {
    let mut videos = Vec::with_capacity(TOTAL_VIDEOS);
    let mut idx = 0usize;

    for g in 0..DEDUP_GROUPS {
        let word = WORDS[g % WORDS.len()];
        let name = format!("{word}-shared-{g:03}.mp4");
        let attr_idx = DEDUP_GROUPS * 2 + g;
        let folder = folder_for(attr_idx);
        let path = format!("/{folder}/{name}");
        let size = size_for(attr_idx);
        let duration = duration_ms_for(attr_idx);
        let (w, h) = resolution_for(attr_idx);
        let dedup = format!("bench-dedup-{g:03}");

        videos.push(BenchVideo::build(
            idx,
            CONN_GD,
            "google_drive",
            name.clone(),
            path.clone(),
            size,
            duration,
            w,
            h,
            None,
            Some(dedup.clone()),
            base,
        ));
        idx += 1;
        videos.push(BenchVideo::build(
            idx,
            CONN_DB,
            "dropbox",
            name,
            path,
            size,
            duration,
            w,
            h,
            None,
            Some(dedup),
            base,
        ));
        idx += 1;
    }

    let ungrouped: &[(&'static str, &'static str, usize)] = &[
        (CONN_GD, "google_drive", 3_300),
        (CONN_DB, "dropbox", 3_300),
        (CONN_OD, "onedrive", 3_000),
    ];
    for &(conn, provider, count) in ungrouped {
        for _ in 0..count {
            let word = WORDS[idx % WORDS.len()];
            let name = format!("{word}-{idx:05}.mp4");
            let folder = folder_for(idx);
            let path = format!("/{folder}/{name}");
            let (w, h) = resolution_for(idx);
            let hash = format!("native-hash-{idx:05}");
            videos.push(BenchVideo::build(
                idx,
                conn,
                provider,
                name,
                path,
                size_for(idx),
                duration_ms_for(idx),
                w,
                h,
                Some(hash),
                None,
                base,
            ));
            idx += 1;
        }
    }

    assert_eq!(
        idx, TOTAL_VIDEOS,
        "generation must produce exactly TOTAL_VIDEOS"
    );
    assert_eq!(videos.len(), TOTAL_VIDEOS);
    videos
}

// ── Main ────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("warn"))
        .with_target(false)
        .init();

    let data_dir =
        PathBuf::from(std::env::var("CASTIFY_DATA_DIR").unwrap_or_else(|_| "./data".to_string()));
    let db_path = data_dir.join("castify.db");

    println!("== bench-seed: {} videos ==", TOTAL_VIDEOS);
    println!("  data dir : {}", data_dir.display());
    println!("  db       : {}", db_path.display());

    let pool = castify_storage::connect(&db_path)
        .await
        .context("failed to connect to database")?;
    castify_storage::run_migrations(&pool)
        .await
        .context("failed to run migrations")?;

    let owner_id = ensure_owner(&pool).await?;

    let started = std::time::Instant::now();
    wipe_catalog(&pool).await?;
    seed_connections(&pool).await?;

    let base = Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap();
    let videos = generate_videos(&base);
    seed_videos(&pool, &videos).await?;

    let gd = videos
        .iter()
        .filter(|v| v.provider == "google_drive")
        .count();
    let db = videos.iter().filter(|v| v.provider == "dropbox").count();
    let od = videos.iter().filter(|v| v.provider == "onedrive").count();
    let unique = videos.iter().filter(|v| v.dedup_group.is_none()).count() + DEDUP_GROUPS;

    seed_favorites(&pool, &owner_id).await?;
    seed_ratings(&pool, &owner_id).await?;
    cache_thumbnails(&pool, &data_dir).await?;

    println!(
        "  inserted : {} videos ({gd} google_drive, {db} dropbox, {od} onedrive)",
        TOTAL_VIDEOS
    );
    println!(
        "  dedup    : {DEDUP_GROUPS} groups ({} videos -> {DEDUP_GROUPS} unique)",
        DEDUP_GROUPS * 2
    );
    println!("  unique   : {unique}");
    println!("  favorites: {FAVORITE_COUNT}");
    println!("  ratings  : {RATING_COUNT}");
    println!("  thumbnails (cached): {CACHED_THUMB_COUNT}");
    println!("  seeding done in {:.2}s", started.elapsed().as_secs_f64());

    println!();
    explain_checks(&pool, &owner_id).await?;
    println!();
    fts5_bloat_check(&pool).await?;

    println!();
    println!("== bench-seed: complete ==");

    Ok(())
}

async fn ensure_owner(pool: &SqlitePool) -> Result<String> {
    if let Some(row) = sqlx::query("SELECT id FROM owners ORDER BY created_at LIMIT 1")
        .fetch_optional(pool)
        .await?
    {
        return Ok(row.get::<String, _>("id"));
    }
    let id = uuid_str();
    let now = iso_now();
    sqlx::query("INSERT INTO owners (id, created_at, display_name) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(&now)
        .bind("Bench Owner")
        .execute(pool)
        .await?;
    println!("  (created placeholder owner {id} — run POST /api/setup first for a real session)");
    Ok(id)
}

async fn wipe_catalog(pool: &SqlitePool) -> Result<()> {
    sqlx::query("DELETE FROM videos").execute(pool).await?;
    sqlx::query("DELETE FROM provider_connections")
        .execute(pool)
        .await?;
    sqlx::query("INSERT INTO videos_fts(videos_fts) VALUES('rebuild')")
        .execute(pool)
        .await?;
    Ok(())
}

async fn seed_connections(pool: &SqlitePool) -> Result<()> {
    let now = iso_now();
    let conns: &[(&str, &str, usize)] = &[
        (CONN_GD, "google_drive", 3_500),
        (CONN_DB, "dropbox", 3_500),
        (CONN_OD, "onedrive", 3_000),
    ];
    let dummy_token: &[u8] = &[0x00];
    for &(id, provider, found) in conns {
        sqlx::query(
            "INSERT INTO provider_connections \
             (id, provider, token_bundle, provider_account_id, provider_account_email, connected_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(provider)
        .bind(dummy_token)
        .bind(format!("bench-account-{provider}"))
        .bind("bench@castify.local")
        .bind(&now)
        .execute(pool)
        .await?;

        sqlx::query(
            "INSERT INTO scan_state (connection_id, status, completed_at, videos_found) \
             VALUES (?, 'idle', ?, ?)",
        )
        .bind(id)
        .bind(&now)
        .bind(found as i64)
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn seed_videos(pool: &SqlitePool, videos: &[BenchVideo]) -> Result<()> {
    let scanned = iso_now();
    let mut tx = pool.begin().await?;

    for v in videos {
        sqlx::query(
            "INSERT INTO videos \
             (id, connection_id, provider, provider_file_id, name, path, size_bytes, \
              mime_type, duration_ms, width, height, native_hash, native_hash_algo, \
              castify_hash, dedup_group, provider_modified_at, scanned_at, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)",
        )
        .bind(&v.id)
        .bind(v.connection_id)
        .bind(v.provider)
        .bind(&v.provider_file_id)
        .bind(&v.name)
        .bind(&v.path)
        .bind(v.size_bytes)
        .bind("video/mp4")
        .bind(v.duration_ms)
        .bind(v.width)
        .bind(v.height)
        .bind(&v.native_hash)
        .bind(if v.native_hash.is_some() {
            Some("sha256")
        } else {
            None::<&str>
        })
        .bind(&v.dedup_group)
        .bind(&scanned)
        .bind(&v.created_at)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

async fn seed_favorites(pool: &SqlitePool, owner_id: &str) -> Result<()> {
    let now = iso_now();
    let mut tx = pool.begin().await?;
    for i in 0..FAVORITE_COUNT {
        let vid = format!("bench-vid-{:05}", i * (TOTAL_VIDEOS / FAVORITE_COUNT));
        sqlx::query(
            "INSERT OR IGNORE INTO video_favorites (owner_id, video_id, created_at) VALUES (?, ?, ?)",
        )
        .bind(owner_id)
        .bind(&vid)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn seed_ratings(pool: &SqlitePool, owner_id: &str) -> Result<()> {
    let now = iso_now();
    let mut tx = pool.begin().await?;
    for i in 0..RATING_COUNT {
        let vid = format!("bench-vid-{:05}", i * (TOTAL_VIDEOS / RATING_COUNT));
        let rating = ((i % 5) as i32) + 1;
        sqlx::query(
            "INSERT OR IGNORE INTO video_ratings (owner_id, video_id, rating, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(owner_id)
        .bind(&vid)
        .bind(rating)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn cache_thumbnails(pool: &SqlitePool, data_dir: &std::path::Path) -> Result<()> {
    let thumb_dir = data_dir.join("thumbnails");
    std::fs::create_dir_all(&thumb_dir)
        .with_context(|| format!("failed to create {}", thumb_dir.display()))?;

    let mut bytes = vec![0u8; 30_000];
    bytes[0] = 0xFF;
    bytes[1] = 0xD8;
    bytes[2] = 0xFF;

    let start = TOTAL_VIDEOS - CACHED_THUMB_COUNT;
    for i in start..TOTAL_VIDEOS {
        let vid = format!("bench-vid-{i:05}");
        std::fs::write(thumb_dir.join(&vid), &bytes)?;
        sqlx::query("UPDATE videos SET thumbnail_status = 'cached' WHERE id = ?")
            .bind(&vid)
            .execute(pool)
            .await?;
    }
    Ok(())
}

// ── EXPLAIN QUERY PLAN checks ───────────────────────────────────────

async fn explain_checks(pool: &SqlitePool, owner_id: &str) -> Result<()> {
    println!("== EXPLAIN QUERY PLAN ==");

    let checks: &[(&str, &str)] = &[
        (
            "1. no-filter page query (representative + LEFT JOIN enrichment + ORDER BY + LIMIT)",
            "EXPLAIN QUERY PLAN \
             SELECT v.id, (vf.video_id IS NOT NULL) AS is_favorite, vr.rating AS my_rating \
             FROM videos v \
             LEFT JOIN video_favorites vf ON vf.video_id = v.id AND vf.owner_id = '__OWNER__' \
             LEFT JOIN video_ratings vr ON vr.video_id = v.id AND vr.owner_id = '__OWNER__' \
             WHERE v.id IN ( \
               SELECT MIN(id) FROM videos WHERE dedup_group IS NOT NULL GROUP BY dedup_group \
               UNION ALL SELECT id FROM videos WHERE dedup_group IS NULL \
             ) ORDER BY v.created_at DESC LIMIT 50 OFFSET 0",
        ),
        (
            "2. FTS5 search subquery (MATCH)",
            "EXPLAIN QUERY PLAN \
             SELECT MIN(id) FROM videos \
             WHERE dedup_group IS NOT NULL \
               AND rowid IN (SELECT rowid FROM videos_fts WHERE videos_fts MATCH '\"concert\"') \
             GROUP BY dedup_group",
        ),
        (
            "3. composed filters (provider + height + duration)",
            "EXPLAIN QUERY PLAN \
             SELECT MIN(id) FROM videos \
             WHERE dedup_group IS NOT NULL \
               AND provider = 'google_drive' AND height >= 720 AND duration_ms >= 300000 \
             GROUP BY dedup_group",
        ),
        (
            "4. folder enumeration",
            "EXPLAIN QUERY PLAN \
             SELECT folder, COUNT(*) FROM ( \
               SELECT CASE WHEN path IS NULL THEN '(Unsorted)' \
                    WHEN substr(path,2) LIKE '%/%' \
                    THEN substr(path, 2, instr(substr(path, 2), '/') - 1) \
                    ELSE '(Root)' END AS folder \
               FROM videos WHERE id IN ( \
                 SELECT MIN(id) FROM videos WHERE dedup_group IS NOT NULL GROUP BY dedup_group \
                 UNION ALL SELECT id FROM videos WHERE dedup_group IS NULL \
               ) \
             ) GROUP BY folder ORDER BY COUNT(*) DESC",
        ),
    ];

    let mut any_concern = false;
    for &(label, sql_tmpl) in checks {
        let sql = sql_tmpl.replace("__OWNER__", owner_id);
        let rows = sqlx::query(&sql).fetch_all(pool).await?;
        let details: Vec<String> = rows
            .iter()
            .map(|r| r.try_get::<String, _>("detail").unwrap_or_default())
            .collect();

        println!("  {label}");
        for d in &details {
            let flag = if is_full_scan(d) {
                "  <-- FULL TABLE SCAN"
            } else {
                ""
            };
            println!("      {d}{flag}");
        }

        for d in &details {
            if is_full_scan(d) {
                any_concern = true;
            }
        }
        println!();
    }

    let fts_uses_index = explain_uses_fts_index(pool).await?;
    if fts_uses_index {
        println!("  [PASS] FTS5 MATCH uses the FTS index (not a table scan)");
    } else {
        println!("  [FAIL] FTS5 MATCH does NOT use the FTS index");
        any_concern = true;
    }

    if any_concern {
        println!("  [WARN] full-table scans detected (see above); verify HTTP p99 meets targets");
    } else {
        println!("  [PASS] no full-table scans detected");
    }

    Ok(())
}

/// Detect a genuine full-table scan in an EXPLAIN QUERY PLAN detail line.
///
/// SQLite's EXPLAIN uses `SCAN table` for sequential access, but several
/// indexed variants are fast and should NOT be flagged:
///   - `SCAN table USING INDEX ...` (index scan)
///   - `SCAN table USING COVERING INDEX ...` (covering index scan)
///   - `SCAN table VIRTUAL TABLE INDEX N:Mk` (FTS5 MATCH index access —
///     FTS5 reports index usage as "VIRTUAL TABLE INDEX", not "SEARCH")
fn is_full_scan(detail: &str) -> bool {
    detail.starts_with("SCAN ")
        && !detail.contains("USING INDEX")
        && !detail.contains("COVERING INDEX")
        && !detail.contains("VIRTUAL TABLE INDEX")
}

async fn explain_uses_fts_index(pool: &SqlitePool) -> Result<bool> {
    let rows = sqlx::query(
        "EXPLAIN QUERY PLAN \
         SELECT rowid FROM videos_fts WHERE videos_fts MATCH '\"concert\"'",
    )
    .fetch_all(pool)
    .await?;

    let details: Vec<String> = rows
        .iter()
        .map(|r| r.try_get::<String, _>("detail").unwrap_or_default())
        .collect();

    // FTS5 MATCH shows as `SCAN videos_fts VIRTUAL TABLE INDEX 0:Mk` — the
    // `VIRTUAL TABLE INDEX` token confirms the FTS5 index is being used.
    Ok(details
        .iter()
        .any(|d| d.contains("videos_fts") && d.contains("VIRTUAL TABLE INDEX")))
}

// ── FTS5 bloat check ────────────────────────────────────────────────

async fn fts5_bloat_check(pool: &SqlitePool) -> Result<()> {
    println!("== FTS5 bloat check ==");

    let vid_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM videos")
        .fetch_one(pool)
        .await?;
    let fts_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM videos_fts")
        .fetch_one(pool)
        .await?;

    let rescanned = iso_now();
    let affected = sqlx::query("UPDATE videos SET scanned_at = ?")
        .bind(&rescanned)
        .execute(pool)
        .await?
        .rows_affected();

    let fts_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM videos_fts")
        .fetch_one(pool)
        .await?;

    println!("  videos rows       : {vid_count}");
    println!("  fts rows (before) : {fts_before}");
    println!("  re-UPDATE rows    : {affected} (fires videos_fts_au delete+insert trigger)");
    println!("  fts rows (after)  : {fts_after}");

    if fts_after == vid_count && fts_after == fts_before {
        println!("  [PASS] FTS5 count stable ({fts_after} == {vid_count}) — no bloat from re-scan");
    } else {
        println!(
            "  [FAIL] FTS5 count changed: before={fts_before} after={fts_after} videos={vid_count}"
        );
        bail!("FTS5 index bloat detected after re-scan simulation");
    }

    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

fn iso_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn uuid_str() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("bench-owner-{nanos:x}")
}
