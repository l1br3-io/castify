//! Video file probing via system `ffprobe`.
//!
//! Shells out to the `ffprobe` binary (requires it installed at runtime).
//! Returns codec, bitrate, framerate, and embedded subtitle track info.
//!
//! ## Why shell-out instead of ffmpeg-the-third
//!
//! For M5 (probing only), shelling out is simpler and avoids the heavy
//! ffmpeg-the-third build dependency. M6 (transcoding) will switch to a
//! static-linked binding since encoding requires tighter integration.
//! The probe module's public API (`probe_video`) stays the same either way.
//!
//! ## Implementation
//!
//! `ffprobe -v quiet -print_format json -show_streams -show_format` on a
//! temp file containing the first 1 MB of the video. ffprobe identifies
//! the container + codec from the header bytes; 1 MB is sufficient for
//! all common container formats (MP4 ftyp, MKV EBML, AVI RIFF, etc.).

use std::path::PathBuf;
use std::process::Stdio;

use serde::Deserialize;
use tokio::process::Command;

/// Result of probing a video file.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeInfo {
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate: Option<u64>,
    pub framerate: Option<f64>,
    pub embedded_subtitle_tracks: Vec<EmbeddedTrack>,
}

/// A subtitle track muxed into the container (discovered at probe time).
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddedTrack {
    pub embedded_index: i64,
    pub codec: String,
    pub format_family: SubtitleFormatFamily,
    pub language: Option<String>,
    pub title: Option<String>,
}

/// Whether a subtitle codec is text-based or image-based. Drives the M8
/// routing decision (text → serve to browser; image → burn into video).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubtitleFormatFamily {
    Text,
    Image,
}

impl SubtitleFormatFamily {
    /// Classify an ffprobe subtitle codec name as text or image.
    pub fn from_codec(codec: &str) -> Self {
        match codec.to_ascii_lowercase().as_str() {
            // Text-based subtitle codecs
            "subrip" | "srt" | "ass" | "ssa" | "webvtt" | "vtt" | "mov_text" | "utf-8"
            | "ascii" => SubtitleFormatFamily::Text,
            // Image-based subtitle codecs
            "hdmv_pgs_subtitle" | "pgssub" | "dvd_subtitle" | "vobsub" | "dvb_subtitle" => {
                SubtitleFormatFamily::Image
            }
            _ => SubtitleFormatFamily::Text, // default: try text first
        }
    }
}

impl std::fmt::Display for SubtitleFormatFamily {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SubtitleFormatFamily::Text => write!(f, "text"),
            SubtitleFormatFamily::Image => write!(f, "image"),
        }
    }
}

/// Probe outcome.
#[derive(Debug)]
pub enum ProbeResult {
    /// Probe succeeded; here's the info.
    Ok(ProbeInfo),
    /// ffprobe couldn't identify the container from the bytes provided.
    /// Caller may retry with more bytes.
    NeedsMoreBytes,
    /// ffprobe doesn't recognize this container at all.
    UnsupportedContainer(String),
    /// ffprobe binary not found, or returned a non-zero exit code.
    Failed(String),
}

/// Probe a video's codec info from a byte buffer.
///
/// Writes `bytes` to a temp file, invokes `ffprobe -print_format json`,
/// parses the result. The caller is expected to pass the first ~1 MB of
/// the video (sufficient for container/codec identification in most cases).
pub async fn probe_video(bytes: &[u8]) -> ProbeResult {
    if bytes.is_empty() {
        return ProbeResult::Failed("empty input".into());
    }

    // Write to a temp file — ffprobe needs seekable input for many containers.
    let tmp = match tempfile::NamedTempFile::new() {
        Ok(t) => t,
        Err(e) => return ProbeResult::Failed(format!("temp file creation: {e}")),
    };
    let path: PathBuf = tmp.path().into();
    // Keep the temp file alive for the duration of the probe by leaking it;
    // we delete it manually at the end.
    std::mem::forget(tmp);

    if let Err(e) = tokio::fs::write(&path, bytes).await {
        let _ = tokio::fs::remove_file(&path).await;
        return ProbeResult::Failed(format!("temp file write: {e}"));
    }

    let result = probe_file(&path).await;

    let _ = tokio::fs::remove_file(&path).await;
    result
}

/// Probe a video file by path. Public for callers that already have a
/// local file (e.g. from the M4 disk cache).
pub async fn probe_file(path: &std::path::Path) -> ProbeResult {
    let output = match Command::new("ffprobe")
        .arg("-v")
        .arg("quiet")
        .arg("-print_format")
        .arg("json")
        .arg("-show_streams")
        .arg("-show_format")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ProbeResult::Failed(
                "ffprobe binary not found; install ffmpeg to enable codec probing".into(),
            );
        }
        Err(e) => return ProbeResult::Failed(format!("ffprobe spawn: {e}")),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // ffprobe returns non-zero when it can't identify the format.
        if stderr.contains("Invalid data found")
            || stderr.contains("Invalid argument")
            || stderr.contains("End of file")
            || stderr.contains("moov atom")
        {
            return ProbeResult::NeedsMoreBytes;
        }
        return ProbeResult::Failed(format!(
            "ffprobe exited {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    let parsed: FfprobeOutput = match serde_json::from_slice(&output.stdout) {
        Ok(p) => p,
        Err(e) => return ProbeResult::Failed(format!("JSON parse: {e}")),
    };

    let info = parse_ffprobe(&parsed);
    if info.video_codec.is_none() && info.audio_codec.is_none() {
        return ProbeResult::UnsupportedContainer("no streams found".into());
    }
    ProbeResult::Ok(info)
}

