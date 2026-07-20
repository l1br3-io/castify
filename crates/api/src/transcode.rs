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
    tokio::spawn(async move {
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

/// Build a master playlist string for a single variant.
pub fn build_master_playlist(variant: &str, bandwidth: u64, resolution: Option<(u32, u32)>) -> String {
    let codecs = "avc1.4d401f,mp4a.40.2";
    let resolution_str = resolution
        .map(|(w, h)| format!(",RESOLUTION={w}x{h}"))
        .unwrap_or_default();
    format!(
        "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH={bandwidth}{resolution_str},CODECS=\"{codecs}\"\n{variant}/playlist.m3u8\n"
    )
}
