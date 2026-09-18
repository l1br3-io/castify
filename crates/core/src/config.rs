use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

const DEFAULT_HOST: &str = "0.0.0.0";
const DEFAULT_PORT: u16 = 8427;
const DEFAULT_LOG_LEVEL: &str = "info";
const DEFAULT_DATA_DIR: &str = "./data";
const DEFAULT_DB_FILENAME: &str = "castify.db";
const DEFAULT_VIDEO_CACHE_MAX_BYTES: u64 = 10 * 1024 * 1024 * 1024; // 10 GiB
const VIDEO_CACHE_DIR_NAME: &str = "video-cache";
const DEFAULT_PROBE_CONCURRENCY: u32 = 2;
const CONFIG_DOCS_HINT: &str = "See docs/config.md for the full reference.";

/// OAuth credentials for a single cloud storage provider.
#[derive(Debug, Clone)]
pub struct ProviderOAuthConfig {
    pub client_id: String,
    pub client_secret: String,
}

/// Hot-video disk cache configuration (M4). Off by default; when enabled,
/// played videos are stream-through cached to local disk for disk-fast
/// re-watching.
#[derive(Debug, Clone)]
pub struct VideoCacheConfig {
    pub enabled: bool,
    pub max_bytes: u64,
    /// Absolute path to the cache directory. Defaults to
    /// `<data_dir>/video-cache`.
    pub dir: std::path::PathBuf,
}

/// Codec probing configuration (M5). Controls whether and how aggressively
/// the catalog is probed for codec/bitrate info via ffprobe.
#[derive(Debug, Clone)]
pub struct ProbeConfig {
    /// When true, scan completion triggers a background sweep that probes
    /// all un-probed videos. Lazy (on-first-play) probing always runs
    /// regardless of this setting.
    pub probe_on_scan: bool,
    /// Parallel probe workers for the eager post-scan sweep.
    pub concurrency: u32,
}

impl Default for ProbeConfig {
    fn default() -> Self {
        Self {
            probe_on_scan: true,
            concurrency: DEFAULT_PROBE_CONCURRENCY,
        }
    }
}

/// Server-side transcoding configuration (M6). When enabled, videos with
/// browser-incompatible codecs are transcoded to H.264/AAC HLS on the fly.
#[derive(Debug, Clone)]
pub struct TranscodeConfig {
    /// Master switch. When false, incompatible codecs fall back to the
    /// "download instead" path.
    pub enabled: bool,
    /// HLS segment duration in seconds.
    pub segment_duration_secs: u32,
    /// Cache directory for transcode output.
    pub dir: std::path::PathBuf,
    /// Soft limit for the transcode cache pool (bytes).
    pub cache_max_bytes: u64,
    /// Interval between background LRU sweeps (seconds). The sweep walks
    /// `transcode_cache_entries` ordered by `last_accessed_at ASC` and
    /// deletes entries + their on-disk segments until total cache size
    /// drops below `cache_max_bytes`. M7 addition.
    pub sweep_interval_secs: u64,
}

impl Default for TranscodeConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            segment_duration_secs: 10,
            dir: std::path::PathBuf::from("./data/transcode-cache"),
            cache_max_bytes: 50 * 1024 * 1024 * 1024, // 50 GiB
            sweep_interval_secs: 600,                 // 10 min
        }
    }
}

/// One rung on the adaptive-bitrate ladder (M7).
///
/// All fields are `'static` because the rung vocabulary is fixed: the
/// built-in set defined by [`builtin_rungs`]. User-defined rungs are not
/// supported in M7; PRD M7 §"Out of scope" defers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VariantRung {
    /// Short identifier used in URLs, env vars, and HLS variant tags
    /// (`"360p"`, `"480p"`, `"720p"`, `"1080p"`).
    pub name: &'static str,
    /// Target video height in pixels. The ffmpeg scale filter caps at this
    /// height without upscaling.
    pub target_height: u32,
    /// Target bitrate in kbps. Used as `BANDWIDTH` in the master playlist
    /// for in-progress variants; completed variants store the actual
    /// measured bitrate in `transcode_cache_entries.bitrate`.
    pub target_bitrate_kbps: u32,
}

/// Built-in rung table. The order is intentional: ascending by height,
/// matching the PRD M7 default ladder `360p,480p,720p,1080p`.
///
/// Bitrates are conservative defaults from PRD M7 §"Bitrate targeting per
/// rung". Tunable via future config; M7 ships these.
pub fn builtin_rungs() -> &'static [VariantRung] {
    static RUNGS: &[VariantRung] = &[
        VariantRung {
            name: "360p",
            target_height: 360,
            target_bitrate_kbps: 800,
        },
        VariantRung {
            name: "480p",
            target_height: 480,
            target_bitrate_kbps: 1500,
        },
        VariantRung {
            name: "720p",
            target_height: 720,
            target_bitrate_kbps: 3000,
        },
        VariantRung {
            name: "1080p",
            target_height: 1080,
            target_bitrate_kbps: 6000,
        },
    ];
    RUNGS
}

/// Look up a built-in rung by name (case-sensitive).
pub fn lookup_rung(name: &str) -> Option<VariantRung> {
    builtin_rungs().iter().find(|r| r.name == name).copied()
}

