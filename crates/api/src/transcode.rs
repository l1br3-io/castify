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

/// Profile component marking a remux output (stream copy, no re-encode).
/// Appended to the base profile (`{DEFAULT_PROFILE}-remux`) so remuxed and
/// re-encoded outputs land in distinct `transcode_cache_entries` rows and
/// distinct on-disk directories — a later full transcode of the same video
/// must never serve remuxed segments, nor vice versa.
pub const REMUX_PROFILE_SUFFIX: &str = "-remux";

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

/// Derive the transcode profile string for a (base profile, optional burn
/// subtitle) pair. `None` returns `base` unchanged; `Some(id)` returns
/// `{base}+subs-{id}`. The `+subs-{id}` suffix is what keeps burned and
/// unburned transcodes in distinct `transcode_cache_entries` rows (the PK
/// is `(video_id, variant, profile)`) and distinct on-disk output
/// directories, so the two coexist independently (spec FR-7.3) and the
/// LRU treats them as separate entries (FR-7.4).
///
/// **GOTCHA:** burned and unburned transcodes share a worker pool but must
/// not share a cache row — the profile suffix is what keeps them distinct.
/// Never collapse the profile back to `DEFAULT_PROFILE` for a burn request.
pub fn burn_profile(base: &str, subtitle_track_id: Option<&str>) -> String {
    match subtitle_track_id {
        Some(id) => format!("{base}+subs-{id}"),
        None => base.to_string(),
    }
}

/// Build the in-memory `TRANSCODE_REGISTRY` key for a (video, variant,
/// burn) triple. The registry deduplicates concurrent requests for the
/// same transcode into one ffmpeg process. Adding the derived profile as
/// a third component means a burn request and an unburned request for the
/// same video+variant no longer collapse into a single worker — they run
/// as independent ffmpeg processes writing to separate output directories.
///
/// The key is parseable by `cancel_transcode` via `splitn(3, ':')`: video
/// ids never contain `:`, and profile strings contain only `-`, `+`, and
/// word chars.
pub fn transcode_registry_key(
    video_id: &str,
    variant: &str,
    subtitle_track_id: Option<&str>,
) -> String {
    let profile = burn_profile(DEFAULT_PROFILE, subtitle_track_id);
    transcode_registry_key_for_profile(video_id, variant, &profile)
}

/// Build the in-memory `TRANSCODE_REGISTRY` key from an already-derived
/// profile string (e.g. one carrying the `+subs-{id}` burn suffix, the
/// `-remux` component, or both dimensions resolved by the caller). Same
/// parseability contract as [`transcode_registry_key`].
pub fn transcode_registry_key_for_profile(video_id: &str, variant: &str, profile: &str) -> String {
    format!("{video_id}:{variant}:{profile}")
}

/// Decide whether an unburned transcode for this video should **remux**
/// (stream-copy into fMP4/HLS) instead of re-encoding (spec FR-3).
///
/// Remux applies only when *all* of these hold:
/// - No burn-in is active (`subtitle_track_id.is_none()`) — the overlay
///   filter forces a re-encode (spec FR-3a).
/// - The codecs are already browser-compatible: H.264 video + **AAC**
///   audio. AAC-only on purpose: MP3-in-fMP4/HLS depends on the hls.js
///   build, and AC3/DTS (the common MKV case) don't fit HLS safely —
///   those take the full-transcode path.
/// - The container is one no browser demuxes (Matroska/AVI/WMV/FLV/TS) —
///   a browser-playable container with these codecs never transcodes at
///   all, so there is nothing to remux.
/// - No previous remux attempt failed for this video. A failed remux
///   (odd MKV features: headers needing genpts, attached fonts) flips the
///   video to the full-transcode path — the caller signals this via
///   `remux_failed_before`, typically from a `failed` `-remux` manifest
///   row.
///
/// Codec names compare case-insensitively (ffprobe reports lowercase, but
/// probe data is provider-controlled).
pub fn should_remux(
    subtitle_track_id: Option<&str>,
    video_codec: Option<&str>,
    audio_codec: Option<&str>,
    mime_type: Option<&str>,
    remux_failed_before: bool,
) -> bool {
    if subtitle_track_id.is_some() || remux_failed_before {
        return false;
    }
    let (Some(vc), Some(ac)) = (video_codec, audio_codec) else {
        return false; // Not probed yet — can't trust codecs for stream copy.
    };
    vc.eq_ignore_ascii_case("h264")
        && ac.eq_ignore_ascii_case("aac")
        && castify_catalog::codec_support::container_requires_transcode(mime_type)
}

