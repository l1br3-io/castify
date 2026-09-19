//! `ShareRepository` — all SQL for shares and share items.
//!
//! Mirrors `castify_auth::AuthRepository`: stateless struct over the pool,
//! runtime `sqlx::query` (no compile-time DB), tests beside the code on a
//! real temp-file SQLite. Writes happen only on owner actions (create,
//! revoke) — recipient reads never write.

use chrono::Utc;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
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
    /// Folder placement — `None` = share root. Organization only; never
    /// consulted by authorization (`is_member` is share-scoped).
    pub folder_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShareFolderRow {
    pub id: String,
    pub share_id: String,
    /// `None` = share root.
    pub parent_id: Option<String>,
    pub name: String,
    /// Order within the folder's scope (its sibling group).
    pub position: i64,
    pub created_at: String,
}

/// Folder-depth cap: root folders sit at depth 1; the deepest legal
/// folder is 8. Enforced by the repository's CTE walks — declarative SQL
/// cannot express it.
const MAX_FOLDER_DEPTH: i64 = 8;

/// Validation rejection for a folder write — the repository's friendly
/// pre-check layer. The partial unique indexes are the race-proof
/// backstop: a concurrent sibling write that slips past the pre-check
/// trips the constraint, which the repo maps back to `DuplicateName`
/// (same layering as `token_hash UNIQUE` + repo logic). Routes map each
/// variant to its 4xx; guard failures are NOT this — they are `Ok(None)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FolderInvalid {
    #[error("folder name must be 1-200 characters after trimming")]
    Name,
    #[error("a sibling folder already has that name")]
    DuplicateName,
    #[error("the folder tree is at its maximum depth of 8")]
    Depth,
    #[error("a folder cannot move into itself or its own subtree")]
    Cycle,
}