/// Pick the variant to pre-compute at transcode start, per PRD M7 §"Pre-compute
/// policy": the closest ladder rung at-or-below `min(source_height, cap)`.
///
/// Selection rules:
/// 1. If `source_height` is `None` (probe pending): return `cap`. Default
///    behavior is to pre-compute the cap rung (e.g., 720p) and let M5's
///    probe refine it later. The pre-compute is wasted work only if the
///    source turns out to be smaller than the cap; the cost is bounded.
/// 2. Filter `ladder` to rungs with `target_height <= min(source_height,
///    cap.target_height)`. Pick the tallest. This is the "closest at-or-below"
///    rung.
/// 3. If no rung satisfies (source smaller than every ladder rung): return
///    the smallest rung. ffmpeg's scale filter caps down without upscaling,
///    so any rung produces the same output for a sub-minimum source.
///    Picking the smallest makes the intent explicit.
pub fn select_precompute_variant(
    source_height: Option<u32>,
    ladder: &[VariantRung],
    cap: &VariantRung,
) -> VariantRung {
    let Some(src) = source_height else {
        return *cap;
    };
    let ceiling = src.min(cap.target_height);
    // Filter to rungs at-or-below the ceiling, pick tallest.
    let mut best: Option<VariantRung> = None;
    for rung in ladder {
        if rung.target_height <= ceiling {
            best = Some(match best {
                Some(b) if b.target_height >= rung.target_height => b,
                _ => *rung,
            });
        }
    }
    best.unwrap_or_else(|| {
        // Source smaller than every rung — return smallest. ffmpeg's scale
        // filter (`min(target,iw)`) won't upscale, so this is a no-op
        // resolution change.
        ladder
            .iter()
            .min_by_key(|r| r.target_height)
            .copied()
            .unwrap_or(*cap)
    })
}

/// Adaptive bitrate configuration (M7). Parsed at startup from
/// `CASTIFY_ABR_LADDER` and `CASTIFY_ABR_PRECOMPUTE_CAP`.
#[derive(Debug, Clone)]
pub struct AbrConfig {
    /// Ordered list of rungs, lowest to highest. The first rung is the
    /// smallest variant; the last is the largest.
    pub ladder: Vec<VariantRung>,
    /// The rung at-or-below source resolution to pre-compute at transcode
    /// start. Must be a member of [`Self::ladder`].
    pub precompute_cap: VariantRung,
}

impl Default for AbrConfig {
    fn default() -> Self {
        Self {
            ladder: builtin_rungs().to_vec(),
            precompute_cap: lookup_rung("720p").expect("720p is a built-in rung"),
        }
    }
}

/// Catalog-prune reconcile mode (docs/specs/catalog-prune/spec.md). Controls
/// when a catalog row the provider no longer lists gets deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PruneMode {
    /// Never prune — exact pre-effort upsert-only behavior.
    Off,
    /// Prune on the first completed scan that omits the row.
    Immediate,
    /// Prune after `grace_scans` consecutive completed scans omitted it
    /// (the default: one flaky listing marks, the next confirms).
    Grace,
}

impl PruneMode {
    fn parse(raw: &str) -> Result<Self> {
        match raw.to_ascii_lowercase().as_str() {
            "off" => Ok(PruneMode::Off),
            "immediate" => Ok(PruneMode::Immediate),
            "grace" => Ok(PruneMode::Grace),
            _ => bail!(
                "CASTIFY_PRUNE_MODE must be one of off | immediate | grace; got {raw:?}. \
                 {CONFIG_DOCS_HINT}"
            ),
        }
    }
}

/// Catalog-prune configuration, parsed from `CASTIFY_PRUNE_MODE` and
/// `CASTIFY_PRUNE_GRACE_SCANS`.
#[derive(Debug, Clone)]
pub struct PruneConfig {
    pub mode: PruneMode,
    /// Raw `CASTIFY_PRUNE_GRACE_SCANS` value, floored at 1. Only meaningful
    /// in [`PruneMode::Grace`] — `immediate ≡ grace 1` by construction.
    pub grace_scans: u32,
}

impl Default for PruneConfig {
    fn default() -> Self {
        Self {
            mode: PruneMode::Grace,
            grace_scans: 2,
        }
    }
}

impl PruneConfig {
    /// The grace the scanner actually enforces: `None` = never delete,
    /// `Some(n)` = delete after n consecutive completed scans omitted the
    /// row. Centralizes the mode→grace normalization so call sites never
    /// re-derive it.
    pub fn effective_grace_scans(&self) -> Option<u32> {
        match self.mode {
            PruneMode::Off => None,
            PruneMode::Immediate => Some(1),
            PruneMode::Grace => Some(self.grace_scans.max(1)),
        }
    }
}

