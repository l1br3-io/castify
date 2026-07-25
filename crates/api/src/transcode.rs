//! Server-side transcoding via system `ffmpeg`.
//!
//! Spawns an `ffmpeg` process that reads from stdin (provider stream piped
//! in) and writes HLS segments + playlists to disk. The HTTP layer serves
//! segments as they appear.
//!
//! ## Why shell-out instead of ffmpeg-the-third
//!
//! For M5 (probing) we shell out to `ffprobe` — simple, works immediately.
//! M6 continues the pattern: `ffmpeg` handles the encoding pipeline
//! (decode → scale → encode → HLS packetize), and we just manage the
//! process lifecycle. A future iteration may switch to `ffmpeg-the-third`
//! for tighter integration (custom I/O contexts, mid-stream codec changes),
//! but the current API (`start_transcode`) stays the same.
//!
//! ## Pipeline
//!
//! ```text
//! provider stream ──→ ffmpeg stdin ──→ decode ──→ scale ──→ H.264 encode ──→ HLS segmenter ──→ .ts files + .m3u8
//! ```
//!
//! ffmpeg starts producing segments within seconds (as soon as it has
//! enough input to fill one segment buffer). The HTTP layer polls the
//! output directory to serve ready segments.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Notify;

use castify_catalog::BodyStream;

/// Default transcode profile (CPU, H.264 High@L4.0 + AAC 128k).
pub const DEFAULT_PROFILE: &str = "h264-high-40-aac128-cpu";

/// Default variant: source resolution capped at 720p.
pub const DEFAULT_VARIANT: &str = "720p";

/// Look up the target bitrate (bits/sec) for a variant name via the
/// built-in ABR rung table. Returns `None` for `"source"` and unknown
/// variants — the caller treats `None` as "leave the column NULL."
pub fn variant_target_bitrate(variant: &str) -> Option<u64> {
    castify_core::lookup_rung(variant).map(|r| r.target_bitrate_kbps as u64 * 1000)
}

/// Look up the target width for a variant name. The built-in rungs don't
/// encode a width (only height + bitrate); this returns the conventional
/// 16:9 width for each rung (`height * 16 / 9`). Returns `None` for
/// `"source"` and unknown variants.
pub fn variant_target_width(variant: &str) -> Option<u32> {
    castify_core::lookup_rung(variant).map(|r| r.target_height * 16 / 9)
}

/// Look up the target height for a variant name. Returns `None` for
/// `"source"` and unknown variants.
pub fn variant_target_height(variant: &str) -> Option<u32> {
    castify_core::lookup_rung(variant).map(|r| r.target_height)
}

/// Errors returned by the transcode pipeline.
#[derive(Debug, thiserror::Error)]
pub enum TranscodeError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("ffmpeg binary not found; install ffmpeg to enable transcoding")]
    FfmpegNotFound,
    #[error("ffmpeg exited with non-zero status: {stderr}")]
    FfmpegFailed { stderr: String },
    #[error("ffmpeg stdin pump error: {0}")]
    PumpError(String),
}

pub type TranscodeResult<T> = Result<T, TranscodeError>;

/// Handle to a running or completed transcode. Clonable for shared
/// monitoring across HTTP handlers.
pub struct TranscodeHandle {
    /// Directory where segments + playlists are written.
    pub output_dir: PathBuf,
    /// Notified when the first segment file lands on disk.
    pub first_segment_ready: Arc<Notify>,
    /// Notified when ffmpeg exits (success or failure).
    pub completion: Arc<Notify>,
    /// Inner state shared between the handle and the pump task.
    pub state: Arc<TranscodeState>,
    /// The ffmpeg child process, shared with the watcher task. The watcher
    /// takes the child out of the mutex and runs `wait_with_output`; cancel
    /// handlers can `kill()` it before the watcher claims it. There's a
    /// race — if the watcher has already taken the child, cancel sees `None`
    /// and the transcode finishes on its own. In practice cancel is called
    /// long before ffmpeg finishes a long-running transcode.
    pub child: Arc<tokio::sync::Mutex<Option<tokio::process::Child>>>,
}

/// Shared state for a transcode job.
pub struct TranscodeState {
    /// Set to true when ffmpeg exits successfully.
    pub completed: std::sync::atomic::AtomicBool,
    /// Set to true if ffmpeg exited with an error.
    pub failed: std::sync::atomic::AtomicBool,
    /// Count of .ts segment files on disk (updated by the HTTP layer on
    /// each playlist read).
    pub segment_count: std::sync::atomic::AtomicU64,
}

