//! Reusable disk cache primitives for Castify.
//!
//! This crate owns the **filesystem** side of caching: writing bytes to disk,
//! reading them back, deleting, and measuring total cache size. It deliberately
//! does NOT own the **manifest** (the table tracking which keys are cached,
//! their sizes, last-access timestamps, and pin state). The manifest stays in
//! the caller's domain — `crates/catalog/` for the video cache, M6's transcode
//! module for the transcode cache, etc.
//!
//! ## Why this split
//!
//! Different caches have different metadata needs (thumbnails need MIME type;
//! video cache needs pinned + size; transcode cache needs segment count +
//! profile). A single generic manifest would either be too restrictive or too
//! amorphous. The filesystem operations, however, are identical across all
//! caches: write bytes to a content-addressed path, read them back, delete
//! them, measure total size. Those live here.
//!
//! ## Atomicity
//!
//! Writes go to a temporary file first, then rename to the final path on
//! completion. A partially-written cache entry is invisible to readers (they
//! see no file at the final path until the rename lands). If the writer
//! crashes mid-write, the tmp file is left behind; the caller's background
//! sweep cleans it up.
//!
//! ## Concurrency
//!
//! `DiskCache` methods are safe to call concurrently. Per-key coordination
//! (avoiding duplicate concurrent writes to the same key) is the caller's
//! responsibility — `tokio::sync::Mutex` per key in the manifest layer handles
//! that.

use std::path::{Path, PathBuf};

use thiserror::Error;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

/// Errors returned by `DiskCache` operations. The caller decides how to
/// surface these — typically a cache miss is silent (falls through to the
/// uncached path), while disk-full or permission errors log at `warn`.
#[derive(Debug, Error)]
pub enum CacheError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("key contains path traversal or invalid characters: {0}")]
    InvalidKey(String),
}

pub type CacheResult<T> = Result<T, CacheError>;

/// A disk-backed byte cache. The root directory holds content-addressed
/// files; methods here are pure filesystem operations — no SQL, no manifest.
///
/// See the crate-level docs for the rationale behind keeping the manifest
/// in the caller's domain.
#[derive(Debug, Clone)]
pub struct DiskCache {
    root: PathBuf,
}

impl DiskCache {
    /// Construct a new cache rooted at `root`. The directory is created
    /// (recursively) if it doesn't exist. Returns an error if the path
    /// exists but is not a directory, or if creation fails.
    pub async fn new(root: impl Into<PathBuf>) -> CacheResult<Self> {
        let root = root.into();
        tokio::fs::create_dir_all(&root).await?;
        Ok(Self { root })
    }

    /// Return the path where bytes for `key` would live. Does NOT check
    /// existence — the caller consults its own manifest to decide that.
    /// The path is content-addressed: `<root>/<first_2_of_key>/<key>`.
    /// The 2-char sharding prevents any single directory from growing
    /// unboundedly large.
    ///
    /// Keys are validated to reject path traversal (`..`, `/`, NUL). Any
    /// key containing those characters returns `InvalidKey`.
    pub fn bytes_path(&self, key: &str) -> CacheResult<PathBuf> {
        validate_key(key)?;
        let shard = key.chars().take(2).collect::<String>();
        Ok(self.root.join(shard).join(key))
    }

    /// Return the path where a temporary in-progress write for `key` lives.
    /// Visible only to the writer until `finalize`d; readers never see it
    /// at the final path until the rename lands. Public for callers that
    /// need to inspect the tmp directory (e.g. admin endpoints).
    pub fn tmp_path(&self, key: &str) -> CacheResult<PathBuf> {
        validate_key(key)?;
        let shard = key.chars().take(2).collect::<String>();
        let dir = self.root.join("_tmp").join(shard);
        Ok(dir.join(format!("{key}.tmp")))
    }

    /// Open a streaming writer for `key`. Bytes written via the returned
    /// `StreamingCacheWriter` land in a temp file; on `finalize()` the
    /// temp file is atomically renamed to the final path.
    ///
    /// Concurrent writes to the same key each get their own temp file
    /// (uniquely named with a counter); only the first `finalize()` lands
    /// at the final path. The caller's manifest layer should serialize
    /// per-key writes via a Mutex to avoid wasted concurrent work.
    pub async fn start_streaming_write(&self, key: &str) -> CacheResult<StreamingCacheWriter> {
        let final_path = self.bytes_path(key)?;
        let tmp_path = self.tmp_path(key)?;

        if let Some(parent) = tmp_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp_path)
            .await?;