/// Load catalog-prune config. Grace is parsed as i64 then floored at 1 —
/// a zero/negative grace would otherwise mean "prune rows the listing just
/// confirmed present", which is never intended.
fn load_prune_config() -> Result<PruneConfig> {
    let mode = match std::env::var("CASTIFY_PRUNE_MODE") {
        Ok(raw) if !raw.is_empty() => PruneMode::parse(&raw)?,
        _ => PruneConfig::default().mode,
    };
    let grace_scans = std::env::var("CASTIFY_PRUNE_GRACE_SCANS")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|raw| {
            raw.parse::<i64>().with_context(|| {
                format!(
                    "CASTIFY_PRUNE_GRACE_SCANS must be an integer; got {raw:?}. {CONFIG_DOCS_HINT}"
                )
            })
        })
        .transpose()?
        .map(|n| n.clamp(1, i64::from(u32::MAX)) as u32)
        .unwrap_or(2);
    Ok(PruneConfig { mode, grace_scans })
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub log_level: String,
    pub data_dir: PathBuf,
    pub database_path: PathBuf,
    pub app_base_url: Option<String>,
    pub cookie_secure: bool,
    pub google_oauth: Option<ProviderOAuthConfig>,
    pub dropbox_oauth: Option<ProviderOAuthConfig>,
    pub microsoft_oauth: Option<ProviderOAuthConfig>,
    pub video_cache: VideoCacheConfig,
    pub probe: ProbeConfig,
    pub transcode: TranscodeConfig,
    pub abr: AbrConfig,
    pub prune: PruneConfig,
}

impl Config {
    /// Load configuration from environment variables.
    ///
    /// Missing required values cause a clear, actionable error that names the
    /// offending key and points to the docs. Sensible defaults are applied for
    /// anything not strictly required, so the app boots in basic mode with no
    /// external service keys.
    pub fn from_env() -> Result<Self> {
        let host = env_string("CASTIFY_HOST", DEFAULT_HOST);
        let port = parse_port(
            "CASTIFY_PORT",
            std::env::var("CASTIFY_PORT").ok().as_deref(),
        )?;
        let bind_addr = parse_bind_addr("CASTIFY_HOST/CASTIFY_PORT", &host, port)?;
        let log_level = log_level_value();
        let data_dir = PathBuf::from(env_string("CASTIFY_DATA_DIR", DEFAULT_DATA_DIR));
        let database_path = match std::env::var("CASTIFY_DB_PATH") {
            Ok(raw) => PathBuf::from(raw),
            Err(_) => data_dir.join(DEFAULT_DB_FILENAME),
        };

        validate_data_dir(&data_dir)?;

        let app_base_url = std::env::var("CASTIFY_APP_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty());
        let cookie_secure = resolve_cookie_secure(&app_base_url)?;
        let google_oauth =
            load_provider_oauth("CASTIFY_GOOGLE_CLIENT_ID", "CASTIFY_GOOGLE_CLIENT_SECRET");
        let dropbox_oauth =
            load_provider_oauth("CASTIFY_DROPBOX_CLIENT_ID", "CASTIFY_DROPBOX_CLIENT_SECRET");
        let microsoft_oauth =
            load_provider_oauth("CASTIFY_MS_CLIENT_ID", "CASTIFY_MS_CLIENT_SECRET");
        let video_cache = load_video_cache_config(&data_dir)?;
        let probe = load_probe_config()?;
        let transcode = load_transcode_config(&data_dir)?;
        let abr = load_abr_config()?;
        let prune = load_prune_config()?;

        Ok(Self {
            bind_addr,
            log_level,
            data_dir,
            database_path,
            app_base_url,
            cookie_secure,
            google_oauth,
            dropbox_oauth,
            microsoft_oauth,
            video_cache,
            probe,
            transcode,
            abr,
            prune,
        })
    }
}

/// Load transcoding config.
fn load_transcode_config(data_dir: &Path) -> Result<TranscodeConfig> {
    let enabled = match std::env::var("CASTIFY_TRANSCODE_ENABLED") {
        Ok(raw) => parse_bool_env("CASTIFY_TRANSCODE_ENABLED", &raw)?,
        Err(_) => true,
    };
    let segment_duration_secs = std::env::var("CASTIFY_TRANSCODE_SEGMENT_DURATION_SECS")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|raw| {
            raw.parse::<u32>().with_context(|| {
                format!(
                    "CASTIFY_TRANSCODE_SEGMENT_DURATION_SECS must be a positive integer; got {raw:?}. {CONFIG_DOCS_HINT}"
                )
            })
        })
        .transpose()?
        .unwrap_or(10);
    let dir = match std::env::var("CASTIFY_TRANSCODE_DIR") {
        Ok(raw) if !raw.is_empty() => PathBuf::from(raw),
        _ => data_dir.join("transcode-cache"),
    };
    let cache_max_bytes = std::env::var("CASTIFY_TRANSCODE_CACHE_MAX_BYTES")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|raw| {
            raw.parse::<u64>().with_context(|| {
                format!(
                    "CASTIFY_TRANSCODE_CACHE_MAX_BYTES must be a positive integer; got {raw:?}. {CONFIG_DOCS_HINT}"
                )
            })
        })
        .transpose()?
        .unwrap_or(50 * 1024 * 1024 * 1024);
    let sweep_interval_secs = std::env::var("CASTIFY_TRANSCODE_SWEEP_INTERVAL_SECS")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|raw| {
            raw.parse::<u64>().with_context(|| {
                format!(
                    "CASTIFY_TRANSCODE_SWEEP_INTERVAL_SECS must be a positive integer; got {raw:?}. {CONFIG_DOCS_HINT}"
                )
            })
        })
        .transpose()?
        .unwrap_or(600);
    Ok(TranscodeConfig {
        enabled,
        segment_duration_secs,
        dir,
        cache_max_bytes,
        sweep_interval_secs,
    })
}

