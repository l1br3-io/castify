//! Local source resolution — gives ffmpeg a seekable local file path for a
//! given video. Used by embedded-text subtitle extraction (Task 006) and
//! burn-in transcoding (Task 008).
//!
//! GOTCHA: ffmpeg's `subtitles=` filter and subtitle demuxer need a seekable
//! file — stdin piping (`-i pipe:0`) can't burn or extract. Always resolve a
//! local source first.
//!
//! ## Resolution order
//!
//! 1. **M4 hot-video cache hit** → return `DiskCache::bytes_path(...)` if the
//!    video is currently cached on disk (no download, no cleanup — the file
//!    is owned by M4's lifecycle).
//! 2. **Cache miss** → stream the provider content to a tempfile under
//!    `<data_dir>/transcode-work/<video_id>/source.<ext>` and return that
//!    path. A per-video mutex dedupes concurrent downloads: the first caller
//!    downloads while holding it; concurrent callers wait, then reuse the
//!    result via a shared ref-counted slot.
//!
//! ## Cleanup
//!
//! The helper returns an RAII handle ([`LocalSource`]) whose guard is a clone
//! of an `Arc<SourceSlot>`. When the last consumer drops their handle, the
//! slot's `Drop` deletes the tempfile (and its parent `transcode-work/<video_id>/`
//! dir if empty). Cache-hit paths carry no guard — they are never deleted here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, Weak};

use futures::StreamExt;
use tokio::io::AsyncWriteExt;

use castify_catalog::{BodyStream, VideoStreamInfo};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// A resolved seekable local source for ffmpeg. Dropping this handle drops the
/// internal guard; for a `Tempfile` source, the last consumer to drop triggers
/// tempfile deletion. `Cached` sources never delete on drop.
pub struct LocalSource {
    /// `Cached` = M4 hot-video cache (not deleted here).
    /// `Tempfile` = downloaded by this helper (deleted when last guard drops).
    pub kind: LocalSourceKind,
    /// The seekable local file path to feed to ffmpeg.
    pub path: PathBuf,
    /// RAII guard. `Some` only for `Tempfile`. Cloning this `Arc` creates an
    /// additional consumer; the file is deleted when the last clone drops.
    _guard: Option<Arc<SourceSlot>>,
}

impl LocalSource {
    /// Whether this source is a downloaded tempfile (vs. an M4 cache hit).
    pub fn is_tempfile(&self) -> bool {
        matches!(self.kind, LocalSourceKind::Tempfile)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalSourceKind {
    /// Served from the M4 hot-video disk cache. Owned by M4's lifecycle —
    /// not deleted by this module.
    Cached,
    /// Streamed to a scratch tempfile under `transcode-work/`. Deleted when
    /// the last [`LocalSource`] guard drops.
    Tempfile,
}

impl std::fmt::Debug for LocalSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalSource")
            .field("kind", &self.kind)
            .field("path", &self.path)
            .finish()
    }
}

/// Process-local registry of resolved local sources, keyed by `video_id`.
/// Registered once on [`AppState`]. Mirrors the `TRANSCODE_REGISTRY` pattern
/// but lives on state (not a static) so it's testable without process-global
/// state.
#[derive(Default)]
pub struct LocalSourceRegistry {
    /// One entry per video ever resolved in this process. Entries persist
    /// (one small `Arc<Mutex<ResolveState>>` per video — bounded by catalog
    /// size, like `TRANSCODE_REGISTRY`). The slot inside dies with its
    /// consumers; a stale entry just re-downloads on next access.
    inner: StdMutex<HashMap<String, Arc<tokio::sync::Mutex<ResolveState>>>>,
}

impl LocalSourceRegistry {
    pub fn new() -> Self {
        Self {
            inner: StdMutex::new(HashMap::new()),
        }
    }

    /// Get (or lazily create) the per-video coordination entry. The returned
    /// `Arc<Mutex<ResolveState>>` serializes the download decision so two
    /// concurrent resolves of the same video share one download.
    fn entry_for(&self, video_id: &str) -> Arc<tokio::sync::Mutex<ResolveState>> {
        let mut inner = self.inner.lock().expect("local source registry poisoned");
        inner
            .entry(video_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(ResolveState::Empty)))
            .clone()
    }
}

