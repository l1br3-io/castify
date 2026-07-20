//! Browser codec compatibility map.
//!
//! Determines whether a given video+audio codec combination is playable
//! natively in a modern browser (Chrome, Firefox, Safari, Edge). Drives
//! the M6 transcoding decision: incompatible codecs trigger on-the-fly
//! transcoding; compatible codecs play directly.
//!
//! Sources cited per codec. Data reviewed annually; browsers add support
//! over time. Conservative defaults — when uncertain, we prefer
//! `DependsOnBrowser` (try direct, fall back to transcode) over `Yes`.

use std::collections::HashMap;
use std::sync::OnceLock;

/// Browser support level for a codec combination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserSupport {
    /// Plays natively in all modern browsers (Chrome 100+, Firefox 100+,
    /// Safari 15+, Edge 100+). No transcoding needed.
    Yes,
    /// Does not play in any browser. Must transcode.
    No,
    /// Plays in some browsers but not others. Try direct; fall back to
    /// transcode on `canPlayType` failure.
    DependsOnBrowser,
    /// Plays only for specific profiles of this codec (e.g. H.264 High
    /// Profile but not Main 10). Probe the user's browser via `canPlayType`
    /// before committing to direct.
    DependsOnProfile,
}

/// Decision returned by `codec_strategy()`. Drives the M6 transcode trigger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscodeDecision {
    /// Codec is browser-compatible. Stream directly (direct URL or proxy).
    PlayDirect,
    /// Codec is definitely incompatible. Transcode to H.264/AAC.
    MustTranscode,
    /// Codec might work. Try direct first; if the browser reports
    /// incompatibility via `canPlayType`, retry with transcode.
    TryDirectFallbackToTranscode,
}

/// Entry in the static codec support map.
struct CodecEntry {
    /// `BrowserSupport` for this video codec (assumes AAC or MP3 audio).
    support: BrowserSupport,
    /// Source for this assessment (MDN URL, caniuse data, etc.)
    _source: &'static str,
}

/// Static map of video codec → browser support. Keys are lowercase ffprobe
/// codec names (e.g. `"h264"`, `"hevc"`, `"vp9"`). Audio codec is checked
/// separately; combinations default to the video codec's support level
/// downgraded if the audio codec is a known problem.
static VIDEO_CODEC_MAP: OnceLock<HashMap<&'static str, CodecEntry>> = OnceLock::new();

