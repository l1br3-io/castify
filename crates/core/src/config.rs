use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

const DEFAULT_HOST: &str = "0.0.0.0";
const DEFAULT_PORT: u16 = 8427;
const DEFAULT_LOG_LEVEL: &str = "info";
const DEFAULT_DATA_DIR: &str = "./data";
const DEFAULT_DB_FILENAME: &str = "castify.db";
const CONFIG_DOCS_HINT: &str = "See docs/config.md for the full reference.";

/// OAuth credentials for a single cloud storage provider.
#[derive(Debug, Clone)]
pub struct ProviderOAuthConfig {
    pub client_id: String,
    pub client_secret: String,
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
        })
    }
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
}
