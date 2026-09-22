//! Library-folders REST — owner-curated organization for the whole
//! catalog (docs/specs/library-folders/spec.md).
//!
//! Every route here is owner-only (session-gated via the middleware
//! stack, CSRF on mutations — no allowlist entry, mirroring the shares
//! mutation contract). Folders are organization, never authorization:
//! nothing in this module gates playback, shares, search, or the
//! "All files" grid — placement is a presentation axis the batch-move
//! endpoint is the sole writer of.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::resolve_owner_id;
use crate::error::{ApiError, ApiResult};
use crate::library_folders::{
    FolderInvalid, FolderWriteError, ItemKind, LibraryContentsFilter, LibraryFolderError,
    LibraryTreeFolder, MoveItem,
};
use crate::state::AppState;

/// Body of `POST /api/library-folders`: the folder name (trimmed,
/// 1..=200 chars) and an optional parent folder id — omitted or `null`
/// creates at the tree root.
#[derive(Debug, Deserialize)]
pub struct CreateFolderRequest {
    pub name: String,
    pub parent_id: Option<String>,
}

/// Body of `PATCH /api/library-folders/{fid}`: absent fields leave the
/// stored value alone. `parent_id` is a double-option so JSON `null`
/// (move to root) is distinguishable from the key being absent (don't
/// move): absent → `None`, `null` → `Some(None)`, id → `Some(Some(id))`.
#[derive(Debug, Default, Deserialize)]
pub struct UpdateFolderRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub parent_id: Option<Option<String>>,
}

/// `serde(default)` + this hook = the double-option protocol: the key
/// absent stays `None`; `null` or a value both surface as `Some(_)`.
fn deserialize_double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}

/// One entry of a batch-move body: the id's namespace tag plus the id.
#[derive(Debug, Deserialize)]
pub struct MoveItemBody {
    /// `video` | `file` — anything else is a 400 before any write.
    pub kind: String,
    pub id: String,
}

/// Body of `PATCH /api/library-folders/items`: the whole batch plus the
/// target folder — `null` (or absent) files the items to Unfiled.
#[derive(Debug, Deserialize)]
pub struct MoveItemsRequest {
    pub items: Vec<MoveItemBody>,
    pub folder_id: Option<String>,
}

/// Query params of `GET /api/library-folders/contents`.
#[derive(Debug, Deserialize)]
pub struct ContentsParams {
    /// Absent → the Unfiled bucket (NULL placement).
    pub folder_id: Option<String>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
    /// `video` or one of the six file kinds; unknown values are ignored.
    pub kind: Option<String>,
    pub q: Option<String>,
}

/// Mutation-response folder row — the share-folder DTO shape exactly.
/// Deliberately carries no `item_count`: mutations invalidate the tree
/// query (the server owns the tree), so a stale count here would only
/// mislead.
#[derive(Debug, Serialize)]
pub struct FolderDto {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub position: i64,
}

impl From<crate::library_folders::LibraryFolderRow> for FolderDto {
    fn from(row: crate::library_folders::LibraryFolderRow) -> Self {
        Self {
            id: row.id,
            parent_id: row.parent_id,
            name: row.name,
            position: row.position,
        }
    }
}

/// Tree node over the wire: the folder row plus its cumulative item
/// count (videos + files over the subtree).
#[derive(Debug, Serialize)]
pub struct TreeFolderDto {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub position: i64,
    pub item_count: i64,
}

impl From<LibraryTreeFolder> for TreeFolderDto {
    fn from(f: LibraryTreeFolder) -> Self {
        Self {
            id: f.id,
            parent_id: f.parent_id,
            name: f.name,
            position: f.position,
            item_count: f.item_count,
        }
    }
}

/// `GET /api/library-folders/tree` payload: the flat folder list (the
/// client builds the nested tree — one fetch, no per-node requests)
/// plus the pinned Unfiled node's live count.
#[derive(Debug, Serialize)]
pub struct TreeDto {
    pub folders: Vec<TreeFolderDto>,
    pub unfiled_count: i64,
}