/// Burn-in specification: resolves a subtitle track to the ffmpeg arguments
/// needed to render (burn) it into the video frames during transcoding.
///
/// When `Some` is passed to [`start_transcode`], ffmpeg reads from
/// `source_path` (a seekable local file) instead of stdin, and the video
/// filter chain gains a `subtitles=` filter that composites the subtitle
/// stream into every frame. The result is a self-contained HLS variant whose
/// frames already carry the subtitles — no player-side subtitle rendering
/// is needed.
///
/// **GOTCHA:** burn-in ffmpeg must read the local source file, not stdin —
/// the subtitles filter needs a seekable demuxer input. The stdin path is
/// for unburned only.
#[derive(Debug, Clone)]
pub struct BurnSpec {
    /// The subtitle track id (from `video_subtitle_tracks`). Carried for
    /// logging/diagnostics; not used directly in ffmpeg args.
    pub subtitle_track_id: String,
    /// The ffmpeg stream index — passed as `si=<index>` to the `subtitles`
    /// filter so ffmpeg selects the right subtitle stream from the source
    /// container (an MKV may carry several).
    pub embedded_index: i64,
    /// Seekable local source file path. ffmpeg's `-i` argument and the
    /// `subtitles=` filter both reference this path.
    pub source_path: PathBuf,
}

/// Escape a string for use as a value inside an ffmpeg filtergraph. The
/// filtergraph syntax treats `\`, `:`, `,`, `[`, `]`, and `'` as structural
/// characters; prefixing each with `\` neutralizes them.
///
/// Applied to the local-source path before it's embedded in
/// `subtitles=<path>:si=<n>`. Paths under `transcode-work/` rarely contain
/// these characters, but escaping is cheap insurance against a `:` in a
/// Windows drive letter or a comma in a user-named video id.
fn escape_filtergraph_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' | ':' | ',' | '[' | ']' | '\'' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Resolve the ffmpeg `-vf` scale expression for a variant name. Caps the
/// output resolution without upscaling (the `min(target,iw)` idiom).
fn scale_filter_for_variant(variant: &str) -> &'static str {
    match variant {
        "source" => "scale=iw:ih",
        "720p" => "scale='min(1280,iw)':-2:force_original_aspect_ratio=decrease",
        "480p" => "scale='min(854,iw)':-2:force_original_aspect_ratio=decrease",
        "360p" => "scale='min(640,iw)':-2:force_original_aspect_ratio=decrease",
        _ => "scale='min(1280,iw)':-2:force_original_aspect_ratio=decrease",
    }
}

/// Compose the full `-vf` filtergraph string for a transcode.
///
/// - **Unburned** (`burn = None`): just the scale filter.
/// - **Burned** (`burn = Some`): `subtitles=<path>:si=<index>,<scale>` — the
///   `subtitles` filter renders subtitle bitmaps at full resolution, then
///   scale shrinks the composited frame. Ordering matters: burning before
///   scaling keeps subtitle text crisp at lower rungs.
fn build_video_filter(variant: &str, burn: Option<&BurnSpec>) -> String {
    let scale = scale_filter_for_variant(variant);
    match burn {
        Some(spec) => {
            let path = escape_filtergraph_value(&spec.source_path.to_string_lossy());
            let index = spec.embedded_index;
            format!("subtitles={path}:si={index},{scale}")
        }
        None => scale.to_string(),
    }
}

