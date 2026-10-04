//! Embedded text-subtitle extraction (M8 Task 006).
//!
//! After a video is probed and ffprobe reports embedded **text** subtitle
//! streams (SRT/ASS/SSA/VTT), this module demuxes each to a sidecar-style
//! file under `<data_dir>/extracted-subs/<video_id>/` and records a row in
//! `video_subtitles` with `provider_file_id = NULL`, `embedded_track_id`
//! populated, and `extracted_path` pointing at the file. The unified subtitle
//! list (Task 002) then surfaces them alongside sidecars.
//!
//! Image-based embedded tracks (PGS/VobSub) are **not** extracted — large
//! bytes, and burn-in (Task 008) reads them directly from the source file.
//! They stay in the discovery-only `video_subtitle_tracks` table.
//!
//! ## Why shell out to ffmpeg
//!
//! The codebase already shells out to `ffmpeg`/`ffprobe` (see `transcode.rs`
//! and `probe.rs`) rather than binding `ffmpeg-the-third`. Extraction reuses
//! that convention — same demux capability, different binding. Recorded in
//! `the m8 deviations (see git log --grep=m8)`.
//!
//! ## Reliability
//!
//! Extraction runs as a best-effort follow-up to a successful probe. Each
//! track is independent: a failure (ffmpeg exits non-zero, empty output) is
//! logged at `warn` and skipped — it never aborts sibling tracks or marks the
//! probe failed (NFR — Reliability).

use std::path::Path;
use std::process::Stdio;

use tokio::process::Command;

use castify_catalog::probe::{EmbeddedTrack, ProbeInfo, SubtitleFormatFamily};
use castify_catalog::CatalogRepository;

use crate::state::AppState;

/// A subtitle codec → (db format value, file extension) mapping for text
/// tracks. The db format must satisfy the `video_subtitles.format` CHECK
/// (`srt`/`vtt`/`ass`/`ssa`). ffmpeg infers the muxer from the extension.
struct TextFormat {
    format: &'static str,
    ext: &'static str,
}

/// Map an ffprobe subtitle codec name to its output format + extension.
/// Only meaningful for text-family tracks. Unknown text codecs default to
/// SRT (the lowest-common-denominator text format); ffmpeg will fail loudly
/// if it can't actually demux them, and the track is skipped on failure.
fn text_track_format(codec: &str) -> TextFormat {
    match codec.to_ascii_lowercase().as_str() {
        "ass" => TextFormat {
            format: "ass",
            ext: "ass",
        },
        "ssa" => TextFormat {
            format: "ssa",
            ext: "ssa",
        },
        "webvtt" | "vtt" => TextFormat {
            format: "vtt",
            ext: "vtt",
        },
        // subrip, srt, mov_text, utf-8, ascii, and unknown-default.
        _ => TextFormat {
            format: "srt",
            ext: "srt",
        },
    }
}

/// Errors from a single ffmpeg extraction invocation.
#[derive(Debug, thiserror::Error)]
enum SubtitleExtractError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("ffmpeg binary not found; install ffmpeg to enable subtitle extraction")]
    FfmpegNotFound,
    #[error("ffmpeg exited non-zero: {stderr}")]
    FfmpegFailed { stderr: String },
}

/// Glue entry point: resolve a seekable local source for `video_id`, then
/// extract every text-family track discovered by the probe. Called as a
/// best-effort follow-up after a successful probe — failures are logged, not
/// propagated. The resolved [`crate::local_source::LocalSource`] guard is
/// held for the duration so a scratch tempfile isn't reaped mid-extraction.
pub async fn extract_embedded_text_subtitles(
    state: &AppState,
    video_id: &str,
    probe_info: &ProbeInfo,
) {
    if !probe_info
        .embedded_subtitle_tracks
        .iter()
        .any(|t| t.format_family == SubtitleFormatFamily::Text)
    {
        return;
    }

    let source = match crate::local_source::resolve_local_source(state, video_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                error = %e, %video_id,
                "subtitle extraction: could not resolve local source"
            );
            return;
        }
    };

    let repo = state.catalog_repository();
    let data_dir = &state.config().data_dir;
    let extracted = extract_text_subtitles_from_path(
        repo,
        data_dir,
        video_id,
        &source.path,
        &probe_info.embedded_subtitle_tracks,
    )
    .await;

    tracing::info!(
        %video_id,
        extracted,
        total_text_tracks = probe_info
            .embedded_subtitle_tracks
            .iter()
            .filter(|t| t.format_family == SubtitleFormatFamily::Text)
            .count(),
        "embedded subtitle extraction complete"
    );
    // `source` drops here → a Tempfile source is cleaned up once ffmpeg is
    // done reading it. A Cached source is left untouched (M4 owns it).
}