/// Per-video resolution state, guarded by a `tokio::sync::Mutex`.
enum ResolveState {
    /// No live slot — caller should (re)download.
    Empty,
    /// A completed download. `Weak` so the registry never pins a source
    /// alive: the tempfile is reclaimed when the last consumer drops their
    /// [`LocalSource`] handle. A stale `Weak` (all consumers gone) upgrades
    /// to `None`, and the next resolve re-downloads.
    Live(Weak<SourceSlot>),
}

/// A downloaded tempfile, ref-counted across consumers. When the last strong
/// reference drops, `Drop` removes the file and its now-empty parent
/// `transcode-work/<video_id>/` directory.
struct SourceSlot {
    video_id: String,
    path: PathBuf,
}

impl Drop for SourceSlot {
    fn drop(&mut self) {
        // Best-effort synchronous cleanup. Brief blocking (~1ms for a file
        // unlink) is acceptable here, and using std::fs avoids requiring a
        // tokio runtime context on drop (the guard may drop on any thread).
        let _ = std::fs::remove_file(&self.path);
        if let Some(parent) = self.path.parent() {
            // remove_dir only succeeds when the directory is empty — leaves
            // any sibling scratch files (e.g. extracted subs) alone.
            let _ = std::fs::remove_dir(parent);
        }
        tracing::trace!(
            video_id = %self.video_id,
            path = %self.path.display(),
            "local source tempfile cleaned up",
        );
    }
}

/// Resolve a seekable local file path for `video_id`. Public entry point —
/// resolves stream info, checks the M4 hot-video cache, and on a miss streams
/// the provider content to a tempfile under `transcode-work/`.
///
/// See the module docs for the resolution order and cleanup semantics.
pub async fn resolve_local_source(state: &AppState, video_id: &str) -> ApiResult<LocalSource> {
    let info = crate::routes::videos::resolve_stream_info(state, video_id).await?;
    let ext = source_extension(&info.name);
    let cache_path = check_video_cache_hit(state, &info).await?;

    // Move owned copies into the fetch closure so the registry/data_dir
    // borrows below don't conflict with the closure capture.
    let fetch_state = state.clone();
    let fetch_info = info.clone();
    let data_dir = state.config().data_dir.clone();

    resolve_local_source_with_fetch(
        state.local_source_registry(),
        &data_dir,
        video_id,
        ext.as_deref(),
        cache_path,
        move || async move {
            crate::routes::videos::open_stream_with_refresh(&fetch_state, &fetch_info, None).await
        },
    )
    .await
}

/// Core resolution logic with an injected fetcher. Split from
/// [`resolve_local_source`] so the concurrency/cleanup surface is unit-testable
/// without a database or provider.
///
/// - `cache_path` = `Some` short-circuits to a `Cached` source (no fetch).
/// - `fetch` produces the provider stream on a cache miss.
pub(crate) async fn resolve_local_source_with_fetch<F, Fut>(
    registry: &LocalSourceRegistry,
    data_dir: &Path,
    video_id: &str,
    ext: Option<&str>,
    cache_path: Option<PathBuf>,
    fetch: F,
) -> ApiResult<LocalSource>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = ApiResult<castify_catalog::StreamResponse>>,
{
    // 1. Cache hit short-circuit — no fetch, no tempfile, no cleanup.
    if let Some(path) = cache_path {
        return Ok(LocalSource {
            kind: LocalSourceKind::Cached,
            path,
            _guard: None,
        });
    }

    // 2. Acquire the per-video coordination lock. Held across the download
    //    so a concurrent caller for the same video waits, then reuses.
    let entry = registry.entry_for(video_id);
    let mut guard = entry.lock().await;

    // 3. Reuse an already-resolved tempfile if one is still alive.
    if let ResolveState::Live(weak) = &*guard {
        if let Some(slot) = weak.upgrade() {
            let path = slot.path.clone();
            return Ok(LocalSource {
                kind: LocalSourceKind::Tempfile,
                path,
                _guard: Some(slot),
            });
        }
    }

    // 4. Download to a tempfile. The fetch runs before any file is created,
    //    so a provider failure leaves nothing behind on disk.
    let stream_response = fetch().await?;

    let dir = data_dir.join("transcode-work").join(video_id);
    let filename = match ext {
        Some(e) => format!("source.{e}"),
        None => "source".to_string(),
    };
    let path = dir.join(filename);

    if let Err(e) = stream_to_file(stream_response.body, &path).await {
        // Clean up any partial file + the (now empty) work dir.
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_dir(&dir).await;
        return Err(ApiError::Internal(e.into()));
    }

    let slot = Arc::new(SourceSlot {
        video_id: video_id.to_string(),
        path: path.clone(),
    });
    *guard = ResolveState::Live(Arc::downgrade(&slot));
    drop(guard);

    tracing::debug!(
        %video_id,
        path = %path.display(),
        "resolved local source tempfile",
    );

    Ok(LocalSource {
        kind: LocalSourceKind::Tempfile,
        path,
        _guard: Some(slot),
    })
}

