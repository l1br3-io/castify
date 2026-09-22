//! `LibraryFolderRepository` — all SQL for the curated library-folder
//! tree and item placement.
//!
//! The share-folders repository mechanics adapted to library scale:
//! stateless struct over the pool, runtime `sqlx::query` (no compile-time
//! DB), tests beside the code on a real temp-file SQLite. Scope is the
//! owner (`owner_id`), not a share — there is no liveness state to guard,
//! only ownership. Writes happen only on owner actions (create, rename,
//! reparent, delete, batch move); scans never write placement.

use castify_catalog::{
    FileEntry, FileKind, FolderContentsFilter, FolderContentsPage, FolderEntry, FolderFileEntry,
    FolderVideoEntry, VideoSource, VideoSummary,
};
use chrono::Utc;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

use crate::library_folders::LibraryFolderResult;

/// Active-connection gate, inlined from the catalog repository's
/// (module-private) `ACTIVE_CONNECTION_FILTER` — this module must not
/// reach into catalog internals, and the catalog crate stays untouched
/// by this effort. Same predicate, kept in sync by the tests below.
const ACTIVE_CONNECTIONS: &str =
    "connection_id IN (SELECT id FROM provider_connections WHERE disconnected_at IS NULL)";

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

/// One flat node of the curated tree, as `GET /api/library-folders/tree`
/// serves it: the folder row plus its **cumulative** item count (videos
/// dedup-aware + files raw, rolled up over the subtree). The client
/// builds the nested tree from this list — one fetch, no per-node
/// requests.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibraryTreeFolder {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub position: i64,
    pub created_at: String,
    /// Items in this folder's subtree (videos + files). Cumulative so
    /// tiles read the same as the provider tree's counts.
    pub item_count: i64,
}

/// The tree payload: flat folders ordered `(parent_id, position)` plus
/// the pinned Unfiled node's live count (NULL placements, videos + files).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibraryFolderTree {
    pub folders: Vec<LibraryTreeFolder>,
    pub unfiled_count: i64,
}

/// Filters for [`LibraryFolderRepository::fetch_contents`] — the curated
/// twin of `castify_catalog::FolderContentsFilter`: placement takes the
/// place of `path`, everything else (`kind`, `q`, pagination, owner
/// enrichment) matches the provider contents contract.
#[derive(Debug, Clone)]
pub struct LibraryContentsFilter {
    /// `None` = the Unfiled bucket (NULL placement).
    pub folder_id: Option<String>,
    pub page: i64,
    pub limit: i64,
    /// Owner for the video-half enrichment joins (favorites/ratings/
    /// progress).
    pub owner_id: String,
    /// `video` or one of the six file kinds (validated upstream).
    pub kind: Option<String>,
    /// Name contains, case-insensitive.
    pub q: Option<String>,
}

/// The id namespace an item id belongs to — `kind` guards the batch move:
/// a video id and a file id are only distinguishable by this tag.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub enum ItemKind {
    Video,
    File,
}