/// Build the flat ffmpeg argument list for a transcode job. Extracted from
/// [`start_transcode`] so the burn-vs-unburned arg construction is
/// unit-testable without spawning ffmpeg or touching the filesystem.
///
/// `input_source` is `"pipe:0"` for the stdin (unburned) path or the local
/// source file path for the burn path. The caller is responsible for
/// matching `input_source` and `burn` (both refer to the same path when
/// burning).
fn build_ffmpeg_args(
    input_source: &str,
    segment_filename: &Path,
    playlist_path: &Path,
    variant: &str,
    segment_duration_secs: u32,
    burn: Option<&BurnSpec>,
) -> Vec<String> {
    let vf = build_video_filter(variant, burn);
    vec![
        "-i".into(),
        input_source.into(),
        // Video encoder.
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-tune".into(),
        "zerolatency".into(),
        "-profile:v".into(),
        "high".into(),
        "-level".into(),
        "4.0".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-crf".into(),
        "23".into(),
        // Scale / subtitles+scale filter.
        "-vf".into(),
        vf,
        // Audio encoder.
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
        "-ac".into(),
        "2".into(),
        // HLS output.
        "-f".into(),
        "hls".into(),
        "-hls_time".into(),
        segment_duration_secs.to_string(),
        "-hls_list_size".into(),
        "0".into(),
        "-hls_segment_filename".into(),
        segment_filename.to_string_lossy().into_owned(),
        "-y".into(),
        playlist_path.to_string_lossy().into_owned(),
    ]
}

