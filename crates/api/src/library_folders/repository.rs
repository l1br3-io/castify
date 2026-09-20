//! `LibraryFolderRepository` — all SQL for the curated library-folder
//! tree and item placement.
//!
//! The share-folders repository mechanics adapted to library scale:
//! stateless struct over the pool, runtime `sqlx::query` (no compile-time
//! DB), tests beside the code on a real temp-file SQLite. Scope is the
//! owner (`owner_id`), not a share — there is no liveness state to guard,
//! only ownership. Writes happen only on owner actions (create, rename,
//! reparent, delete, batch move); scans never write placement.

use chrono::Utc;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// A curated folder row. `parent_id: None` = tree root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibraryFolderRow {
    pub id: String,
    pub owner_id: String,
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
/// (same layering as the shares repository). Routes map each variant to
/// its 4xx; guard failures are NOT this — they are `Ok(None)`.
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
/// infrastructure passthrough. Scoping outcomes (unknown folder id,
/// folder owned by another owner) are deliberately NOT errors — methods
/// return `Ok(None)` for those, the same no-leak shape as the shares
/// repository.
#[derive(Debug, thiserror::Error)]
pub enum FolderWriteError {
    #[error(transparent)]
    Invalid(#[from] FolderInvalid),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

/// A folder row's raw columns for the in-memory subtree walk:
/// `(id, parent_id, name, position)`.
type SubtreeNode = (String, Option<String>, String, i64);

#[derive(Clone)]
pub struct LibraryFolderRepository {
    pool: SqlitePool,
}

impl LibraryFolderRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Owner-scoped folder create (one transaction: guard, validate,
    /// append). `parent_id: None` creates at the tree root. The name is
    /// trimmed and must be 1..=200 chars; sibling names are unique within
    /// a scope (case-sensitive); depth is capped at 8.
    ///
    /// Returns the stored row, or `Ok(None)` when the guard rejects the
    /// write — the parent folder is unknown or owned by another owner
    /// (indistinguishable by design, no existence leak). Validation
    /// failures come back as [`FolderInvalid`] via
    /// [`FolderWriteError::Invalid`].
    pub async fn create_folder(
        &self,
        owner_id: &str,
        parent_id: Option<&str>,
        name: &str,
    ) -> Result<Option<LibraryFolderRow>, FolderWriteError> {
        let mut tx = self.pool.begin().await?;
        if let Some(pid) = parent_id {
            // An unknown or foreign parent folder is a no-op — never an
            // error, no existence leak (owner scoping doubles as the
            // guard: there is no liveness state to check).
            if Self::fetch_folder(&mut tx, owner_id, pid).await?.is_none() {
                // Dropping the tx rolls back — nothing was written.
                return Ok(None);
            }
            // New folder's depth = the parent's ancestor chain (parent
            // included) + this folder.
            if Self::ancestor_chain_len(&mut tx, owner_id, pid).await? + 1 > MAX_FOLDER_DEPTH {
                return Err(FolderInvalid::Depth.into());
            }
        }
        let name = valid_folder_name(name).ok_or(FolderInvalid::Name)?;
        if Self::sibling_name_taken(&mut tx, owner_id, parent_id, name, None).await? {
            return Err(FolderInvalid::DuplicateName.into());
        }
        let position = Self::next_folder_position(&mut tx, owner_id, parent_id).await?;
        let id = Uuid::new_v4().to_string();
        let created_at = iso_now();
        sqlx::query(
            "INSERT INTO library_folders (id, owner_id, parent_id, name, position, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(owner_id)
        .bind(parent_id)
        .bind(name)
        .bind(position)
        .bind(&created_at)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_folder_write_err)?;
        tx.commit().await?;

        Ok(Some(LibraryFolderRow {
            id,
            owner_id: owner_id.to_string(),
            parent_id: parent_id.map(str::to_string),
            name: name.to_string(),
            position,
            created_at,
        }))
    }

    /// Owner-scoped folder rename (one transaction). Thin wrapper over
    /// [`Self::update_folder`] — see there for the shared ladder.
    /// `Ok(None)` = guard rejection (folder id unknown/foreign).
    pub async fn rename_folder(
        &self,
        owner_id: &str,
        folder_id: &str,
        name: &str,
    ) -> Result<Option<LibraryFolderRow>, FolderWriteError> {
        self.update_folder(owner_id, folder_id, Some(name), None)
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
        folder_id: &str,
        new_parent_id: Option<&str>,
    ) -> Result<Option<LibraryFolderRow>, FolderWriteError> {
        self.update_folder(owner_id, folder_id, None, Some(new_parent_id))
            .await
    }

    /// Owner-scoped folder update — the one-transaction write behind
    /// `PATCH /api/library-folders/{fid}`. Rename and reparent share
    /// this path so a PATCH carrying both fields is atomic: one guard,
    /// one sibling-name check per affected scope (the reparent's check
    /// runs against the NEW name in the TARGET scope), one update, one
    /// commit — a half-applied rename+move can never land.
    ///
    /// `name: Some(_)` renames (trim/length rules as create);
    /// `new_parent_id` distinguishes three states: `None` = leave the
    /// parent alone, `Some(None)` = move to the tree root,
    /// `Some(Some(id))` = move under that folder (appending at the end
    /// of its sibling group; the vacated scope renumbers densely;
    /// cycle/depth walks as create-with-parent). `Ok(None)` = guard
    /// rejection (folder/new-parent id unknown or foreign).
    pub async fn update_folder(
        &self,
        owner_id: &str,
        folder_id: &str,
        name: Option<&str>,
        new_parent_id: Option<Option<&str>>,
    ) -> Result<Option<LibraryFolderRow>, FolderWriteError> {
        let mut tx = self.pool.begin().await?;
        let Some(folder) = Self::fetch_folder(&mut tx, owner_id, folder_id).await? else {
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
                if Self::fetch_folder(&mut tx, owner_id, pid).await?.is_none() {
                    return Ok(None);
                }
                // Cycle: the new parent must not live inside the moved
                // folder's own subtree — one downward CTE covers self,
                // children, and every deeper descendant.
                if Self::subtree_contains(&mut tx, owner_id, folder_id, pid).await? {
                    return Err(FolderInvalid::Cycle.into());
                }
                // Depth: the new parent's ancestor chain (it included)
                // plus the moved subtree's height (folder included)
                // must stay within the cap.
                if Self::ancestor_chain_len(&mut tx, owner_id, pid).await?
                    + Self::subtree_height(&mut tx, owner_id, folder_id).await?
                    > MAX_FOLDER_DEPTH
                {
                    return Err(FolderInvalid::Depth.into());
                }
            }
            // Root moves can only reduce depth (the subtree was already
            // within the cap), so no walk is needed for `Some(None)`.
            if Self::sibling_name_taken(
                &mut tx,
                owner_id,
                new_parent,
                effective_name,
                Some(folder_id),
            )
            .await?
            {
                return Err(FolderInvalid::DuplicateName.into());
            }
            position = Self::next_folder_position(&mut tx, owner_id, new_parent).await?;
        } else if name.is_some() {
            // Rename-in-place: check the current scope with the new name.
            if Self::sibling_name_taken(
                &mut tx,
                owner_id,
                folder.parent_id.as_deref(),
                effective_name,
                Some(folder_id),
            )
            .await?
            {
                return Err(FolderInvalid::DuplicateName.into());
            }
        }

        sqlx::query(
            "UPDATE library_folders SET name = ?, parent_id = ?, position = ? WHERE id = ?",
        )
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
            Self::renumber_folder_scope(&mut tx, owner_id, folder.parent_id.as_deref()).await?;
        }
        tx.commit().await?;

        Ok(Some(LibraryFolderRow {
            name: effective_name.to_string(),
            parent_id: new_parent.map(str::to_string),
            position,
            ..folder
        }))
    }