/// Extract every text-family track from `source_path` to disk and record a
/// `video_subtitles` row per success. Image-family tracks in `tracks` are
/// skipped (no row, no file). Returns the count of successfully extracted
/// tracks.
///
/// Idempotent: existing extracted rows (`provider_file_id IS NULL`) for the
/// video are cleared before insert, so re-probe doesn't accumulate dupes.
/// Sidecar rows are untouched.
pub async fn extract_text_subtitles_from_path(
    repo: &CatalogRepository,
    data_dir: &Path,
    video_id: &str,
    source_path: &Path,
    tracks: &[EmbeddedTrack],
) -> usize {
    let text_tracks: Vec<&EmbeddedTrack> = tracks
        .iter()
        .filter(|t| t.format_family == SubtitleFormatFamily::Text)
        .collect();
    if text_tracks.is_empty() {
        return 0;
    }

    let out_dir = data_dir.join("extracted-subs").join(video_id);
    if let Err(e) = tokio::fs::create_dir_all(&out_dir).await {
        tracing::warn!(
            error = %e, %video_id,
            "subtitle extraction: could not create output dir"
        );
        return 0;
    }

    if let Err(e) = repo.clear_extracted_subtitles(video_id).await {
        tracing::warn!(
            error = %e, %video_id,
            "subtitle extraction: could not clear stale extracted rows"
        );
    }

    let mut extracted = 0usize;
    for track in text_tracks {
        let tf = text_track_format(&track.codec);
        let track_id = format!("{video_id}-sub-{}", track.embedded_index);
        let filename = format!("{track_id}.{}", tf.ext);
        let out_path = out_dir.join(&filename);

        match extract_one_subtitle(source_path, track.embedded_index, &out_path).await {
            Ok(()) => match tokio::fs::metadata(&out_path).await {
                Ok(meta) if meta.len() > 0 => {
                    if let Err(e) = repo
                        .upsert_extracted_subtitle(
                            &track_id,
                            video_id,
                            track.embedded_index,
                            track.language.as_deref(),
                            &filename,
                            tf.format,
                            &out_path.to_string_lossy(),
                        )
                        .await
                    {
                        tracing::warn!(
                            error = %e, %video_id, index = track.embedded_index,
                            "subtitle extraction: upsert failed"
                        );
                        continue;
                    }
                    extracted += 1;
                }
                _ => {
                    tracing::warn!(
                        %video_id, index = track.embedded_index,
                        "subtitle extraction: output empty or missing"
                    );
                    let _ = tokio::fs::remove_file(&out_path).await;
                }
            },
            Err(e) => {
                tracing::warn!(
                    error = %e, %video_id, index = track.embedded_index,
                    "subtitle extraction: ffmpeg failed"
                );
                let _ = tokio::fs::remove_file(&out_path).await;
            }
        }
    }

    extracted
}

/// Demux subtitle stream `stream_index` (absolute ffprobe index) from
/// `source_path` to `out_path`. ffmpeg infers the output format from the
/// extension (`.srt`, `.ass`, `.ssa`, `.vtt`).
async fn extract_one_subtitle(
    source_path: &Path,
    stream_index: i64,
    out_path: &Path,
) -> Result<(), SubtitleExtractError> {
    let map = format!("0:{stream_index}");
    let output = Command::new("ffmpeg")
        .arg("-y")
        .arg("-nostdin")
        .arg("-i")
        .arg(source_path)
        .arg("-map")
        .arg(&map)
        .arg(out_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(SubtitleExtractError::FfmpegFailed {
            stderr: String::from_utf8_lossy(&o.stderr).trim().to_string(),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(SubtitleExtractError::FfmpegNotFound)
        }
        Err(e) => Err(SubtitleExtractError::Io(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_track_format_mapping() {
        let f = text_track_format("subrip");
        assert_eq!((f.format, f.ext), ("srt", "srt"));
        let f = text_track_format("mov_text");
        assert_eq!((f.format, f.ext), ("srt", "srt"));
        let f = text_track_format("ASS");
        assert_eq!((f.format, f.ext), ("ass", "ass"));
        let f = text_track_format("ssa");
        assert_eq!((f.format, f.ext), ("ssa", "ssa"));
        let f = text_track_format("webvtt");
        assert_eq!((f.format, f.ext), ("vtt", "vtt"));
        // Unknown text codec defaults to SRT.
        let f = text_track_format("totally_unknown");
        assert_eq!((f.format, f.ext), ("srt", "srt"));
    }
}
