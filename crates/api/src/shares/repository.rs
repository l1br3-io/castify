//! `ShareRepository` — all SQL for shares and share items.
//!
//! Mirrors `castify_auth::AuthRepository`: stateless struct over the pool,
//! runtime `sqlx::query` (no compile-time DB), tests beside the code on a
//! real temp-file SQLite. Writes happen only on owner actions (create,
//! revoke) — recipient reads never write.

use chrono::Utc;
use sqlx::SqlitePool;
use std::collections::HashSet;
use uuid::Uuid;

use crate::shares::ShareResult;

/// Input to `ShareRepository::create_share`. `token_hash` is already the
/// SHA-256 of the raw token — the raw token never enters this module's
/// write path, so it cannot be persisted or logged by construction.
pub struct NewShare<'a> {
    pub owner_id: &'a Uuid,
    pub token_hash: &'a [u8],
    /// argon2id PHC string, or `None` for an open share.
    pub password_hash: Option<&'a str>,
    pub title: &'a str,
    /// RFC3339, or `None` for never-expires.
    pub expires_at: Option<&'a str>,
    /// Curation order is the insertion order of this slice.
    pub video_ids: &'a [String],
}

#[derive(Clone, Debug)]
pub struct ShareRow {
    pub id: String,
    pub owner_id: String,
    pub token_hash: Vec<u8>,
    pub password_hash: Option<String>,
    pub title: String,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct ShareItemRow {
    pub share_id: String,
    pub video_id: String,
    pub position: i64,
}

#[derive(Clone)]
pub struct ShareRepository {
    pool: SqlitePool,
}

impl ShareRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Insert a share and its items atomically (share + items in one
    /// transaction — a share with zero items must never be visible).
    /// Returns the stored row, raw token excluded by input design.
    pub async fn create_share(&self, new: &NewShare<'_>) -> ShareResult<ShareRow> {
        let id = Uuid::new_v4().to_string();
        let created_at = iso_now();

        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO shares (id, owner_id, token_hash, password_hash, title, expires_at, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(new.owner_id.to_string())
        .bind(new.token_hash)
        .bind(new.password_hash)
        .bind(new.title)
        .bind(new.expires_at)
        .bind(&created_at)
        .execute(&mut *tx)
        .await?;
        for (position, video_id) in new.video_ids.iter().enumerate() {
            sqlx::query("INSERT INTO share_items (share_id, video_id, position) VALUES (?, ?, ?)")
                .bind(&id)
                .bind(video_id)
                .bind(position as i64)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;

        Ok(ShareRow {
            id,
            owner_id: new.owner_id.to_string(),
            token_hash: new.token_hash.to_vec(),
            password_hash: new.password_hash.map(str::to_string),
            title: new.title.to_string(),
            expires_at: new.expires_at.map(str::to_string),
            revoked_at: None,
            created_at,
        })
    }

    /// Look up a share by token hash — the recipient entry point. Returns
    /// the row regardless of expiry/revocation; the status machine
    /// (404/401/410) is the route layer's call, informed by these fields.
    pub async fn fetch_by_token_hash(&self, token_hash: &[u8]) -> ShareResult<Option<ShareRow>> {
        let row = sqlx::query(
            "SELECT id, owner_id, token_hash, password_hash, title, expires_at, revoked_at, created_at \
             FROM shares WHERE token_hash = ?",
        )
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|r| row_to_share(&r)).transpose()
    }

    /// All shares owned by `owner_id`, newest first (management list).
    /// `rowid DESC` tiebreaks same-second creations in insertion order —
    /// the ids are random UUIDs, so tiebreaking on `id` would scramble
    /// shares made in quick succession.
    pub async fn list_by_owner(&self, owner_id: &str) -> ShareResult<Vec<ShareRow>> {
        let rows = sqlx::query(
            "SELECT id, owner_id, token_hash, password_hash, title, expires_at, revoked_at, created_at \
             FROM shares WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC",
        )
        .bind(owner_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(row_to_share).collect()
    }

    /// Owner-scoped lookup — the row the owner routes need to inspect
    /// (terminal state, expiry) before acting. Foreign and unknown ids
    /// are both `None`, so this never leaks whether a share exists.
    pub async fn fetch_owned(
        &self,
        owner_id: &str,
        share_id: &str,
    ) -> ShareResult<Option<ShareRow>> {
        let row = sqlx::query(
            "SELECT id, owner_id, token_hash, password_hash, title, expires_at, revoked_at, created_at \
             FROM shares WHERE id = ? AND owner_id = ?",
        )
        .bind(share_id)
        .bind(owner_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|r| row_to_share(&r)).transpose()
    }

    /// Set `revoked_at` (terminal). Returns rows affected — 0 means the
    /// share doesn't exist or was already revoked (idempotent for callers).
    pub async fn revoke(&self, share_id: &str) -> ShareResult<u64> {
        let result =
            sqlx::query("UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
                .bind(iso_now())
                .bind(share_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected())
    }

    /// Owner-scoped revoke (the route-layer variant). Same terminal update
    /// as [`ShareRepository::revoke`], but a share owned by someone else
    /// counts as not-found — the migration's `owner_id` column exists to
    /// keep listing *and revocation* scoped to the creating owner. Callers
    /// treat 0 rows as success (idempotent 204), so this never leaks
    /// whether a foreign share id exists.
    pub async fn revoke_owned(&self, owner_id: &str, share_id: &str) -> ShareResult<u64> {
        let result = sqlx::query(
            "UPDATE shares SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL",
        )
        .bind(iso_now())
        .bind(share_id)
        .bind(owner_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Owner-scoped hard delete — the purge behind
    /// `DELETE /api/shares/{id}?purge=true`. Removes the `shares` row;
    /// migration 0012's `ON DELETE CASCADE` takes the `share_items` rows
    /// with it, so one statement is the whole transaction. Works on any
    /// past state (revoked, expired) — a cleanup that only accepted live
    /// shares would keep listing the dead rows it was asked to remove.
    ///
    /// Returns rows affected — 0 means not found or not owned, which
    /// callers treat as success (idempotent 204), so a foreign share id
    /// stays indistinguishable from an unknown one (same no-leak shape as
    /// [`ShareRepository::revoke_owned`]).
    pub async fn purge_owned(&self, owner_id: &str, share_id: &str) -> ShareResult<u64> {
        let result = sqlx::query("DELETE FROM shares WHERE id = ? AND owner_id = ?")
            .bind(share_id)
            .bind(owner_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected())
    }

    /// Owner-scoped full-list swap. One transaction: guard on exists +
    /// owned + not revoked, delete every `share_items` row for the
    /// share, re-insert the caller's list with fresh `0..N` positions
    /// (the old positions die with the old rows — no stale gaps). A
    /// bogus video id trips the FK and rolls the whole swap back, so
    /// the old list survives intact (same atomicity shape as
    /// [`ShareRepository::create_share`]).
    ///
    /// Returns the item rows written (deleted + inserted). `Ok(0)` means
    /// the guard rejected the write — not found, not owned, or revoked
    /// (all three collapse here; routes call
    /// [`ShareRepository::fetch_owned`] first to map 404 vs 410).
    pub async fn replace_items(
        &self,
        owner_id: &str,
        share_id: &str,
        video_ids: &[String],
    ) -> ShareResult<u64> {
        let mut tx = self.pool.begin().await?;
        let live: Option<String> = sqlx::query_scalar(
            "SELECT id FROM shares WHERE id = ? AND owner_id = ? AND revoked_at IS NULL",
        )
        .bind(share_id)
        .bind(owner_id)
        .fetch_optional(&mut *tx)
        .await?;
        if live.is_none() {
            // Dropping the tx rolls back — nothing was written.
            return Ok(0);
        }
        let deleted = sqlx::query("DELETE FROM share_items WHERE share_id = ?")
            .bind(share_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        for (position, video_id) in video_ids.iter().enumerate() {
            sqlx::query("INSERT INTO share_items (share_id, video_id, position) VALUES (?, ?, ?)")
                .bind(share_id)
                .bind(video_id)
                .bind(position as i64)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;

        Ok(deleted + video_ids.len() as u64)
    }

    /// Owner-scoped append. One transaction: guard on exists + owned +
    /// not revoked, load the existing member ids, dedupe the request
    /// (both in-request and against current members), and insert the
    /// remainder at `MAX(position)+1..` in request order — existing
    /// members keep both their membership and their positions. A bogus
    /// video id trips the FK and rolls the whole append back, so the
    /// list survives intact (same atomicity shape as
    /// [`ShareRepository::replace_items`]).
    ///
    /// Returns the item rows inserted. `Ok(0)` means either the guard
    /// rejected the write (not found, not owned, or revoked — routes
    /// call [`ShareRepository::fetch_owned`] first to map 404 vs 409) or
    /// every requested id was already a member (an idempotent no-op, a
    /// success at the route layer).
    pub async fn append_items(
        &self,
        owner_id: &str,
        share_id: &str,
        video_ids: &[String],
    ) -> ShareResult<u64> {
        let mut tx = self.pool.begin().await?;
        let live: Option<String> = sqlx::query_scalar(
            "SELECT id FROM shares WHERE id = ? AND owner_id = ? AND revoked_at IS NULL",
        )
        .bind(share_id)
        .bind(owner_id)
        .fetch_optional(&mut *tx)
        .await?;
        if live.is_none() {
            // Dropping the tx rolls back — nothing was written.
            return Ok(0);
        }
        let members: Vec<String> =
            sqlx::query_scalar("SELECT video_id FROM share_items WHERE share_id = ?")
                .bind(share_id)
                .fetch_all(&mut *tx)
                .await?;
        let mut seen: HashSet<&str> = members.iter().map(String::as_str).collect();
        let mut position: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM share_items WHERE share_id = ?",
        )
        .bind(share_id)
        .fetch_one(&mut *tx)
        .await?;
        let mut written = 0u64;
        for video_id in video_ids {
            if !seen.insert(video_id) {
                continue; // in-request or membership duplicate — skip
            }
            sqlx::query("INSERT INTO share_items (share_id, video_id, position) VALUES (?, ?, ?)")
                .bind(share_id)
                .bind(video_id)
                .bind(position)
                .execute(&mut *tx)
                .await?;
            position += 1;
            written += 1;
        }
        tx.commit().await?;

        Ok(written)
    }

    /// Membership guard — every mirror route's authorization check
    /// reduces to this plus share liveness.
    pub async fn is_member(&self, share_id: &str, video_id: &str) -> ShareResult<bool> {
        let found: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM share_items WHERE share_id = ? AND video_id = ?")
                .bind(share_id)
                .bind(video_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(found.is_some())
    }

    /// A share's items in curation order (`position`).
    pub async fn list_items(&self, share_id: &str) -> ShareResult<Vec<ShareItemRow>> {
        let rows = sqlx::query(
            "SELECT share_id, video_id, position FROM share_items WHERE share_id = ? ORDER BY position",
        )
        .bind(share_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|r| ShareItemRow {
                share_id: sqlx::Row::get(r, "share_id"),
                video_id: sqlx::Row::get(r, "video_id"),
                position: sqlx::Row::get(r, "position"),
            })
            .collect())
    }
}

fn row_to_share(row: &sqlx::sqlite::SqliteRow) -> ShareResult<ShareRow> {
    Ok(ShareRow {
        id: sqlx::Row::get(row, "id"),
        owner_id: sqlx::Row::get(row, "owner_id"),
        token_hash: sqlx::Row::get(row, "token_hash"),
        password_hash: sqlx::Row::get(row, "password_hash"),
        title: sqlx::Row::get(row, "title"),
        expires_at: sqlx::Row::get(row, "expires_at"),
        revoked_at: sqlx::Row::get(row, "revoked_at"),
        created_at: sqlx::Row::get(row, "created_at"),
    })
}

/// ISO-8601 UTC without sub-second noise, matching `castify_auth`'s
/// timestamp convention (`session::iso_now`).
fn iso_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shares::token::{generate_share_token, hash_share_token};

    /// `(pool, guard)` — same shape as `castify_auth` repository tests:
    /// guard keeps the temp SQLite file alive for the test's lifetime.
    async fn fresh_pool() -> (SqlitePool, tempfile::TempPath) {
        let guard = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        let pool = castify_storage::connect(guard.to_path_buf()).await.unwrap();
        castify_storage::run_migrations(&pool).await.unwrap();
        (pool, guard)
    }

    async fn seed_owner(pool: &SqlitePool) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO owners (id, created_at, display_name) VALUES (?, ?, NULL)")
            .bind(id.to_string())
            .bind("2026-01-01T00:00:00Z")
            .execute(pool)
            .await
            .unwrap();
        id
    }

    /// Minimal catalog seed: one active connection + `names.len()` videos.
    /// Returns the video ids in insertion order.
    async fn seed_videos(pool: &SqlitePool, names: &[&str]) -> Vec<String> {
        sqlx::query(
            "INSERT INTO provider_connections (id, provider, token_bundle, connected_at) \
             VALUES ('c1', 'google_drive', x'00', '2026-01-01T00:00:00Z')",
        )
        .execute(pool)
        .await
        .unwrap();
        let mut ids = Vec::with_capacity(names.len());
        for name in names {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO videos (id, connection_id, provider, provider_file_id, name, \
                 size_bytes, scanned_at, created_at) \
                 VALUES (?, 'c1', 'google_drive', ?, ?, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            )
            .bind(&id)
            .bind(name)
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
            ids.push(id);
        }
        ids
    }

    fn new_share<'a>(
        owner_id: &'a Uuid,
        token_hash: &'a [u8],
        video_ids: &'a [String],
    ) -> NewShare<'a> {
        NewShare {
            owner_id,
            token_hash,
            password_hash: None,
            title: "Trip footage",
            expires_at: None,
            video_ids,
        }
    }

    /// Fresh token hash for tests that don't care about the specific token.
    fn any_hash() -> Vec<u8> {
        hash_share_token(&generate_share_token())
    }

    #[tokio::test]
    async fn create_and_fetch_by_token_hash_round_trip() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4", "b.mp4"]).await;

        let token = generate_share_token();
        let token_hash = hash_share_token(&token);
        let created = repo
            .create_share(&NewShare {
                owner_id: &owner,
                token_hash: &token_hash,
                password_hash: Some("$argon2id$phc"),
                title: "Trip footage",
                expires_at: Some("2027-01-01T00:00:00Z"),
                video_ids: &videos,
            })
            .await
            .unwrap();

        assert_eq!(created.owner_id, owner.to_string());
        assert_eq!(created.title, "Trip footage");
        assert_eq!(created.password_hash.as_deref(), Some("$argon2id$phc"));
        assert_eq!(created.expires_at.as_deref(), Some("2027-01-01T00:00:00Z"));
        assert!(created.revoked_at.is_none());
        assert!(!created.created_at.is_empty());

        let fetched = repo
            .fetch_by_token_hash(&token_hash)
            .await
            .unwrap()
            .expect("row exists");
        assert_eq!(fetched.id, created.id);
        assert_eq!(fetched.token_hash, token_hash);
    }

    /// Acceptance criterion: only the SHA-256 hash is ever persisted — a
    /// raw dump of the stored bytes must not contain the raw token.
    #[tokio::test]
    async fn only_the_hash_is_persisted_never_the_raw_token() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;

        let token = generate_share_token();
        repo.create_share(&NewShare {
            owner_id: &owner,
            token_hash: &hash_share_token(&token),
            password_hash: None,
            title: "t",
            expires_at: None,
            video_ids: &videos,
        })
        .await
        .unwrap();

        let row = repo
            .fetch_by_token_hash(&hash_share_token(&token))
            .await
            .unwrap()
            .unwrap();
        assert_ne!(
            row.token_hash,
            token.as_bytes().to_vec(),
            "stored bytes ≠ raw token"
        );
        assert_eq!(row.token_hash.len(), 32);

        // Unknown token hash finds nothing — no table scan leaks rows.
        assert!(repo
            .fetch_by_token_hash(&hash_share_token("nope"))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn list_by_owner_scopes_to_owner_newest_first() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner_a = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;

        let first = repo
            .create_share(&new_share(&owner_a, &any_hash(), &videos))
            .await
            .unwrap();
        let second = repo
            .create_share(&new_share(&owner_a, &any_hash(), &videos))
            .await
            .unwrap();

        // A different owner sees none of A's shares.
        let owner_b = seed_owner(&pool).await;
        assert!(repo
            .list_by_owner(&owner_b.to_string())
            .await
            .unwrap()
            .is_empty());

        let listed = repo.list_by_owner(&owner_a.to_string()).await.unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, second.id, "newest first");
        assert_eq!(listed[1].id, first.id);
    }

    #[tokio::test]
    async fn revoke_is_terminal_and_idempotent() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;

        let created = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        assert_eq!(repo.revoke(&created.id).await.unwrap(), 1);

        let row = repo
            .fetch_by_token_hash(&created.token_hash)
            .await
            .unwrap()
            .unwrap();
        assert!(row.revoked_at.is_some(), "revoked_at set after revoke");

        // Second revoke changes nothing (0 rows affected), and unknown ids
        // are a no-op rather than an error.
        assert_eq!(repo.revoke(&created.id).await.unwrap(), 0);
        assert_eq!(repo.revoke("missing-id").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn is_member_distinguishes_member_from_foreign_videos() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["member.mp4", "outsider.mp4"]).await;
        let member = &videos[0];
        let outsider = &videos[1];

        let created = repo
            .create_share(&new_share(
                &owner,
                &any_hash(),
                std::slice::from_ref(member),
            ))
            .await
            .unwrap();

        assert!(repo.is_member(&created.id, member).await.unwrap());
        assert!(
            !repo.is_member(&created.id, outsider).await.unwrap(),
            "foreign video is not a member"
        );
        assert!(!repo.is_member("missing-share", member).await.unwrap());
    }