/// Map the repository's folder-write rejections onto the HTTP ladder:
/// shape problems (name, depth) are 400 `Validation`; tree-state
/// problems (sibling name, cycle) are 409 `Conflict`; an unknown item
/// id in a batch is a plain 404 (spec: unknown ids never leak and never
/// half-move); database errors ride the subsystem passthrough. Four
/// distinct messages, four distinct client behaviors (spec criterion 4).
fn folder_write_error(err: FolderWriteError) -> ApiError {
    match err {
        FolderWriteError::Invalid(FolderInvalid::DuplicateName) => {
            ApiError::Conflict(FolderInvalid::DuplicateName.to_string())
        }
        FolderWriteError::Invalid(FolderInvalid::Cycle) => {
            ApiError::Conflict(FolderInvalid::Cycle.to_string())
        }
        FolderWriteError::Invalid(other) => ApiError::Validation {
            detail: other.to_string(),
        },
        FolderWriteError::UnknownItem => ApiError::NotFound,
        FolderWriteError::ReorderMismatch => ApiError::Validation {
            detail: FolderWriteError::ReorderMismatch.to_string(),
        },
        FolderWriteError::Database(db) => {
            ApiError::LibraryFolders(LibraryFolderError::Database(db))
        }
    }
}

/// `GET /api/library-folders/tree` — the curated tree + Unfiled count.
///
/// Read-only; the payload is a flat list with cumulative counts so the
/// sidebar renders folders, counts, and the pinned Unfiled node from
/// one response.
pub async fn tree(State(state): State<AppState>, jar: CookieJar) -> ApiResult<Json<TreeDto>> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;
    let tree = state
        .library_folder_repository()
        .fetch_tree(&owner_id.to_string())
        .await?;
    Ok(Json(TreeDto {
        folders: tree.folders.into_iter().map(TreeFolderDto::from).collect(),
        unfiled_count: tree.unfiled_count,
    }))
}

/// `POST /api/library-folders` — create a folder (root by default).
///
/// The repository's one transaction guards ownership of the parent,
/// validates the name (trim, 1..=200), and appends at the scope's tail.
/// Unknown/foreign parent ids are plain 404s; shape rejections are 400;
/// a sibling-name collision is 409.
pub async fn create(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<CreateFolderRequest>,
) -> ApiResult<impl IntoResponse> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;
    let row = state
        .library_folder_repository()
        .create_folder(&owner_id.to_string(), req.parent_id.as_deref(), &req.name)
        .await
        .map_err(folder_write_error)?
        .ok_or(ApiError::NotFound)?;
    tracing::info!(owner_id = %owner_id, folder_id = %row.id, "library folder created");
    Ok((StatusCode::CREATED, Json(FolderDto::from(row))))
}

/// `PATCH /api/library-folders/{fid}` — rename and/or reparent in one
/// write.
///
/// Absent fields leave the stored value untouched; `parent_id: null`
/// moves the folder to the tree root. The rename/reparent pair shares
/// one repository transaction, so a PATCH carrying both lands atomically
/// — the sibling-name check for the move runs against the NEW name in
/// the TARGET scope. Cycle and depth walk as [`create`]; the moved
/// folder appends at the end of its new sibling group and the vacated
/// scope renumbers. Unknown/foreign folder or parent ids are plain 404.
pub async fn update(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(folder_id): Path<String>,
    Json(req): Json<UpdateFolderRequest>,
) -> ApiResult<Json<FolderDto>> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;
    let row = state
        .library_folder_repository()
        .update_folder(
            &owner_id.to_string(),
            &folder_id,
            req.name.as_deref(),
            req.parent_id.as_ref().map(|p| p.as_deref()),
        )
        .await
        .map_err(folder_write_error)?
        .ok_or(ApiError::NotFound)?;
    tracing::info!(owner_id = %owner_id, folder_id = %folder_id, "library folder updated");
    Ok(Json(FolderDto::from(row)))
}

