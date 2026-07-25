use anyhow::Context;
use castify_api::app::build_app;
use castify_api::shutdown::shutdown_signal;
use castify_api::state::AppState;
use castify_api::tracing_init::init_tracing;
use castify_auth::SessionSecret;
use castify_catalog::TokenKey;
use castify_core::Config;
use castify_storage::{connect, run_migrations};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env().context("failed to load configuration")?;
    init_tracing(&config);

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        bind = %config.bind_addr,
        data_dir = %config.data_dir.display(),
        database_path = %config.database_path.display(),
        "starting castify"
    );

    let pool = connect(&config.database_path)
        .await
        .context("failed to open database")?;
    run_migrations(&pool)
        .await
        .context("database migration failed")?;
    let session_secret =
        SessionSecret::resolve(&pool, std::env::var("CASTIFY_SESSION_SECRET").ok())
            .await
            .context("failed to resolve session secret")?;
    let token_key = TokenKey::resolve(&pool, std::env::var("CASTIFY_TOKEN_KEY").ok())
        .await
        .context("failed to resolve token encryption key")?;

    let state = AppState::new(config.clone(), pool, session_secret, token_key);
    let app = build_app(state.clone());

    // M7: spawn the transcode cache LRU sweep loop. The loop sleeps for the
    // configured interval between passes, so the cost when nothing's cached
    // is one DB query per `sweep_interval_secs`.
    if config.transcode.enabled {
        tokio::spawn(castify_api::routes::videos::transcode_sweep_loop(
            state.clone(),
            std::time::Duration::from_secs(config.transcode.sweep_interval_secs),
        ));
    }

    let listener = tokio::net::TcpListener::bind(config.bind_addr)
        .await
        .with_context(|| format!("failed to bind {}", config.bind_addr))?;
    tracing::info!(addr = %config.bind_addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")?;

    tracing::info!("shutdown complete");
    Ok(())
}