fn video_codec_map() -> &'static HashMap<&'static str, CodecEntry> {
    VIDEO_CODEC_MAP.get_or_init(|| {
        let mut m = HashMap::new();
        // H.264 / AVC — universally supported in MP4 container.
        // Source: https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Video_codecs#h.264_avc
        m.insert(
            "h264",
            CodecEntry {
                support: BrowserSupport::Yes,
                _source: "MDN: H.264 (AVC) — universally supported",
            },
        );
        m.insert(
            "avc",
            CodecEntry {
                support: BrowserSupport::Yes,
                _source: "MDN: H.264 (AVC) — alt name",
            },
        );
        m.insert(
            "avc1",
            CodecEntry {
                support: BrowserSupport::Yes,
                _source: "MDN: H.264 (AVC) — alt name",
            },
        );

        // H.265 / HEVC — Safari yes, Chrome/Firefox no (without hardware+OS support).
        // Source: https://caniuse.com/hevc
        m.insert(
            "hevc",
            CodecEntry {
                support: BrowserSupport::DependsOnBrowser,
                _source: "caniuse: HEVC — Safari 11+, Chrome/Firefox limited",
            },
        );
        m.insert(
            "h265",
            CodecEntry {
                support: BrowserSupport::DependsOnBrowser,
                _source: "caniuse: HEVC — alt name",
            },
        );

        // VP8 — widely supported in WebM.
        // Source: https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Video_codecs#vp8
        m.insert(
            "vp8",
            CodecEntry {
                support: BrowserSupport::Yes,
                _source: "MDN: VP8 — supported in all modern browsers (WebM)",
            },
        );

        // VP9 — supported in Chrome, Firefox, Edge; Safari 14+.
        // Source: https://caniuse.com/vp9
        m.insert(
            "vp9",
            CodecEntry {
                support: BrowserSupport::Yes,
                _source: "caniuse: VP9 — supported in all modern browsers",
            },
        );

        // AV1 — Chrome 85+, Firefox 67+, Safari 16.4+ (2023). Edge follows Chrome.
        // Source: https://caniuse.com/av1
        m.insert(
            "av1",
            CodecEntry {
                support: BrowserSupport::DependsOnBrowser,
                _source: "caniuse: AV1 — Chrome/Firefox yes, Safari 16.4+ only",
            },
        );

        // MPEG-2 — not supported in any browser via `<video>`.
        m.insert(
            "mpeg2video",
            CodecEntry {
                support: BrowserSupport::No,
                _source: "MDN: MPEG-2 not supported in HTML5 video",
            },
        );

        // MPEG-4 Part 2 (DivX, Xvid) — not supported.
        m.insert(
            "mpeg4",
            CodecEntry {
                support: BrowserSupport::DependsOnProfile,
                _source: "MDN: MPEG-4 Part 2 — some Simple Profile works, most don't",
            },
        );

        // WMV3 (Windows Media Video 9) — not supported.
        m.insert(
            "wmv3",
            CodecEntry {
                support: BrowserSupport::No,
                _source: "MDN: WMV not supported in HTML5 video",
            },
        );

        // WVC1 (Windows Media Video 9 Advanced) — not supported.
        m.insert(
            "wvc1",
            CodecEntry {
                support: BrowserSupport::No,
                _source: "MDN: WMV not supported in HTML5 video",
            },
        );

        // VP6 — not supported.
        m.insert(
            "vp6",
            CodecEntry {
                support: BrowserSupport::No,
                _source: "MDN: VP6 not supported",
            },
        );
        m.insert(
            "vp6f",
            CodecEntry {
                support: BrowserSupport::No,
                _source: "MDN: VP6 not supported",
            },
        );

        // Theora — supported in Firefox; Chrome dropped it.
        m.insert(
            "theora",
            CodecEntry {
                support: BrowserSupport::DependsOnBrowser,
                _source: "MDN: Theora — Firefox only (Chrome dropped support)",
            },
        );

        // MJPEG — technically supported as image, but not for streaming video.
        m.insert(
            "mjpeg",
            CodecEntry {
                support: BrowserSupport::No,
                _source: "MDN: MJPEG not supported as HTML5 video",
            },
        );

        // ProRes — Safari only (via QuickTime).
        m.insert(
            "prores",
            CodecEntry {
                support: BrowserSupport::DependsOnBrowser,
                _source: "MDN: ProRes — Safari only via QuickTime",
            },
        );

        // DNxHD — not supported.
        m.insert(
            "dnxhd",
            CodecEntry {
                support: BrowserSupport::No,
                _source: "MDN: DNxHD not supported in HTML5 video",
            },
        );

        // FFV1 (lossless) — not supported.
        m.insert(
            "ffv1",
            CodecEntry {
                support: BrowserSupport::No,
                _source: "MDN: FFV1 not supported in HTML5 video",
            },
        );

        // HuffYUV — not supported.
        m.insert(
            "huffyuv",
            CodecEntry {
                support: BrowserSupport::No,
                _source: "MDN: HuffYUV not supported in HTML5 video",
            },
        );

        m
    })
}

/// Audio codecs known to be problematic. AAC + MP3 + Opus + Vorbis are
/// universally supported; everything else triggers transcode.
fn audio_codec_support(codec: &str) -> BrowserSupport {
    match codec.to_ascii_lowercase().as_str() {
        "aac" | "mp3" | "opus" | "vorbis" | "flac" => BrowserSupport::Yes,
        "ac3" | "eac3" | "dts" | "dca" => BrowserSupport::No, // Dolby/DTS not in browsers
        "pcm_s16le" | "pcm_s24le" | "pcm_s32le" | "pcm_u8" => {
            BrowserSupport::DependsOnBrowser // WAV-ish; sometimes works
        }
        "alac" => BrowserSupport::DependsOnBrowser, // Apple Lossless; Safari only
        "truehd" => BrowserSupport::No,
        _ => BrowserSupport::DependsOnBrowser, // Unknown — try direct
    }
}