    #[tokio::test]
    async fn list_items_preserves_curation_order_and_positions() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["first.mp4", "second.mp4", "third.mp4"]).await;

        let created = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        let items = repo.list_items(&created.id).await.unwrap();

        assert_eq!(
            items
                .iter()
                .map(|i| i.video_id.as_str())
                .collect::<Vec<_>>(),
            videos.iter().map(String::as_str).collect::<Vec<_>>(),
            "insertion order is curation order"
        );
        assert_eq!(
            items.iter().map(|i| i.position).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );

        // Empty share lists cleanly (video deletes cascade to items).
        sqlx::query("DELETE FROM videos WHERE id = ?")
            .bind(&videos[0])
            .execute(&pool)
            .await
            .unwrap();
        let after_delete = repo.list_items(&created.id).await.unwrap();
        assert_eq!(after_delete.len(), 2);
    }

    #[tokio::test]
    async fn fetch_owned_scopes_to_the_owning_owner() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let created = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        let row = repo
            .fetch_owned(&owner.to_string(), &created.id)
            .await
            .unwrap()
            .expect("owning owner fetches the row");
        assert_eq!(row.id, created.id);
        assert_eq!(row.owner_id, owner.to_string());

        // A different owner and an unknown id both count as not-found —
        // no existence leak across owners.
        let stranger = seed_owner(&pool).await;
        assert!(repo
            .fetch_owned(&stranger.to_string(), &created.id)
            .await
            .unwrap()
            .is_none());
        assert!(repo
            .fetch_owned(&owner.to_string(), "missing-id")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn replace_items_swaps_the_full_list_in_curation_order() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4", "b.mp4", "c.mp4"]).await;
        let created = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        let swapped = vec![videos[2].clone(), videos[0].clone()];
        let written = repo
            .replace_items(&owner.to_string(), &created.id, &swapped)
            .await
            .unwrap();
        assert!(written > 0, "successful replace reports rows written");

        let items = repo.list_items(&created.id).await.unwrap();
        assert_eq!(
            items
                .iter()
                .map(|i| i.video_id.as_str())
                .collect::<Vec<_>>(),
            swapped.iter().map(String::as_str).collect::<Vec<_>>(),
            "caller's order is the new curation order"
        );
        assert_eq!(
            items.iter().map(|i| i.position).collect::<Vec<_>>(),
            vec![0, 1],
            "positions are fresh and contiguous"
        );
    }

    #[tokio::test]
    async fn replacing_with_a_foreign_video_fails_atomically() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4", "b.mp4"]).await;
        let created = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        let bogus = vec![videos[0].clone(), "not-a-video".to_string()];
        assert!(
            repo.replace_items(&owner.to_string(), &created.id, &bogus)
                .await
                .is_err(),
            "FK violation must fail the replace"
        );

        // Atomic: the old list is intact, in its original order.
        let items = repo.list_items(&created.id).await.unwrap();
        assert_eq!(
            items
                .iter()
                .map(|i| i.video_id.as_str())
                .collect::<Vec<_>>(),
            videos.iter().map(String::as_str).collect::<Vec<_>>(),
            "failed replace must not mutate the existing list"
        );
    }

    #[tokio::test]
    async fn replace_items_on_a_revoked_share_does_not_mutate() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let created = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        repo.revoke(&created.id).await.unwrap();

        assert_eq!(
            repo.replace_items(&owner.to_string(), &created.id, &[])
                .await
                .unwrap(),
            0,
            "revoked share replaces nothing — route layer maps the state"
        );
        assert_eq!(repo.list_items(&created.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn replace_items_on_foreign_or_missing_share_is_zero() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let stranger = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let created = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        assert_eq!(
            repo.replace_items(&stranger.to_string(), &created.id, &[])
                .await
                .unwrap(),
            0,
            "foreign owner counts as not-found"
        );
        assert_eq!(
            repo.replace_items(&owner.to_string(), "missing-id", &[])
                .await
                .unwrap(),
            0
        );
        // Neither guard failure touched the real share.
        assert_eq!(repo.list_items(&created.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn append_items_appends_after_existing_in_request_order() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4", "b.mp4", "c.mp4", "d.mp4"]).await;
        let created = repo
            .create_share(&new_share(&owner, &any_hash(), &videos[..2]))
            .await
            .unwrap();

        // Request [c, a, d]: `a` is already a member, the rest append in
        // request order after the existing tail.
        let request = vec![videos[2].clone(), videos[0].clone(), videos[3].clone()];
        let written = repo
            .append_items(&owner.to_string(), &created.id, &request)
            .await
            .unwrap();
        assert_eq!(written, 2, "only the non-member ids write rows");

        let items = repo.list_items(&created.id).await.unwrap();
        assert_eq!(
            items
                .iter()
                .map(|i| i.video_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                videos[0].as_str(),
                videos[1].as_str(),
                videos[2].as_str(),
                videos[3].as_str()
            ],
            "existing members keep their positions; new ids append in request order"
        );
        assert_eq!(
            items.iter().map(|i| i.position).collect::<Vec<_>>(),
            vec![0, 1, 2, 3],
            "positions stay contiguous"
        );
    }

    #[tokio::test]
    async fn append_items_where_every_id_is_already_a_member_writes_nothing() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4", "b.mp4"]).await;
        let created = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        // Reversed on purpose: an all-duplicate append must not reorder.
        let request = vec![videos[1].clone(), videos[0].clone(), videos[1].clone()];
        assert_eq!(
            repo.append_items(&owner.to_string(), &created.id, &request)
                .await
                .unwrap(),
            0,
            "an all-member request writes no rows"
        );
        assert_eq!(
            repo.list_items(&created.id)
                .await
                .unwrap()
                .iter()
                .map(|i| i.video_id.as_str())
                .collect::<Vec<_>>(),
            videos.iter().map(String::as_str).collect::<Vec<_>>(),
            "membership and order are untouched"
        );
    }

    #[tokio::test]
    async fn append_items_on_foreign_missing_or_revoked_share_is_zero() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let stranger = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4", "b.mp4"]).await;
        let created = repo
            .create_share(&new_share(&owner, &any_hash(), &videos[..1]))
            .await
            .unwrap();
        let revoked = repo
            .create_share(&new_share(&owner, &any_hash(), &videos[..1]))
            .await
            .unwrap();
        repo.revoke(&revoked.id).await.unwrap();

        assert_eq!(
            repo.append_items(&stranger.to_string(), &created.id, &videos[1..])
                .await
                .unwrap(),
            0,
            "foreign owner counts as not-found"
        );
        assert_eq!(
            repo.append_items(&owner.to_string(), "missing-id", &videos[1..])
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            repo.append_items(&owner.to_string(), &revoked.id, &videos[1..])
                .await
                .unwrap(),
            0,
            "revoked share appends nothing — route layer maps the state"
        );
        // None of the guard failures touched the real shares.
        assert_eq!(repo.list_items(&created.id).await.unwrap().len(), 1);
        assert_eq!(repo.list_items(&revoked.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn purge_owned_deletes_the_row_and_cascades_items() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4", "b.mp4"]).await;
        let created = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        assert_eq!(
            repo.purge_owned(&owner.to_string(), &created.id)
                .await
                .unwrap(),
            1,
            "purging a live share deletes exactly one row"
        );

        // The row, its items, and the token-hash mapping are all gone —
        // nothing survives for the list or a recipient to find.
        assert!(repo
            .fetch_owned(&owner.to_string(), &created.id)
            .await
            .unwrap()
            .is_none());
        assert!(repo
            .fetch_by_token_hash(&created.token_hash)
            .await
            .unwrap()
            .is_none());
        assert!(repo.list_items(&created.id).await.unwrap().is_empty());
        assert!(repo
            .list_by_owner(&owner.to_string())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn purge_owned_removes_revoked_and_expired_rows_too() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;

        let revoked = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        repo.revoke(&revoked.id).await.unwrap();

        // Past expiry seeded straight through the repo (the API refuses
        // to create one).
        let expired = repo
            .create_share(&NewShare {
                owner_id: &owner,
                token_hash: &any_hash(),
                password_hash: None,
                title: "Past",
                expires_at: Some("2000-01-01T00:00:00Z"),
                video_ids: &videos,
            })
            .await
            .unwrap();

        assert_eq!(
            repo.purge_owned(&owner.to_string(), &revoked.id)
                .await
                .unwrap(),
            1,
            "purge works on revoked rows, not just active ones"
        );
        assert_eq!(
            repo.purge_owned(&owner.to_string(), &expired.id)
                .await
                .unwrap(),
            1,
            "purge works on expired rows"
        );
        assert!(repo
            .list_by_owner(&owner.to_string())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn purge_owned_scopes_to_owner_and_is_idempotent() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let stranger = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let created = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        // A stranger's purge deletes nothing — 0 rows, share intact.
        assert_eq!(
            repo.purge_owned(&stranger.to_string(), &created.id)
                .await
                .unwrap(),
            0,
            "foreign owner deletes nothing"
        );
        assert!(repo
            .fetch_owned(&owner.to_string(), &created.id)
            .await
            .unwrap()
            .is_some());
        assert_eq!(repo.list_items(&created.id).await.unwrap().len(), 1);

        // The owner's purge lands, and repeating it (or a missing id) is
        // a 0-row no-op the route maps to the same idempotent 204.
        assert_eq!(
            repo.purge_owned(&owner.to_string(), &created.id)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            repo.purge_owned(&owner.to_string(), &created.id)
                .await
                .unwrap(),
            0,
            "second purge finds nothing left"
        );
        assert_eq!(
            repo.purge_owned(&owner.to_string(), "missing-id")
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn creating_a_share_with_a_foreign_video_fails_atomically() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let bogus = vec![videos[0].clone(), "not-a-video".to_string()];

        let err = repo
            .create_share(&new_share(&owner, &any_hash(), &bogus))
            .await;
        assert!(err.is_err(), "FK violation must fail the create");

        // Atomic: no share row, no orphan item, no token_hash consumed.
        let owner_shares = repo.list_by_owner(&owner.to_string()).await.unwrap();
        assert!(
            owner_shares.is_empty(),
            "failed create must not leave a share behind"
        );
    }
}