// ── ffprobe JSON parsing ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    streams: Vec<FfprobeStream>,
    #[serde(default)]
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct FfprobeStream {
    codec_type: String,
    codec_name: String,
    #[serde(default)]
    codec_long_name: Option<String>,
    #[serde(default)]
    index: i64,
    #[serde(default)]
    avg_frame_rate: Option<String>,
    #[serde(default)]
    bit_rate: Option<String>,
    #[serde(default)]
    tags: std::collections::HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct FfprobeFormat {
    #[serde(default)]
    bit_rate: Option<String>,
    #[serde(default)]
    format_name: Option<String>,
    #[serde(default)]
    format_long_name: Option<String>,
}

fn parse_ffprobe(output: &FfprobeOutput) -> ProbeInfo {
    let mut video_codec = None;
    let mut audio_codec = None;
    let mut framerate = None;
    let mut video_bitrate = None;
    let mut embedded_subtitle_tracks = Vec::new();

    for stream in &output.streams {
        match stream.codec_type.as_str() {
            "video" => {
                if video_codec.is_none() {
                    video_codec = Some(stream.codec_name.clone());
                    video_bitrate = stream.bit_rate.as_ref().and_then(|s| s.parse::<u64>().ok());
                    framerate = stream.avg_frame_rate.as_deref().and_then(parse_frame_rate);
                }
            }
            "audio" => {
                if audio_codec.is_none() {
                    audio_codec = Some(stream.codec_name.clone());
                }
            }
            "subtitle" => {
                let format_family = SubtitleFormatFamily::from_codec(&stream.codec_name);
                let language = stream.tags.get("language").cloned();
                let title = stream.tags.get("title").cloned();
                embedded_subtitle_tracks.push(EmbeddedTrack {
                    embedded_index: stream.index,
                    codec: stream.codec_name.clone(),
                    format_family,
                    language,
                    title,
                });
            }
            _ => {}
        }
    }

    // Prefer the format-level bitrate (covers all streams); fall back to
    // the video stream's bitrate.
    let bitrate = output
        .format
        .as_ref()
        .and_then(|f| f.bit_rate.as_ref())
        .and_then(|s| s.parse::<u64>().ok())
        .or(video_bitrate);

    ProbeInfo {
        video_codec,
        audio_codec,
        bitrate,
        framerate,
        embedded_subtitle_tracks,
    }
}

/// Parse an ffprobe fractional frame rate like "30000/1001" (= 29.97).
fn parse_frame_rate(s: &str) -> Option<f64> {
    if let Some((num, den)) = s.split_once('/') {
        let num: f64 = num.parse().ok()?;
        let den: f64 = den.parse().ok()?;
        if den == 0.0 {
            return None;
        }
        Some(num / den)
    } else {
        s.parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtitle_family_classification() {
        assert_eq!(
            SubtitleFormatFamily::from_codec("subrip"),
            SubtitleFormatFamily::Text
        );
        assert_eq!(
            SubtitleFormatFamily::from_codec("ass"),
            SubtitleFormatFamily::Text
        );
        assert_eq!(
            SubtitleFormatFamily::from_codec("hdmv_pgs_subtitle"),
            SubtitleFormatFamily::Image
        );
        assert_eq!(
            SubtitleFormatFamily::from_codec("dvd_subtitle"),
            SubtitleFormatFamily::Image
        );
        assert_eq!(
            SubtitleFormatFamily::from_codec("unknown"),
            SubtitleFormatFamily::Text,
            "unknown subtitle codec defaults to text"
        );
    }

    #[test]
    fn parse_frame_rate_fractional() {
        assert_eq!(parse_frame_rate("30000/1001"), Some(29.97002997002997));
        assert_eq!(parse_frame_rate("25/1"), Some(25.0));
        assert_eq!(parse_frame_rate("24"), Some(24.0));
        assert_eq!(parse_frame_rate("garbage"), None);
        assert_eq!(parse_frame_rate("1/0"), None);
    }

    #[tokio::test]
    async fn probe_empty_returns_failed() {
        match probe_video(&[]).await {
            ProbeResult::Failed(_) => {}
            other => panic!("expected Failed for empty input, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn probe_random_bytes_returns_needs_more_or_failed() {
        // Random bytes aren't a valid container.
        let bytes = vec![0u8; 1024];
        let result = probe_video(&bytes).await;
        match result {
            ProbeResult::NeedsMoreBytes | ProbeResult::Failed(_) => {}
            other => panic!("expected NeedsMoreBytes or Failed, got {other:?}"),
        }
    }
}