/// Load adaptive-bitrate config (M7). The ladder is parsed from
/// `CASTIFY_ABR_LADDER` (comma-separated rung names); the pre-compute cap
/// from `CASTIFY_ABR_PRECOMPUTE_CAP`. Both must reference built-in rungs.
fn load_abr_config() -> Result<AbrConfig> {
    let ladder = match std::env::var("CASTIFY_ABR_LADDER") {
        Ok(raw) if !raw.is_empty() => parse_ladder(&raw)?,
        _ => builtin_rungs().to_vec(),
    };
    if ladder.is_empty() {
        bail!("CASTIFY_ABR_LADDER must contain at least one rung. {CONFIG_DOCS_HINT}");
    }
    let precompute_cap_name = std::env::var("CASTIFY_ABR_PRECOMPUTE_CAP")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "720p".to_string());
    let precompute_cap = lookup_rung(&precompute_cap_name).ok_or_else(|| {
        anyhow::anyhow!(
            "CASTIFY_ABR_PRECOMPUTE_CAP={precompute_cap_name:?} is not a known rung. \
             Valid rungs: {}. {CONFIG_DOCS_HINT}",
            builtin_rungs()
                .iter()
                .map(|r| r.name)
                .collect::<Vec<_>>()
                .join(", "),
        )
    })?;
    if !ladder.iter().any(|r| r.name == precompute_cap.name) {
        bail!(
            "CASTIFY_ABR_PRECOMPUTE_CAP={:?} must be a member of CASTIFY_ABR_LADDER. \
             {CONFIG_DOCS_HINT}",
            precompute_cap.name
        );
    }
    Ok(AbrConfig {
        ladder,
        precompute_cap,
    })
}

/// Parse a comma-separated ladder string into rungs. Validates each name
/// against the built-in vocabulary. Order is preserved as given.
fn parse_ladder(raw: &str) -> Result<Vec<VariantRung>> {
    let mut rungs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for token in raw.split(',') {
        let name = token.trim();
        if name.is_empty() {
            continue;
        }
        let rung = lookup_rung(name).ok_or_else(|| {
            anyhow::anyhow!(
                "CASTIFY_ABR_LADDER contains unknown rung {name:?}. \
                 Valid rungs: {}. {CONFIG_DOCS_HINT}",
                builtin_rungs()
                    .iter()
                    .map(|r| r.name)
                    .collect::<Vec<_>>()
                    .join(", "),
            )
        })?;
        if !seen.insert(rung.name) {
            bail!("CASTIFY_ABR_LADDER contains duplicate rung {name:?}. {CONFIG_DOCS_HINT}");
        }
        rungs.push(rung);
    }
    Ok(rungs)
}

/// Load codec probing config.
fn load_probe_config() -> Result<ProbeConfig> {
    let probe_on_scan = match std::env::var("CASTIFY_PROBE_ON_SCAN") {
        Ok(raw) => parse_bool_env("CASTIFY_PROBE_ON_SCAN", &raw)?,
        Err(_) => true,
    };
    let concurrency = std::env::var("CASTIFY_PROBE_CONCURRENCY")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|raw| {
            raw.parse::<u32>().with_context(|| {
                format!(
                    "CASTIFY_PROBE_CONCURRENCY must be a positive integer; got {raw:?}. {CONFIG_DOCS_HINT}"
                )
            })
        })
        .transpose()?
        .unwrap_or(DEFAULT_PROBE_CONCURRENCY);
    Ok(ProbeConfig {
        probe_on_scan,
        concurrency,
    })
}

/// Load hot-video cache config. Enabled by `CASTIFY_VIDEO_CACHE_ENABLED=true`.
/// When disabled, no routes are registered, no tee on `/stream`, zero overhead.
fn load_video_cache_config(data_dir: &Path) -> Result<VideoCacheConfig> {
    let enabled = match std::env::var("CASTIFY_VIDEO_CACHE_ENABLED") {
        Ok(raw) => parse_bool_env("CASTIFY_VIDEO_CACHE_ENABLED", &raw)?,
        Err(_) => false,
    };
    let max_bytes = std::env::var("CASTIFY_VIDEO_CACHE_MAX_BYTES")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|raw| {
            raw.parse::<u64>().with_context(|| {
                format!(
                    "CASTIFY_VIDEO_CACHE_MAX_BYTES must be a positive integer (bytes); got {raw:?}. {CONFIG_DOCS_HINT}"
                )
            })
        })
        .transpose()?
        .unwrap_or(DEFAULT_VIDEO_CACHE_MAX_BYTES);
    let dir = match std::env::var("CASTIFY_VIDEO_CACHE_DIR") {
        Ok(raw) if !raw.is_empty() => PathBuf::from(raw),
        _ => data_dir.join(VIDEO_CACHE_DIR_NAME),
    };
    Ok(VideoCacheConfig {
        enabled,
        max_bytes,
        dir,
    })
}