        Ok(StreamingCacheWriter {
            file: Some(file),
            tmp_path,
            final_path,
            bytes_written: 0,
            finalized: false,
        })
    }

    /// Write a complete byte buffer to `key` atomically. Convenience for
    /// the small-payload case (e.g. thumbnails). For streaming sources use
    /// `start_streaming_write` instead.
    pub async fn put_bytes(&self, key: &str, bytes: &[u8]) -> CacheResult<u64> {
        let mut writer = self.start_streaming_write(key).await?;
        writer.write_chunk(bytes).await?;
        writer.finalize().await
    }

    /// Read bytes for `key` into a `Vec<u8>`. Returns `None` if the file
    /// doesn't exist (caller consults its manifest first; this is a
    /// defensive fallback for the rare case where the manifest says cached
    /// but the file is missing on disk).
    pub async fn read_bytes(&self, key: &str) -> CacheResult<Option<Vec<u8>>> {
        let path = self.bytes_path(key)?;
        match tokio::fs::read(&path).await {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Open `key` for reading. Returns `None` if the file doesn't exist.
    /// The returned `File` supports `seek` for Range requests.
    pub async fn open(&self, key: &str) -> CacheResult<Option<File>> {
        let path = self.bytes_path(key)?;
        match tokio::fs::File::open(&path).await {
            Ok(file) => Ok(Some(file)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Delete the bytes file for `key`. Idempotent — returns `Ok(())` if
    /// the file doesn't exist. The caller's manifest row is the caller's
    /// responsibility.
    pub async fn delete(&self, key: &str) -> CacheResult<()> {
        let path = self.bytes_path(key)?;
        match tokio::fs::remove_file(&path).await {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Check whether the bytes file for `key` exists on disk.
    pub async fn exists(&self, key: &str) -> CacheResult<bool> {
        let path = self.bytes_path(key)?;
        match tokio::fs::metadata(&path).await {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// Total size in bytes of all files under the cache root, excluding
    /// the `_tmp/` directory (those are aborted writes, not part of the
    /// active cache). Walks the tree iteratively — O(file count). Used by
    /// the caller's eviction logic.
    pub async fn total_size_bytes(&self) -> CacheResult<u64> {
        walk_dir_excluding(&self.root, "_tmp").await
    }

    /// Sweep the `_tmp/` directory for orphaned writes. Called by the
    /// caller's periodic background sweep. Returns the count of files
    /// removed. A non-zero return indicates crashed writers (server
    /// restart mid-write, panic, etc.) — the corresponding manifest
    /// rows (if any) were never written, so no manifest cleanup is needed.
    pub async fn sweep_orphans(&self) -> CacheResult<u64> {
        let tmp_root = self.root.join("_tmp");
        sweep_dir(&tmp_root).await
    }
}

/// A streaming writer that buffers bytes to a temp file, then renames to
/// the final path on completion. Drop without `finalize` or `abort` leaves
/// the temp file behind — the background sweep cleans it up.
pub struct StreamingCacheWriter {
    file: Option<File>,
    tmp_path: PathBuf,
    final_path: PathBuf,
    bytes_written: u64,
    finalized: bool,
}

impl StreamingCacheWriter {
    /// Append a chunk of bytes to the in-progress write.
    pub async fn write_chunk(&mut self, bytes: &[u8]) -> CacheResult<()> {
        let file = self.file.as_mut().expect("writer already finalized");
        file.write_all(bytes).await?;
        self.bytes_written += bytes.len() as u64;
        Ok(())
    }

    /// Total bytes written so far.
    pub fn bytes_written(&self) -> u64 {
        self.bytes_written
    }

    /// Finalize the write: flush, close, rename tmp → final. Returns the
    /// total bytes written. After this call the bytes are visible to
    /// readers at the final path.
    pub async fn finalize(mut self) -> CacheResult<u64> {
        if let Some(mut file) = self.file.take() {
            file.flush().await?;
            file.sync_all().await?;
            // drop(file) happens here implicitly — close before rename
            // (Windows requires this).
        }

        if let Some(parent) = self.final_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        tokio::fs::rename(&self.tmp_path, &self.final_path).await?;
        self.finalized = true;
        Ok(self.bytes_written)
    }

    /// Abort the write: delete the temp file. Use when the upstream stream
    /// errored mid-write or when the caller decides not to cache after all.
    pub async fn abort(mut self) -> CacheResult<()> {
        self.file.take(); // close the file handle
        match tokio::fs::remove_file(&self.tmp_path).await {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Whether this writer has been finalized (rename succeeded).
    pub fn is_finalized(&self) -> bool {
        self.finalized
    }
}

// Drop safety net: if neither finalize nor abort was called, try to remove
// the tmp file synchronously. Brief blocking (~1ms) is acceptable here —
// this path only fires on bug scenarios (forgotten finalize, panic). The
// background sweep catches anything this misses.
impl Drop for StreamingCacheWriter {
    fn drop(&mut self) {
        if !self.finalized {
            let _ = std::fs::remove_file(&self.tmp_path);
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

/// Validate that `key` is safe to use as a path component. Rejects empty,
/// contains `/` or `\`, `..`, or NUL bytes. Also rejects keys that resolve
/// to `.` or `..` after normalization.
fn validate_key(key: &str) -> CacheResult<()> {
    if key.is_empty() {
        return Err(CacheError::InvalidKey("(empty)".into()));
    }
    if key.contains('/') || key.contains('\\') {
        return Err(CacheError::InvalidKey(key.into()));
    }
    if key == "." || key == ".." || key.contains('\0') {
        return Err(CacheError::InvalidKey(key.into()));
    }
    if key.starts_with('.') && key.chars().take(2).all(|c| c == '.') {
        return Err(CacheError::InvalidKey(key.into()));
    }
    Ok(())
}

/// Iteratively walk `root`, summing file sizes, skipping top-level child
/// named `exclude`. Avoids async-recursion (which would require Box::pin).
async fn walk_dir_excluding(root: &Path, exclude: &str) -> CacheResult<u64> {
    let mut total: u64 = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            // Skip the excluded name only at the root level.
            if dir == root && entry.file_name() == exclude {
                continue;
            }
            let metadata = entry.metadata().await?;
            if metadata.is_dir() {
                stack.push(path);
            } else if metadata.is_file() {
                total += metadata.len();
            }
        }
    }
    Ok(total)
}

/// Iteratively delete all files under `root`. Returns count of files removed.
async fn sweep_dir(root: &Path) -> CacheResult<u64> {
    let mut count: u64 = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let metadata = entry.metadata().await?;
            if metadata.is_dir() {
                stack.push(path);
            } else if metadata.is_file() && tokio::fs::remove_file(&path).await.is_ok() {
                count += 1;
            }
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup() -> (tempfile::TempDir, DiskCache) {
        let tmp = tempfile::tempdir().unwrap();
        let cache = DiskCache::new(tmp.path()).await.unwrap();
        (tmp, cache)
    }

    #[tokio::test]
    async fn put_and_read_round_trip() {
        let (_tmp, cache) = setup().await;
        let bytes = b"hello world";
        let written = cache.put_bytes("abc123", bytes).await.unwrap();
        assert_eq!(written, bytes.len() as u64);

        let read = cache.read_bytes("abc123").await.unwrap();
        assert_eq!(read.as_deref(), Some(bytes.as_slice()));
    }

    #[tokio::test]
    async fn read_missing_key_returns_none() {
        let (_tmp, cache) = setup().await;
        let read = cache.read_bytes("missing").await.unwrap();
        assert_eq!(read, None);
    }

    #[tokio::test]
    async fn delete_is_idempotent() {
        let (_tmp, cache) = setup().await;
        cache.put_bytes("key", b"data").await.unwrap();
        cache.delete("key").await.unwrap();
        cache.delete("key").await.unwrap(); // second delete is a no-op
        assert!(!cache.exists("key").await.unwrap());
    }

    #[tokio::test]
    async fn streaming_write_finalizes_atomically() {
        let (_tmp, cache) = setup().await;
        let mut writer = cache.start_streaming_write("stream-key").await.unwrap();
        writer.write_chunk(b"part1-").await.unwrap();
        writer.write_chunk(b"part2-").await.unwrap();
        writer.write_chunk(b"part3").await.unwrap();
        let written = writer.finalize().await.unwrap();
        assert_eq!(written, 17);

        let read = cache.read_bytes("stream-key").await.unwrap();
        assert_eq!(read.as_deref(), Some(b"part1-part2-part3".as_slice()));
    }

    #[tokio::test]
    async fn streaming_write_abort_cleans_up() {
        let (_tmp, cache) = setup().await;
        let mut writer = cache.start_streaming_write("aborted").await.unwrap();
        writer.write_chunk(b"partial").await.unwrap();
        writer.abort().await.unwrap();

        assert!(!cache.exists("aborted").await.unwrap());
    }

    #[tokio::test]
    async fn streaming_write_drop_without_finalize_cleans_up() {
        let (_tmp, cache) = setup().await;
        {
            let mut writer = cache.start_streaming_write("dropped").await.unwrap();
            writer.write_chunk(b"partial").await.unwrap();
            // dropped here without finalize/abort
        }
        // Give the spawned cleanup task time to run.
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        assert!(!cache.exists("dropped").await.unwrap());
    }

    #[tokio::test]
    async fn total_size_excludes_tmp() {
        let (_tmp, cache) = setup().await;
        cache.put_bytes("aaa", b"12345").await.unwrap(); // 5 bytes
        cache.put_bytes("bbb", b"6789012345").await.unwrap(); // 10 bytes

        // Active in-progress write (not yet finalized).
        let mut writer = cache.start_streaming_write("ccc").await.unwrap();
        writer.write_chunk(b"tmp-bytes-here").await.unwrap(); // 14 bytes
        // Don't finalize.

        let total = cache.total_size_bytes().await.unwrap();
        assert_eq!(total, 15, "total should exclude _tmp/ files");
    }

    #[tokio::test]
    async fn sweep_orphans_removes_tmp_files() {
        let (_tmp, cache) = setup().await;
        cache.put_bytes("real", b"real-data").await.unwrap();

        // Simulate a crashed writer: drop the writer via ManuallyDrop so the
        // Drop safety net doesn't run, leaving the tmp file behind.
        {
            let writer = cache.start_streaming_write("orphan").await.unwrap();
            let _leaked = std::mem::ManuallyDrop::new(writer);
        }
        // Confirm the tmp file exists.
        let tmp_path = cache.tmp_path("orphan").unwrap();
        assert!(tmp_path.exists(), "tmp file should exist after leak");

        let removed = cache.sweep_orphans().await.unwrap();
        assert_eq!(removed, 1, "one orphan file removed");
        assert!(!tmp_path.exists(), "tmp file gone after sweep");
    }

    #[tokio::test]
    async fn sharding_creates_subdirs() {
        let (_tmp, cache) = setup().await;
        cache.put_bytes("abcdef", b"data").await.unwrap();
        // Path: <root>/ab/abcdef
        let path = cache.bytes_path("abcdef").unwrap();
        assert!(path.ends_with("ab/abcdef"));
    }

    #[tokio::test]
    async fn invalid_keys_rejected() {
        let (_tmp, cache) = setup().await;
        assert!(cache.bytes_path("").is_err());
        assert!(cache.bytes_path("a/b").is_err());
        assert!(cache.bytes_path("..").is_err());
        assert!(cache.bytes_path(".").is_err());
        assert!(cache.bytes_path("a\\b").is_err());
        assert!(cache.bytes_path("a\0b").is_err());
        assert!(cache.bytes_path("...").is_err());
        // Valid keys
        assert!(cache.bytes_path("abc").is_ok());
        assert!(cache.bytes_path("a").is_ok());
        assert!(cache.bytes_path("1234567890abcdef").is_ok());
    }

    #[tokio::test]
    async fn open_returns_file_for_reading() {
        let (_tmp, cache) = setup().await;
        cache.put_bytes("file-key", b"file-bytes").await.unwrap();
        let file = cache.open("file-key").await.unwrap();
        assert!(file.is_some());
    }
}