    /// `DELETE /api/library-folders/{fid}` backing — delete a folder;
    /// its contained items return to **Unfiled** and its subfolders
    /// flatten to the root. Folder deletion is organization, never
    /// catalog: no `videos`/`files` row is removed, so playback, shares,
    /// search, and the all-videos grid are untouched. One transaction,
    /// ordered so the migration's `ON DELETE CASCADE` never fires:
    /// (1) collect the subtree with a single recursive CTE and pre-order
    /// it in memory (siblings by `position`, children before next
    /// sibling); (2) lift every contained item (videos and files) to
    /// Unfiled — a plain `SET library_folder_id = NULL`, no position
    /// bookkeeping, because only folders have positions in the curated
    /// model; (3) lift the descendants to root, appended after the
    /// existing root folders in the same order — a flattened name that
    /// collides at root takes the smallest `" (n)"` suffix, because the
    /// delete must stay a total operation, not fail on the sibling-name
    /// index; (4) delete the folder row itself (nothing references it
    /// anymore). The placement columns' `ON DELETE SET NULL` remains the
    /// documented safety net for paths that bypass this transaction.
    ///
    /// `Ok(None)` = guard rejection (folder id unknown or foreign) —
    /// same no-leak shape as every other folder write.
    pub async fn delete_folder(
        &self,
        owner_id: &str,
        folder_id: &str,
    ) -> Result<Option<LibraryFolderRow>, FolderWriteError> {
        let mut tx = self.pool.begin().await?;
        let Some(folder) = Self::fetch_folder(&mut tx, owner_id, folder_id).await? else {
            return Ok(None);
        };

        // Subtree membership via one recursive CTE; rows come back
        // unordered, the pre-order walk happens in memory (tree ≤
        // depth 8, personal-library cardinality — a Rust DFS beats
        // fighting CTE ordering semantics).
        let subtree: Vec<SubtreeNode> = sqlx::query(
            "WITH RECURSIVE subtree(id) AS ( \
                 SELECT id FROM library_folders WHERE id = ? AND owner_id = ? \
                 UNION \
                 SELECT f.id FROM library_folders f JOIN subtree s ON f.parent_id = s.id \
             ) SELECT f.id, f.parent_id, f.name, f.position FROM library_folders f \
             WHERE f.id IN (SELECT id FROM subtree)",
        )
        .bind(folder_id)
        .bind(owner_id)
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
        // flatten order (emit-on-visit, so each subtree fully drains
        // before the next sibling — children before next sibling).
        let mut children: HashMap<Option<&str>, Vec<&SubtreeNode>> = HashMap::new();
        for rec in &subtree {
            children.entry(rec.1.as_deref()).or_default().push(rec);
        }
        for group in children.values_mut() {
            group.sort_by_key(|rec| rec.3);
        }
        fn walk<'a>(
            children: &HashMap<Option<&'a str>, Vec<&'a SubtreeNode>>,
            parent: Option<&'a str>,
            out: &mut Vec<&'a (String, Option<String>, String, i64)>,
        ) {
            for rec in children.get(&parent).into_iter().flatten() {
                out.push(rec);
                walk(children, Some(rec.0.as_str()), out);
            }
        }
        let mut descendants: Vec<&SubtreeNode> = Vec::new();
        walk(&children, Some(folder_id), &mut descendants);