/// Build the flat ffmpeg argument list for a **remux** job (spec FR-3):
/// stream-copy the first video + audio streams into HLS without any
/// decode/encode. Disk-speed-bound — no encoder libraries involved.
///
/// `-sn` drops subtitle streams on purpose: MPEG-TS/HLS segments can't
/// carry MKV-style subtitle tracks (PGS/SRT), and ffmpeg aborts rather
/// than silently producing unplayable output. Text subtitles keep being
/// served to the browser as sidecar tracks, exactly as today.
fn build_remux_args(
    input_source: &str,
    segment_filename: &Path,
    playlist_path: &Path,
    segment_duration_secs: u32,
) -> Vec<String> {
    vec![
        "-i".into(),
        input_source.into(),
        // First video + first audio only: a second AC3/DTS track would
        // either fail or produce an unplayable variant.
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0".into(),
        // Stream copy — the whole point of remux.
        "-c".into(),
        "copy".into(),
        "-sn".into(),
        // HLS output, same segmenting contract as the full transcode.
        "-f".into(),
        "hls".into(),
        "-hls_time".into(),
        segment_duration_secs.to_string(),
        "-hls_list_size".into(),
        "0".into(),
        "-hls_segment_filename".into(),
        segment_filename.to_string_lossy().into_owned(),
        "-y".into(),
        playlist_path.to_string_lossy().into_owned(),
    ]
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
/// Spawns an `ffmpeg` process and writes HLS segments to `output_dir`.
/// Returns immediately with a handle; the transcode runs in the background.
///
/// **Three modes:**
/// - **Unburned full transcode** (`burn = None`, `remux = false`,
///   `input = Some(stream)`): ffmpeg reads from stdin (provider stream
///   piped in) and re-encodes. This is the M6/M7 path, unchanged.
/// - **Unburned remux** (`burn = None`, `remux = true`,
///   `input = Some(stream)`): same stdin pipeline, but ffmpeg args
///   stream-copy (`-c copy`) instead of re-encoding (transcode-controls
///   FR-3). Remux and burn are mutually exclusive — the overlay filter
///   requires re-encode (FR-3a).
/// - **Burned** (`burn = Some(spec)`, `input = None`, `remux = false`):
///   ffmpeg reads from `spec.source_path` (a seekable local file resolved
///   by Task 005's `resolve_local_source`) and applies a `subtitles=`
///   filter to render the subtitle track into the video frames.
///
/// The caller is responsible for:
/// - Polling the output directory for ready segments
/// - Storing the manifest row when the transcode completes
/// - Cleaning up on cancellation
/// - Holding the [`crate::local_source::LocalSource`] guard for the
///   transcode's lifetime when burning (so a tempfile isn't reaped
///   mid-encode)
pub async fn start_transcode(
    input: Option<BodyStream>,
    output_dir: PathBuf,
    variant: &str,
    segment_duration_secs: u32,
    burn: Option<BurnSpec>,
    remux: bool,
) -> TranscodeResult<TranscodeHandle> {
    debug_assert!(
        !(remux && burn.is_some()),
        "start_transcode: remux and burn are mutually exclusive"
    );
    // Ensure output directory exists.
    tokio::fs::create_dir_all(&output_dir).await?;

    let segment_filename = output_dir.join("segment_%05d.ts");
    let playlist_path = output_dir.join("playlist.m3u8");

    // Determine ffmpeg's input source and stdin policy.
    //
    // GOTCHA: burn-in ffmpeg must read the local source file, not stdin —
    // the subtitles filter needs a seekable demuxer input. The stdin path
    // is for unburned only.
    let input_source = match &burn {
        Some(spec) => spec.source_path.to_string_lossy().into_owned(),
        None => "pipe:0".to_string(),
    };
    let args = if remux {
        build_remux_args(
            &input_source,
            &segment_filename,
            &playlist_path,
            segment_duration_secs,
        )
    } else {
        build_ffmpeg_args(
            &input_source,
            &segment_filename,
            &playlist_path,
            variant,
            segment_duration_secs,
            burn.as_ref(),
        )
    };

    let mut cmd = Command::new("ffmpeg");
    cmd.args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // Kill ffmpeg if the parent process dies.
        ;

    // Stdin policy: piped for the unburned stdin pump; null for burn
    // (ffmpeg reads from the file, not stdin).
    if burn.is_some() {
        cmd.stdin(Stdio::null());
    } else {
        cmd.stdin(Stdio::piped());
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            TranscodeError::FfmpegNotFound
        } else {
            TranscodeError::Io(e)
        }
    })?;

    // Take stdin for the pump before the child goes into the shared mutex.
    // Burn mode has no stdin to pump (ffmpeg reads from the file).
    let stdin = if burn.is_some() {
        None
    } else {
        Some(
            child
                .stdin
                .take()
                .ok_or_else(|| TranscodeError::PumpError("ffmpeg stdin not captured".into()))?,
        )
    };

    let state = Arc::new(TranscodeState::new());
    let first_segment_ready = Arc::new(Notify::new());
    let completion = Arc::new(Notify::new());
    let child: Arc<tokio::sync::Mutex<Option<tokio::process::Child>>> =
        Arc::new(tokio::sync::Mutex::new(Some(child)));

    // Spawn the stdin pump task for the unburned path. Burn mode reads
    // from a file and has no stdin to pump.
    if let (Some(stream), Some(stdin)) = (input, stdin) {
        debug_assert!(
            burn.is_none(),
            "start_transcode: input and burn are mutually exclusive"
        );
        let pump_state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(e) = pump_stream_to_stdin(stream, stdin).await {
                tracing::warn!(error = %e, "transcode stdin pump error");
                pump_state
                    .failed
                    .store(true, std::sync::atomic::Ordering::Relaxed);
            }
            // Signal that input is done — ffmpeg will finish processing.
        });
    }

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
                    if entry.file_name().to_string_lossy().ends_with(".ts") {
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

    fn entry(
        variant: &str,
        bitrate: Option<i64>,
        width: Option<i64>,
        height: Option<i64>,
    ) -> TranscodeCacheEntry {
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
        let playlist =
            build_master_playlist(&[entry("720p", Some(3_000_000), Some(1280), Some(720))]);
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

    // ── burn_profile + transcode_registry_key (M8 Task 007) ──────────

    #[test]
    fn burn_profile_returns_base_for_none() {
        assert_eq!(
            burn_profile("h264-high-40-aac128-cpu", None),
            "h264-high-40-aac128-cpu"
        );
    }

    #[test]
    fn burn_profile_appends_subs_suffix_for_some() {
        assert_eq!(
            burn_profile("h264-high-40-aac128-cpu", Some("vid-sub-3")),
            "h264-high-40-aac128-cpu+subs-vid-sub-3"
        );
    }

    #[test]
    fn burn_profile_with_default_profile_none_is_default_unchanged() {
        assert_eq!(burn_profile(DEFAULT_PROFILE, None), DEFAULT_PROFILE);
    }

    #[test]
    fn transcode_registry_key_unburned_carries_default_profile_component() {
        let key = transcode_registry_key("vid1", "720p", None);
        assert_eq!(key, format!("vid1:720p:{DEFAULT_PROFILE}"));
    }

    #[test]
    fn transcode_registry_key_burned_includes_subs_profile_suffix() {
        let key = transcode_registry_key("vid1", "720p", Some("track-7"));
        assert!(
            key.contains("+subs-track-7"),
            "key missing burn suffix: {key}"
        );
        assert_eq!(key, format!("vid1:720p:{DEFAULT_PROFILE}+subs-track-7"));
    }

    #[test]
    fn transcode_registry_key_burned_and_unburned_differ() {
        // Core AC: same video+variant, one burned and one not, must
        // resolve to distinct registry keys — and thus distinct cache rows
        // and distinct ffmpeg processes.
        let unburned = transcode_registry_key("vid1", "720p", None);
        let burned = transcode_registry_key("vid1", "720p", Some("track-7"));
        assert_ne!(unburned, burned);
    }

    #[test]
    fn transcode_registry_key_distinct_burn_tracks_differ() {
        // Two different burn targets must also dedupe separately.
        let burn_a = transcode_registry_key("vid1", "720p", Some("track-a"));
        let burn_b = transcode_registry_key("vid1", "720p", Some("track-b"));
        assert_ne!(burn_a, burn_b);
    }

    // ── build_ffmpeg_args burn vs. unburned (M8 Task 008) ─────────────

    /// Helper: join a Vec<String> into a single space-separated string so
    /// substring assertions read clearly.
    fn args_joined(args: &[String]) -> String {
        args.join(" ")
    }

    #[test]
    fn unburned_args_read_stdin_and_have_no_subtitles_filter() {
        let seg = Path::new("/tmp/out/segment_%05d.ts");
        let plist = Path::new("/tmp/out/playlist.m3u8");
        let args = build_ffmpeg_args("pipe:0", seg, plist, "720p", 6, None);
        let joined = args_joined(&args);

        assert!(
            joined.contains("-i pipe:0"),
            "unburned must read stdin: {joined}"
        );
        assert!(
            !joined.contains("subtitles="),
            "unburned must not carry a subtitles filter: {joined}"
        );
        assert!(
            joined.contains("-vf scale="),
            "unburned must still have scale filter: {joined}"
        );
    }

    #[test]
    fn burned_args_read_local_source_and_attach_subtitles_filter() {
        let seg = Path::new("/tmp/out/segment_%05d.ts");
        let plist = Path::new("/tmp/out/playlist.m3u8");
        let source = Path::new("/data/transcode-work/vid-1/source.mkv");
        let spec = BurnSpec {
            subtitle_track_id: "vid-1-sub-3".into(),
            embedded_index: 2,
            source_path: source.into(),
        };
        let source_str = source.to_string_lossy().into_owned();
        let args = build_ffmpeg_args(&source_str, seg, plist, "720p", 6, Some(&spec));
        let joined = args_joined(&args);

        // Input switches from pipe:0 to the local file.
        assert!(
            joined.contains(&format!("-i {source_str}")),
            "burned must read the local source file: {joined}"
        );
        assert!(
            !joined.contains("-i pipe:0"),
            "burned must not read stdin: {joined}"
        );

        // The subtitles filter references the source path and stream index.
        assert!(
            joined.contains("subtitles="),
            "burned must carry a subtitles filter: {joined}"
        );
        assert!(
            joined.contains("si=2"),
            "burned must select stream index 2: {joined}"
        );

        // The scale filter is still present, after the subtitles filter
        // (burn-then-scale ordering keeps subtitle bitmaps crisp).
        let vf_pos = joined.find("-vf ").unwrap();
        let vf_val_start = vf_pos + 4;
        let vf_end = joined[vf_val_start..].find(' ').unwrap() + vf_val_start;
        let vf_val = &joined[vf_val_start..vf_end];
        let subs_pos = vf_val.find("subtitles=").unwrap();
        let scale_pos = vf_val.find("scale=").unwrap();
        assert!(
            subs_pos < scale_pos,
            "subtitles filter must precede scale (burn at full res, then shrink): {vf_val}"
        );
    }

    #[test]
    fn burned_args_escape_special_chars_in_source_path() {
        // A path containing filtergraph-structural characters must be
        // escaped so ffmpeg parses the -vf string correctly. A colon in a
        // Windows-style path (C:\videos\source.mkv) is the realistic case.
        let seg = Path::new("/tmp/out/segment_%05d.ts");
        let plist = Path::new("/tmp/out/playlist.m3u8");
        let source = Path::new("C:/videos/source.mkv");
        let spec = BurnSpec {
            subtitle_track_id: "track-1".into(),
            embedded_index: 0,
            source_path: source.into(),
        };
        let args = build_ffmpeg_args(
            &source.to_string_lossy(),
            seg,
            plist,
            "480p",
            10,
            Some(&spec),
        );
        let joined = args_joined(&args);

        // The -vf value should contain the escaped path (C\:...).
        assert!(
            joined.contains("subtitles=C\\:/videos/source.mkv"),
            "colon in path must be backslash-escaped: {joined}"
        );
    }

    #[test]
    fn burned_and_unburned_args_differ_in_input_and_filter() {
        let seg = Path::new("/tmp/out/segment_%05d.ts");
        let plist = Path::new("/tmp/out/playlist.m3u8");
        let unburned = build_ffmpeg_args("pipe:0", seg, plist, "720p", 6, None);

        let source = Path::new("/data/source.mkv");
        let spec = BurnSpec {
            subtitle_track_id: "t1".into(),
            embedded_index: 1,
            source_path: source.into(),
        };
        let burned = build_ffmpeg_args(
            &source.to_string_lossy(),
            seg,
            plist,
            "720p",
            6,
            Some(&spec),
        );

        // The arg lists must differ — at minimum the -i value and -vf value.
        assert_ne!(unburned, burned, "burn and unburn args must differ");
    }

    #[test]
    fn unburned_args_match_pre_m8_shape() {
        // Regression guard: the unburned arg list must be identical to what
        // M6/M7 produced. If this breaks, an unrelated transcode change
        // leaked into the burn refactor.
        let seg = Path::new("/out/segment_%05d.ts");
        let plist = Path::new("/out/playlist.m3u8");
        let args = build_ffmpeg_args("pipe:0", seg, plist, "720p", 10, None);

        // Spot-check the encoder + HLS settings that must not change.
        let joined = args_joined(&args);
        for expected in [
            "-c:v libx264",
            "-preset veryfast",
            "-tune zerolatency",
            "-profile:v high",
            "-level 4.0",
            "-pix_fmt yuv420p",
            "-crf 23",
            "-c:a aac",
            "-b:a 128k",
            "-ac 2",
            "-f hls",
            "-hls_list_size 0",
            "-y",
        ] {
            assert!(
                joined.contains(expected),
                "unburned args missing `{expected}`: {joined}"
            );
        }
    }

    #[test]
    fn escape_filtergraph_value_neutralizes_structural_chars() {
        assert_eq!(escape_filtergraph_value("plain"), "plain");
        assert_eq!(escape_filtergraph_value("a:b"), "a\\:b");
        assert_eq!(escape_filtergraph_value("a,b"), "a\\,b");
        assert_eq!(escape_filtergraph_value(r"a\b"), "a\\\\b");
        assert_eq!(escape_filtergraph_value("a'b"), "a\\'b");
    }

    #[test]
    fn should_remux_h264_aac_in_undemuxable_container() {
        assert!(should_remux(
            None,
            Some("h264"),
            Some("aac"),
            Some("video/x-matroska"),
            false
        ));
    }

    #[test]
    fn should_remux_rejects_non_aac_audio() {
        // MP3/AC3/DTS never remux — MP3-in-HLS is hls.js-dependent and
        // AC3/DTS don't fit HLS (spec FR-3).
        for audio in ["mp3", "ac3", "eac3", "dts"] {
            assert!(
                !should_remux(
                    None,
                    Some("h264"),
                    Some(audio),
                    Some("video/x-matroska"),
                    false
                ),
                "h264+{audio} must take the full-transcode path"
            );
        }
    }

    #[test]
    fn should_remux_rejects_non_h264_video_and_direct_containers() {
        assert!(!should_remux(
            None,
            Some("hevc"),
            Some("aac"),
            Some("video/x-matroska"),
            false
        ));
        // Browser-playable container: these never transcode at all, so
        // there is nothing to remux.
        assert!(!should_remux(
            None,
            Some("h264"),
            Some("aac"),
            Some("video/mp4"),
            false
        ));
    }

    #[test]
    fn should_remux_never_with_burn_unprobed_codecs_or_prior_failure() {
        // FR-3a: burn-in forces a re-encode.
        assert!(!should_remux(
            Some("sub-1"),
            Some("h264"),
            Some("aac"),
            Some("video/x-matroska"),
            false
        ));
        // Unprobed codecs — can't trust stream copy.
        assert!(!should_remux(
            None,
            None,
            Some("aac"),
            Some("video/x-matroska"),
            false
        ));
        // A previously failed remux flips to full transcode.
        assert!(!should_remux(
            None,
            Some("h264"),
            Some("aac"),
            Some("video/x-matroska"),
            true
        ));
    }

    #[test]
    fn remux_args_stream_copy_without_encoders() {
        let tmp = std::env::temp_dir();
        let args = build_remux_args(
            "pipe:0",
            &tmp.join("segment_%05d.ts"),
            &tmp.join("playlist.m3u8"),
            10,
        );
        let joined = args.join(" ");
        assert!(joined.contains("-c copy"), "remux must stream copy");
        assert!(
            !joined.contains("libx264"),
            "remux must not re-encode video"
        );
        assert!(!joined.contains("-b:a"), "remux must not re-encode audio");
        assert!(joined.contains("-sn"), "subtitle streams must be dropped");
        assert!(joined.contains("-map 0:v:0"), "first video stream only");
        assert!(joined.contains("-map 0:a:0"), "first audio stream only");
        assert!(joined.contains("-f hls"), "output is HLS");
        assert!(
            joined.contains("-i pipe:0"),
            "reads provider bytes from stdin"
        );
        assert!(joined.contains("-hls_time 10"));
    }

    #[test]
    fn registry_key_with_remux_profile_differs_from_full() {
        let full = transcode_registry_key_for_profile("v1", "720p", DEFAULT_PROFILE);
        let remux = transcode_registry_key_for_profile(
            "v1",
            "720p",
            &format!("{DEFAULT_PROFILE}{REMUX_PROFILE_SUFFIX}"),
        );
        assert_ne!(full, remux);
    }
}
