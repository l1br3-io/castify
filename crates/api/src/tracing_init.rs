use tracing_subscriber::EnvFilter;

use castify_core::Config;

pub fn init_tracing(config: &Config) {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&config.log_level));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .with_target(true)
        .with_file(false)
        .with_line_number(false)
        .init();
}