        // (2) Lift items to Unfiled: every video and file whose folder
        // sits in the subtree. Only folders have positions in the
        // curated model, so this is a plain placement clear — no
        // bookkeeping.
        for table in ["videos", "files"] {
            sqlx::query(&format!(
                "WITH RECURSIVE subtree(id) AS ( \
                     SELECT id FROM library_folders WHERE id = ? AND owner_id = ? \
                     UNION \
                     SELECT f.id FROM library_folders f JOIN subtree s ON f.parent_id = s.id \
                 ) UPDATE {table} SET library_folder_id = NULL \
                 WHERE library_folder_id IN (SELECT id FROM subtree)"
            ))
            .bind(folder_id)
            .bind(owner_id)
            .execute(&mut *tx)
            .await?;
        }

        // (3) Lift descendants to root, appended after the existing
        // root folders, names de-collided deterministically against
        // the root's taken names (existing + already lifted). The
        // doomed folder is excluded from both the tail and the name
        // set — it is not "existing" by the time the lift lands.
        let mut folder_position: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM library_folders \
             WHERE owner_id = ? AND parent_id IS NULL AND id != ?",
        )
        .bind(owner_id)
        .bind(folder_id)
        .fetch_one(&mut *tx)
        .await?;
        let mut root_names: HashSet<String> = sqlx::query_scalar(
            "SELECT name FROM library_folders WHERE owner_id = ? AND parent_id IS NULL AND id != ?",
        )
        .bind(owner_id)
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
                "UPDATE library_folders SET parent_id = NULL, position = ?, name = ? WHERE id = ?",
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
        sqlx::query("DELETE FROM library_folders WHERE id = ?")
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        Ok(Some(folder))
    }

    // -- Folder helpers: owner-scoped fetch and the single-CTE walks that
    // keep every tree check O(depth) statements.

    /// Owner-scoped folder fetch — a folder id owned by another owner is
    /// indistinguishable from an unknown one.
    async fn fetch_folder(
        tx: &mut sqlx::SqliteConnection,
        owner_id: &str,
        folder_id: &str,
    ) -> sqlx::Result<Option<LibraryFolderRow>> {
        let row = sqlx::query(
            "SELECT id, owner_id, parent_id, name, position, created_at \
             FROM library_folders WHERE id = ? AND owner_id = ?",
        )
        .bind(folder_id)
        .bind(owner_id)
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
        owner_id: &str,
        folder_id: &str,
    ) -> sqlx::Result<i64> {
        sqlx::query_scalar(
            "WITH RECURSIVE ancestors(id) AS ( \
                 SELECT id FROM library_folders WHERE id = ? AND owner_id = ? \
                 UNION \
                 SELECT f.parent_id FROM library_folders f \
                     JOIN ancestors a ON f.id = a.id \
                     WHERE f.parent_id IS NOT NULL \
             ) SELECT COUNT(*) FROM ancestors",
        )
        .bind(folder_id)
        .bind(owner_id)
        .fetch_one(tx)
        .await
    }

    /// Subtree height of `folder_id`, itself included — one downward
    /// recursive CTE. A missing folder measures 0.
    async fn subtree_height(
        tx: &mut sqlx::SqliteConnection,
        owner_id: &str,
        folder_id: &str,
    ) -> sqlx::Result<i64> {
        sqlx::query_scalar(
            "WITH RECURSIVE subtree(id, depth) AS ( \
                 SELECT id, 1 FROM library_folders WHERE id = ? AND owner_id = ? \
                 UNION ALL \
                 SELECT f.id, s.depth + 1 FROM library_folders f \
                     JOIN subtree s ON f.parent_id = s.id \
             ) SELECT COALESCE(MAX(depth), 0) FROM subtree",
        )
        .bind(folder_id)
        .bind(owner_id)
        .fetch_one(tx)
        .await
    }

    /// Does `folder_id`'s subtree (itself included) contain `candidate`?
    /// The reparent cycle check — one downward recursive CTE.
    async fn subtree_contains(
        tx: &mut sqlx::SqliteConnection,
        owner_id: &str,
        folder_id: &str,
        candidate: &str,
    ) -> sqlx::Result<bool> {
        sqlx::query_scalar(
            "WITH RECURSIVE tree(id) AS ( \
                 SELECT id FROM library_folders WHERE id = ? AND owner_id = ? \
                 UNION \
                 SELECT f.id FROM library_folders f JOIN tree t ON f.parent_id = t.id \
             ) SELECT EXISTS(SELECT 1 FROM tree WHERE id = ?)",
        )
        .bind(folder_id)
        .bind(owner_id)
        .bind(candidate)
        .fetch_one(tx)
        .await
    }

    /// Sibling-name pre-check within one scope (root when `parent_id` is
    /// `None`). `exclude_folder` spares the folder itself on
    /// rename/reparent — keeping one's own name is not a collision.
    async fn sibling_name_taken(
        tx: &mut sqlx::SqliteConnection,
        owner_id: &str,
        parent_id: Option<&str>,
        name: &str,
        exclude_folder: Option<&str>,
    ) -> sqlx::Result<bool> {
        let sql = match exclude_folder {
            Some(_) => concat!(
                "SELECT EXISTS(SELECT 1 FROM library_folders ",
                "WHERE owner_id = ? AND parent_id IS ? AND name = ? AND id != ?)"
            ),
            None => concat!(
                "SELECT EXISTS(SELECT 1 FROM library_folders ",
                "WHERE owner_id = ? AND parent_id IS ? AND name = ?)"
            ),
        };
        let mut q = sqlx::query_scalar(sql)
            .bind(owner_id)
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
        owner_id: &str,
        parent_id: Option<&str>,
    ) -> sqlx::Result<i64> {
        sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM library_folders \
             WHERE owner_id = ? AND parent_id IS ?",
        )
        .bind(owner_id)
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
        owner_id: &str,
        parent_id: Option<&str>,
    ) -> sqlx::Result<u64> {
        sqlx::query(
            "UPDATE library_folders SET position = ( \
                 SELECT COUNT(*) FROM library_folders s2 \
                     WHERE s2.owner_id = library_folders.owner_id \
                       AND s2.parent_id IS library_folders.parent_id \
                       AND s2.position < library_folders.position \
             ) WHERE owner_id = ? AND parent_id IS ?",
        )
        .bind(owner_id)
        .bind(parent_id)
        .execute(tx)
        .await
        .map(|r| r.rows_affected())
    }

    /// Constraint-violation backstop: a folder write that loses a
    /// sibling-name race trips the partial unique index and surfaces as
    /// the same friendly duplicate the pre-check reports. Every other
    /// database error passes through untouched.
    fn map_folder_write_err(err: sqlx::Error) -> FolderWriteError {
        match err.as_database_error() {
            Some(db) if db.is_unique_violation() => FolderInvalid::DuplicateName.into(),
            _ => err.into(),
        }
    }
}