fn env_string(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn load_provider_oauth(id_key: &str, secret_key: &str) -> Option<ProviderOAuthConfig> {
    let client_id = std::env::var(id_key).ok().filter(|s| !s.is_empty())?;
    let client_secret = std::env::var(secret_key).ok().filter(|s| !s.is_empty())?;
    Some(ProviderOAuthConfig {
        client_id,
        client_secret,
    })
}

fn log_level_value() -> String {
    if let Ok(v) = std::env::var("CASTIFY_LOG") {
        return v;
    }
    if let Ok(v) = std::env::var("RUST_LOG") {
        return v;
    }
    DEFAULT_LOG_LEVEL.to_string()
}

fn parse_port(key: &str, raw: Option<&str>) -> Result<u16> {
    match raw {
        None => Ok(DEFAULT_PORT),
        Some(value) => value.parse::<u16>().with_context(|| {
            format!(
                "{key} must be a valid port number (1..=65535); got {value:?}. {CONFIG_DOCS_HINT}"
            )
        }),
    }
}

fn parse_bind_addr(key: &str, host: &str, port: u16) -> Result<SocketAddr> {
    format!("{host}:{port}").parse().with_context(|| {
        format!("{key} produced an invalid bind address {host}:{port}. {CONFIG_DOCS_HINT}")
    })
}

fn resolve_cookie_secure(app_base_url: &Option<String>) -> Result<bool> {
    match std::env::var("CASTIFY_COOKIE_SECURE")
        .ok()
        .filter(|s| !s.is_empty())
    {
        Some(raw) => parse_bool_env("CASTIFY_COOKIE_SECURE", &raw),
        None => Ok(app_base_url
            .as_deref()
            .map(|u| u.starts_with("https://"))
            .unwrap_or(false)),
    }
}

fn parse_bool_env(key: &str, raw: &str) -> Result<bool> {
    match raw.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => bail!("{key} must be a boolean (true/false/1/0); got {raw:?}. {CONFIG_DOCS_HINT}"),
    }
}