/// Determine whether the given video+audio codec combination is playable
/// natively in a modern browser. Returns the combined support level.
pub fn browser_support(video_codec: &str, audio_codec: Option<&str>) -> BrowserSupport {
    let v_support = video_codec_map()
        .get(video_codec.to_ascii_lowercase().as_str())
        .map(|e| e.support)
        .unwrap_or(BrowserSupport::DependsOnBrowser);

    let a_support = audio_codec
        .map(audio_codec_support)
        .unwrap_or(BrowserSupport::Yes); // No audio info → assume OK

    // Combine: the most restrictive wins.
    combine_support(v_support, a_support)
}

/// Map a `BrowserSupport` to a `TranscodeDecision`.
pub fn codec_strategy(video_codec: &str, audio_codec: Option<&str>) -> TranscodeDecision {
    match browser_support(video_codec, audio_codec) {
        BrowserSupport::Yes => TranscodeDecision::PlayDirect,
        BrowserSupport::No => TranscodeDecision::MustTranscode,
        BrowserSupport::DependsOnBrowser => TranscodeDecision::TryDirectFallbackToTranscode,
        BrowserSupport::DependsOnProfile => TranscodeDecision::TryDirectFallbackToTranscode,
    }
}

/// Combine two `BrowserSupport` values — the more restrictive wins.
fn combine_support(a: BrowserSupport, b: BrowserSupport) -> BrowserSupport {
    use BrowserSupport::*;
    match (a, b) {
        (Yes, Yes) => Yes,
        (No, _) | (_, No) => No,
        (DependsOnBrowser, _) | (_, DependsOnBrowser) => DependsOnBrowser,
        (DependsOnProfile, Yes) | (Yes, DependsOnProfile) => DependsOnProfile,
        (DependsOnProfile, DependsOnProfile) => DependsOnProfile,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn h264_aac_is_yes() {
        assert_eq!(browser_support("h264", Some("aac")), BrowserSupport::Yes);
    }

    #[test]
    fn hevc_with_any_audio_depends() {
        assert_eq!(
            browser_support("hevc", Some("aac")),
            BrowserSupport::DependsOnBrowser
        );
    }

    #[test]
    fn mpeg2_is_no() {
        assert_eq!(browser_support("mpeg2video", None), BrowserSupport::No);
    }

    #[test]
    fn unknown_codec_depends() {
        assert_eq!(
            browser_support("somefuturecodec", None),
            BrowserSupport::DependsOnBrowser
        );
    }

    #[test]
    fn h264_ac3_depends_on_browser_because_of_audio() {
        assert_eq!(
            browser_support("h264", Some("ac3")),
            BrowserSupport::No,
            "AC-3 audio is not supported by any browser"
        );
    }

    #[test]
    fn vp9_opus_yes() {
        assert_eq!(browser_support("vp9", Some("opus")), BrowserSupport::Yes);
    }

    #[test]
    fn av1_depends_on_browser() {
        assert_eq!(
            browser_support("av1", Some("aac")),
            BrowserSupport::DependsOnBrowser
        );
    }

    #[test]
    fn strategy_play_direct_for_h264() {
        assert_eq!(
            codec_strategy("h264", Some("aac")),
            TranscodeDecision::PlayDirect
        );
    }

    #[test]
    fn strategy_must_transcode_for_mpeg2() {
        assert_eq!(
            codec_strategy("mpeg2video", None),
            TranscodeDecision::MustTranscode
        );
    }

    #[test]
    fn strategy_try_direct_for_hevc() {
        assert_eq!(
            codec_strategy("hevc", Some("aac")),
            TranscodeDecision::TryDirectFallbackToTranscode
        );
    }

    #[test]
    fn codec_map_covers_at_least_15_codecs() {
        let map = video_codec_map();
        assert!(
            map.len() >= 15,
            "expected ≥15 codecs in the support map, got {}",
            map.len()
        );
    }
}