fn row_to_folder(row: &sqlx::sqlite::SqliteRow) -> LibraryFolderRow {
    LibraryFolderRow {
        id: sqlx::Row::get(row, "id"),
        owner_id: sqlx::Row::get(row, "owner_id"),
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
    (1..=200)
        .contains(&trimmed.chars().count())
        .then_some(trimmed)
}

/// ISO-8601 UTC without sub-second noise, matching `castify_auth`'s
/// timestamp convention (`session::iso_now`).
fn iso_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `(pool, guard)` — same shape as the shares repository tests:
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

    /// Non-video catalog seed, same connection. Returns the file ids in
    /// insertion order.
    async fn seed_files(pool: &SqlitePool, names: &[&str]) -> Vec<String> {
        let mut ids = Vec::with_capacity(names.len());
        for name in names {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO files (id, connection_id, provider_file_id, name, kind) \
                 VALUES (?, 'c1', ?, ?, 'image')",
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

    /// Direct-SQL placement seed — the batch-move API is task 002; these
    /// tests only need items to *sit* in folders to watch delete lift
    /// them.
    async fn place(pool: &SqlitePool, table: &str, id: &str, folder_id: Option<&str>) {
        assert!(table == "videos" || table == "files");
        sqlx::query(&format!(
            "UPDATE {table} SET library_folder_id = ? WHERE id = ?"
        ))
        .bind(folder_id)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Direct-SQL placement read-back: `(table, id) -> folder_id`.
    async fn placement_of(pool: &SqlitePool, table: &str, id: &str) -> Option<String> {
        assert!(table == "videos" || table == "files");
        sqlx::query_scalar(&format!(
            "SELECT library_folder_id FROM {table} WHERE id = ?"
        ))
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    /// Root-level folder rows `(name, position)` for the owner, in
    /// position order — the assertion lens for flatten/append behavior.
    async fn root_folders(pool: &SqlitePool, owner_id: &str) -> Vec<(String, i64, Option<String>)> {
        sqlx::query(
            "SELECT name, position, id FROM library_folders \
             WHERE owner_id = ? AND parent_id IS NULL ORDER BY position",
        )
        .bind(owner_id)
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r: sqlx::sqlite::SqliteRow| {
            (
                sqlx::Row::get(&r, "name"),
                sqlx::Row::get(&r, "position"),
                sqlx::Row::get(&r, "id"),
            )
        })
        .collect()
    }

    /// Extract the [`FolderInvalid`] a folder write rejected with —
    /// panics on `Ok` and on infrastructure errors alike, so a test
    /// can't mistake a database failure for a validation outcome.
    fn expect_invalid(result: Result<Option<LibraryFolderRow>, FolderWriteError>) -> FolderInvalid {
        match result {
            Err(FolderWriteError::Invalid(e)) => e,
            other => panic!("expected a validation rejection, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_root_and_nested_folders_round_trip() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();

        let day1 = repo
            .create_folder(&owner, None, "  Day 1  ")
            .await
            .unwrap()
            .expect("root folder creates");
        assert_eq!(day1.name, "Day 1", "names are stored trimmed");
        assert_eq!(day1.parent_id, None);
        assert_eq!(day1.position, 0, "first root folder appends at 0");
        assert_eq!(day1.owner_id, owner);
        assert!(!day1.created_at.is_empty());

        let day2 = repo
            .create_folder(&owner, None, "Day 2")
            .await
            .unwrap()
            .expect("second root folder creates");
        assert_eq!(day2.position, 1, "roots append in creation order");

        let morning = repo
            .create_folder(&owner, Some(&day1.id), "Morning")
            .await
            .unwrap()
            .expect("nested folder creates");
        assert_eq!(morning.parent_id.as_deref(), Some(day1.id.as_str()));
        assert_eq!(morning.position, 0, "nested scope numbers from 0");

        // The same name in a different scope is not a duplicate.
        repo.create_folder(&owner, Some(&day2.id), "Morning")
            .await
            .unwrap()
            .expect("same name under a different parent is fine");

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM library_folders WHERE owner_id = ?")
                .bind(&owner)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 4);
    }

    #[tokio::test]
    async fn invalid_folder_shapes_are_rejected_with_friendly_results() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();

        use FolderInvalid::{Cycle, Depth, DuplicateName, Name};

        for bad in ["", "   \t  "] {
            assert_eq!(
                expect_invalid(repo.create_folder(&owner, None, bad).await),
                Name,
                "empty/whitespace name must be FolderInvalid::Name"
            );
        }
        let long = "x".repeat(201);
        assert_eq!(
            expect_invalid(repo.create_folder(&owner, None, &long).await),
            Name,
            "201-char name must be FolderInvalid::Name"
        );
        // Exactly 200 is fine — the boundary is inclusive.
        repo.create_folder(&owner, None, &"x".repeat(200))
            .await
            .unwrap()
            .unwrap();

        let dupe = repo
            .create_folder(&owner, None, "Day 1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            expect_invalid(repo.create_folder(&owner, None, "Day 1").await),
            DuplicateName,
            "same name among siblings must be FolderInvalid::DuplicateName"
        );
        assert_eq!(
            expect_invalid(
                repo.rename_folder(&owner, &dupe.id, "x".repeat(200).as_str())
                    .await
            ),
            DuplicateName,
            "rename onto a sibling's name hits the friendly pre-check"
        );

        // Depth: a chain of 8 nests fine; the 9th is over the cap.
        let mut deepest = repo
            .create_folder(&owner, None, "d1")
            .await
            .unwrap()
            .unwrap();
        for n in 2..=8 {
            deepest = repo
                .create_folder(&owner, Some(&deepest.id), &format!("d{n}"))
                .await
                .unwrap()
                .unwrap_or_else(|| panic!("depth {n} must be legal"));
        }
        assert_eq!(
            expect_invalid(repo.create_folder(&owner, Some(&deepest.id), "d9").await),
            Depth,
            "create past the depth cap must be FolderInvalid::Depth"
        );

        // Reparent depth: ancestor chain of the target + height of the
        // moved subtree must stay within the cap.
        let mut chain_b = repo
            .create_folder(&owner, None, "b1")
            .await
            .unwrap()
            .unwrap();
        for n in 2..=5 {
            chain_b = repo
                .create_folder(&owner, Some(&chain_b.id), &format!("b{n}"))
                .await
                .unwrap()
                .unwrap();
        }
        // b-chain is 5 deep; a 4-subtree moving under b5 would be 9.
        let mut sub = repo
            .create_folder(&owner, None, "s1")
            .await
            .unwrap()
            .unwrap();
        for n in 2..=4 {
            sub = repo
                .create_folder(&owner, Some(&sub.id), &format!("s{n}"))
                .await
                .unwrap()
                .unwrap();
        }
        let s_root = sqlx::query_scalar::<_, String>(
            "SELECT id FROM library_folders WHERE owner_id = ? AND name = 's1'",
        )
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            expect_invalid(
                repo.reparent_folder(&owner, &s_root, Some(&chain_b.id))
                    .await
            ),
            Depth,
            "reparent pushing combined depth past 8 must be FolderInvalid::Depth"
        );

        // Cycle: a folder cannot move under its own descendant.
        let child = repo
            .create_folder(&owner, Some(&dupe.id), "child")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            expect_invalid(
                repo.reparent_folder(&owner, &dupe.id, Some(&child.id))
                    .await
            ),
            Cycle,
            "reparent onto own descendant must be FolderInvalid::Cycle"
        );
        assert_eq!(
            expect_invalid(repo.reparent_folder(&owner, &dupe.id, Some(&dupe.id)).await),
            Cycle,
            "reparent onto itself must be FolderInvalid::Cycle"
        );
    }

    #[tokio::test]
    async fn the_unique_index_rejects_a_raw_rename_onto_a_siblings_name() {
        use FolderInvalid::DuplicateName;

        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();

        let a = repo
            .create_folder(&owner, None, "a")
            .await
            .unwrap()
            .unwrap();
        let b = repo
            .create_folder(&owner, None, "b")
            .await
            .unwrap()
            .unwrap();

        // Bypass the repository's pre-check: the partial unique index at
        // the root level must refuse the raw write (the race backstop).
        let raw = sqlx::query("UPDATE library_folders SET name = 'a' WHERE id = ?")
            .bind(&b.id)
            .execute(&pool)
            .await;
        assert!(raw.is_err(), "unique index must trip on sibling rename");

        // The repo path maps that constraint onto the friendly variant.
        assert_eq!(
            expect_invalid(repo.rename_folder(&owner, &b.id, "a").await),
            DuplicateName
        );
        assert!(!a.id.is_empty());
    }

    #[tokio::test]
    async fn guards_return_none_without_leaking_foreign_or_unknown_ids() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner_a = seed_owner(&pool).await;
        let owner_a = owner_a.to_string();
        let owner_b = seed_owner(&pool).await;
        let owner_b = owner_b.to_string();

        let folder = repo
            .create_folder(&owner_a, None, "mine")
            .await
            .unwrap()
            .unwrap();

        // Unknown parent on create.
        assert!(repo
            .create_folder(&owner_a, Some("missing"), "x")
            .await
            .unwrap()
            .is_none());
        // Foreign parent on create (owner B under A's folder).
        assert!(repo
            .create_folder(&owner_b, Some(&folder.id), "x")
            .await
            .unwrap()
            .is_none());
        // Unknown and foreign folder ids on update.
        assert!(repo
            .rename_folder(&owner_a, "missing", "x")
            .await
            .unwrap()
            .is_none());
        assert!(repo
            .rename_folder(&owner_b, &folder.id, "x")
            .await
            .unwrap()
            .is_none());
        // Foreign new parent on reparent.
        let other = repo
            .create_folder(&owner_b, None, "theirs")
            .await
            .unwrap()
            .unwrap();
        assert!(repo
            .reparent_folder(&owner_a, &folder.id, Some(&other.id))
            .await
            .unwrap()
            .is_none());
        // Unknown and foreign ids on delete.
        assert!(repo
            .delete_folder(&owner_a, "missing")
            .await
            .unwrap()
            .is_none());
        assert!(repo
            .delete_folder(&owner_b, &folder.id)
            .await
            .unwrap()
            .is_none());

        // The untouched folder still exists — nothing above wrote.
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM library_folders WHERE owner_id = ?")
                .bind(&owner_a)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn update_folder_renames_and_reparents_in_one_write() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();

        let first = repo
            .create_folder(&owner, None, "First")
            .await
            .unwrap()
            .unwrap();
        let target = repo
            .create_folder(&owner, None, "Target")
            .await
            .unwrap()
            .unwrap();
        let second = repo
            .create_folder(&owner, None, "Second")
            .await
            .unwrap()
            .unwrap();

        let updated = repo
            .update_folder(&owner, &first.id, Some(" Renamed "), Some(Some(&target.id)))
            .await
            .unwrap()
            .expect("rename+reparent lands as one write");
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.parent_id.as_deref(), Some(target.id.as_str()));
        assert_eq!(updated.position, 0, "appends at the target scope's tail");

        // Source scope renumbered densely: second shifts to 0.
        let roots = root_folders(&pool, &owner).await;
        assert_eq!(
            roots.iter().map(|(n, _, _)| n.as_str()).collect::<Vec<_>>(),
            vec!["Target", "Second"],
            "vacated root scope renumbers"
        );
        let second_row: i64 =
            sqlx::query_scalar("SELECT position FROM library_folders WHERE id = ?")
                .bind(&second.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(second_row, 1, "second shifts up behind target's 0");

        // Move back to root appends at the root tail.
        let back = repo
            .update_folder(&owner, &first.id, None, Some(None))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(back.parent_id, None);
        assert_eq!(
            back.position, 2,
            "root scope now Target(0), Second(1), Renamed(2)"
        );
    }

    #[tokio::test]
    async fn delete_folder_lifts_items_to_unfiled_and_flattens_descendants() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let videos = seed_videos(&pool, &["v-root.mp4", "v-a.mp4", "v-ab.mp4"]).await;
        let files = seed_files(&pool, &["f-a.jpg", "f-ab.pdf"]).await;

        // tree: a{ ab }  — plus one untouched root folder to pin the
        // flatten tail.
        let keeper = repo
            .create_folder(&owner, None, "keeper")
            .await
            .unwrap()
            .unwrap();
        let a = repo
            .create_folder(&owner, None, "a")
            .await
            .unwrap()
            .unwrap();
        let ab = repo
            .create_folder(&owner, Some(&a.id), "ab")
            .await
            .unwrap()
            .unwrap();

        place(&pool, "videos", &videos[1], Some(&a.id)).await;
        place(&pool, "videos", &videos[2], Some(&ab.id)).await;
        place(&pool, "files", &files[0], Some(&a.id)).await;
        place(&pool, "files", &files[1], Some(&ab.id)).await;

        let deleted = repo
            .delete_folder(&owner, &a.id)
            .await
            .unwrap()
            .expect("delete returns the doomed folder row");
        assert_eq!(deleted.id, a.id);

        // Items (both tables) are Unfiled; the catalog rows are intact.
        for id in &videos {
            assert_eq!(
                placement_of(&pool, "videos", id).await,
                None,
                "video returns to Unfiled"
            );
        }
        for id in &files {
            assert_eq!(
                placement_of(&pool, "files", id).await,
                None,
                "file returns to Unfiled"
            );
        }
        let v: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM videos")
            .fetch_one(&pool)
            .await
            .unwrap();
        let f: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM files")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            (v, f),
            (3, 2),
            "nothing leaves the catalog on folder delete"
        );

        // Descendant ab flattened to root, appended after keeper; the
        // doomed folder is gone.
        let roots = root_folders(&pool, &owner).await;
        assert_eq!(
            roots.iter().map(|(n, _, _)| n.as_str()).collect::<Vec<_>>(),
            vec!["keeper", "ab"],
            "descendants flatten to root in subtree order"
        );
        assert_eq!(
            roots[1].1, 1,
            "flattened folder appends after existing roots"
        );
        let a_gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_folders WHERE id = ?")
            .bind(&a.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(a_gone, 0);
        assert!(!keeper.id.is_empty());
    }

    #[tokio::test]
    async fn delete_folder_decollides_flattened_names_at_root() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();

        // Root already holds "b"; deleting a{ b, c, b2 } flattens b with
        // the smallest free `" (n)"` suffix off the ORIGINAL name — root
        // has "b" and "b (2)" taken, so b lands as "b (3)" — then c,
        // then b2 (which collides with nothing).
        repo.create_folder(&owner, None, "b")
            .await
            .unwrap()
            .unwrap();
        let a = repo
            .create_folder(&owner, None, "a")
            .await
            .unwrap()
            .unwrap();
        repo.create_folder(&owner, Some(&a.id), "b")
            .await
            .unwrap()
            .unwrap();
        repo.create_folder(&owner, Some(&a.id), "c")
            .await
            .unwrap()
            .unwrap();
        let b2 = repo
            .create_folder(&owner, Some(&a.id), "b2")
            .await
            .unwrap()
            .unwrap();

        // A root folder named "b2 (2)" forces the de-collision chain one
        // step further for a second flattened "b2".
        sqlx::query(
            "INSERT INTO library_folders (id, owner_id, name, position, created_at) \
                     VALUES ('z-root', ?, 'b (2)', 1, '2026-01-01T00:00:00Z')",
        )
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
        let _ = b2;

        repo.delete_folder(&owner, &a.id).await.unwrap().unwrap();

        let roots = root_folders(&pool, &owner).await;
        let names: Vec<&str> = roots.iter().map(|(n, _, _)| n.as_str()).collect();
        assert!(
            names.contains(&"b (3)"),
            "smallest free suffix off the base name wins: {names:?}"
        );
        assert!(names.contains(&"c"));
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM library_folders WHERE owner_id = ?")
                .bind(&owner)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            count, 5,
            "two root b's + flattened b, c, b2 — minus deleted a"
        );
    }

    #[tokio::test]
    async fn deleting_an_owner_cascades_their_folder_tree() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let owner_id = owner.to_string();
        let other = seed_owner(&pool).await;
        let other = other.to_string();

        let root = repo
            .create_folder(&owner_id, None, "root")
            .await
            .unwrap()
            .unwrap();
        repo.create_folder(&owner_id, Some(&root.id), "kid")
            .await
            .unwrap()
            .unwrap();
        repo.create_folder(&other, None, "theirs")
            .await
            .unwrap()
            .unwrap();

        sqlx::query("DELETE FROM owners WHERE id = ?")
            .bind(&owner_id)
            .execute(&pool)
            .await
            .unwrap();

        let mine: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM library_folders WHERE owner_id = ?")
                .bind(&owner_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(mine, 0, "owner purge removes the curated tree");
        let theirs: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM library_folders WHERE owner_id = ?")
                .bind(&other)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(theirs, 1, "other owners' trees are untouched");
    }
}