/// `DELETE /api/library-folders/{fid}` — delete a folder; its items
/// return to Unfiled and its subfolders flatten to the root.
///
/// Folder deletion is organization, never catalog: no `videos`/`files`
/// row is removed, so playback, shares, search, and the "All files" grid
/// are untouched. The repository's single transaction lifts items (plain
/// placement clear — only folders have positions), flattens subfolders
/// to root with deterministic de-collision, then deletes the row; a
/// success is 204. An unknown or foreign folder id is a plain 404 — the
/// ladder's no-existence-leak rule beats retry-idempotence here,
/// matching the share-folder routes.
pub async fn delete(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(folder_id): Path<String>,
) -> ApiResult<StatusCode> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;
    state
        .library_folder_repository()
        .delete_folder(&owner_id.to_string(), &folder_id)
        .await
        .map_err(folder_write_error)?
        .ok_or(ApiError::NotFound)?;
    tracing::info!(owner_id = %owner_id, folder_id = %folder_id, "library folder deleted");
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/library-folders/contents?folder_id=&page=&limit=&kind=&q=`
/// — the mixed, paginated listing of items directly in one folder, or
/// the Unfiled bucket when `folder_id` is absent.
///
/// Items only — subfolder tiles derive from the tree query, so
/// pagination never drops a folder off a page boundary. The wire reuses
/// the provider contents shapes (`FolderContentsPage`), `kind`/`q`
/// filter as there. An unknown/foreign `folder_id` is a plain 404.
pub async fn contents(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(params): Query<ContentsParams>,
) -> ApiResult<Json<castify_catalog::FolderContentsPage>> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;
    let filter = LibraryContentsFilter {
        folder_id: params.folder_id.filter(|s| !s.is_empty()),
        page: params.page.unwrap_or(1),
        limit: params.limit.unwrap_or(50),
        owner_id: owner_id.to_string(),
        kind: params.kind.filter(|s| !s.is_empty()),
        q: params.q.filter(|s| !s.is_empty()),
    };
    let page = state
        .library_folder_repository()
        .fetch_contents(&owner_id.to_string(), &filter)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(page))
}

/// `PATCH /api/library-folders/items` — batch move. One transaction per
/// user action (data-storage rule #5): all listed items land in
/// `folder_id` (null → Unfiled) or the request fails whole. Folders are
/// organization, never authorization — playback and shares never read
/// this column. `kind` guards the id namespace (`video` | `file`,
/// anything else is a 400 before any write); unknown item ids fail the
/// batch with 404 and nothing moves; an unknown/foreign target folder
/// is a plain 404.
pub async fn move_items(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<MoveItemsRequest>,
) -> ApiResult<StatusCode> {
    let owner_id: Uuid = resolve_owner_id(&state, &jar).await?;
    if req.items.is_empty() {
        return Err(ApiError::Validation {
            detail: "items must contain at least one entry".to_string(),
        });
    }
    let mut items = Vec::with_capacity(req.items.len());
    for entry in &req.items {
        let kind = match entry.kind.as_str() {
            "video" => ItemKind::Video,
            "file" => ItemKind::File,
            other => {
                return Err(ApiError::Validation {
                    detail: format!("unknown item kind {other:?}; expected \"video\" or \"file\""),
                });
            }
        };
        items.push(MoveItem {
            kind,
            id: entry.id.as_str(),
        });
    }
    state
        .library_folder_repository()
        .move_items(&owner_id.to_string(), &items, req.folder_id.as_deref())
        .await
        .map_err(folder_write_error)?
        .ok_or(ApiError::NotFound)?;
    tracing::info!(
        owner_id = %owner_id,
        count = items.len(),
        folder_id = req.folder_id.as_deref().unwrap_or("<unfiled>"),
        "library items moved"
    );
    Ok(StatusCode::NO_CONTENT)
}