fn validate_data_dir(data_dir: &Path) -> Result<()> {
    if data_dir.as_os_str().is_empty() {
        bail!("CASTIFY_DATA_DIR cannot be empty. {CONFIG_DOCS_HINT}");
    }
    if !data_dir.exists() {
        std::fs::create_dir_all(data_dir).with_context(|| {
            format!(
                "failed to create data dir {}; check permissions. {CONFIG_DOCS_HINT}",
                data_dir.display()
            )
        })?;
    }
    let metadata = std::fs::metadata(data_dir).with_context(|| {
        format!(
            "cannot stat data dir {}; check permissions. {CONFIG_DOCS_HINT}",
            data_dir.display()
        )
    })?;
    if !metadata.is_dir() {
        bail!(
            "CASTIFY_DATA_DIR {} exists but is not a directory. {CONFIG_DOCS_HINT}",
            data_dir.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Config::from_env reads process-global env vars; tests must serialize.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);

    impl EnvGuard {
        fn lock() -> Self {
            let guard = ENV_LOCK.lock().unwrap();
            // SAFETY: tests serialize via ENV_LOCK, so leaking to 'static is
            // fine for the test process lifetime.
            EnvGuard(unsafe {
                std::mem::transmute::<
                    std::sync::MutexGuard<'_, ()>,
                    std::sync::MutexGuard<'static, ()>,
                >(guard)
            })
        }
    }

    fn clear_castify_env() {
        for key in [
            "CASTIFY_HOST",
            "CASTIFY_PORT",
            "CASTIFY_LOG",
            "CASTIFY_DATA_DIR",
            "CASTIFY_DB_PATH",
            "CASTIFY_APP_BASE_URL",
            "CASTIFY_COOKIE_SECURE",
            "CASTIFY_TOKEN_KEY",
            "CASTIFY_GOOGLE_CLIENT_ID",
            "CASTIFY_GOOGLE_CLIENT_SECRET",
            "CASTIFY_DROPBOX_CLIENT_ID",
            "CASTIFY_DROPBOX_CLIENT_SECRET",
            "CASTIFY_MS_CLIENT_ID",
            "CASTIFY_MS_CLIENT_SECRET",
            "CASTIFY_VIDEO_CACHE_ENABLED",
            "CASTIFY_VIDEO_CACHE_MAX_BYTES",
            "CASTIFY_VIDEO_CACHE_DIR",
            "CASTIFY_PROBE_ON_SCAN",
            "CASTIFY_PROBE_CONCURRENCY",
            "CASTIFY_TRANSCODE_ENABLED",
            "CASTIFY_TRANSCODE_SEGMENT_DURATION_SECS",
            "CASTIFY_TRANSCODE_DIR",
            "CASTIFY_TRANSCODE_CACHE_MAX_BYTES",
            "CASTIFY_TRANSCODE_SWEEP_INTERVAL_SECS",
            "CASTIFY_ABR_LADDER",
            "CASTIFY_ABR_PRECOMPUTE_CAP",
            "CASTIFY_PRUNE_MODE",
            "CASTIFY_PRUNE_GRACE_SCANS",
            "RUST_LOG",
        ] {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn defaults_apply_when_env_missing() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        // Use a temp dir so we don't pollute the repo's actual ./data dir.
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());

        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.bind_addr.port(), DEFAULT_PORT);
        assert_eq!(cfg.log_level, DEFAULT_LOG_LEVEL);
        assert!(cfg.database_path.ends_with(DEFAULT_DB_FILENAME));
    }

    #[test]
    fn invalid_port_produces_actionable_error() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_PORT", "not-a-port");

        let err = Config::from_env().expect_err("must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("CASTIFY_PORT"), "msg = {msg}");
        assert!(msg.contains("docs/config.md"), "msg = {msg}");
    }

    #[test]
    fn data_dir_must_be_a_directory() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        let not_a_dir = tmp.path().join("regular_file");
        std::fs::write(&not_a_dir, b"hi").unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", &not_a_dir);

        let err = Config::from_env().expect_err("must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("not a directory"), "msg = {msg}");
    }

    #[test]
    fn explicit_db_path_overrides_data_dir_default() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        let custom_db = tmp.path().join("custom.db");
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_DB_PATH", &custom_db);

        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.database_path, custom_db);
    }

    #[test]
    fn castify_log_takes_precedence_over_rust_log() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("RUST_LOG", "debug");
        std::env::set_var("CASTIFY_LOG", "warn");

        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.log_level, "warn");
    }

    #[test]
    fn falls_back_to_rust_log_when_castify_log_missing() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("RUST_LOG", "debug");

        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.log_level, "debug");
    }

    #[test]
    fn provider_oauth_defaults_to_none() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());

        let cfg = Config::from_env().unwrap();
        assert!(cfg.google_oauth.is_none());
        assert!(cfg.dropbox_oauth.is_none());
        assert!(cfg.microsoft_oauth.is_none());
        assert!(cfg.app_base_url.is_none());
    }

    #[test]
    fn provider_oauth_loaded_when_both_keys_present() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_GOOGLE_CLIENT_ID", "g-id");
        std::env::set_var("CASTIFY_GOOGLE_CLIENT_SECRET", "g-secret");

        let cfg = Config::from_env().unwrap();
        let google = cfg.google_oauth.expect("google oauth should be set");
        assert_eq!(google.client_id, "g-id");
        assert_eq!(google.client_secret, "g-secret");
    }

    #[test]
    fn provider_oauth_ignored_when_only_id_present() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_GOOGLE_CLIENT_ID", "g-id");

        let cfg = Config::from_env().unwrap();
        assert!(
            cfg.google_oauth.is_none(),
            "partial credentials should not produce a config"
        );
    }

    #[test]
    fn cookie_secure_defaults_false_without_app_base_url() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());

        let cfg = Config::from_env().unwrap();
        assert!(
            !cfg.cookie_secure,
            "cookie_secure should default to false when there is no app_base_url (local HTTP dev)"
        );
    }

    #[test]
    fn cookie_secure_auto_detects_from_https_app_base_url() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_APP_BASE_URL", "https://media.example.com");

        let cfg = Config::from_env().unwrap();
        assert!(
            cfg.cookie_secure,
            "cookie_secure should auto-enable when app_base_url is HTTPS"
        );
    }

    #[test]
    fn cookie_secure_auto_detects_from_http_app_base_url() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_APP_BASE_URL", "http://localhost:8427");

        let cfg = Config::from_env().unwrap();
        assert!(
            !cfg.cookie_secure,
            "cookie_secure should stay off for HTTP app_base_url"
        );
    }

    #[test]
    fn cookie_secure_explicit_overrides_auto_detect() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_APP_BASE_URL", "https://media.example.com");
        std::env::set_var("CASTIFY_COOKIE_SECURE", "false");

        let cfg = Config::from_env().unwrap();
        assert!(
            !cfg.cookie_secure,
            "explicit CASTIFY_COOKIE_SECURE=false must override the HTTPS auto-detect"
        );
    }

    #[test]
    fn cookie_secure_explicit_true_without_app_base_url() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_COOKIE_SECURE", "true");

        let cfg = Config::from_env().unwrap();
        assert!(cfg.cookie_secure);
    }

    #[test]
    fn cookie_secure_invalid_value_errors() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_COOKIE_SECURE", "maybe");

        let err = Config::from_env().expect_err("must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("CASTIFY_COOKIE_SECURE"), "msg = {msg}");
        assert!(msg.contains("boolean"), "msg = {msg}");
    }

    #[test]
    fn app_base_url_loaded_when_present() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_APP_BASE_URL", "https://media.example.com");

        let cfg = Config::from_env().unwrap();
        assert_eq!(
            cfg.app_base_url.as_deref(),
            Some("https://media.example.com")
        );
    }

    #[test]
    fn all_three_providers_can_be_configured() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_GOOGLE_CLIENT_ID", "g");
        std::env::set_var("CASTIFY_GOOGLE_CLIENT_SECRET", "gs");
        std::env::set_var("CASTIFY_DROPBOX_CLIENT_ID", "d");
        std::env::set_var("CASTIFY_DROPBOX_CLIENT_SECRET", "ds");
        std::env::set_var("CASTIFY_MS_CLIENT_ID", "m");
        std::env::set_var("CASTIFY_MS_CLIENT_SECRET", "ms");

        let cfg = Config::from_env().unwrap();
        assert!(cfg.google_oauth.is_some());
        assert!(cfg.dropbox_oauth.is_some());
        assert!(cfg.microsoft_oauth.is_some());
    }

    #[test]
    fn video_cache_defaults_disabled() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());

        let cfg = Config::from_env().unwrap();
        assert!(!cfg.video_cache.enabled, "video cache defaults off");
        assert_eq!(cfg.video_cache.max_bytes, DEFAULT_VIDEO_CACHE_MAX_BYTES);
        assert!(cfg.video_cache.dir.ends_with(VIDEO_CACHE_DIR_NAME));
    }

    #[test]
    fn video_cache_enabled_flag_works() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_VIDEO_CACHE_ENABLED", "true");

        let cfg = Config::from_env().unwrap();
        assert!(cfg.video_cache.enabled);
    }

    #[test]
    fn video_cache_invalid_max_bytes_errors() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_VIDEO_CACHE_MAX_BYTES", "not-a-number");

        let err = Config::from_env().expect_err("must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("CASTIFY_VIDEO_CACHE_MAX_BYTES"));
    }

    #[test]
    fn video_cache_custom_dir_overrides_default() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        let custom = tmp.path().join("custom-cache");
        std::env::set_var("CASTIFY_VIDEO_CACHE_DIR", &custom);

        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.video_cache.dir, custom);
    }

    // ── ABR config (M7) ───────────────────────────────────────────────

    #[test]
    fn abr_defaults_to_full_ladder_with_720p_cap() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());

        let cfg = Config::from_env().unwrap();
        let names: Vec<_> = cfg.abr.ladder.iter().map(|r| r.name).collect();
        assert_eq!(names, vec!["360p", "480p", "720p", "1080p"]);
        assert_eq!(cfg.abr.precompute_cap.name, "720p");
    }

    #[test]
    fn abr_ladder_custom_subset_parses() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_ABR_LADDER", "480p,720p");
        std::env::set_var("CASTIFY_ABR_PRECOMPUTE_CAP", "480p");

        let cfg = Config::from_env().unwrap();
        let names: Vec<_> = cfg.abr.ladder.iter().map(|r| r.name).collect();
        assert_eq!(names, vec!["480p", "720p"]);
        assert_eq!(cfg.abr.precompute_cap.name, "480p");
    }

    #[test]
    fn abr_ladder_unknown_rung_rejected() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_ABR_LADDER", "720p,foo");

        let err = Config::from_env().expect_err("must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("CASTIFY_ABR_LADDER"), "msg = {msg}");
        assert!(msg.contains("foo"), "msg = {msg}");
    }

    #[test]
    fn abr_ladder_duplicate_rung_rejected() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_ABR_LADDER", "720p,720p");

        let err = Config::from_env().expect_err("must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("duplicate"), "msg = {msg}");
    }

    #[test]
    fn abr_ladder_empty_rejected() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_ABR_LADDER", "   ,  ,");

        let err = Config::from_env().expect_err("must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("at least one rung"), "msg = {msg}");
    }

    #[test]
    fn abr_precompute_cap_unknown_rejected() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_ABR_PRECOMPUTE_CAP", "1440p");

        let err = Config::from_env().expect_err("must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("CASTIFY_ABR_PRECOMPUTE_CAP"), "msg = {msg}");
        assert!(msg.contains("1440p"), "msg = {msg}");
    }

    #[test]
    fn abr_precompute_cap_must_be_in_ladder() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_ABR_LADDER", "480p,720p");
        // 1080p is a valid rung but not in the custom ladder.
        std::env::set_var("CASTIFY_ABR_PRECOMPUTE_CAP", "1080p");

        let err = Config::from_env().expect_err("must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("must be a member"), "msg = {msg}");
    }

    #[test]
    fn builtin_rungs_table_matches_prd_defaults() {
        let rungs = builtin_rungs();
        assert_eq!(rungs.len(), 4, "PRD M7 default ladder has 4 rungs");
        assert_eq!(rungs[0].name, "360p");
        assert_eq!(rungs[0].target_height, 360);
        assert_eq!(rungs[0].target_bitrate_kbps, 800);
        assert_eq!(rungs[3].name, "1080p");
        assert_eq!(rungs[3].target_height, 1080);
        assert_eq!(rungs[3].target_bitrate_kbps, 6000);
    }

    // ── select_precompute_variant (M7 T5) ────────────────────────────

    #[test]
    fn precompute_returns_cap_when_source_height_unknown() {
        let cfg = AbrConfig::default();
        let picked = select_precompute_variant(None, &cfg.ladder, &cfg.precompute_cap);
        assert_eq!(picked.name, "720p", "must return cap when probe pending");
    }

    #[test]
    fn precompute_picks_tallest_rung_at_or_below_source_capped() {
        let cfg = AbrConfig::default();
        // 1080p source: min(1080, 720) = 720 → tallest ≤ 720 is 720p.
        let picked = select_precompute_variant(Some(1080), &cfg.ladder, &cfg.precompute_cap);
        assert_eq!(picked.name, "720p");
        // 720p source: min(720, 720) = 720 → tallest ≤ 720 is 720p.
        let picked = select_precompute_variant(Some(720), &cfg.ladder, &cfg.precompute_cap);
        assert_eq!(picked.name, "720p");
        // 500p source: min(500, 720) = 500 → tallest ≤ 500 is 480p.
        let picked = select_precompute_variant(Some(500), &cfg.ladder, &cfg.precompute_cap);
        assert_eq!(picked.name, "480p");
        // 480p source: tallest ≤ 480 is 480p.
        let picked = select_precompute_variant(Some(480), &cfg.ladder, &cfg.precompute_cap);
        assert_eq!(picked.name, "480p");
        // 400p source: tallest ≤ 400 is 360p.
        let picked = select_precompute_variant(Some(400), &cfg.ladder, &cfg.precompute_cap);
        assert_eq!(picked.name, "360p");
    }

    #[test]
    fn precompute_uses_custom_cap_when_configured() {
        // Ladder covers 360p-1080p; cap raised to 1080p.
        let cfg = AbrConfig {
            ladder: builtin_rungs().to_vec(),
            precompute_cap: lookup_rung("1080p").unwrap(),
        };
        // 1080p source: min(1080, 1080) = 1080 → 1080p.
        let picked = select_precompute_variant(Some(1080), &cfg.ladder, &cfg.precompute_cap);
        assert_eq!(picked.name, "1080p");
        // 720p source: min(720, 1080) = 720 → 720p.
        let picked = select_precompute_variant(Some(720), &cfg.ladder, &cfg.precompute_cap);
        assert_eq!(picked.name, "720p");
    }

    #[test]
    fn precompute_returns_smallest_rung_when_source_below_minimum() {
        let cfg = AbrConfig::default();
        // 144p source: no rung ≤ 144 → return smallest (360p).
        let picked = select_precompute_variant(Some(144), &cfg.ladder, &cfg.precompute_cap);
        assert_eq!(picked.name, "360p");
    }

    #[test]
    fn precompute_obeys_ladder_subset() {
        // Ladder reduced to just 720p + 1080p; 480p source must still pick
        // from the configured ladder (720p — smallest available, since no
        // rung ≤ 480 in this subset).
        let cfg = AbrConfig {
            ladder: vec![lookup_rung("720p").unwrap(), lookup_rung("1080p").unwrap()],
            precompute_cap: lookup_rung("720p").unwrap(),
        };
        let picked = select_precompute_variant(Some(480), &cfg.ladder, &cfg.precompute_cap);
        assert_eq!(picked.name, "720p", "must pick from configured ladder only");
    }

    // ── Prune config (catalog-prune) ─────────────────────────────────

    #[test]
    fn prune_defaults_to_grace_two() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());

        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.prune.mode, PruneMode::Grace);
        assert_eq!(cfg.prune.grace_scans, 2);
        assert_eq!(cfg.prune.effective_grace_scans(), Some(2));
    }

    #[test]
    fn prune_mode_off_disables_pruning() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_PRUNE_MODE", "off");

        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.prune.mode, PruneMode::Off);
        assert_eq!(
            cfg.prune.effective_grace_scans(),
            None,
            "off must disable pruning entirely"
        );
    }

    #[test]
    fn prune_mode_immediate_is_grace_one_regardless_of_knob() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_PRUNE_MODE", "immediate");
        std::env::set_var("CASTIFY_PRUNE_GRACE_SCANS", "5");

        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.prune.mode, PruneMode::Immediate);
        assert_eq!(
            cfg.prune.effective_grace_scans(),
            Some(1),
            "immediate ≡ grace 1; the GRACE_SCANS knob is ignored"
        );
    }

    #[test]
    fn prune_grace_custom_value_parses() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_PRUNE_GRACE_SCANS", "3");

        let cfg = Config::from_env().unwrap();
        assert_eq!(cfg.prune.grace_scans, 3);
        assert_eq!(cfg.prune.effective_grace_scans(), Some(3));
    }

    #[test]
    fn prune_grace_floors_at_one() {
        for raw in ["0", "-4"] {
            let _g = EnvGuard::lock();
            clear_castify_env();
            let tmp = tempfile::tempdir().unwrap();
            std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
            std::env::set_var("CASTIFY_PRUNE_GRACE_SCANS", raw);

            let cfg = Config::from_env().unwrap();
            assert_eq!(
                cfg.prune.effective_grace_scans(),
                Some(1),
                "grace of {raw} must floor to 1 (one confirmation scan)"
            );
        }
    }

    #[test]
    fn prune_invalid_mode_rejected() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_PRUNE_MODE", "sometimes");

        let err = Config::from_env().expect_err("must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("CASTIFY_PRUNE_MODE"), "msg = {msg}");
        assert!(msg.contains("sometimes"), "msg = {msg}");
    }

    #[test]
    fn prune_non_integer_grace_rejected() {
        let _g = EnvGuard::lock();
        clear_castify_env();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CASTIFY_DATA_DIR", tmp.path());
        std::env::set_var("CASTIFY_PRUNE_GRACE_SCANS", "two");

        let err = Config::from_env().expect_err("must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("CASTIFY_PRUNE_GRACE_SCANS"), "msg = {msg}");
    }
}