/// One entry of a batch-move request.
#[derive(Clone, Copy, Debug)]
pub struct MoveItem<'a> {
    pub kind: ItemKind,
    pub id: &'a str,
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
    /// A batch-move item id that doesn't exist under its declared kind.
    /// Fails the whole batch (all-or-nothing); routes map it to 404.
    #[error("batch contains an unknown item id")]
    UnknownItem,
    /// A reorder list that isn't exactly the scope's current members
    /// (missing id, extra/foreign id, duplicate, or empty). Fails whole
    /// — nothing moves; routes map it to 422.
    #[error("the ordered list must be exactly the folder's current contents")]
    ReorderMismatch,
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
    /// search, and the "All files" grid are untouched. One transaction,
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
        // sits in the subtree. Positions clear with the placement — a
        // delete must not smuggle an order into the Unfiled bucket
        // (task 005's ordering model).
        for table in ["videos", "files"] {
            sqlx::query(&format!(
                "WITH RECURSIVE subtree(id) AS ( \
                     SELECT id FROM library_folders WHERE id = ? AND owner_id = ? \
                     UNION \
                     SELECT f.id FROM library_folders f JOIN subtree s ON f.parent_id = s.id \
                 ) UPDATE {table} SET library_folder_id = NULL, library_folder_position = NULL \
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

    /// The curated tree read behind `GET /api/library-folders/tree`: the
    /// owner's folders as one flat `(parent_id, position)`-ordered list,
    /// each carrying its **cumulative** item count, plus the Unfiled
    /// bucket's live count. The client builds the nested tree from the
    /// flat list — one fetch, no per-node requests.
    ///
    /// Cumulative counts roll up in Rust, not SQL (plan § Architecture
    /// Decisions): one grouped dedup-aware count query per table over
    /// placements, then an ancestor walk over the flat folder list —
    /// folder cardinality is small, the shape is unit-testable, and it
    /// avoids fighting recursive-CTE aggregation semantics. Video counts
    /// are dedup-aware **per placement scope** (the provider tree's
    /// `MIN(id) GROUP BY dedup_group` representative trick, scoped to
    /// the folder): copies of one dedup group placed in the same folder
    /// count once, while copies split across folders each count for the
    /// scope they sit in. File counts are raw (files don't dedup).
    pub async fn fetch_tree(&self, owner_id: &str) -> LibraryFolderResult<LibraryFolderTree> {
        let folders: Vec<LibraryFolderRow> = sqlx::query(
            "SELECT id, owner_id, parent_id, name, position, created_at \
             FROM library_folders WHERE owner_id = ? ORDER BY parent_id, position",
        )
        .bind(owner_id)
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(row_to_folder)
        .collect();

        // Direct (per-folder) counts: videos dedup-aware per placement
        // scope (the provider tree's representative trick, scoped to the
        // folder — copies of one dedup group in the same folder collapse;
        // copies split across folders each count for their scope), files
        // raw. Two grouped queries total.
        let video_counts: Vec<(String, i64)> = sqlx::query(&format!(
            "SELECT fid, COUNT(*) AS n FROM ( \
                 SELECT library_folder_id AS fid FROM videos \
                     WHERE library_folder_id IS NOT NULL AND dedup_group IS NOT NULL \
                       AND {ACTIVE_CONNECTIONS} \
                     GROUP BY dedup_group, library_folder_id \
                 UNION ALL \
                 SELECT library_folder_id FROM videos \
                     WHERE library_folder_id IS NOT NULL AND dedup_group IS NULL \
                       AND {ACTIVE_CONNECTIONS} \
             ) GROUP BY fid",
        ))
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|r: sqlx::sqlite::SqliteRow| (sqlx::Row::get(&r, "fid"), sqlx::Row::get(&r, "n")))
        .collect();
        let file_counts: Vec<(String, i64)> = sqlx::query(
            "SELECT library_folder_id AS fid, COUNT(*) AS n FROM files \
             WHERE library_folder_id IS NOT NULL \
               AND connection_id IN (SELECT id FROM provider_connections \
                                     WHERE disconnected_at IS NULL) \
             GROUP BY library_folder_id",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|r: sqlx::sqlite::SqliteRow| (sqlx::Row::get(&r, "fid"), sqlx::Row::get(&r, "n")))
        .collect();

        // Unfiled: NULL placements, same dedup-awareness over videos.
        let unfiled_videos: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*) FROM ( \
                 SELECT dedup_group FROM videos \
                     WHERE library_folder_id IS NULL AND dedup_group IS NOT NULL \
                       AND {ACTIVE_CONNECTIONS} \
                     GROUP BY dedup_group \
                 UNION ALL \
                 SELECT 1 FROM videos \
                     WHERE library_folder_id IS NULL AND dedup_group IS NULL \
                       AND {ACTIVE_CONNECTIONS} \
             )",
        ))
        .fetch_one(&self.pool)
        .await?;
        let unfiled_files: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM files WHERE library_folder_id IS NULL \
             AND connection_id IN (SELECT id FROM provider_connections \
                                   WHERE disconnected_at IS NULL)",
        )
        .fetch_one(&self.pool)
        .await?;

        // Ancestor roll-up over the flat list in memory — folder
        // cardinality is small and the math is unit-testable (see the
        // tests above); no recursive-CTE aggregation to fight.
        let mut direct: HashMap<&str, i64> = HashMap::new();
        for (fid, n) in video_counts.iter().chain(file_counts.iter()) {
            *direct.entry(fid.as_str()).or_insert(0) += *n;
        }
        let parent_of: HashMap<&str, Option<&str>> = folders
            .iter()
            .map(|f| (f.id.as_str(), f.parent_id.as_deref()))
            .collect();
        let mut cumulative: HashMap<String, i64> =
            folders.iter().map(|f| (f.id.clone(), 0i64)).collect();
        for f in &folders {
            let d = direct.get(f.id.as_str()).copied().unwrap_or(0);
            let mut cursor = Some(f.id.as_str());
            while let Some(id) = cursor {
                if let Some(slot) = cumulative.get_mut(id) {
                    *slot += d;
                }
                cursor = parent_of.get(id).copied().flatten();
            }
        }

        Ok(LibraryFolderTree {
            folders: folders
                .into_iter()
                .map(|f| LibraryTreeFolder {
                    item_count: cumulative.remove(&f.id).unwrap_or(0),
                    id: f.id,
                    parent_id: f.parent_id,
                    name: f.name,
                    position: f.position,
                    created_at: f.created_at,
                })
                .collect(),
            unfiled_count: unfiled_videos + unfiled_files,
        })
    }

    /// The curated contents read behind `GET /api/library-folders/
    /// contents`: the mixed, paginated listing of items **directly** in
    /// one folder (or the Unfiled bucket when `folder_id` is `None`).
    /// Items only — subfolder tiles derive from the tree query, so
    /// pagination never drops a folder off a page boundary. The wire
    /// reuses the provider contents shapes (`FolderContentsPage`) so the
    /// organizer renders both listings with the same components.
    ///
    /// `Ok(None)` = guard rejection: the folder id is unknown or owned
    /// by another owner (no existence leak).
    pub async fn fetch_contents(
        &self,
        owner_id: &str,
        filter: &LibraryContentsFilter,
    ) -> LibraryFolderResult<Option<FolderContentsPage>> {
        if let Some(fid) = filter.folder_id.as_deref() {
            let mut tx = self.pool.begin().await?;
            if Self::fetch_folder(&mut tx, owner_id, fid).await?.is_none() {
                return Ok(None);
            }
        }

        let page = filter.page.max(1);
        let limit = filter.limit.clamp(1, 200);
        let offset = (page - 1) * limit;

        // One builder produces the shared UNION body plus its binds, in
        // order — the count and page queries wrap it identically, so the
        // positional `?`s always line up (same shape as the catalog's
        // provider contents query). A kind filter is applied at the
        // wrapper level — the video half must be excluded for file
        // kinds, not just the file half restricted.
        let (union_sql, binds) = Self::contents_union(filter);
        let kind_entry_frag = match filter.kind.as_deref() {
            Some(k) if FolderContentsFilter::is_valid_kind(k) => {
                format!(" WHERE entry_kind = '{k}'")
            }
            _ => String::new(),
        };

        // ── Count ─────────────────────────────────────────────────────
        let count_sql = format!("SELECT COUNT(*) FROM ({union_sql}){kind_entry_frag}");
        let mut count_q = sqlx::query_scalar::<_, i64>(&count_sql);
        for b in &binds {
            count_q = count_q.bind(b);
        }
        let total: i64 = count_q.fetch_one(&self.pool).await?;

        // ── Page ──────────────────────────────────────────────────────
        // Ordered scopes follow the owner's positions; unordered scopes
        // (the all-NULL default) keep the shipped name-ascending order
        // byte-for-byte. The name/kind/id tail stands as the tiebreak.
        let mut scope_conn = self.pool.acquire().await?;
        let ordered = Self::scope_is_ordered(&mut scope_conn, filter.folder_id.as_deref()).await?;
        let order_sql = if ordered {
            "ORDER BY entry_position, name COLLATE NOCASE, entry_kind, id"
        } else {
            "ORDER BY name COLLATE NOCASE, entry_kind, id"
        };
        let page_sql = format!(
            "SELECT * FROM ({union_sql}){kind_entry_frag} \
             {order_sql} LIMIT {limit} OFFSET {offset}"
        );
        let mut page_q = sqlx::query(&page_sql);
        for b in &binds {
            page_q = page_q.bind(b);
        }
        let rows = page_q.fetch_all(&self.pool).await?;

        // ── Hydrate video sources (dedup groups on this page) ─────────
        let dedup_groups: Vec<String> = rows
            .iter()
            .filter(|r| sqlx::Row::get::<String, _>(*r, "entry_kind") == "video")
            .filter_map(|r| sqlx::Row::get::<Option<String>, _>(r, "dedup_group"))
            .collect();
        let sources_by_group = if dedup_groups.is_empty() {
            HashMap::new()
        } else {
            Self::sources_by_groups(&self.pool, &dedup_groups).await?
        };

        let entries = rows
            .iter()
            .map(|row| {
                let entry_kind: String = sqlx::Row::get(row, "entry_kind");
                if entry_kind == "video" {
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
                    FolderEntry::Video(FolderVideoEntry {
                        kind: "video",
                        video: VideoSummary {
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
                        },
                    })
                } else {
                    FolderEntry::File(FolderFileEntry {
                        kind: FileKind::parse(&entry_kind),
                        file: FileEntry {
                            id: sqlx::Row::get(row, "id"),
                            name: sqlx::Row::get(row, "name"),
                            provider: sqlx::Row::get(row, "provider"),
                            path: sqlx::Row::get(row, "path"),
                            size_bytes: sqlx::Row::get(row, "size_bytes"),
                            mime_type: sqlx::Row::get(row, "mime_type"),
                            modified_at: sqlx::Row::get(row, "provider_modified_at"),
                        },
                    })
                }
            })
            .collect();

        Ok(Some(FolderContentsPage {
            entries,
            total,
            page,
            limit,
        }))
    }

    /// The batch placement write behind `PATCH /api/library-folders/
    /// items` — the primitive move op. One transaction for the whole
    /// batch (data-storage rule #5: one user action, one transaction):
    /// every listed item lands in `folder_id` (null → Unfiled) or the
    /// request fails whole — an item id that doesn't exist under its
    /// declared `kind` aborts with [`FolderWriteError::UnknownItem`]
    /// and nothing moves. A single-item move is the degenerate
    /// `items: [one]`. Folders are organization, never authorization —
    /// playback and shares never read this column.
    ///
    /// `Ok(None)` = guard rejection: the target folder is unknown or
    /// foreign. `Ok(Some(n))` = `n` item rows rewritten.
    pub async fn move_items(
        &self,
        owner_id: &str,
        items: &[MoveItem<'_>],
        folder_id: Option<&str>,
    ) -> Result<Option<u64>, FolderWriteError> {
        let mut tx = self.pool.begin().await?;
        if let Some(fid) = folder_id {
            if Self::fetch_folder(&mut tx, owner_id, fid).await?.is_none() {
                // Dropping the tx rolls back — nothing was written.
                return Ok(None);
            }
        }
        // Ordered targets append incoming items at the tail (dense
        // positions stand, the newcomer goes after them); unordered
        // targets take NULL positions — a move never flips a scope's
        // ordered-ness by itself.
        let target_ordered = Self::scope_is_ordered(&mut tx, folder_id).await?;
        let mut next_position = if target_ordered {
            Self::scope_tail_position(&mut tx, folder_id).await? + 1
        } else {
            0
        };
        let mut written = 0u64;
        let mut seen: HashSet<(ItemKind, &str)> = HashSet::new();
        for item in items {
            if !seen.insert((item.kind, item.id)) {
                continue; // in-batch duplicate — skip
            }
            let sql = match (item.kind, target_ordered) {
                (ItemKind::Video, true) => {
                    "UPDATE videos SET library_folder_id = ?, library_folder_position = ? \
                     WHERE id = ?"
                }
                (ItemKind::Video, false) => {
                    "UPDATE videos SET library_folder_id = ?, library_folder_position = NULL \
                     WHERE id = ?"
                }
                (ItemKind::File, true) => {
                    "UPDATE files SET library_folder_id = ?, library_folder_position = ? \
                     WHERE id = ?"
                }
                (ItemKind::File, false) => {
                    "UPDATE files SET library_folder_id = ?, library_folder_position = NULL \
                     WHERE id = ?"
                }
            };
            let mut q = sqlx::query(sql).bind(folder_id);
            if target_ordered {
                q = q.bind(next_position);
                next_position += 1;
            }
            let result = q.bind(item.id).execute(&mut *tx).await?;
            if result.rows_affected() == 0 {
                // All-or-nothing: dropping the tx rolls every earlier
                // update in this batch back.
                return Err(FolderWriteError::UnknownItem);
            }
            written += 1;
        }
        tx.commit().await?;
        Ok(Some(written))
    }

    /// Dense-rewrite item reorder — the write behind `PATCH
    /// /api/library-folders/items/order`. One transaction for the whole
    /// user action (data-storage rule #5): `ordered` must list EXACTLY
    /// the scope's current placed items as the contents listing shows
    /// them (dedup representatives), and any deviation — missing id,
    /// extra or foreign id, duplicate, empty — aborts with
    /// [`FolderWriteError::ReorderMismatch`] before a single row moves.
    ///
    /// Ordered-vs-unordered invariant (the *why*): a scope is ordered
    /// iff every placed item in it has a position. The first reorder of
    /// an untouched folder flips it dense (0..n-1) in this one
    /// transaction; folders no one reorders stay all-NULL and keep the
    /// shipped name-ascending contents byte-for-byte. Dedup copies ride
    /// their representative's position so a hidden copy can never
    /// silently un-order the folder.
    ///
    /// `folder_id: None` orders the Unfiled bucket — same mechanics.
    /// `Ok(None)` = guard rejection (folder unknown or foreign).
    pub async fn reorder_items(
        &self,
        owner_id: &str,
        folder_id: Option<&str>,
        ordered: &[MoveItem<'_>],
    ) -> Result<Option<usize>, FolderWriteError> {
        let mut tx = self.pool.begin().await?;
        if let Some(fid) = folder_id {
            if Self::fetch_folder(&mut tx, owner_id, fid).await?.is_none() {
                return Ok(None);
            }
        }

        // Exact-set validation, before any write.
        if ordered.is_empty() {
            return Err(FolderWriteError::ReorderMismatch);
        }
        let mut listed: HashSet<(ItemKind, &str)> = HashSet::new();
        for item in ordered {
            if !listed.insert((item.kind, item.id)) {
                return Err(FolderWriteError::ReorderMismatch); // duplicate
            }
        }
        let current = Self::scope_member_set(&mut tx, folder_id).await?;
        let matches = current.len() == listed.len()
            && current
                .iter()
                .all(|(kind, id)| listed.contains(&(*kind, id.as_str())));
        if !matches {
            return Err(FolderWriteError::ReorderMismatch);
        }

        // Dense rewrite: each listed item takes its index; same-folder
        // dedup copies of a video ride along so the ordered-iff-
        // everything-positioned invariant holds for hidden rows too.
        for (index, item) in ordered.iter().enumerate() {
            let index = index as i64;
            match item.kind {
                ItemKind::Video => {
                    sqlx::query(
                        "UPDATE videos SET library_folder_position = ? \
                         WHERE library_folder_id IS ? AND (id = ? OR (dedup_group IS NOT NULL \
                           AND dedup_group = (SELECT dedup_group FROM videos WHERE id = ?)))",
                    )
                    .bind(index)
                    .bind(folder_id)
                    .bind(item.id)
                    .bind(item.id)
                    .execute(&mut *tx)
                    .await?;
                }
                ItemKind::File => {
                    sqlx::query(
                        "UPDATE files SET library_folder_position = ? \
                         WHERE library_folder_id IS ? AND id = ?",
                    )
                    .bind(index)
                    .bind(folder_id)
                    .bind(item.id)
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }
        tx.commit().await?;
        Ok(Some(ordered.len()))
    }

    /// Dense-rewrite sibling reorder — the write behind `PATCH
    /// /api/library-folders/folders/order` (task 006): `ordered_ids`
    /// must be exactly `parent_id`'s current children (missing, extra,
    /// duplicate, or empty aborts whole); positions rewrite 0..n-1 in
    /// list order over the existing `library_folders.position` column.
    /// `Ok(None)` = guard rejection (parent unknown or foreign).
    pub async fn reorder_folders(
        &self,
        owner_id: &str,
        parent_id: Option<&str>,
        ordered_ids: &[&str],
    ) -> Result<Option<usize>, FolderWriteError> {
        let mut tx = self.pool.begin().await?;
        if let Some(pid) = parent_id {
            if Self::fetch_folder(&mut tx, owner_id, pid).await?.is_none() {
                return Ok(None);
            }
        }

        if ordered_ids.is_empty() {
            return Err(FolderWriteError::ReorderMismatch);
        }
        let mut listed: HashSet<&str> = HashSet::new();
        for id in ordered_ids {
            if !listed.insert(id.as_ref()) {
                return Err(FolderWriteError::ReorderMismatch);
            }
        }
        let current: HashSet<String> = sqlx::query_scalar(
            "SELECT id FROM library_folders WHERE owner_id = ? AND parent_id IS ?",
        )
        .bind(owner_id)
        .bind(parent_id)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect();
        if current.len() != listed.len() || !current.iter().all(|id| listed.contains(id.as_str())) {
            return Err(FolderWriteError::ReorderMismatch);
        }

        for (index, id) in ordered_ids.iter().enumerate() {
            sqlx::query("UPDATE library_folders SET position = ? WHERE id = ?")
                .bind(index as i64)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(Some(ordered_ids.len()))
    }

    // -- Folder helpers: owner-scoped fetch and the single-CTE walks that
    // keep every tree check O(depth) statements.

    /// The placement scope's displayed member set — the exact set a
    /// reorder list must match: dedup representatives for videos (the
    /// contents listing's selection) plus all files, placements scoped
    /// to `folder_id` (`None` = the Unfiled bucket), active connections
    /// only (what contents serves is what reorders).
    async fn scope_member_set(
        tx: &mut sqlx::SqliteConnection,
        folder_id: Option<&str>,
    ) -> sqlx::Result<HashSet<(ItemKind, String)>> {
        let mut set = HashSet::new();
        let videos: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT MIN(id) FROM videos \
                  WHERE library_folder_id IS ? AND dedup_group IS NOT NULL \
                    AND {ACTIVE_CONNECTIONS} \
                  GROUP BY dedup_group \
              UNION ALL \
              SELECT id FROM videos \
                  WHERE library_folder_id IS ? AND dedup_group IS NULL \
                    AND {ACTIVE_CONNECTIONS}"
        ))
        .bind(folder_id)
        .bind(folder_id)
        .fetch_all(&mut *tx)
        .await?;
        for id in videos {
            set.insert((ItemKind::Video, id));
        }
        let files: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT id FROM files WHERE library_folder_id IS ? AND {ACTIVE_CONNECTIONS}"
        ))
        .bind(folder_id)
        .fetch_all(&mut *tx)
        .await?;
        for id in files {
            set.insert((ItemKind::File, id));
        }
        Ok(set)
    }

    /// Ordered-scope detection: a placement scope is ordered iff it has
    /// at least one placed item and none of its placed items has a NULL
    /// position. The all-NULL default — every folder untouched by a
    /// reorder — is unordered, keeping the shipped name-ascending
    /// contents byte-for-byte.
    async fn scope_is_ordered(
        tx: &mut sqlx::SqliteConnection,
        folder_id: Option<&str>,
    ) -> sqlx::Result<bool> {
        let mut any_placed = false;
        for table in ["videos", "files"] {
            let row = sqlx::query(&format!(
                "SELECT COUNT(*) AS total, \
                        COALESCE(SUM(library_folder_position IS NULL), 0) AS nulls \
                 FROM {table} WHERE library_folder_id IS ? AND {ACTIVE_CONNECTIONS}"
            ))
            .bind(folder_id)
            .fetch_one(&mut *tx)
            .await?;
            let total: i64 = sqlx::Row::get(&row, "total");
            let nulls: i64 = sqlx::Row::get(&row, "nulls");
            if nulls > 0 {
                return Ok(false); // any unpositioned row ⇒ unordered
            }
            any_placed |= total > 0;
        }
        Ok(any_placed)
    }

    /// The scope's highest position across both tables — the append-
    /// at-tail seed for batch moves into an ordered scope. `-1` for an
    /// empty scope (only queried when ordered, so never in practice).
    async fn scope_tail_position(
        tx: &mut sqlx::SqliteConnection,
        folder_id: Option<&str>,
    ) -> sqlx::Result<i64> {
        sqlx::query_scalar(&format!(
            "SELECT COALESCE(MAX(m), -1) FROM ( \
                 SELECT MAX(library_folder_position) AS m FROM videos \
                     WHERE library_folder_id IS ? AND {ACTIVE_CONNECTIONS} \
                 UNION ALL \
                 SELECT MAX(library_folder_position) FROM files \
                     WHERE library_folder_id IS ? AND {ACTIVE_CONNECTIONS} \
             )"
        ))
        .bind(folder_id)
        .bind(folder_id)
        .fetch_one(&mut *tx)
        .await
    }

    /// Build the shared UNION body for the curated contents queries and
    /// its bind values, in positional order — the placement-scoped twin
    /// of the catalog's `folder_contents_union`: the video half selects
    /// dedup representatives *within the placement scope* (so copies
    /// split across folders surface in each), the file half joins the
    /// provider name the same way. The caller wraps the body in
    /// `SELECT COUNT(*)` or `SELECT * … LIMIT`.
    fn contents_union(filter: &LibraryContentsFilter) -> (String, Vec<Option<String>>) {
        let mut sql = String::new();
        let mut binds: Vec<Option<String>> = Vec::new();

        // ── Video half ────────────────────────────────────────────────
        sql.push_str(&format!(
            "SELECT 'video' AS entry_kind, v.id, v.name, v.provider, v.size_bytes, \
                    v.mime_type, v.duration_ms, v.width, v.height, v.dedup_group, \
                    v.connection_id, v.provider_file_id, v.created_at, v.path, \
                    v.thumbnail_status, v.provider_modified_at, \
                    (vf.video_id IS NOT NULL) AS is_favorite, vr.rating AS my_rating, \
                    pp.position_seconds AS position_seconds, \
                    COALESCE(pp.completed, 0) AS completed, \
                    v.library_folder_position AS entry_position \
             FROM videos v \
             LEFT JOIN video_favorites vf ON vf.video_id = v.id AND vf.owner_id = ? \
             LEFT JOIN video_ratings vr ON vr.video_id = v.id AND vr.owner_id = ? \
             LEFT JOIN playback_progress pp ON pp.video_id = v.id AND pp.owner_id = ? \
             WHERE v.id IN ( \
                 SELECT MIN(id) FROM videos \
                     WHERE library_folder_id IS ? AND dedup_group IS NOT NULL \
                       AND {ACTIVE_CONNECTIONS} \
                     GROUP BY dedup_group \
                 UNION ALL \
                 SELECT id FROM videos \
                     WHERE library_folder_id IS ? AND dedup_group IS NULL \
                       AND {ACTIVE_CONNECTIONS} \
             )",
        ));
        binds.push(Some(filter.owner_id.clone()));
        binds.push(Some(filter.owner_id.clone()));
        binds.push(Some(filter.owner_id.clone()));
        binds.push(filter.folder_id.clone());
        binds.push(filter.folder_id.clone());
        if let Some(q) = like_escape(filter.q.as_deref()) {
            sql.push_str(" AND v.name LIKE ? ESCAPE '\\'");
            binds.push(Some(q));
        }

        // ── File half ─────────────────────────────────────────────────
        sql.push_str(
            " UNION ALL \
             SELECT f.kind AS entry_kind, f.id, f.name, pc.provider, f.size_bytes, \
                    f.mime_type, NULL, NULL, NULL, NULL, f.connection_id, \
                    f.provider_file_id, f.created_at, f.path, NULL, \
                    f.provider_modified_at, 0, NULL, NULL, 0, \
                    f.library_folder_position \
             FROM files f \
             JOIN provider_connections pc ON pc.id = f.connection_id \
                    AND pc.disconnected_at IS NULL \
             WHERE f.library_folder_id IS ?",
        );
        binds.push(filter.folder_id.clone());
        if let Some(q) = like_escape(filter.q.as_deref()) {
            sql.push_str(" AND f.name LIKE ? ESCAPE '\\'");
            binds.push(Some(q));
        }

        (sql, binds)
    }

    /// Dedup-group source hydration — the local twin of the catalog
    /// repository's private `fetch_sources_by_groups` (the catalog crate
    /// stays untouched by this effort).
    async fn sources_by_groups(
        pool: &SqlitePool,
        groups: &[String],
    ) -> sqlx::Result<HashMap<String, Vec<VideoSource>>> {
        let placeholders = vec!["?"; groups.len()].join(", ");
        let sql = format!(
            "SELECT connection_id, provider, provider_file_id, dedup_group \
             FROM videos WHERE dedup_group IN ({placeholders}) AND {ACTIVE_CONNECTIONS}"
        );
        let mut query = sqlx::query(&sql);
        for g in groups {
            query = query.bind(g);
        }
        let rows = query.fetch_all(pool).await?;

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

/// `q` → a LIKE pattern with `%`/`_`/`\` escaped — the same escaping
/// rule as `FolderContentsFilter::q_filter` (catalog), inlined so the
/// catalog crate stays untouched.
fn like_escape(q: Option<&str>) -> Option<String> {
    let q = q?.trim();
    if q.is_empty() {
        return None;
    }
    let escaped = q
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Some(format!("%{escaped}%"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `(pool, guard)` — same shape as the shares repository tests:
    /// guard holds the TempDir (db + SQLite sidecars) for the test's
    /// lifetime; drop removes it recursively.
    async fn fresh_pool() -> (SqlitePool, tempfile::TempDir) {
        let guard = tempfile::TempDir::new().unwrap();
        let pool = castify_storage::connect(guard.path().join("db.sqlite3"))
            .await
            .unwrap();
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

    /// A dedup pair: two `videos` rows sharing one `dedup_group` — the
    /// counting lens the provider tree also uses.
    async fn seed_dedup_pair(pool: &SqlitePool, names: &[&str], group: &str) -> Vec<String> {
        sqlx::query(
            "INSERT OR IGNORE INTO provider_connections (id, provider, token_bundle, connected_at) \
             VALUES ('c1', 'google_drive', x'00', '2026-01-01T00:00:00Z')",
        )
        .execute(pool)
        .await
        .unwrap();
        let mut ids = Vec::new();
        for name in names {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO videos (id, connection_id, provider, provider_file_id, name, \
                 size_bytes, dedup_group, scanned_at, created_at) \
                 VALUES (?, 'c1', 'google_drive', ?, ?, 1, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            )
            .bind(&id)
            .bind(name)
            .bind(name)
            .bind(group)
            .execute(pool)
            .await
            .unwrap();
            ids.push(id);
        }
        ids
    }

    fn contents_filter(folder: Option<&str>, owner: &str) -> LibraryContentsFilter {
        LibraryContentsFilter {
            folder_id: folder.map(str::to_string),
            page: 1,
            limit: 50,
            owner_id: owner.to_string(),
            kind: None,
            q: None,
        }
    }

    fn entry_names(page: &FolderContentsPage) -> Vec<String> {
        page.entries
            .iter()
            .map(|e| match e {
                FolderEntry::Video(v) => v.video.name.clone(),
                FolderEntry::File(f) => f.file.name.clone(),
            })
            .collect()
    }

    #[tokio::test]
    async fn fetch_tree_rolls_up_cumulative_counts_and_unfiled() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();

        // Tree: A{ A1{ A2 } }, B — videos and files spread over it.
        let a = repo
            .create_folder(&owner, None, "A")
            .await
            .unwrap()
            .unwrap();
        let a1 = repo
            .create_folder(&owner, Some(&a.id), "A1")
            .await
            .unwrap()
            .unwrap();
        let a2 = repo
            .create_folder(&owner, Some(&a1.id), "A2")
            .await
            .unwrap()
            .unwrap();
        let b = repo
            .create_folder(&owner, None, "B")
            .await
            .unwrap()
            .unwrap();

        let videos =
            seed_videos(&pool, &["in-a.mp4", "in-a2.mp4", "in-b.mp4", "unfiled.mp4"]).await;
        let files = seed_files(&pool, &["in-a1.jpg", "unfiled.pdf"]).await;

        place(&pool, "videos", &videos[0], Some(&a.id)).await;
        place(&pool, "videos", &videos[1], Some(&a2.id)).await;
        place(&pool, "videos", &videos[2], Some(&b.id)).await;
        place(&pool, "files", &files[0], Some(&a1.id)).await;

        // A dedup pair in B: two rows, one group — B (and every ancestor)
        // counts the item once.
        let pair = seed_dedup_pair(&pool, &["dup-1.mp4", "dup-2.mp4"], "g1").await;
        place(&pool, "videos", &pair[0], Some(&b.id)).await;
        place(&pool, "videos", &pair[1], Some(&b.id)).await;

        // A split pair: one copy unfiled, one in A — both scopes count it.
        let split = seed_dedup_pair(&pool, &["split-1.mp4", "split-2.mp4"], "g2").await;
        place(&pool, "videos", &split[0], None).await;
        place(&pool, "videos", &split[1], Some(&a.id)).await;

        let tree = repo.fetch_tree(&owner).await.unwrap();

        // Flat order: roots first (NULL parent sorts first) in position
        // order; nested groups follow grouped by parent (their relative
        // order rides the parent UUIDs — the client builds the tree from
        // parent_id refs, so only the roots-first contract matters).
        let names: Vec<&str> = tree.folders.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(&names[..2], &["A", "B"], "roots lead, in position order");
        assert_eq!(
            tree.folders
                .iter()
                .map(|f| f.name.as_str())
                .collect::<std::collections::BTreeSet<_>>(),
            ["A", "A1", "A2", "B"]
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>(),
            "the flat list carries every folder exactly once"
        );
        let count = |id: &str| tree.folders.iter().find(|f| f.id == id).unwrap().item_count;
        assert_eq!(count(&a2.id), 1, "leaf: one video");
        assert_eq!(
            count(&a1.id),
            2,
            "A1's file + A2's video (cumulative subtree)"
        );
        assert_eq!(
            count(&a.id),
            4,
            "A = in-a.mp4 + A2's video + A1's file + the split pair's copy"
        );
        assert_eq!(count(&b.id), 2, "B = in-b.mp4 + the dedup pair (once)");
        // Unfiled = loose.mp4 + unfiled.pdf + the split pair's unfiled
        // copy (one item despite two rows).
        assert_eq!(tree.unfiled_count, 3);
    }

    #[tokio::test]
    async fn fetch_contents_lists_direct_mixed_children_paginated_and_filtered() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();

        let outer = repo
            .create_folder(&owner, None, "outer")
            .await
            .unwrap()
            .unwrap();
        let inner = repo
            .create_folder(&owner, Some(&outer.id), "inner")
            .await
            .unwrap()
            .unwrap();

        let videos = seed_videos(
            &pool,
            &["zeta.mp4", "alpha.mp4", "inner-only.mp4", "loose.mp4"],
        )
        .await;
        let files = seed_files(&pool, &["beta.jpg", "gamma.pdf"]).await;
        place(&pool, "videos", &videos[0], Some(&outer.id)).await;
        place(&pool, "videos", &videos[1], Some(&outer.id)).await;
        place(&pool, "videos", &videos[2], Some(&inner.id)).await;
        place(&pool, "files", &files[0], Some(&outer.id)).await;
        place(&pool, "files", &files[1], None).await;

        // Full listing: direct children only, name-ascending, mixed.
        let page = repo
            .fetch_contents(&owner, &contents_filter(Some(&outer.id), &owner))
            .await
            .unwrap()
            .expect("owned folder lists");
        assert_eq!(
            entry_names(&page),
            vec!["alpha.mp4", "beta.jpg", "zeta.mp4"],
            "mixed kinds, name-ascending, no nested or foreign items"
        );
        assert_eq!(page.total, 3);
        assert_eq!((page.page, page.limit), (1, 50));

        // kind filter.
        let mut video_only = contents_filter(Some(&outer.id), &owner);
        video_only.kind = Some("video".into());
        let page = repo
            .fetch_contents(&owner, &video_only)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry_names(&page), vec!["alpha.mp4", "zeta.mp4"]);

        let mut image_only = contents_filter(Some(&outer.id), &owner);
        image_only.kind = Some("image".into());
        let page = repo
            .fetch_contents(&owner, &image_only)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry_names(&page), vec!["beta.jpg"]);

        // q filter (name contains).
        let mut q = contents_filter(Some(&outer.id), &owner);
        q.q = Some("eta".into());
        let page = repo.fetch_contents(&owner, &q).await.unwrap().unwrap();
        assert_eq!(entry_names(&page), vec!["beta.jpg", "zeta.mp4"]);

        // Pagination: page 2 with limit 2 → the tail entry.
        let mut p2 = contents_filter(Some(&outer.id), &owner);
        p2.page = 2;
        p2.limit = 2;
        let page = repo.fetch_contents(&owner, &p2).await.unwrap().unwrap();
        assert_eq!(entry_names(&page), vec!["zeta.mp4"]);
        assert_eq!(page.total, 3, "total is unpaginated");

        // Unfiled bucket (folder_id None): loose.mp4 + gamma.pdf.
        let page = repo
            .fetch_contents(&owner, &contents_filter(None, &owner))
            .await
            .unwrap()
            .expect("unfiled always lists");
        assert_eq!(entry_names(&page), vec!["gamma.pdf", "loose.mp4"]);
        assert_eq!(page.total, 2);
    }

    #[tokio::test]
    async fn fetch_contents_hydrates_video_sources_and_enrichment() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();

        let folder = repo
            .create_folder(&owner, None, "f")
            .await
            .unwrap()
            .unwrap();
        let pair = seed_dedup_pair(&pool, &["dup-1.mp4", "dup-2.mp4"], "g1").await;
        place(&pool, "videos", &pair[0], Some(&folder.id)).await;
        place(&pool, "videos", &pair[1], Some(&folder.id)).await;

        let page = repo
            .fetch_contents(&owner, &contents_filter(Some(&folder.id), &owner))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(page.entries.len(), 1, "dedup pair surfaces once");
        let FolderEntry::Video(v) = &page.entries[0] else {
            panic!("expected a video entry");
        };
        assert_eq!(v.kind, "video");
        assert_eq!(
            v.video.sources.len(),
            2,
            "both dedup copies hydrate as sources"
        );
        assert!(!v.video.is_favorite);
        assert!(v.video.my_rating.is_none());
        assert!(v.video.position_seconds.is_none());
        assert!(!v.video.completed);
    }

    #[tokio::test]
    async fn fetch_contents_on_foreign_or_unknown_folder_is_none() {
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
        assert!(repo
            .fetch_contents(&owner_a, &contents_filter(Some("missing"), &owner_a))
            .await
            .unwrap()
            .is_none());
        assert!(repo
            .fetch_contents(&owner_b, &contents_filter(Some(&folder.id), &owner_b))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn move_items_rewrites_a_mixed_batch_in_one_transaction() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let videos = seed_videos(&pool, &["v1.mp4", "v2.mp4"]).await;
        let files = seed_files(&pool, &["f1.jpg"]).await;
        let folder = repo
            .create_folder(&owner, None, "Trip")
            .await
            .unwrap()
            .unwrap();

        let batch = [
            MoveItem {
                kind: ItemKind::Video,
                id: &videos[0],
            },
            MoveItem {
                kind: ItemKind::Video,
                id: &videos[1],
            },
            MoveItem {
                kind: ItemKind::File,
                id: &files[0],
            },
        ];
        let written = repo
            .move_items(&owner, &batch, Some(&folder.id))
            .await
            .unwrap()
            .expect("owned target folder accepts the batch");
        assert_eq!(written, 3);

        assert_eq!(
            placement_of(&pool, "videos", &videos[0]).await,
            Some(folder.id.clone())
        );
        assert_eq!(
            placement_of(&pool, "videos", &videos[1]).await,
            Some(folder.id.clone())
        );
        assert_eq!(
            placement_of(&pool, "files", &files[0]).await,
            Some(folder.id.clone())
        );

        // Counts shift: folder +1 cumulative per item, unfiled drains.
        let tree = repo.fetch_tree(&owner).await.unwrap();
        assert_eq!(tree.folders[0].item_count, 3);
        assert_eq!(tree.unfiled_count, 0);

        // Back to Unfiled: folder_id null files items as unfiled.
        let written = repo
            .move_items(&owner, &batch, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(written, 3);
        assert_eq!(placement_of(&pool, "videos", &videos[0]).await, None);
        let tree = repo.fetch_tree(&owner).await.unwrap();
        assert_eq!(tree.folders[0].item_count, 0);
        assert_eq!(tree.unfiled_count, 3);

        // A repeated id in one batch is a no-op beyond the first write.
        let twice = [
            MoveItem {
                kind: ItemKind::Video,
                id: &videos[0],
            },
            MoveItem {
                kind: ItemKind::Video,
                id: &videos[0],
            },
        ];
        let written = repo
            .move_items(&owner, &twice, Some(&folder.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(written, 1, "in-batch duplicates collapse");
    }

    #[tokio::test]
    async fn move_items_with_one_unknown_id_fails_atomically() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let videos = seed_videos(&pool, &["v1.mp4"]).await;
        let folder = repo
            .create_folder(&owner, None, "Trip")
            .await
            .unwrap()
            .unwrap();

        // The bogus id sits in the middle — the valid item before it must
        // not survive (all-or-nothing).
        let batch = [
            MoveItem {
                kind: ItemKind::Video,
                id: &videos[0],
            },
            MoveItem {
                kind: ItemKind::Video,
                id: "not-a-video",
            },
        ];
        let err = repo
            .move_items(&owner, &batch, Some(&folder.id))
            .await
            .unwrap_err();
        assert!(
            matches!(err, FolderWriteError::UnknownItem),
            "unknown id must fail the batch, got {err:?}"
        );
        assert_eq!(
            placement_of(&pool, "videos", &videos[0]).await,
            None,
            "nothing moved — the batch is atomic"
        );

        // A video id declared as a file (wrong namespace) is equally
        // unknown.
        let batch = [MoveItem {
            kind: ItemKind::File,
            id: &videos[0],
        }];
        assert!(matches!(
            repo.move_items(&owner, &batch, Some(&folder.id))
                .await
                .unwrap_err(),
            FolderWriteError::UnknownItem
        ));
        assert_eq!(placement_of(&pool, "videos", &videos[0]).await, None);
    }

    #[tokio::test]
    async fn move_items_to_a_foreign_folder_is_a_guard_rejection() {
        let (pool, _guard) = fresh_pool().await;
        let repo = LibraryFolderRepository::new(pool.clone());
        let owner_a = seed_owner(&pool).await;
        let owner_a = owner_a.to_string();
        let owner_b = seed_owner(&pool).await;
        let owner_b = owner_b.to_string();
        let videos = seed_videos(&pool, &["v1.mp4"]).await;
        let theirs = repo
            .create_folder(&owner_b, None, "theirs")
            .await
            .unwrap()
            .unwrap();

        let batch = [MoveItem {
            kind: ItemKind::Video,
            id: &videos[0],
        }];
        assert!(repo
            .move_items(&owner_a, &batch, Some(&theirs.id))
            .await
            .unwrap()
            .is_none());
        assert!(repo
            .move_items(&owner_a, &batch, Some("missing"))
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            placement_of(&pool, "videos", &videos[0]).await,
            None,
            "guard rejection writes nothing"
        );
    }

    // ---- drag-and-drop task 005: item ordering ----

    /// The names one folder's contents page serves, in served order —
    /// the ordering lens for these tests.
    async fn contents_names(
        repo: &LibraryFolderRepository,
        owner_id: &str,
        folder_id: Option<&str>,
    ) -> Vec<String> {
        let page = repo
            .fetch_contents(
                owner_id,
                &LibraryContentsFilter {
                    folder_id: folder_id.map(str::to_string),
                    page: 1,
                    limit: 200,
                    owner_id: owner_id.to_string(),
                    kind: None,
                    q: None,
                },
            )
            .await
            .unwrap()
            .expect("contents fetch");
        page.entries
            .iter()
            .map(|entry| match entry {
                FolderEntry::Video(v) => v.video.name.clone(),
                FolderEntry::File(f) => f.file.name.clone(),
            })
            .collect()
    }

    /// Raw position read-back for one placed row.
    async fn position_of(pool: &SqlitePool, table: &str, id: &str) -> Option<i64> {
        assert!(table == "videos" || table == "files");
        sqlx::query_scalar(&format!(
            "SELECT library_folder_position FROM {table} WHERE id = ?"
        ))
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    fn items<'a, I>(kind: ItemKind, ids: I) -> Vec<MoveItem<'a>>
    where
        I: IntoIterator<Item = &'a String>,
    {
        ids.into_iter()
            .map(|id| MoveItem {
                kind,
                id: id.as_str(),
            })
            .collect()
    }

    /// The reorder-list contract violation — panics on any other
    /// outcome so a test can't mistake success or a database error for
    /// the rejection.
    fn expect_reorder_mismatch<T: std::fmt::Debug>(result: Result<Option<T>, FolderWriteError>) {
        assert!(
            matches!(result, Err(FolderWriteError::ReorderMismatch)),
            "expected ReorderMismatch, got {result:?}"
        );
    }

    #[tokio::test]
    async fn migration_leaves_existing_positions_null() {
        let (pool, _guard) = fresh_pool().await;
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let files = seed_files(&pool, &["b.jpg"]).await;
        let folder = repo_folder(&pool, &owner, "F").await;
        place(&pool, "videos", &videos[0], Some(&folder)).await;
        place(&pool, "files", &files[0], Some(&folder)).await;

        for (table, id) in [("videos", &videos[0]), ("files", &files[0])] {
            assert_eq!(
                position_of(&pool, table, id).await,
                None,
                "seeded (pre-0019) rows must start unordered"
            );
        }
        assert_eq!(
            contents_names(&repo_of(&pool), &owner, Some(&folder)).await,
            vec!["a.mp4".to_string(), "b.jpg".to_string()],
            "unordered contents stay name-ascending (NOCASE)"
        );
    }

    /// Shared fixture: folder F holding videos B, A, C (name-ascending
    /// display A, B, C) — returns (folder_id, video ids in name order).
    async fn ordered_fixture(pool: &SqlitePool, owner: &str) -> (String, Vec<String>) {
        let folder = repo_folder(pool, owner, "F").await;
        let videos = seed_videos(pool, &["B.mp4", "A.mp4", "C.mp4"]).await;
        for id in &videos {
            place(pool, "videos", id, Some(&folder)).await;
        }
        (folder, videos)
    }

    /// `repo_folder` via the public API (positions exercised through
    /// create, not raw SQL).
    async fn repo_folder(pool: &SqlitePool, owner: &str, name: &str) -> String {
        LibraryFolderRepository::new(pool.clone())
            .create_folder(owner, None, name)
            .await
            .unwrap()
            .unwrap()
            .id
    }

    fn repo_of(pool: &SqlitePool) -> LibraryFolderRepository {
        LibraryFolderRepository::new(pool.clone())
    }

    #[tokio::test]
    async fn reorder_items_first_flip_is_dense_and_orders_contents() {
        let (pool, _guard) = fresh_pool().await;
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let (folder, videos) = ordered_fixture(&pool, &owner).await;
        // videos in seed order: B, A, C.
        let [b, a, c] = [&videos[0], &videos[1], &videos[2]];

        let repo = repo_of(&pool);
        let list = [c.clone(), a.clone(), b.clone()];
        let ordered = items(ItemKind::Video, &list);
        let n = repo
            .reorder_items(&owner, Some(&folder), &ordered)
            .await
            .unwrap()
            .expect("reorder of the exact member set succeeds");
        assert_eq!(n, 3);

        assert_eq!(
            position_of(&pool, "videos", c).await,
            Some(0),
            "first listed item flips to dense position 0"
        );
        assert_eq!(position_of(&pool, "videos", a).await, Some(1));
        assert_eq!(position_of(&pool, "videos", b).await, Some(2));
        assert_eq!(
            contents_names(&repo, &owner, Some(&folder)).await,
            vec![
                "C.mp4".to_string(),
                "A.mp4".to_string(),
                "B.mp4".to_string()
            ],
            "ordered contents follow the positions, not the name sort"
        );

        // A second reorder rewrites the same dense space.
        let list = [a.clone(), b.clone(), c.clone()];
        let ordered = items(ItemKind::Video, &list);
        repo.reorder_items(&owner, Some(&folder), &ordered)
            .await
            .unwrap();
        assert_eq!(position_of(&pool, "videos", a).await, Some(0));
        assert_eq!(
            contents_names(&repo, &owner, Some(&folder)).await,
            vec![
                "A.mp4".to_string(),
                "B.mp4".to_string(),
                "C.mp4".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn reorder_items_rejects_mismatched_lists_without_moving_anything() {
        let (pool, _guard) = fresh_pool().await;
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let (folder, videos) = ordered_fixture(&pool, &owner).await;
        let [b, a, c] = [&videos[0], &videos[1], &videos[2]];
        let outsider = seed_videos(&pool, &["Z-unfiled.mp4"]).await;

        let repo = repo_of(&pool);
        let bad_id_lists = [
            // Missing id (2 of 3 placed).
            vec![a.clone(), c.clone()],
            // Extra id (a placed id + an unfiled one).
            vec![a.clone(), b.clone(), c.clone(), outsider[0].clone()],
            // Foreign id (unknown uuid).
            vec![a.clone(), b.clone(), c.clone(), Uuid::new_v4().to_string()],
            // Duplicate in list.
            vec![a.clone(), a.clone(), c.clone()],
        ];
        for ids in &bad_id_lists {
            let bad = items(ItemKind::Video, ids);
            let result = repo.reorder_items(&owner, Some(&folder), &bad).await;
            expect_reorder_mismatch(result);
        }
        // Empty.
        expect_reorder_mismatch(repo.reorder_items(&owner, Some(&folder), &[]).await);

        // Nothing moved: still unordered, still name-ascending.
        for id in [&videos[0], &videos[1], &videos[2]] {
            assert_eq!(position_of(&pool, "videos", id).await, None);
        }
        assert_eq!(
            contents_names(&repo, &owner, Some(&folder)).await,
            vec![
                "A.mp4".to_string(),
                "B.mp4".to_string(),
                "C.mp4".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn reorder_items_unknown_folder_is_a_guard_rejection() {
        let (pool, _guard) = fresh_pool().await;
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let videos = seed_videos(&pool, &["a.mp4"]).await;
        let ordered = items(ItemKind::Video, &videos);
        assert!(repo_of(&pool)
            .reorder_items(&owner, Some("missing"), &ordered)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn reorder_items_unfiled_bucket_orders_null_placements() {
        let (pool, _guard) = fresh_pool().await;
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let videos = seed_videos(&pool, &["B.mp4", "A.mp4"]).await;

        let repo = repo_of(&pool);
        let ordered = items(ItemKind::Video, &videos);
        repo.reorder_items(&owner, None, &ordered).await.unwrap();
        assert_eq!(
            contents_names(&repo, &owner, None).await,
            vec!["B.mp4".to_string(), "A.mp4".to_string()],
            "the Unfiled bucket reorders with the same mechanics"
        );
    }

    #[tokio::test]
    async fn reorder_items_dedup_copies_ride_the_representative() {
        let (pool, _guard) = fresh_pool().await;
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let folder = repo_folder(&pool, &owner, "F").await;
        // One dedup group (two copies) + one lone video, all in F.
        let vids = seed_videos(&pool, &["Copy1.mp4", "Copy2.mp4", "Lone.mp4"]).await;
        sqlx::query("UPDATE videos SET dedup_group = 'g1' WHERE id IN (?, ?)")
            .bind(&vids[0])
            .bind(&vids[1])
            .execute(&pool)
            .await
            .unwrap();
        for id in &vids {
            place(&pool, "videos", id, Some(&folder)).await;
        }

        let repo = repo_of(&pool);
        // Contents shows one representative (MIN(id) of the group) +
        // the lone video — the reorder list speaks in those ids. Which
        // copy is the representative is id-order, not seed order.
        let (rep, hidden, rep_name) = if vids[0] < vids[1] {
            (&vids[0], &vids[1], "Copy1.mp4")
        } else {
            (&vids[1], &vids[0], "Copy2.mp4")
        };
        assert_eq!(
            contents_names(&repo, &owner, Some(&folder)).await,
            vec![rep_name.to_string(), "Lone.mp4".to_string()],
            "name-ascending before the flip; the hidden copy never lists"
        );
        let list = [vids[2].clone(), rep.clone()];
        repo.reorder_items(&owner, Some(&folder), &items(ItemKind::Video, &list))
            .await
            .unwrap();

        assert_eq!(position_of(&pool, "videos", &vids[2]).await, Some(0));
        assert_eq!(
            position_of(&pool, "videos", hidden).await,
            position_of(&pool, "videos", rep).await,
            "the hidden copy rides its representative's position — the \
             ordered-iff-everything-positioned invariant holds"
        );
        assert_eq!(
            contents_names(&repo, &owner, Some(&folder)).await,
            vec!["Lone.mp4".to_string(), rep_name.to_string()],
            "post-flip order follows the reorder list"
        );
    }

    #[tokio::test]
    async fn reorder_folders_dense_rewrite_and_rejections() {
        let (pool, _guard) = fresh_pool().await;
        let repo = repo_of(&pool);
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();

        let a = repo
            .create_folder(&owner, None, "A")
            .await
            .unwrap()
            .unwrap();
        let b = repo
            .create_folder(&owner, None, "B")
            .await
            .unwrap()
            .unwrap();
        let c = repo
            .create_folder(&owner, None, "C")
            .await
            .unwrap()
            .unwrap();

        // Root siblings reorder densely.
        repo.reorder_folders(&owner, None, &[c.id.as_str(), a.id.as_str(), b.id.as_str()])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            root_folders(&pool, &owner)
                .await
                .into_iter()
                .map(|(name, position, _)| (name, position))
                .collect::<Vec<_>>(),
            vec![
                ("C".to_string(), 0),
                ("A".to_string(), 1),
                ("B".to_string(), 2),
            ]
        );

        // Mismatch matrix: missing, extra (a nested child is not a root
        // sibling), duplicate, empty — every one aborts whole.
        let child = repo
            .create_folder(&owner, Some(&a.id), "child")
            .await
            .unwrap()
            .unwrap();
        for bad in [
            vec![a.id.as_str(), b.id.as_str()],
            vec![
                a.id.as_str(),
                b.id.as_str(),
                c.id.as_str(),
                child.id.as_str(),
            ],
            vec![a.id.as_str(), a.id.as_str(), c.id.as_str()],
            vec![],
        ] {
            let result = repo.reorder_folders(&owner, None, &bad).await;
            expect_reorder_mismatch(result);
        }
        // Nothing moved.
        assert_eq!(
            root_folders(&pool, &owner)
                .await
                .into_iter()
                .map(|(_, position, _)| position)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );

        // Nested scope reorders through the same shape.
        let child2 = repo
            .create_folder(&owner, Some(&a.id), "child2")
            .await
            .unwrap()
            .unwrap();
        repo.reorder_folders(
            &owner,
            Some(&a.id),
            &[child2.id.as_str(), child.id.as_str()],
        )
        .await
        .unwrap()
        .unwrap();
        let under_a: Vec<(String, i64)> = sqlx::query(
            "SELECT name, position FROM library_folders \
             WHERE owner_id = ? AND parent_id = ? ORDER BY position",
        )
        .bind(&owner)
        .bind(&a.id)
        .fetch_all(&pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r: sqlx::sqlite::SqliteRow| {
            (sqlx::Row::get(&r, "name"), sqlx::Row::get(&r, "position"))
        })
        .collect();
        assert_eq!(
            under_a,
            vec![("child2".to_string(), 0), ("child".to_string(), 1)]
        );
    }

    #[tokio::test]
    async fn move_into_ordered_folder_appends_at_tail() {
        let (pool, _guard) = fresh_pool().await;
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let (folder, videos) = ordered_fixture(&pool, &owner).await;
        let [b, a, c] = [&videos[0], &videos[1], &videos[2]];
        let repo = repo_of(&pool);
        let list = [c.clone(), a.clone(), b.clone()];
        repo.reorder_items(&owner, Some(&folder), &items(ItemKind::Video, &list))
            .await
            .unwrap();

        let x = seed_videos(&pool, &["X.mp4"]).await;
        repo.move_items(&owner, &items(ItemKind::Video, &x), Some(&folder))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(position_of(&pool, "videos", &x[0]).await, Some(3));
        assert_eq!(
            contents_names(&repo, &owner, Some(&folder)).await,
            vec![
                "C.mp4".to_string(),
                "A.mp4".to_string(),
                "B.mp4".to_string(),
                "X.mp4".to_string()
            ],
            "the incoming item lands after the ordered tail"
        );
    }

    #[tokio::test]
    async fn move_out_of_ordered_folder_clears_the_position() {
        let (pool, _guard) = fresh_pool().await;
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let (folder, videos) = ordered_fixture(&pool, &owner).await;
        let [b, a, c] = [&videos[0], &videos[1], &videos[2]];
        let repo = repo_of(&pool);
        let list = [c.clone(), a.clone(), b.clone()];
        repo.reorder_items(&owner, Some(&folder), &items(ItemKind::Video, &list))
            .await
            .unwrap();

        // B leaves for Unfiled.
        let leaving = [b.clone()];
        repo.move_items(&owner, &items(ItemKind::Video, &leaving), None)
            .await
            .unwrap();
        assert_eq!(position_of(&pool, "videos", b).await, None);
        assert_eq!(
            contents_names(&repo, &owner, Some(&folder)).await,
            vec!["C.mp4".to_string(), "A.mp4".to_string()],
            "the remaining order stands — gaps never change rendering"
        );
    }

    #[tokio::test]
    async fn move_into_unordered_folder_assigns_no_positions() {
        let (pool, _guard) = fresh_pool().await;
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let folder = repo_folder(&pool, &owner, "F").await;
        let videos = seed_videos(&pool, &["B.mp4"]).await;
        let repo = repo_of(&pool);
        repo.move_items(&owner, &items(ItemKind::Video, &videos), Some(&folder))
            .await
            .unwrap();
        assert_eq!(
            position_of(&pool, "videos", &videos[0]).await,
            None,
            "a move into an unordered folder never assigns positions"
        );
    }

    #[tokio::test]
    async fn delete_folder_lifts_items_with_cleared_positions() {
        let (pool, _guard) = fresh_pool().await;
        let owner = seed_owner(&pool).await;
        let owner = owner.to_string();
        let (folder, videos) = ordered_fixture(&pool, &owner).await;
        let [b, a, c] = [&videos[0], &videos[1], &videos[2]];
        let repo = repo_of(&pool);
        let list = [c.clone(), a.clone(), b.clone()];
        repo.reorder_items(&owner, Some(&folder), &items(ItemKind::Video, &list))
            .await
            .unwrap();

        repo.delete_folder(&owner, &folder).await.unwrap().unwrap();
        for id in [a, b, c] {
            assert_eq!(
                position_of(&pool, "videos", id).await,
                None,
                "lifted items return to Unfiled unordered — a delete must \
                 not smuggle an order into the bucket"
            );
        }
    }
}
