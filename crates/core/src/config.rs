use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

const DEFAULT_HOST: &str = "0.0.0.0";
const DEFAULT_PORT: u16 = 3000;
const DEFAULT_LOG_LEVEL: &str = "info";
const DEFAULT_DATA_DIR: &str = "./data";
const DEFAULT_DB_FILENAME: &str = "castify.db";
const CONFIG_DOCS_HINT: &str = "See docs/config.md for the full reference.";

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub log_level: String,
    pub data_dir: PathBuf,
    pub database_path: PathBuf,
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

        Ok(Self {
            bind_addr,
            log_level,
            data_dir,
            database_path,
        })
    }
}

fn env_string(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
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
}