/// Folder-write error: expected validation rejections plus the
/// infrastructure passthrough. Scoping outcomes (unknown/foreign share,
/// revoked share, unknown folder) are deliberately NOT errors — methods
/// return `Ok(None)` for those, the same no-leak shape as
/// [`ShareRepository::replace_items`].
#[derive(Debug, thiserror::Error)]
pub enum FolderWriteError {
    #[error(transparent)]
    Invalid(#[from] FolderInvalid),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

/// Granular item-removal outcome. Scoping failures (unknown/foreign
/// share, revoked share, non-member video) deliberately collapse into
/// one variant — routes pre-check the share with `fetch_owned` to map
/// 404 vs 409, so the only split they need is member-vs-last-item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemovedItem {
    /// Row deleted; the vacated scope renumbered.
    Removed,
    /// Guard or membership rejection — nothing written, no leak.
    Rejected,
    /// The removal would empty the share — refused (route: 400).
    LastItem,
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

    /// Owner-scoped diff rewrite of the member list. One transaction:
    /// guard on exists + owned + not revoked, then diff the caller's
    /// array against current membership — removed ids delete their
    /// rows, **survivors keep their folder placement** and are
    /// renumbered per scope by their relative order in the caller's
    /// array, and new ids join the root scope in array order (one
    /// walk, so a flat share ends up exactly `0..N` in caller order —
    /// the pre-folder contract). A diff (not the old
    /// delete-all-reinsert) is what makes "membership edits preserve
    /// placement" true: survivor rows are updated in place, so
    /// `folder_id` never has to be carried across a delete/insert
    /// cycle. A bogus video id trips the FK and rolls the whole
    /// rewrite back, so the old list survives intact (same atomicity
    /// shape as [`ShareRepository::create_share`]).
    ///
    /// Returns the item rows removed + inserted. `Ok(0)` means the
    /// guard rejected the write — not found, not owned, or revoked
    /// (all three collapse here; routes call
    /// [`ShareRepository::fetch_owned`] first to map 404 vs 409). A
    /// successful pure reorder also reports 0 (nothing removed or
    /// inserted — survivors keep their rows); routes treat any `Ok(_)`
    /// after their own pre-checks as success.
    pub async fn replace_items(
        &self,
        owner_id: &str,
        share_id: &str,
        video_ids: &[String],
    ) -> ShareResult<u64> {
        let mut tx = self.pool.begin().await?;
        if Self::guard_live_share(&mut tx, owner_id, share_id)
            .await?
            .is_none()
        {
            // Dropping the tx rolls back — nothing was written.
            return Ok(0);
        }
        // Current membership → placement map. Loaded before any write
        // so the diff sees one snapshot (SQLite's serialized writes
        // keep the transaction honest).
        let current: Vec<(String, Option<String>)> =
            sqlx::query("SELECT video_id, folder_id FROM share_items WHERE share_id = ?")
                .bind(share_id)
                .fetch_all(&mut *tx)
                .await?
                .into_iter()
                .map(|r: sqlx::sqlite::SqliteRow| {
                    (
                        sqlx::Row::get(&r, "video_id"),
                        sqlx::Row::get(&r, "folder_id"),
                    )
                })
                .collect();
        let caller: HashSet<&str> = video_ids.iter().map(String::as_str).collect();

        let mut written = 0u64;
        // Pass 1 — removals: members the caller didn't keep.
        for (video_id, _) in &current {
            if !caller.contains(video_id.as_str()) {
                sqlx::query("DELETE FROM share_items WHERE share_id = ? AND video_id = ?")
                    .bind(share_id)
                    .bind(video_id)
                    .execute(&mut *tx)
                    .await?;
                written += 1;
            }
        }
        // Pass 2 — one walk in caller order: survivors renumber within
        // their scope, new ids join the ROOT scope's tail. The array is
        // the curation order, so a single pass is what keeps a flat
        // share's positions exactly `0..N` in caller order (new ids
        // interleaved before survivors stay in front); foldered
        // survivors renumber by their relative array order within each
        // scope. The `folder_id` column of survivors is deliberately
        // untouched — placement is the durable axis this diff exists
        // to preserve.
        let current_placements: HashMap<&str, Option<&str>> = current
            .iter()
            .map(|(vid, folder)| (vid.as_str(), folder.as_deref()))
            .collect();
        let mut next_by_scope: HashMap<Option<&str>, i64> = HashMap::new();
        for video_id in video_ids {
            match current_placements.get(video_id.as_str()) {
                Some(scope) => {
                    let slot = next_by_scope.entry(*scope).or_insert(0);
                    sqlx::query(
                        "UPDATE share_items SET position = ? WHERE share_id = ? AND video_id = ?",
                    )
                    .bind(*slot)
                    .bind(share_id)
                    .bind(video_id)
                    .execute(&mut *tx)
                    .await?;
                    *slot += 1;
                }
                None => {
                    let slot = next_by_scope.entry(None).or_insert(0);
                    sqlx::query(
                        "INSERT INTO share_items (share_id, video_id, position, folder_id) \
                         VALUES (?, ?, ?, NULL)",
                    )
                    .bind(share_id)
                    .bind(video_id)
                    .bind(*slot)
                    .execute(&mut *tx)
                    .await?;
                    *slot += 1;
                    written += 1;
                }
            }
        }
        tx.commit().await?;

        Ok(written)
    }

    /// Owner-scoped append. One transaction: guard on exists + owned +
    /// not revoked, load the existing member ids, dedupe the request
    /// (both in-request and against current members), and insert the
    /// remainder at the **root scope's** `MAX(position)+1..` in request
    /// order — per-scope numbering means the tail is measured among
    /// root items only, so a folder holding high positions can't push
    /// the append past a gap. Existing members keep both their
    /// membership and their placement. A bogus video id trips the FK
    /// and rolls the whole append back, so the list survives intact
    /// (same atomicity shape as
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
            "SELECT COALESCE(MAX(position) + 1, 0) FROM share_items \
             WHERE share_id = ? AND folder_id IS NULL",
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

    /// A share's items in curation order (`position`). Folder placement
    /// travels with each row; flat shares simply carry `folder_id: None`.
    pub async fn list_items(&self, share_id: &str) -> ShareResult<Vec<ShareItemRow>> {
        let rows = sqlx::query(
            "SELECT share_id, video_id, position, folder_id FROM share_items WHERE share_id = ? ORDER BY position",
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
                folder_id: sqlx::Row::get(r, "folder_id"),
            })
            .collect())
    }

    /// A share's folders ordered by `(parent_id, position)` — roots
    /// first (SQLite sorts NULL `parent_id` before ids), then each
    /// sibling group in curation order. Recipients get the whole flat
    /// list in one shot; the tree is built client-side.
    pub async fn list_folders(&self, share_id: &str) -> ShareResult<Vec<ShareFolderRow>> {
        let rows = sqlx::query(
            "SELECT id, share_id, parent_id, name, position, created_at \
             FROM share_folders WHERE share_id = ? ORDER BY parent_id, position",
        )
        .bind(share_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(row_to_folder).collect())
    }

    /// Owner-scoped folder create (one transaction: guard, validate,
    /// append). `parent_id: None` creates at the share root. The name is
    /// trimmed and must be 1..=200 chars; sibling names are unique within
    /// a scope (case-sensitive); depth is capped at 8.
    ///
    /// Returns the stored row, or `Ok(None)` when the guard rejects the
    /// write — share not found, not owned, revoked, or the parent folder
    /// unknown/foreign (routes call [`ShareRepository::fetch_owned`]
    /// first to map 404 vs 409). Validation failures come back as
    /// [`FolderInvalid`] via [`FolderWriteError::Invalid`].
    pub async fn create_folder(
        &self,
        owner_id: &str,
        share_id: &str,
        parent_id: Option<&str>,
        name: &str,
    ) -> Result<Option<ShareFolderRow>, FolderWriteError> {
        let mut tx = self.pool.begin().await?;
        if Self::guard_live_share(&mut tx, owner_id, share_id)
            .await?
            .is_none()
        {
            // Dropping the tx rolls back — nothing was written.
            return Ok(None);
        }
        if let Some(pid) = parent_id {
            // An unknown or foreign parent folder is a no-op, same shape
            // as the share guard — never an error, no existence leak.
            if Self::fetch_folder(&mut tx, share_id, pid)
                .await?
                .is_none()
            {
                return Ok(None);
            }
            // New folder's depth = the parent's ancestor chain (parent
            // included) + this folder.
            if Self::ancestor_chain_len(&mut tx, pid).await? + 1 > MAX_FOLDER_DEPTH {
                return Err(FolderInvalid::Depth.into());
            }
        }
        let name = valid_folder_name(name).ok_or(FolderInvalid::Name)?;
        if Self::sibling_name_taken(&mut tx, share_id, parent_id, name, None)
            .await?
        {
            return Err(FolderInvalid::DuplicateName.into());
        }
        let position = Self::next_folder_position(&mut tx, share_id, parent_id).await?;
        let id = Uuid::new_v4().to_string();
        let created_at = iso_now();
        sqlx::query(
            "INSERT INTO share_folders (id, share_id, parent_id, name, position, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(share_id)
        .bind(parent_id)
        .bind(name)
        .bind(position)
        .bind(&created_at)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_folder_write_err)?;
        tx.commit().await?;

        Ok(Some(ShareFolderRow {
            id,
            share_id: share_id.to_string(),
            parent_id: parent_id.map(str::to_string),
            name: name.to_string(),
            position,
            created_at,
        }))
    }

    /// Owner-scoped folder rename (one transaction). Thin wrapper over
    /// [`Self::update_folder`] — see there for the shared ladder. `Ok(None)`
    /// = guard rejection (share state, or the folder id is unknown/foreign
    /// to this share).
    pub async fn rename_folder(
        &self,
        owner_id: &str,
        share_id: &str,
        folder_id: &str,
        name: &str,
    ) -> Result<Option<ShareFolderRow>, FolderWriteError> {
        self.update_folder(owner_id, share_id, folder_id, Some(name), None)
            .await
    }

    /// Owner-scoped folder reparent (one transaction). Thin wrapper over
    /// [`Self::update_folder`] — see there for the shared ladder. The
    /// folder lands at the END of its new sibling group; the scope it
    /// vacates renumbers densely; its own subtree keeps its internal
    /// order. `Ok(None)` = guard rejection.
    pub async fn reparent_folder(
        &self,
        owner_id: &str,
        share_id: &str,
        folder_id: &str,
        new_parent_id: Option<&str>,
    ) -> Result<Option<ShareFolderRow>, FolderWriteError> {
        self.update_folder(owner_id, share_id, folder_id, None, Some(new_parent_id))
            .await
    }

    /// Owner-scoped folder update — the one-transaction write behind
    /// `PATCH /api/shares/{id}/folders/{fid}`. Rename and reparent
    /// share this path so a PATCH carrying both fields is atomic: one
    /// guard, one sibling-name check per affected scope (the reparent's
    /// check runs against the NEW name in the TARGET scope), one
    /// update, one commit — a half-applied rename+move can never land.
    ///
    /// `name: Some(_)` renames (trim/length rules as create);
    /// `new_parent_id` distinguishes three states: `None` = leave the
    /// parent alone, `Some(None)` = move to the share root,
    /// `Some(Some(id))` = move under that folder (appending at the end
    /// of its sibling group; the vacated scope renumbers densely;
    /// cycle/depth walks as create-with-parent). `Ok(None)` = guard
    /// rejection (share state, or folder/new-parent id unknown/foreign
    /// to this share).
    pub async fn update_folder(
        &self,
        owner_id: &str,
        share_id: &str,
        folder_id: &str,
        name: Option<&str>,
        new_parent_id: Option<Option<&str>>,
    ) -> Result<Option<ShareFolderRow>, FolderWriteError> {
        let mut tx = self.pool.begin().await?;
        if Self::guard_live_share(&mut tx, owner_id, share_id)
            .await?
            .is_none()
        {
            // Dropping the tx rolls back — nothing was written.
            return Ok(None);
        }
        let Some(folder) = Self::fetch_folder(&mut tx, share_id, folder_id).await? else {
            return Ok(None);
        };

        // Resolve the effective name first: every later check (and the
        // row update) must see the post-rename value.
        let effective_name = match name {
            Some(raw) => valid_folder_name(raw).ok_or(FolderInvalid::Name)?,
            None => folder.name.as_str(),
        };

        // No-op fast path: same name, no parent change.
        if name.is_none() && new_parent_id.is_none() {
            return Ok(Some(folder));
        }

        let mut new_parent = folder.parent_id.as_deref();
        let mut position = folder.position;
        if let Some(target) = new_parent_id {
            new_parent = target;
            if let Some(pid) = target {
                if Self::fetch_folder(&mut tx, share_id, pid)
                    .await?
                    .is_none()
                {
                    return Ok(None);
                }
                // Cycle: the new parent must not live inside the moved
                // folder's own subtree — one downward CTE covers self,
                // children, and every deeper descendant.
                if Self::subtree_contains(&mut tx, folder_id, pid).await? {
                    return Err(FolderInvalid::Cycle.into());
                }
                // Depth: the new parent's ancestor chain (it included)
                // plus the moved subtree's height (folder included)
                // must stay within the cap.
                if Self::ancestor_chain_len(&mut tx, pid).await?
                    + Self::subtree_height(&mut tx, folder_id).await?
                    > MAX_FOLDER_DEPTH
                {
                    return Err(FolderInvalid::Depth.into());
                }
            }
            // Root moves can only reduce depth (the subtree was already
            // within the cap), so no walk is needed for `Some(None)`.
            if Self::sibling_name_taken(
                &mut tx,
                share_id,
                new_parent,
                effective_name,
                Some(folder_id),
            )
            .await?
            {
                return Err(FolderInvalid::DuplicateName.into());
            }
            position = Self::next_folder_position(&mut tx, share_id, new_parent).await?;
        } else if name.is_some() {
            // Rename-in-place: check the current scope with the new name.
            if Self::sibling_name_taken(
                &mut tx,
                share_id,
                folder.parent_id.as_deref(),
                effective_name,
                Some(folder_id),
            )
            .await?
            {
                return Err(FolderInvalid::DuplicateName.into());
            }
        }

        sqlx::query("UPDATE share_folders SET name = ?, parent_id = ?, position = ? WHERE id = ?")
            .bind(effective_name)
            .bind(new_parent)
            .bind(position)
            .bind(folder_id)
            .execute(&mut *tx)
            .await
            .map_err(Self::map_folder_write_err)?;
        // Close the gap a reparent left behind: the source scope
        // renumbers densely on write; untouched scopes never rewrite.
        if new_parent_id.is_some() && new_parent != folder.parent_id.as_deref() {
            Self::renumber_folder_scope(&mut tx, share_id, folder.parent_id.as_deref()).await?;
        }
        tx.commit().await?;

        Ok(Some(ShareFolderRow {
            name: effective_name.to_string(),
            parent_id: new_parent.map(str::to_string),
            position,
            ..folder
        }))
    }

    /// `DELETE /api/shares/{id}/folders/{fid}` backing — delete a
    /// folder; its contents move to the share root. Folder deletion is
    /// organization, never membership: no `share_items` row is removed,
    /// so no recipient loses access. One transaction, ordered so the
    /// migration's `ON DELETE CASCADE` never fires: (1) collect the
    /// subtree with a single recursive CTE and pre-order it in memory
    /// (siblings by `position`, children before next sibling);
    /// (2) lift every contained item to root with fresh appended
    /// positions in that subtree order; (3) lift the descendants to
    /// root, appended after the existing root folders in the same
    /// order — a flattened name that collides at root takes the
    /// smallest `" (n)"` suffix, because the delete must stay a total
    /// operation, not fail on the sibling-name index; (4) delete the
    /// folder row itself (nothing references it anymore).
    /// `share_items.folder_id`'s `ON DELETE SET NULL` remains the
    /// documented safety net for paths that bypass this transaction.
    ///
    /// `Ok(None)` = guard rejection (share state, or the folder id is
    /// unknown/foreign to this share) — same no-leak shape as every
    /// other folder write.
    pub async fn delete_folder(
        &self,
        owner_id: &str,
        share_id: &str,
        folder_id: &str,
    ) -> Result<Option<ShareFolderRow>, FolderWriteError> {
        let mut tx = self.pool.begin().await?;
        if Self::guard_live_share(&mut tx, owner_id, share_id)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        let Some(folder) = Self::fetch_folder(&mut tx, share_id, folder_id).await? else {
            return Ok(None);
        };

        // Subtree membership via one recursive CTE; rows come back
        // unordered, the pre-order walk happens in memory (tree ≤
        // depth 8, dozens of folders — a Rust DFS beats fighting CTE
        // ordering semantics).
        let subtree: Vec<(String, Option<String>, String, i64)> = sqlx::query(
            "WITH RECURSIVE subtree(id) AS ( \
                 SELECT id FROM share_folders WHERE id = ? \
                 UNION \
                 SELECT f.id FROM share_folders f JOIN subtree s ON f.parent_id = s.id \
             ) SELECT f.id, f.parent_id, f.name, f.position FROM share_folders f \
             WHERE f.id IN (SELECT id FROM subtree)",
        )
        .bind(folder_id)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|r: sqlx::sqlite::SqliteRow| {
            (
                sqlx::Row::get(&r, "id"),
                sqlx::Row::get(&r, "parent_id"),
                sqlx::Row::get(&r, "name"),
                sqlx::Row::get(&r, "position"),
            )
        })
        .collect();

        // Children grouped by parent, each sibling group in curation
        // order; a recursive DFS from the deleted folder yields the
        // lift order (emit-on-visit, so each subtree fully drains
        // before the next sibling — children before next sibling).
        let mut children: HashMap<Option<&str>, Vec<&(String, Option<String>, String, i64)>> =
            HashMap::new();
        for rec in &subtree {
            children
                .entry(rec.1.as_deref())
                .or_default()
                .push(rec);
        }
        for group in children.values_mut() {
            group.sort_by_key(|rec| rec.3);
        }
        fn walk<'a>(
            children: &HashMap<Option<&'a str>, Vec<&'a (String, Option<String>, String, i64)>>,
            parent: Option<&'a str>,
            out: &mut Vec<&'a (String, Option<String>, String, i64)>,
        ) {
            for rec in children.get(&parent).into_iter().flatten() {
                out.push(rec);
                walk(children, Some(rec.0.as_str()), out);
            }
        }
        let mut descendants: Vec<&(String, Option<String>, String, i64)> = Vec::new();
        walk(&children, Some(folder_id), &mut descendants);

        // (2) Lift items: every item whose folder sits in the subtree,
        // root positions assigned in subtree pre-order — the deleted
        // folder's own items first, then each descendant's, siblings
        // by their in-folder position.
        let mut items_by_folder: HashMap<String, Vec<(String, i64)>> = HashMap::new();
        {
            let rows: Vec<(String, Option<String>, i64)> = sqlx::query(
                "WITH RECURSIVE subtree(id) AS ( \
                     SELECT id FROM share_folders WHERE id = ? \
                     UNION \
                     SELECT f.id FROM share_folders f JOIN subtree s ON f.parent_id = s.id \
                 ) SELECT i.video_id, i.folder_id, i.position FROM share_items i \
                 WHERE i.share_id = ? AND i.folder_id IN (SELECT id FROM subtree)",
            )
            .bind(folder_id)
            .bind(share_id)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|r: sqlx::sqlite::SqliteRow| {
                (
                    sqlx::Row::get(&r, "video_id"),
                    sqlx::Row::get(&r, "folder_id"),
                    sqlx::Row::get(&r, "position"),
                )
            })
            .collect();
            for (video_id, fid, position) in rows {
                if let Some(fid) = fid {
                    items_by_folder.entry(fid).or_default().push((video_id, position));
                }
            }
            for group in items_by_folder.values_mut() {
                group.sort_by_key(|(_, position)| *position);
            }
        }
        let mut item_position: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM share_items \
             WHERE share_id = ? AND folder_id IS NULL",
        )
        .bind(share_id)
        .fetch_one(&mut *tx)
        .await?;
        for folder_key in std::iter::once(folder_id).chain(descendants.iter().map(|r| r.0.as_str()))
        {
            for (video_id, _) in items_by_folder.get(folder_key).into_iter().flatten() {
                sqlx::query(
                    "UPDATE share_items SET folder_id = NULL, position = ? \
                     WHERE share_id = ? AND video_id = ?",
                )
                .bind(item_position)
                .bind(share_id)
                .bind(video_id)
                .execute(&mut *tx)
                .await?;
                item_position += 1;
            }
        }

        // (3) Lift descendants to root, appended after the existing
        // root folders, names de-collided deterministically against
        // the root's taken names (existing + already lifted). The
        // doomed folder is excluded from both the tail and the name
        // set — it is not "existing" by the time the lift lands.
        let mut folder_position: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM share_folders \
             WHERE share_id = ? AND parent_id IS NULL AND id != ?",
        )
        .bind(share_id)
        .bind(folder_id)
        .fetch_one(&mut *tx)
        .await?;
        let mut root_names: HashSet<String> = sqlx::query_scalar(
            "SELECT name FROM share_folders WHERE share_id = ? AND parent_id IS NULL AND id != ?",
        )
        .bind(share_id)
        .bind(folder_id)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect();
        for rec in &descendants {
            let base = rec.2.clone();
            let name = if root_names.contains(&base) {
                let mut n = 2;
                while root_names.contains(&format!("{base} ({n})")) {
                    n += 1;
                }
                format!("{base} ({n})")
            } else {
                base
            };
            root_names.insert(name.clone());
            sqlx::query(
                "UPDATE share_folders SET parent_id = NULL, position = ?, name = ? WHERE id = ?",
            )
            .bind(folder_position)
            .bind(name)
            .bind(&rec.0)
            .execute(&mut *tx)
            .await
            .map_err(Self::map_folder_write_err)?;
            folder_position += 1;
        }

        // (4) The folder row itself — descendants no longer reference
        // it, so the CASCADE stays dormant and SET NULL never fires.
        sqlx::query("DELETE FROM share_folders WHERE id = ?")
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        Ok(Some(folder))
    }

    /// Owner-scoped item move — the granular placement write behind
    /// `PATCH /api/shares/{id}/items/{video_id}`. Sets the item's
    /// scope (`folder_id: None` = share root) and appends it at the
    /// target scope's tail; the scope it vacates renumbers densely.
    /// The target folder must belong to the same share and the video
    /// must be a member — anything else is `Ok(None)`, the shared
    /// no-leak guard shape (never an error).
    pub async fn move_item(
        &self,
        owner_id: &str,
        share_id: &str,
        video_id: &str,
        folder_id: Option<&str>,
    ) -> ShareResult<Option<ShareItemRow>> {
        let mut tx = self.pool.begin().await?;
        if Self::guard_live_share(&mut tx, owner_id, share_id)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        if let Some(fid) = folder_id {
            if Self::fetch_folder(&mut tx, share_id, fid).await?.is_none() {
                return Ok(None);
            }
        }
        let prev: Option<Option<String>> = sqlx::query_scalar(
            "SELECT folder_id FROM share_items WHERE share_id = ? AND video_id = ?",
        )
        .bind(share_id)
        .bind(video_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(prev_folder) = prev else {
            return Ok(None); // non-member video
        };
        let position: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM share_items \
             WHERE share_id = ? AND folder_id IS ?",
        )
        .bind(share_id)
        .bind(folder_id)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE share_items SET folder_id = ?, position = ? WHERE share_id = ? AND video_id = ?",
        )
        .bind(folder_id)
        .bind(position)
        .bind(share_id)
        .bind(video_id)
        .execute(&mut *tx)
        .await?;
        // Same-scope moves renumber their own tail back into shape;
        // cross-scope moves close the gap in the vacated scope only.
        Self::renumber_item_scope(&mut tx, share_id, prev_folder.as_deref()).await?;
        tx.commit().await?;

        Ok(Some(ShareItemRow {
            share_id: share_id.to_string(),
            video_id: video_id.to_string(),
            position,
            folder_id: folder_id.map(str::to_string),
        }))
    }

    /// Owner-scoped granular removal — the row delete behind
    /// `DELETE /api/shares/{id}/items/{video_id}`. The vacated scope
    /// renumbers densely. Removing the share's **last** item is
    /// refused (`RemovedItem::LastItem`, route: 400) — an empty share
    /// is the PUT's empty-list rule, and revoke is the path for
    /// retiring one. Guard failures (share state) and non-member
    /// videos collapse into `RemovedItem::Rejected` — routes pre-check
    /// the share with [`ShareRepository::fetch_owned`] to map 404 vs
    /// 409, so the split they still need is member-vs-last-item.
    pub async fn remove_item(
        &self,
        owner_id: &str,
        share_id: &str,
        video_id: &str,
    ) -> ShareResult<RemovedItem> {
        let mut tx = self.pool.begin().await?;
        if Self::guard_live_share(&mut tx, owner_id, share_id)
            .await?
            .is_none()
        {
            return Ok(RemovedItem::Rejected);
        }
        let prev_folder: Option<Option<String>> = sqlx::query_scalar(
            "SELECT folder_id FROM share_items WHERE share_id = ? AND video_id = ?",
        )
        .bind(share_id)
        .bind(video_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(prev_folder) = prev_folder else {
            return Ok(RemovedItem::Rejected); // non-member video
        };
        let members: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM share_items WHERE share_id = ?")
            .bind(share_id)
            .fetch_one(&mut *tx)
            .await?;
        if members == 1 {
            return Ok(RemovedItem::LastItem);
        }
        sqlx::query("DELETE FROM share_items WHERE share_id = ? AND video_id = ?")
            .bind(share_id)
            .bind(video_id)
            .execute(&mut *tx)
            .await?;
        Self::renumber_item_scope(&mut tx, share_id, prev_folder.as_deref()).await?;
        tx.commit().await?;

        Ok(RemovedItem::Removed)
    }


    // -- Folder helpers: one shared guard, share-scoped fetches, and the
    // single-CTE walks that keep every tree check O(depth) statements.

    /// The live-share guard every folder write runs first, inside its
    /// own transaction — same contract as `replace_items`: not found,
    /// not owned, and revoked all collapse to `None`.
    async fn guard_live_share(
        tx: &mut sqlx::SqliteConnection,
        owner_id: &str,
        share_id: &str,
    ) -> sqlx::Result<Option<String>> {
        sqlx::query_scalar(
            "SELECT id FROM shares WHERE id = ? AND owner_id = ? AND revoked_at IS NULL",
        )
        .bind(share_id)
        .bind(owner_id)
        .fetch_optional(tx)
        .await
    }

    /// Share-scoped folder fetch — a folder id from another share is
    /// indistinguishable from an unknown one.
    async fn fetch_folder(
        tx: &mut sqlx::SqliteConnection,
        share_id: &str,
        folder_id: &str,
    ) -> sqlx::Result<Option<ShareFolderRow>> {
        let row = sqlx::query(
            "SELECT id, share_id, parent_id, name, position, created_at \
             FROM share_folders WHERE id = ? AND share_id = ?",
        )
        .bind(folder_id)
        .bind(share_id)
        .fetch_optional(tx)
        .await?;
        Ok(row.map(|r| row_to_folder(&r)))
    }

    /// Ancestor-chain length of `folder_id`, itself included — one
    /// upward recursive CTE that carries each node's parent into the
    /// working set (`UNION` dedups, so even a corrupt cyclic tree
    /// terminates). A missing folder counts 0.
    async fn ancestor_chain_len(
        tx: &mut sqlx::SqliteConnection,
        folder_id: &str,
    ) -> sqlx::Result<i64> {
        sqlx::query_scalar(
            "WITH RECURSIVE ancestors(id) AS ( \
                 SELECT id FROM share_folders WHERE id = ? \
                 UNION \
                 SELECT f.parent_id FROM share_folders f \
                     JOIN ancestors a ON f.id = a.id \
                     WHERE f.parent_id IS NOT NULL \
             ) SELECT COUNT(*) FROM ancestors",
        )
        .bind(folder_id)
        .fetch_one(tx)
        .await
    }

    /// Subtree height of `folder_id`, itself included — one downward
    /// recursive CTE. A missing folder measures 0.
    async fn subtree_height(
        tx: &mut sqlx::SqliteConnection,
        folder_id: &str,
    ) -> sqlx::Result<i64> {
        sqlx::query_scalar(
            "WITH RECURSIVE subtree(id, depth) AS ( \
                 SELECT id, 1 FROM share_folders WHERE id = ? \
                 UNION ALL \
                 SELECT f.id, s.depth + 1 FROM share_folders f JOIN subtree s ON f.parent_id = s.id \
             ) SELECT COALESCE(MAX(depth), 0) FROM subtree",
        )
        .bind(folder_id)
        .fetch_one(tx)
        .await
    }

    /// Does `folder_id`'s subtree (itself included) contain `candidate`?
    /// The reparent cycle check — one downward recursive CTE.
    async fn subtree_contains(
        tx: &mut sqlx::SqliteConnection,
        folder_id: &str,
        candidate: &str,
    ) -> sqlx::Result<bool> {
        sqlx::query_scalar(
            "WITH RECURSIVE tree(id) AS ( \
                 SELECT id FROM share_folders WHERE id = ? \
                 UNION \
                 SELECT f.id FROM share_folders f JOIN tree t ON f.parent_id = t.id \
             ) SELECT EXISTS(SELECT 1 FROM tree WHERE id = ?)",
        )
        .bind(folder_id)
        .bind(candidate)
        .fetch_one(tx)
        .await
    }

    /// Sibling-name pre-check within one scope (root when `parent_id` is
    /// `None`). `exclude_folder` spares the folder itself on
    /// rename/reparent — keeping one's own name is not a collision.
    async fn sibling_name_taken(
        tx: &mut sqlx::SqliteConnection,
        share_id: &str,
        parent_id: Option<&str>,
        name: &str,
        exclude_folder: Option<&str>,
    ) -> sqlx::Result<bool> {
        let sql = match exclude_folder {
            Some(_) => concat!(
                "SELECT EXISTS(SELECT 1 FROM share_folders ",
                "WHERE share_id = ? AND parent_id IS ? AND name = ? AND id != ?)"
            ),
            None => concat!(
                "SELECT EXISTS(SELECT 1 FROM share_folders ",
                "WHERE share_id = ? AND parent_id IS ? AND name = ?)"
            ),
        };
        let mut q = sqlx::query_scalar(sql)
            .bind(share_id)
            .bind(parent_id)
            .bind(name);
        if let Some(exclude) = exclude_folder {
            q = q.bind(exclude);
        }
        q.fetch_one(tx).await
    }

    /// Append position for the next folder in a scope (`MAX(position)+1`,
    /// or 0 for an empty scope).
    async fn next_folder_position(
        tx: &mut sqlx::SqliteConnection,
        share_id: &str,
        parent_id: Option<&str>,
    ) -> sqlx::Result<i64> {
        sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM share_folders \
             WHERE share_id = ? AND parent_id IS ?",
        )
        .bind(share_id)
        .bind(parent_id)
        .fetch_one(tx)
        .await
    }

    /// Renumber one scope densely by current relative order — the
    /// renumber-on-write half of the position contract: a write that
    /// removes a member from a scope closes its gap; scopes no write
    /// touched never rewrite.
    async fn renumber_folder_scope(
        tx: &mut sqlx::SqliteConnection,
        share_id: &str,
        parent_id: Option<&str>,
    ) -> sqlx::Result<u64> {
        sqlx::query(
            "UPDATE share_folders SET position = ( \
                 SELECT COUNT(*) FROM share_folders s2 \
                     WHERE s2.share_id = share_folders.share_id \
                       AND s2.parent_id IS share_folders.parent_id \
                       AND s2.position < share_folders.position \
             ) WHERE share_id = ? AND parent_id IS ?",
        )
        .bind(share_id)
        .bind(parent_id)
        .execute(tx)
        .await
        .map(|r| r.rows_affected())
    }

    /// Renumber one item scope densely by current relative order — the
    /// item-side twin of [`Self::renumber_folder_scope`]: a write that
    /// removes an item from a scope closes its gap; scopes no write
    /// touched never rewrite.
    async fn renumber_item_scope(
        tx: &mut sqlx::SqliteConnection,
        share_id: &str,
        folder_id: Option<&str>,
    ) -> sqlx::Result<u64> {
        sqlx::query(
            "UPDATE share_items SET position = ( \
                 SELECT COUNT(*) FROM share_items s2 \
                     WHERE s2.share_id = share_items.share_id \
                       AND s2.folder_id IS share_items.folder_id \
                       AND s2.position < share_items.position \
             ) WHERE share_id = ? AND folder_id IS ?",
        )
        .bind(share_id)
        .bind(folder_id)
        .execute(tx)
        .await
        .map(|r| r.rows_affected())
    }

    /// Constraint-violation backstop: a folder write that loses a
    /// sibling-name race trips the partial unique index and surfaces as
    /// the same friendly duplicate the pre-check reports. Every other
    /// database error passes through untouched.
    fn map_folder_write_err(err: sqlx::Error) -> FolderWriteError {
        // `as_database_error()` hands back `&dyn DatabaseError`, whose
        // methods are inherent on the trait object — no import needed.
        match err.as_database_error() {
            Some(db) if db.is_unique_violation() => FolderInvalid::DuplicateName.into(),
            _ => err.into(),
        }
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

fn row_to_folder(row: &sqlx::sqlite::SqliteRow) -> ShareFolderRow {
    ShareFolderRow {
        id: sqlx::Row::get(row, "id"),
        share_id: sqlx::Row::get(row, "share_id"),
        parent_id: sqlx::Row::get(row, "parent_id"),
        name: sqlx::Row::get(row, "name"),
        position: sqlx::Row::get(row, "position"),
        created_at: sqlx::Row::get(row, "created_at"),
    }
}

/// Trim a folder name and check its shape (1..=200 chars after trim).
/// Returns the trimmed form ready to store, or `None` when invalid.
fn valid_folder_name(name: &str) -> Option<&str> {
    let trimmed = name.trim();
    (1..=200).contains(&trimmed.chars().count()).then_some(trimmed)
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
        // OR IGNORE: a second call (extra videos seeded mid-test) must
        // not trip the connection row's primary key.
        sqlx::query(
            "INSERT OR IGNORE INTO provider_connections (id, provider, token_bundle, connected_at) \
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

    // ---- Folders (0016) ----

    /// Unwrap the expected validation rejection out of a folder write.
    fn expect_invalid(
        result: Result<Option<ShareFolderRow>, FolderWriteError>,
    ) -> FolderInvalid {
        match result {
            Err(FolderWriteError::Invalid(e)) => e,
            other => panic!("expected a validation rejection, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_root_and_nested_folders_round_trip_via_list_folders() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        let day1 = repo
            .create_folder(&owner.to_string(), &share.id, None, "  Day 1  ")
            .await
            .unwrap()
            .expect("root folder creates");
        assert_eq!(day1.name, "Day 1", "names are stored trimmed");
        assert_eq!(day1.parent_id, None);
        assert_eq!(day1.position, 0, "first root folder appends at 0");

        let day2 = repo
            .create_folder(&owner.to_string(), &share.id, None, "Day 2")
            .await
            .unwrap()
            .expect("second root folder creates");
        assert_eq!(day2.position, 1, "roots append in creation order");

        let morning = repo
            .create_folder(&owner.to_string(), &share.id, Some(&day1.id), "Morning")
            .await
            .unwrap()
            .expect("nested folder creates");
        assert_eq!(morning.parent_id.as_deref(), Some(day1.id.as_str()));
        assert_eq!(morning.position, 0, "nested scope numbers from 0");

        // The same name in a different scope is not a duplicate.
        repo.create_folder(&owner.to_string(), &share.id, Some(&day2.id), "Morning")
            .await
            .unwrap()
            .expect("same name under a different parent is fine");

        let folders = repo.list_folders(&share.id).await.unwrap();
        assert_eq!(folders.len(), 4);
        // Roots first (NULL parent sorts first), then nested groups.
        assert_eq!(
            folders.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec!["Day 1", "Day 2", "Morning", "Morning"],
            "ordered by (parent_id, position)"
        );
        assert!(folders.iter().all(|f| !f.created_at.is_empty()));

        // Items list carries placement — None until an owner moves
        // something (task 002 wires the move).
        let items = repo.list_items(&share.id).await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].folder_id, None, "flat share items sit at root");
    }

    #[tokio::test]
    async fn rename_folder_keeps_parent_and_position() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        let first = repo
            .create_folder(&owner.to_string(), &share.id, None, "First")
            .await
            .unwrap()
            .unwrap();
        repo.create_folder(&owner.to_string(), &share.id, None, "Second")
            .await
            .unwrap()
            .unwrap();

        let renamed = repo
            .rename_folder(&owner.to_string(), &share.id, &first.id, " Renamed ")
            .await
            .unwrap()
            .expect("rename returns the updated row");
        assert_eq!(renamed.name, "Renamed", "rename trims and stores");
        assert_eq!(renamed.parent_id, None);
        assert_eq!(renamed.position, 0, "rename does not reorder");
        assert_eq!(renamed.id, first.id);

        let folders = repo.list_folders(&share.id).await.unwrap();
        assert_eq!(
            folders.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec!["Renamed", "Second"],
            "only the name changed — position 0 still sorts first"
        );
    }

    #[tokio::test]
    async fn reparent_appends_at_end_of_new_sibling_group_preserving_internal_order() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        // Root group: x(0), y(1). Trip holds kids a(0), b(1).
        let x = repo
            .create_folder(&owner.to_string(), &share.id, None, "x")
            .await
            .unwrap()
            .unwrap();
        let y = repo
            .create_folder(&owner.to_string(), &share.id, None, "y")
            .await
            .unwrap()
            .unwrap();
        let trip = repo
            .create_folder(&owner.to_string(), &share.id, None, "trip")
            .await
            .unwrap()
            .unwrap();
        let kid_a = repo
            .create_folder(&owner.to_string(), &share.id, Some(&trip.id), "a")
            .await
            .unwrap()
            .unwrap();
        let kid_b = repo
            .create_folder(&owner.to_string(), &share.id, Some(&trip.id), "b")
            .await
            .unwrap()
            .unwrap();

        // Move `y` under `trip`: lands after `b`, internal order of
        // trip's existing children untouched.
        let moved = repo
            .reparent_folder(&owner.to_string(), &share.id, &y.id, Some(&trip.id))
            .await
            .unwrap()
            .expect("reparent returns the updated row");
        assert_eq!(moved.parent_id.as_deref(), Some(trip.id.as_str()));
        assert_eq!(moved.position, 2, "appends at the end of the new group");

        let folders = repo.list_folders(&share.id).await.unwrap();
        let by_id = |id: &str| folders.iter().find(|f| f.id == id).unwrap();
        assert_eq!(by_id(&x.id).position, 0, "x keeps root position 0");
        assert_eq!(by_id(&trip.id).position, 1, "trip shifts up, untouched");
        assert_eq!(by_id(&kid_a.id).position, 0, "kid a internal order kept");
        assert_eq!(by_id(&kid_b.id).position, 1, "kid b internal order kept");
        assert_eq!(by_id(&y.id).position, 2);

        // Move `y` back to root: appends after the last root sibling.
        let back = repo
            .reparent_folder(&owner.to_string(), &share.id, &y.id, None)
            .await
            .unwrap()
            .expect("move to root works");
        assert_eq!(back.parent_id, None);
        assert_eq!(back.position, 2, "root scope now x(0), trip(1), y(2)");
    }

    #[tokio::test]
    async fn invalid_folder_shapes_are_rejected_with_friendly_results() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        use FolderInvalid::{Depth, DuplicateName, Name};

        assert_eq!(
            expect_invalid(repo.create_folder(&owner.to_string(), &share.id, None, "")
                .await),
            Name,
            "empty name rejected"
        );
        assert_eq!(
            expect_invalid(repo.create_folder(&owner.to_string(), &share.id, None, "   \t ")
                .await),
            Name,
            "whitespace-only name rejected"
        );
        assert_eq!(
            expect_invalid(repo.create_folder(&owner.to_string(), &share.id, None, &"x".repeat(201))
                .await),
            Name,
            "201 chars rejected"
        );
        repo.create_folder(&owner.to_string(), &share.id, None, &"x".repeat(200))
            .await
            .unwrap()
            .expect("exactly 200 chars is legal");

        assert_eq!(
            expect_invalid(
                repo.create_folder(&owner.to_string(), &share.id, None, &"x".repeat(200))
                    .await
            ),
            DuplicateName,
            "sibling duplicate rejected"
        );

        // Case-sensitive uniqueness — POSIX-ish.
        repo.create_folder(&owner.to_string(), &share.id, None, "X")
            .await
            .unwrap()
            .expect("case differs, not a duplicate");

        // Depth boundary: a chain of 8 is legal, the 9th is not.
        let mut parent = repo
            .create_folder(&owner.to_string(), &share.id, None, "d1")
            .await
            .unwrap()
            .unwrap();
        for depth in 2..=8 {
            parent = repo
                .create_folder(&owner.to_string(), &share.id, Some(&parent.id), &format!("d{depth}"))
                .await
                .unwrap()
                .unwrap_or_else(|| panic!("depth {depth} must be legal"));
        }
        assert_eq!(
            expect_invalid(repo.create_folder(&owner.to_string(), &share.id, Some(&parent.id), "d9")
                .await),
            Depth,
            "depth 9 rejected at the boundary"
        );

        // Reparent depth: a 2-high subtree under the depth-7 node would
        // reach 9.
        let chain7 = repo
            .list_folders(&share.id)
            .await
            .unwrap()
            .into_iter()
            .find(|f| f.name == "d7")
            .unwrap();
        let sub_root = repo
            .create_folder(&owner.to_string(), &share.id, None, "sub")
            .await
            .unwrap()
            .unwrap();
        repo.create_folder(&owner.to_string(), &share.id, Some(&sub_root.id), "sub2")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            expect_invalid(repo.reparent_folder(&owner.to_string(), &share.id, &sub_root.id, Some(&chain7.id))
                .await),
            Depth,
            "subtree height counts toward the cap"
        );

        // Cycles: onto itself, onto a child, onto a deep descendant.
        let d1 = repo
            .list_folders(&share.id)
            .await
            .unwrap()
            .into_iter()
            .find(|f| f.name == "d1")
            .unwrap();
        let d2 = repo
            .list_folders(&share.id)
            .await
            .unwrap()
            .into_iter()
            .find(|f| f.name == "d2")
            .unwrap();
        assert_eq!(
            expect_invalid(repo.reparent_folder(&owner.to_string(), &share.id, &d1.id, Some(&d1.id))
                .await),
            FolderInvalid::Cycle,
            "self reparent rejected"
        );
        assert_eq!(
            expect_invalid(repo.reparent_folder(&owner.to_string(), &share.id, &d1.id, Some(&d2.id))
                .await),
            FolderInvalid::Cycle,
            "reparent onto own child rejected"
        );
        assert_eq!(
            expect_invalid(repo.reparent_folder(&owner.to_string(), &share.id, &d1.id, Some(&parent.id))
                .await),
            FolderInvalid::Cycle,
            "reparent onto deep descendant rejected"
        );
    }

    #[tokio::test]
    async fn rename_onto_a_sibling_name_hits_the_friendly_precheck() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        let a = repo
            .create_folder(&owner.to_string(), &share.id, None, "one")
            .await
            .unwrap()
            .unwrap();
        let b = repo
            .create_folder(&owner.to_string(), &share.id, None, "two")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            expect_invalid(repo.rename_folder(&owner.to_string(), &share.id, &a.id, "two")
                .await),
            FolderInvalid::DuplicateName,
            "rename onto a sibling's name is the friendly duplicate"
        );
        // Renaming to one's own name is a no-op, not a duplicate.
        repo.rename_folder(&owner.to_string(), &share.id, &b.id, "two")
            .await
            .unwrap()
            .expect("own name does not trip the sibling check");
    }

    /// The PATCH route's combined write: one transaction renames AND
    /// reparents, with the sibling-name check for the reparent run
    /// against the NEW name in the TARGET scope.
    #[tokio::test]
    async fn update_folder_renames_and_reparents_in_one_write() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        // Root: trip(0), holder(1). trip already has a child "memo".
        let trip = repo
            .create_folder(&owner.to_string(), &share.id, None, "trip")
            .await
            .unwrap()
            .unwrap();
        let holder = repo
            .create_folder(&owner.to_string(), &share.id, None, "holder")
            .await
            .unwrap()
            .unwrap();
        repo.create_folder(&owner.to_string(), &share.id, Some(&trip.id), "memo")
            .await
            .unwrap()
            .unwrap();

        // Rename `holder` → `memo` AND move it under `trip` in one
        // write: the target scope already owns a "memo", so the
        // combined check must see the NEW name colliding.
        assert_eq!(
            expect_invalid(
                repo.update_folder(
                    &owner.to_string(),
                    &share.id,
                    &holder.id,
                    Some("memo"),
                    Some(Some(&trip.id)),
                )
                .await
            ),
            FolderInvalid::DuplicateName,
            "combined write checks the new name in the target scope"
        );

        // Non-colliding combo succeeds atomically: name + parent land
        // together, position appends in the target scope.
        let updated = repo
            .update_folder(
                &owner.to_string(),
                &share.id,
                &holder.id,
                Some(" holder2 "),
                Some(Some(&trip.id)),
            )
            .await
            .unwrap()
            .expect("combined write returns the updated row");
        assert_eq!(updated.name, "holder2", "name trimmed and stored");
        assert_eq!(updated.parent_id.as_deref(), Some(trip.id.as_str()));
        assert_eq!(updated.position, 1, "appends after trip's existing child");

        let folders = repo.list_folders(&share.id).await.unwrap();
        assert_eq!(
            folders.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec!["trip", "memo", "holder2"],
            "root gap closed, target scope dense"
        );

        // No-op PATCH (both fields absent) is a clean pass-through.
        let untouched = repo
            .update_folder(&owner.to_string(), &share.id, &holder.id, None, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(untouched, updated, "absent fields leave the row alone");

        // Explicit null parent in a combined write moves to root.
        let to_root = repo
            .update_folder(
                &owner.to_string(),
                &share.id,
                &holder.id,
                None,
                Some(None),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(to_root.parent_id, None);
        assert_eq!(to_root.position, 1, "root tail after trip(0)");
    }

    /// The partial unique index is the race-proof backstop: a rename the
    /// pre-check never saw (raw SQL, simulating the losing side of a
    /// concurrent write) must still fail at the constraint.
    #[tokio::test]
    async fn the_unique_index_rejects_a_raw_rename_onto_a_siblings_name() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        let a = repo
            .create_folder(&owner.to_string(), &share.id, None, "one")
            .await
            .unwrap()
            .unwrap();
        repo.create_folder(&owner.to_string(), &share.id, None, "two")
            .await
            .unwrap()
            .unwrap();

        let raw = sqlx::query("UPDATE share_folders SET name = 'two' WHERE id = ?")
            .bind(&a.id)
            .execute(&pool)
            .await;
        assert!(raw.is_err(), "the sibling unique index must reject");
    }

    #[tokio::test]
    async fn folder_writes_on_foreign_missing_or_terminal_targets_are_no_ops() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let stranger = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        let other = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        let foreign_folder = repo
            .create_folder(&owner.to_string(), &other.id, None, "theirs")
            .await
            .unwrap()
            .unwrap();
        let revoked = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        repo.revoke(&revoked.id).await.unwrap();

        // Guard rejections are Ok(None) — never errors, no leak between
        // "missing" and "foreign".
        assert!(repo
            .create_folder(&stranger.to_string(), &share.id, None, "n")
            .await
            .unwrap()
            .is_none(), "foreign owner writes nothing");
        assert!(repo
            .create_folder(&owner.to_string(), "missing-share", None, "n")
            .await
            .unwrap()
            .is_none(), "unknown share is a no-op");
        assert!(repo
            .create_folder(&owner.to_string(), &revoked.id, None, "n")
            .await
            .unwrap()
            .is_none(), "revoked share is a no-op");
        assert!(repo
            .create_folder(&owner.to_string(), &share.id, Some(&foreign_folder.id), "n")
            .await
            .unwrap()
            .is_none(), "a folder from another share cannot parent");
        assert!(repo
            .create_folder(&owner.to_string(), &share.id, Some("missing-folder"), "n")
            .await
            .unwrap()
            .is_none(), "unknown parent folder is a no-op");

        assert!(repo
            .rename_folder(&owner.to_string(), &share.id, "missing-folder", "n")
            .await
            .unwrap()
            .is_none(), "rename of unknown folder is a no-op");
        assert!(repo
            .rename_folder(&owner.to_string(), &share.id, &foreign_folder.id, "n")
            .await
            .unwrap()
            .is_none(), "rename scoped to this share's folders");
        assert!(repo
            .rename_folder(&stranger.to_string(), &share.id, &foreign_folder.id, "n")
            .await
            .unwrap()
            .is_none());

        assert!(repo
            .reparent_folder(&owner.to_string(), &share.id, "missing-folder", None)
            .await
            .unwrap()
            .is_none(), "reparent of unknown folder is a no-op");
        assert!(repo
            .reparent_folder(&owner.to_string(), &share.id, &foreign_folder.id, None)
            .await
            .unwrap()
            .is_none(), "reparent scoped to this share's folders");

        // Nothing leaked into either share's tree.
        assert_eq!(repo.list_folders(&share.id).await.unwrap().len(), 0);
        assert_eq!(repo.list_folders(&other.id).await.unwrap().len(), 1);
        assert_eq!(repo.list_folders(&revoked.id).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn purging_a_share_cascades_its_folders() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        let root = repo
            .create_folder(&owner.to_string(), &share.id, None, "root")
            .await
            .unwrap()
            .unwrap();
        repo.create_folder(&owner.to_string(), &share.id, Some(&root.id), "nested")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            repo.purge_owned(&owner.to_string(), &share.id)
                .await
                .unwrap(),
            1
        );
        assert!(
            repo.list_folders(&share.id).await.unwrap().is_empty(),
            "share purge cascades the folder tree (migration FK)"
        );
    }

    // ---- Placement-aware write semantics (task 002) ----

    /// `(video_id, folder_id, position)` for every item, keyed lookup
    /// helper for the placement assertions below.
    fn placement(items: &[ShareItemRow]) -> Vec<(String, Option<String>, i64)> {
        items
            .iter()
            .map(|i| (i.video_id.clone(), i.folder_id.clone(), i.position))
            .collect()
    }

    fn placement_of(items: &[ShareItemRow], video_id: &str) -> (Option<String>, i64) {
        let i = items
            .iter()
            .find(|i| i.video_id == video_id)
            .unwrap_or_else(|| panic!("video {video_id} should be a member"));
        (i.folder_id.clone(), i.position)
    }

    #[tokio::test]
    async fn replace_items_is_a_diff_that_preserves_folder_placement() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(
            &pool,
            &["a.mp4", "b.mp4", "c.mp4", "d.mp4", "e.mp4", "f.mp4"],
        )
        .await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        let trip = repo
            .create_folder(&owner.to_string(), &share.id, None, "Trip")
            .await
            .unwrap()
            .unwrap();
        let night = repo
            .create_folder(&owner.to_string(), &share.id, Some(&trip.id), "Night")
            .await
            .unwrap()
            .unwrap();

        // Placement: a,e at root; b,c,f in Trip; d in Night.
        for (vid, folder) in [
            (&videos[1], Some(&trip.id)),
            (&videos[2], Some(&trip.id)),
            (&videos[5], Some(&trip.id)),
            (&videos[3], Some(&night.id)),
        ] {
            repo.move_item(&owner.to_string(), &share.id, vid, folder.map(|s| s.as_str()))
                .await
                .unwrap()
                .expect("seeding move succeeds");
        }

        // Replace: drop `b`, reorder the survivors, interleave a fresh
        // id BEFORE a root survivor (new ids must not jump the queue
        // of the caller's curation order).
        let extra = seed_videos(&pool, &["g.mp4"]).await;
        let swapped = vec![
            videos[4].clone(), // e (root survivor)
            extra[0].clone(),  // g (new → root, in array position)
            videos[0].clone(), // a (root survivor)
            videos[3].clone(), // d (Night survivor)
            videos[5].clone(), // f (Trip survivor)
            videos[2].clone(), // c (Trip survivor)
        ];
        repo.replace_items(&owner.to_string(), &share.id, &swapped)
            .await
            .unwrap();

        let items = repo.list_items(&share.id).await.unwrap();
        assert_eq!(items.len(), 6, "b left, g joined");
        // Survivors keep their folders; per-scope positions follow the
        // caller's relative order; new ids slot into the root scope in
        // array order.
        assert_eq!(placement_of(&items, &videos[4]), (None, 0), "e — root, first");
        assert_eq!(placement_of(&items, &extra[0]), (None, 1), "g — new, in place");
        assert_eq!(placement_of(&items, &videos[0]), (None, 2), "a — root, after g");
        assert_eq!(
            placement_of(&items, &videos[3]),
            (Some(night.id.clone()), 0),
            "d — Night keeps placement, dense in scope"
        );
        assert_eq!(
            placement_of(&items, &videos[5]),
            (Some(trip.id.clone()), 0),
            "f — Trip, ahead of c in caller order"
        );
        assert_eq!(
            placement_of(&items, &videos[2]),
            (Some(trip.id.clone()), 1),
            "c — Trip, after f in caller order"
        );
        assert!(
            !repo.is_member(&share.id, &videos[1]).await.unwrap(),
            "dropped id lost membership"
        );
    }

    #[tokio::test]
    async fn append_items_appends_at_the_root_scope_tail() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4", "b.mp4", "c.mp4", "d.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos[..3]))
            .await
            .unwrap();
        let trip = repo
            .create_folder(&owner.to_string(), &share.id, None, "Trip")
            .await
            .unwrap()
            .unwrap();
        repo.move_item(&owner.to_string(), &share.id, &videos[2], Some(&trip.id))
            .await
            .unwrap()
            .unwrap();

        repo.append_items(&owner.to_string(), &share.id, &videos[3..])
            .await
            .unwrap();

        let items = repo.list_items(&share.id).await.unwrap();
        // Root scope renumbered densely when c left (a 0, b 1); d
        // appends at the ROOT tail (2) — not past the folder item's
        // position — and lands at root scope like every append.
        assert_eq!(placement_of(&items, &videos[0]), (None, 0));
        assert_eq!(placement_of(&items, &videos[1]), (None, 1));
        assert_eq!(placement_of(&items, &videos[3]), (None, 2), "root-tail append");
        assert_eq!(
            placement_of(&items, &videos[2]),
            (Some(trip.id.clone()), 0),
            "folder item untouched by the append"
        );
    }

    #[tokio::test]
    async fn delete_folder_lifts_contents_to_root_in_subtree_order() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(
            &pool,
            &["r0.mp4", "r1.mp4", "d0.mp4", "d1.mp4", "ia.mp4", "ib.mp4", "ig.mp4"],
        )
        .await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        // Tree: root: stay, del. del: c1, c2. c1: g.
        let stay = repo
            .create_folder(&owner.to_string(), &share.id, None, "stay")
            .await
            .unwrap()
            .unwrap();
        let del = repo
            .create_folder(&owner.to_string(), &share.id, None, "del")
            .await
            .unwrap()
            .unwrap();
        let c1 = repo
            .create_folder(&owner.to_string(), &share.id, Some(&del.id), "c1")
            .await
            .unwrap()
            .unwrap();
        let c2 = repo
            .create_folder(&owner.to_string(), &share.id, Some(&del.id), "c2")
            .await
            .unwrap()
            .unwrap();
        let g = repo
            .create_folder(&owner.to_string(), &share.id, Some(&c1.id), "g")
            .await
            .unwrap()
            .unwrap();

        // Items: r0,r1 at root; d0,d1 in del; ia in c1; ib in c2; ig in g.
        for (vid, folder) in [
            (&videos[2], Some(&del.id)),
            (&videos[3], Some(&del.id)),
            (&videos[4], Some(&c1.id)),
            (&videos[5], Some(&c2.id)),
            (&videos[6], Some(&g.id)),
        ] {
            repo.move_item(&owner.to_string(), &share.id, vid, folder.map(|s| s.as_str()))
                .await
                .unwrap()
                .unwrap();
        }

        let deleted = repo
            .delete_folder(&owner.to_string(), &share.id, &del.id)
            .await
            .unwrap()
            .expect("delete returns the removed row");
        assert_eq!(deleted.id, del.id);

        // Folders: descendants flatten to root in DFS pre-order —
        // c1, then its child g, then c2 — appended after `stay`.
        let folders = repo.list_folders(&share.id).await.unwrap();
        let root_order: Vec<(String, i64)> = folders
            .iter()
            .map(|f| (f.name.clone(), f.position))
            .collect();
        assert_eq!(
            root_order,
            vec![
                ("stay".to_string(), 0),
                ("c1".to_string(), 1),
                ("g".to_string(), 2),
                ("c2".to_string(), 3),
            ],
            "pre-order flatten: children before next sibling"
        );
        assert!(folders.iter().all(|f| f.parent_id.is_none()));

        // Items: all seven still members, lifted to root in subtree
        // pre-order (del's items, then c1's, then g's, then c2's),
        // appended after the existing root tail.
        let items = repo.list_items(&share.id).await.unwrap();
        assert_eq!(items.len(), 7, "membership never changes");
        assert!(items.iter().all(|i| i.folder_id.is_none()));
        assert_eq!(
            placement(&items),
            vec![
                (videos[0].clone(), None, 0),
                (videos[1].clone(), None, 1),
                (videos[2].clone(), None, 2), // d0
                (videos[3].clone(), None, 3), // d1
                (videos[4].clone(), None, 4), // ia (c1's item)
                (videos[6].clone(), None, 5), // ig (g's item — before c2's)
                (videos[5].clone(), None, 6), // ib
            ],
            "DFS pre-order lift with deterministic positions"
        );
        // The untouched root folder kept its position.
        let stay_row = folders.iter().find(|f| f.id == stay.id).unwrap();
        assert_eq!(stay_row.position, 0);
    }

    #[tokio::test]
    async fn delete_folder_decollides_flattened_names_at_root() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4", "b.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();

        // Root already owns "dup"; the subtree nests three more "dup"s
        // — each in its own scope, so creation is legal — plus a
        // "uniq". Deleting `del` flattens all of them to root.
        repo.create_folder(&owner.to_string(), &share.id, None, "dup")
            .await
            .unwrap()
            .unwrap();
        let del = repo
            .create_folder(&owner.to_string(), &share.id, None, "del")
            .await
            .unwrap()
            .unwrap();
        let dup_child = repo
            .create_folder(&owner.to_string(), &share.id, Some(&del.id), "dup")
            .await
            .unwrap()
            .unwrap();
        repo.create_folder(&owner.to_string(), &share.id, Some(&del.id), "uniq")
            .await
            .unwrap()
            .unwrap();
        let dup_grand = repo
            .create_folder(&owner.to_string(), &share.id, Some(&dup_child.id), "dup")
            .await
            .unwrap()
            .unwrap();
        repo.create_folder(&owner.to_string(), &share.id, Some(&dup_grand.id), "dup")
            .await
            .unwrap()
            .unwrap();

        repo.delete_folder(&owner.to_string(), &share.id, &del.id)
            .await
            .unwrap()
            .unwrap();

        // Flattened folders keep their names when free and take the
        // smallest deterministic suffix when taken — the delete must
        // never fail on the root sibling-name index. Order is the same
        // pre-order lift: dup-child, its dup, that one's dup, uniq.
        let folders = repo.list_folders(&share.id).await.unwrap();
        let names: Vec<&str> = folders.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["dup", "dup (2)", "dup (3)", "dup (4)", "uniq"],
            "original root dup, then deterministic suffixes in lift order"
        );
        assert!(folders.iter().all(|f| f.parent_id.is_none()));
    }

    #[tokio::test]
    async fn delete_folder_on_foreign_missing_or_terminal_targets_is_a_no_op() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let stranger = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        let other = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        let foreign_folder = repo
            .create_folder(&owner.to_string(), &other.id, None, "theirs")
            .await
            .unwrap()
            .unwrap();
        let mine = repo
            .create_folder(&owner.to_string(), &share.id, None, "mine")
            .await
            .unwrap()
            .unwrap();
        let revoked = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        let revoked_folder = repo
            .create_folder(&owner.to_string(), &revoked.id, None, "dead")
            .await
            .unwrap()
            .unwrap();
        repo.revoke(&revoked.id).await.unwrap();

        let missing_share = String::from("missing-share");
        let missing_folder = String::from("missing-folder");
        for (owner_id, share_id, folder_id) in [
            (&stranger.to_string(), &share.id, &mine.id),
            (&owner.to_string(), &missing_share, &mine.id),
            (&owner.to_string(), &revoked.id, &revoked_folder.id),
            (&owner.to_string(), &share.id, &foreign_folder.id),
            (&owner.to_string(), &share.id, &missing_folder),
        ] {
            assert!(
                repo.delete_folder(owner_id, share_id, folder_id)
                    .await
                    .unwrap()
                    .is_none(),
                "guard rejection is a no-op, not an error"
            );
        }

        // Nothing was deleted anywhere.
        assert_eq!(repo.list_folders(&share.id).await.unwrap().len(), 1);
        assert_eq!(repo.list_folders(&other.id).await.unwrap().len(), 1);
        assert_eq!(repo.list_folders(&revoked.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn move_item_sets_scope_appends_at_target_tail_and_renumbers_the_vacated_scope() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4", "b.mp4", "c.mp4", "d.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        let f = repo
            .create_folder(&owner.to_string(), &share.id, None, "F")
            .await
            .unwrap()
            .unwrap();

        // a,b into F in that order: F scope a(0) b(1); root renumbers
        // densely behind them → c(0) d(1).
        repo.move_item(&owner.to_string(), &share.id, &videos[0], Some(&f.id))
            .await
            .unwrap()
            .unwrap();
        repo.move_item(&owner.to_string(), &share.id, &videos[1], Some(&f.id))
            .await
            .unwrap()
            .unwrap();
        let items = repo.list_items(&share.id).await.unwrap();
        assert_eq!(placement_of(&items, &videos[0]), (Some(f.id.clone()), 0));
        assert_eq!(placement_of(&items, &videos[1]), (Some(f.id.clone()), 1));
        assert_eq!(placement_of(&items, &videos[2]), (None, 0), "root renumbered");
        assert_eq!(placement_of(&items, &videos[3]), (None, 1));

        // a back to root: appends at the root tail.
        let moved = repo
            .move_item(&owner.to_string(), &share.id, &videos[0], None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(moved.folder_id, None);
        assert_eq!(moved.position, 2, "root tail append");
        let items = repo.list_items(&share.id).await.unwrap();
        assert_eq!(
            placement_of(&items, &videos[1]),
            (Some(f.id.clone()), 0),
            "F scope renumbered behind the departed item"
        );

        // Guard no-ops: stranger, missing share, revoked share,
        // non-member video, foreign folder.
        let stranger = seed_owner(&pool).await;
        let outsider = seed_videos(&pool, &["z.mp4"]).await;
        let other = repo
            .create_share(&new_share(&owner, &any_hash(), &videos[..1]))
            .await
            .unwrap();
        let foreign_folder = repo
            .create_folder(&owner.to_string(), &other.id, None, "theirs")
            .await
            .unwrap()
            .unwrap();
        let revoked = repo
            .create_share(&new_share(&owner, &any_hash(), &videos[..1]))
            .await
            .unwrap();
        repo.revoke(&revoked.id).await.unwrap();

        let missing_share = String::from("missing-share");
        let missing_folder = String::from("missing-folder");
        for (owner_id, share_id, video_id, folder_id) in [
            (&stranger.to_string(), &share.id, &videos[0], Some(&f.id)),
            (&owner.to_string(), &missing_share, &videos[0], Some(&f.id)),
            (&owner.to_string(), &revoked.id, &videos[0], Some(&f.id)),
            (&owner.to_string(), &share.id, &outsider[0], Some(&f.id)),
            (&owner.to_string(), &share.id, &videos[0], Some(&foreign_folder.id)),
            (&owner.to_string(), &share.id, &videos[0], Some(&missing_folder)),
        ] {
            assert!(
                repo.move_item(owner_id, share_id, video_id, folder_id.map(|s| s.as_str()))
                    .await
                    .unwrap()
                    .is_none(),
                "guard rejection is a no-op, not an error"
            );
        }
        let items = repo.list_items(&share.id).await.unwrap();
        assert_eq!(placement_of(&items, &videos[0]), (None, 2), "untouched");
    }

    #[tokio::test]
    async fn remove_item_deletes_renumbers_and_guards_the_last_item() {
        let (pool, _guard) = fresh_pool().await;
        let repo = ShareRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let videos = seed_videos(&pool, &["a.mp4", "b.mp4", "c.mp4"]).await;
        let share = repo
            .create_share(&new_share(&owner, &any_hash(), &videos))
            .await
            .unwrap();
        let f = repo
            .create_folder(&owner.to_string(), &share.id, None, "F")
            .await
            .unwrap()
            .unwrap();
        repo.move_item(&owner.to_string(), &share.id, &videos[0], Some(&f.id))
            .await
            .unwrap()
            .unwrap();
        repo.move_item(&owner.to_string(), &share.id, &videos[1], Some(&f.id))
            .await
            .unwrap()
            .unwrap();

        // Granular removal: a leaves; the F scope renumbers behind it.
        assert_eq!(
            repo.remove_item(&owner.to_string(), &share.id, &videos[0])
                .await
                .unwrap(),
            RemovedItem::Removed
        );
        let items = repo.list_items(&share.id).await.unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(
            placement_of(&items, &videos[1]),
            (Some(f.id.clone()), 0),
            "vacated scope renumbers densely"
        );

        // A non-member video is a rejection (route: 404).
        let outsider = seed_videos(&pool, &["z.mp4"]).await;
        assert_eq!(
            repo.remove_item(&owner.to_string(), &share.id, &outsider[0])
                .await
                .unwrap(),
            RemovedItem::Rejected
        );

        // Whittling down to one member: that last removal is refused.
        assert_eq!(
            repo.remove_item(&owner.to_string(), &share.id, &videos[1])
                .await
                .unwrap(),
            RemovedItem::Removed
        );
        assert_eq!(
            repo.remove_item(&owner.to_string(), &share.id, &videos[2])
                .await
                .unwrap(),
            RemovedItem::LastItem,
            "the last item cannot be removed — revoke instead"
        );
        assert_eq!(repo.list_items(&share.id).await.unwrap().len(), 1);
        assert!(repo.is_member(&share.id, &videos[2]).await.unwrap());

        // Guard rejections: stranger, missing share, revoked share.
        let stranger = seed_owner(&pool).await;
        let revoked = repo
            .create_share(&new_share(&owner, &any_hash(), &videos[..1]))
            .await
            .unwrap();
        repo.revoke(&revoked.id).await.unwrap();
        assert_eq!(
            repo.remove_item(&stranger.to_string(), &share.id, &videos[2])
                .await
                .unwrap(),
            RemovedItem::Rejected
        );
        assert_eq!(
            repo.remove_item(&owner.to_string(), "missing-share", &videos[2])
                .await
                .unwrap(),
            RemovedItem::Rejected
        );
        assert_eq!(
            repo.remove_item(&owner.to_string(), &revoked.id, &videos[0])
                .await
                .unwrap(),
            RemovedItem::Rejected
        );
        assert_eq!(repo.list_items(&share.id).await.unwrap().len(), 1);
    }
}