impl TranscodeState {
    fn new() -> Self {
        Self {
            completed: std::sync::atomic::AtomicBool::new(false),
            failed: std::sync::atomic::AtomicBool::new(false),
            segment_count: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Check if the transcode has finished (success or failure).
    pub fn is_done(&self) -> bool {
        self.completed.load(std::sync::atomic::Ordering::Relaxed)
            || self.failed.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// Start a transcode job.
///
/// Spawns an `ffmpeg` process that reads from `input` (piped to stdin) and
/// writes HLS segments to `output_dir`. Returns immediately with a handle;
/// the transcode runs in the background.
///
/// The caller is responsible for:
/// - Polling the output directory for ready segments
/// - Storing the manifest row when the transcode completes
/// - Cleaning up on cancellation
pub async fn start_transcode(
    input: BodyStream,
    output_dir: PathBuf,
    variant: &str,
    segment_duration_secs: u32,
) -> TranscodeResult<TranscodeHandle> {
    // Ensure output directory exists.
    tokio::fs::create_dir_all(&output_dir).await?;

    let segment_filename = output_dir.join("segment_%05d.ts");
    let playlist_path = output_dir.join("playlist.m3u8");

    // Build ffmpeg args. CPU-only H.264/AAC with HLS output.
    // -preset veryfast + -tune zerolatency for fast startup.
    // Scale filter caps at 720p without upscaling.
    let scale_filter = match variant {
        "source" => "scale=iw:ih".to_string(),
        "720p" => {
            "scale='min(1280,iw)':-2:force_original_aspect_ratio=decrease".to_string()
        }
        "480p" => {
            "scale='min(854,iw)':-2:force_original_aspect_ratio=decrease".to_string()
        }
        "360p" => {
            "scale='min(640,iw)':-2:force_original_aspect_ratio=decrease".to_string()
        }
        _ => {
            "scale='min(1280,iw)':-2:force_original_aspect_ratio=decrease".to_string()
        }
    };

    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-i")
        .arg("pipe:0")
        // Video encoder.
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("veryfast")
        .arg("-tune")
        .arg("zerolatency")
        .arg("-profile:v")
        .arg("high")
        .arg("-level")
        .arg("4.0")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-crf")
        .arg("23")
        // Scale filter (caps resolution per variant).
        .arg("-vf")
        .arg(&scale_filter)
        // Audio encoder.
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("128k")
        .arg("-ac")
        .arg("2")
        // HLS output.
        .arg("-f")
        .arg("hls")
        .arg("-hls_time")
        .arg(segment_duration_secs.to_string())
        .arg("-hls_list_size")
        .arg("0")
        .arg("-hls_segment_filename")
        .arg(&segment_filename)
        .arg("-y") // overwrite playlist if exists
        .arg(&playlist_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // Kill ffmpeg if the parent process dies.
        ;

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            TranscodeError::FfmpegNotFound
        } else {
            TranscodeError::Io(e)
        }
    })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| TranscodeError::PumpError("ffmpeg stdin not captured".into()))?;

    let state = Arc::new(TranscodeState::new());
    let first_segment_ready = Arc::new(Notify::new());
    let completion = Arc::new(Notify::new());
    let child: Arc<tokio::sync::Mutex<Option<tokio::process::Child>>> =
        Arc::new(tokio::sync::Mutex::new(Some(child)));

    // Spawn the stdin pump task: reads from BodyStream, writes to ffmpeg stdin.
    let pump_state = Arc::clone(&state);
    tokio::spawn(async move {
        if let Err(e) = pump_stream_to_stdin(input, stdin).await {
            tracing::warn!(error = %e, "transcode stdin pump error");
            pump_state
                .failed
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        // Signal that input is done — ffmpeg will finish processing.
    });

    // Spawn the completion watcher: waits for ffmpeg to exit, then notifies.
    let watch_state = Arc::clone(&state);
    let watch_notify = Arc::clone(&completion);
    let watch_first = Arc::clone(&first_segment_ready);
    let watch_dir = output_dir.clone();
    let watch_child = Arc::clone(&child);
    tokio::spawn(async move {
        // Take the child out of the shared slot. The lock is held only for
        // the take itself, so cancel handlers can acquire it before this
        // task gets here. Once taken, the watcher owns the child for the
        // remainder of ffmpeg's run.
        let taken = watch_child.lock().await.take();
        let Some(child) = taken else {
            // Cancel handler got there first.
            tracing::info!(
                output_dir = %watch_dir.display(),
                "transcode cancelled before watcher could claim child"
            );
            watch_state
                .failed
                .store(true, std::sync::atomic::Ordering::Relaxed);
            watch_notify.notify_waiters();
            watch_first.notify_waiters();
            return;
        };
        let output = child.wait_with_output().await;
        match output {
            Ok(out) if out.status.success() => {
                tracing::info!(
                    output_dir = %watch_dir.display(),
                    "transcode ffmpeg completed successfully"
                );
                watch_state
                    .completed
                    .store(true, std::sync::atomic::Ordering::Relaxed);
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                tracing::warn!(
                    status = ?out.status,
                    stderr = %stderr.chars().take(500).collect::<String>(),
                    "transcode ffmpeg exited non-zero"
                );
                watch_state
                    .failed
                    .store(true, std::sync::atomic::Ordering::Relaxed);
            }
            Err(e) => {
                tracing::warn!(error = %e, "transcode ffmpeg wait failed");
                watch_state
                    .failed
                    .store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
        // Notify waiters.
        watch_notify.notify_waiters();
        watch_first.notify_waiters(); // in case no segment was ever produced
    });

    // Spawn a lightweight task that watches for the first segment file.
    let seg_state = Arc::clone(&state);
    let seg_notify = Arc::clone(&first_segment_ready);
    let seg_dir = output_dir.clone();
    tokio::spawn(async move {
        loop {
            if seg_state.is_done() {
                break;
            }
            if let Ok(mut entries) = tokio::fs::read_dir(&seg_dir).await {
                let mut found = false;
                while let Ok(Some(entry)) = entries.next_entry().await {
                    if entry
                        .file_name()
                        .to_string_lossy()
                        .ends_with(".ts")
                    {
                        found = true;
                        break;
                    }
                }
                if found {
                    seg_notify.notify_waiters();
                    break;
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        }
    });

    Ok(TranscodeHandle {
        output_dir,
        first_segment_ready,
        completion,
        state,
        child,
    })
}

/// Read from a `BodyStream` and write all bytes to ffmpeg's stdin.
/// Closes stdin on completion to signal EOF.
async fn pump_stream_to_stdin(
    mut stream: BodyStream,
    mut stdin: tokio::process::ChildStdin,
) -> Result<(), String> {
    use futures::StreamExt;
    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(bytes) => {
                if let Err(e) = stdin.write_all(&bytes).await {
                    return Err(format!("stdin write: {e}"));
                }
            }
            Err(e) => {
                return Err(format!("stream error: {e}"));
            }
        }
    }
    // Close stdin to signal EOF to ffmpeg.
    let _ = stdin.shutdown().await;
    drop(stdin);
    Ok(())
}

/// Count the number of .ts segment files in a directory.
pub async fn count_segments(dir: &Path) -> u64 {
    let mut count = 0u64;
    if let Ok(mut entries) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.file_name().to_string_lossy().ends_with(".ts") {
                count += 1;
            }
        }
    }
    count
}

/// Read the variant playlist from disk, if it exists.
pub async fn read_playlist(dir: &Path) -> Option<String> {
    tokio::fs::read_to_string(dir.join("playlist.m3u8"))
        .await
        .ok()
}

/// Build a master playlist string for a set of variants. Each entry emits
/// one `#EXT-X-STREAM-INF` line with `BANDWIDTH`, `RESOLUTION`, `CODECS`.
///
/// Variants come from `transcode_cache_entries` rows; the row's `bitrate`,
/// `width`, `height` are populated at `insert_pending_transcode` time from
/// the rung's target values. For older M6-era rows where these columns are
/// NULL, we fall back to the built-in rung table (conventional 16:9 width
/// from the variant name). Unknown variant names (not in the rung table)
/// are skipped — the master only lists variants hls.js can reason about.
///
/// `CODECS` is fixed at `"avc1.4d401f,mp4a.40.2"` (H.264 High@L4.0 + AAC)
/// because every transcode uses the same encoder settings; only resolution
/// and bitrate change across rungs.
pub fn build_master_playlist(entries: &[castify_catalog::TranscodeCacheEntry]) -> String {
    const CODECS: &str = "avc1.4d401f,mp4a.40.2";
    let mut lines = vec!["#EXTM3U".to_string(), "#EXT-X-VERSION:6".to_string()];

    for entry in entries {
        // Resolve (width, height) — prefer manifest, fall back to rung table.
        let (w, h) = match (entry.width, entry.height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => (w as u32, h as u32),
            _ => match castify_core::lookup_rung(&entry.variant) {
                Some(r) => (r.target_height * 16 / 9, r.target_height),
                None => {
                    tracing::debug!(
                        variant = %entry.variant,
                        "skipping master playlist entry: unknown variant (no rung fallback)"
                    );
                    continue;
                }
            },
        };

        // Resolve bandwidth — prefer manifest, fall back to rung target.
        let bandwidth: u64 = entry
            .bitrate
            .filter(|b| *b > 0)
            .map(|b| b as u64)
            .or_else(|| {
                castify_core::lookup_rung(&entry.variant)
                    .map(|r| r.target_bitrate_kbps as u64 * 1000)
            })
            .unwrap_or(0);
        if bandwidth == 0 {
            continue;
        }

        lines.push(format!(
            "#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},RESOLUTION={w}x{h},CODECS=\"{CODECS}\""
        ));
        lines.push(format!("{}/playlist.m3u8", entry.variant));
    }

    lines.join("\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use castify_catalog::TranscodeCacheEntry;

    fn entry(variant: &str, bitrate: Option<i64>, width: Option<i64>, height: Option<i64>) -> TranscodeCacheEntry {
        TranscodeCacheEntry {
            video_id: "vid".into(),
            variant: variant.into(),
            profile: "prof".into(),
            output_dir: "/tmp".into(),
            total_segments: None,
            completed_segments: 0,
            segment_duration_secs: 10,
            bitrate,
            width,
            height,
            status: "pending".into(),
            last_error: None,
            created_at: "2024-01-01T00:00:00Z".into(),
            last_accessed_at: "2024-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn empty_entries_produces_header_only() {
        let playlist = build_master_playlist(&[]);
        assert!(playlist.starts_with("#EXTM3U\n#EXT-X-VERSION:6\n"));
        // No STREAM-INF lines.
        assert!(!playlist.contains("EXT-X-STREAM-INF"));
    }

    #[test]
    fn single_completed_720p_emits_one_stream_inf() {
        let playlist = build_master_playlist(&[entry("720p", Some(3_000_000), Some(1280), Some(720))]);
        assert!(playlist.contains("#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720"));
        assert!(playlist.contains("\n720p/playlist.m3u8\n"));
    }

    #[test]
    fn multiple_variants_emit_one_stream_inf_each_in_input_order() {
        let entries = vec![
            entry("1080p", Some(6_000_000), Some(1920), Some(1080)),
            entry("720p", Some(3_000_000), Some(1280), Some(720)),
            entry("480p", Some(1_500_000), Some(854), Some(480)),
        ];
        let playlist = build_master_playlist(&entries);
        // Three STREAM-INF lines.
        assert_eq!(
            playlist.matches("EXT-X-STREAM-INF").count(),
            3,
            "{playlist}"
        );
        // Order preserved from input.
        let pos_1080 = playlist.find("RESOLUTION=1920x1080").unwrap();
        let pos_720 = playlist.find("RESOLUTION=1280x720").unwrap();
        let pos_480 = playlist.find("RESOLUTION=854x480").unwrap();
        assert!(pos_1080 < pos_720);
        assert!(pos_720 < pos_480);
    }

    #[test]
    fn null_bitrate_falls_back_to_rung_target() {
        let playlist = build_master_playlist(&[entry("720p", None, Some(1280), Some(720))]);
        // 720p target = 3000 kbps = 3,000,000 bps.
        assert!(playlist.contains("BANDWIDTH=3000000"), "{playlist}");
    }

    #[test]
    fn null_width_height_falls_back_to_16_9_from_rung() {
        let playlist = build_master_playlist(&[entry("480p", Some(1_500_000), None, None)]);
        // 480 * 16 / 9 = 853 (rounded down to 853).
        assert!(playlist.contains("RESOLUTION=853x480"), "{playlist}");
    }

    #[test]
    fn unknown_variant_with_explicit_data_is_included() {
        // A variant name not in the rung table is fine as long as the row
        // carries its own bitrate + width + height. This covers `'source'`
        // (codec-conversion-only, no ladder rung) and any future custom
        // variant.
        let entries = vec![
            entry("source", Some(8_000_000), Some(1920), Some(1080)),
            entry("720p", Some(3_000_000), Some(1280), Some(720)),
        ];
        let playlist = build_master_playlist(&entries);
        assert_eq!(playlist.matches("EXT-X-STREAM-INF").count(), 2);
        assert!(playlist.contains("source/playlist.m3u8"));
        assert!(playlist.contains("720p/playlist.m3u8"));
    }

    #[test]
    fn unknown_variant_with_no_data_is_skipped() {
        // No explicit bitrate/width/height AND not in the rung table →
        // can't compute BANDWIDTH or RESOLUTION → must skip.
        let entries = vec![
            entry("weird", None, None, None),
            entry("720p", None, None, None), // rung fallback works
        ];
        let playlist = build_master_playlist(&entries);
        assert_eq!(
            playlist.matches("EXT-X-STREAM-INF").count(),
            1,
            "{playlist}"
        );
        assert!(!playlist.contains("weird"));
        assert!(playlist.contains("720p"));
    }

    #[test]
    fn zero_bitrate_is_skipped() {
        let entries = vec![
            entry("720p", Some(0), Some(1280), Some(720)), // explicit zero
        ];
        let playlist = build_master_playlist(&entries);
        // Falls back to rung target 3,000,000.
        assert!(playlist.contains("BANDWIDTH=3000000"));
    }
}