/// Derive a lowercase file extension from the video's original filename.
/// ffmpeg uses it for container detection; falls back to no extension when
/// the filename has none.
fn source_extension(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

/// Stream a provider [`BodyStream`] to `path`, creating parent dirs as needed.
/// On error the caller is responsible for removing any partial file.
async fn stream_to_file(mut body: BodyStream, path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut file = tokio::fs::File::create(path).await?;
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    file.sync_all().await?;
    Ok(())
}

/// Check whether the video is live in the M4 hot-video disk cache. Returns the
/// on-disk path on hit. Mirrors the cache-hit logic in `get_stream_url`: the
/// manifest `provider_file_id` must match (no stale cache) AND the bytes must
/// exist on disk.
async fn check_video_cache_hit(
    state: &AppState,
    info: &VideoStreamInfo,
) -> ApiResult<Option<PathBuf>> {
    let Some(cache) = state.video_cache() else {
        return Ok(None);
    };
    let repo = state.catalog_repository();
    if let Some(entry) = repo.fetch_video_cache_entry(&info.id).await? {
        if entry.provider_file_id == info.provider_file_id
            && cache.exists(&info.id).await.unwrap_or(false)
        {
            return Ok(Some(
                cache
                    .bytes_path(&info.id)
                    .map_err(|e| ApiError::Internal(e.into()))?,
            ));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use castify_catalog::StreamResponse;

    /// Build a `BodyStream` that yields one chunk of `data`.
    fn bytes_stream(data: &[u8]) -> BodyStream {
        let chunk = Bytes::copy_from_slice(data);
        Box::pin(futures::stream::once(async move { Ok(chunk) }))
    }

    /// Minimal `StreamResponse` carrying `data` as a single chunk.
    fn stream_response(data: &[u8]) -> StreamResponse {
        StreamResponse {
            status: 200,
            content_type: "video/mp4".into(),
            content_length: Some(data.len() as u64),
            content_range: None,
            body: bytes_stream(data),
        }
    }

    #[tokio::test]
    async fn cache_hit_short_circuits_no_fetch() {
        let registry = LocalSourceRegistry::new();
        let data_dir = tempfile::tempdir().unwrap();
        let cache_path = data_dir
            .path()
            .join("video-cache")
            .join("ab")
            .join("video-1");
        let fetch_called = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let src = resolve_local_source_with_fetch(
            &registry,
            data_dir.path(),
            "video-1",
            Some("mp4"),
            Some(cache_path.clone()),
            {
                let c = Arc::clone(&fetch_called);
                move || {
                    let c = Arc::clone(&c);
                    async move {
                        c.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        Ok(stream_response(b"never reached"))
                    }
                }
            },
        )
        .await
        .expect("cache hit resolves");

        assert_eq!(src.kind, LocalSourceKind::Cached);
        assert_eq!(src.path, cache_path);
        assert!(!src.is_tempfile());
        assert_eq!(
            fetch_called.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "fetcher must not run on a cache hit"
        );
    }

    #[tokio::test]
    async fn tempfile_cleanup_on_drop() {
        let registry = LocalSourceRegistry::new();
        let data_dir = tempfile::tempdir().unwrap();

        let src = resolve_local_source_with_fetch(
            &registry,
            data_dir.path(),
            "video-2",
            Some("mkv"),
            None,
            || async { Ok(stream_response(b"video bytes here")) },
        )
        .await
        .expect("tempfile resolves");

        assert_eq!(src.kind, LocalSourceKind::Tempfile);
        assert!(src.is_tempfile());
        let path = src.path.clone();
        let parent = path.parent().unwrap().to_path_buf();
        assert!(path.exists(), "tempfile should exist while held");
        assert!(
            path.to_string_lossy().ends_with("source.mkv"),
            "filename should carry the extension: {}",
            path.display()
        );
        assert!(
            parent.ends_with("transcode-work/video-2"),
            "parent should be transcode-work/<video_id>"
        );

        drop(src);

        assert!(!path.exists(), "tempfile should be deleted on drop");
        assert!(
            !parent.exists(),
            "empty parent dir should be removed on drop"
        );
    }

    #[tokio::test]
    async fn fetch_failure_leaves_no_tempfile() {
        let registry = LocalSourceRegistry::new();
        let data_dir = tempfile::tempdir().unwrap();

        let result = resolve_local_source_with_fetch(
            &registry,
            data_dir.path(),
            "video-3",
            Some("mp4"),
            None,
            || async { Err(ApiError::ServiceUnavailable("provider is down".into())) },
        )
        .await;

        assert!(result.is_err(), "fetch failure must propagate");
        let work_dir = data_dir.path().join("transcode-work").join("video-3");
        assert!(
            !work_dir.exists(),
            "no partial tempfile or work dir should be left behind"
        );
    }

    #[tokio::test]
    async fn concurrent_calls_share_one_download() {
        use std::sync::atomic::AtomicUsize;

        let registry = Arc::new(LocalSourceRegistry::new());
        let data_dir = Arc::new(tempfile::tempdir().unwrap());
        let fetch_count = Arc::new(AtomicUsize::new(0));
        // A's fetcher announces it has entered the download (mutex held), then
        // blocks on `release` so caller B has time to spawn and wait.
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());

        // Caller A's fetcher — increments the counter, signals start, waits.
        let (fc_a, st_a, rel_a) = (
            Arc::clone(&fetch_count),
            Arc::clone(&started),
            Arc::clone(&release),
        );
        let fetcher_a = move || {
            let (fc, st, rel) = (Arc::clone(&fc_a), Arc::clone(&st_a), Arc::clone(&rel_a));
            async move {
                fc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                st.notify_one();
                rel.notified().await;
                Ok(stream_response(b"shared download"))
            }
        };

        // Caller B's fetcher — would increment the counter if called. If dedup
        // works, this never runs (B reuses A's slot). Kept non-blocking so a
        // dedup *failure* fails the assertion instead of hanging the test.
        let fc_b = Arc::clone(&fetch_count);
        let fetcher_b = move || {
            let fc = Arc::clone(&fc_b);
            async move {
                fc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(stream_response(b"b's own download"))
            }
        };

        // Spawn caller A — acquires the per-video lock, enters fetch, holds it.
        let (reg_a, dir_a) = (Arc::clone(&registry), Arc::clone(&data_dir));
        let task_a = tokio::spawn(async move {
            resolve_local_source_with_fetch(
                &reg_a,
                dir_a.path(),
                "video-4",
                Some("mp4"),
                None,
                fetcher_a,
            )
            .await
            .expect("A resolves")
        });

        // Wait until A is mid-download (holding the per-video mutex).
        started.notified().await;

        // Spawn caller B — blocks on the per-video mutex until A releases.
        let (reg_b, dir_b) = (Arc::clone(&registry), Arc::clone(&data_dir));
        let task_b = tokio::spawn(async move {
            resolve_local_source_with_fetch(
                &reg_b,
                dir_b.path(),
                "video-4",
                Some("mp4"),
                None,
                fetcher_b,
            )
            .await
            .expect("B resolves")
        });

        // Let A finish its download.
        release.notify_one();

        let src_a = task_a.await.expect("task A");
        let src_b = task_b.await.expect("task B");

        assert_eq!(
            fetch_count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "concurrent callers must share one download"
        );
        assert_eq!(src_a.path, src_b.path, "both callers share the same path");
        assert_eq!(src_a.kind, LocalSourceKind::Tempfile);
        assert_eq!(src_b.kind, LocalSourceKind::Tempfile);
        assert!(src_a.path.exists(), "file exists while both hold guards");
    }

    #[test]
    fn source_extension_lowercases() {
        assert_eq!(source_extension("Movie.MKV"), Some("mkv".into()));
        assert_eq!(source_extension("clip.mp4"), Some("mp4".into()));
        assert_eq!(source_extension("noext"), None);
        assert_eq!(source_extension(""), None);
    }
}
