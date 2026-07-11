use crate::crypto::TokenBundle;
use crate::model::ListPage;

/// Error returned by provider API operations.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("network error: {0}")]
    Network(String),
    #[error("rate limited; retry after {retry_after_secs:?} seconds")]
    RateLimited { retry_after_secs: Option<u64> },
    #[error("unauthorized: token may be expired or revoked")]
    Unauthorized,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("api error ({status}): {body}")]
    Api { status: u16, body: String },
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

pub type ProviderResult<T> = Result<T, ProviderError>;

/// Abstraction over a cloud storage provider's video listing and file access.
///
/// Each provider (Google Drive, Dropbox, OneDrive) implements this trait. The
/// scanner uses it to discover videos and compute prefix hashes for cross-
/// provider dedup.
#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    /// Human-readable provider identifier (e.g. "google_drive").
    fn name(&self) -> &'static str;

    /// List one page of video files. `cursor` is the pagination cursor from
    /// the previous page (or `None` for the first page). Returns the page of
    /// discovered videos and an optional cursor for the next page.
    async fn list_videos(&self, cursor: Option<&str>) -> ProviderResult<ListPage>;

    /// Compute a SHA-256 hash of the first 4 MB of `file_id` via an HTTP Range
    /// request. Returns `None` if the file is too small to be worth hashing
    /// (under 4 MB) or if the provider doesn't support Range requests for this
    /// file. `size` is the full file size in bytes.
    async fn fetch_prefix_hash(&self, file_id: &str, size: i64) -> ProviderResult<Option<String>>;

    /// Revoke the provider token (best-effort — network failure should not
    /// prevent local connection deletion).
    async fn revoke(&self, token_bundle: &TokenBundle) -> ProviderResult<()>;
}

/// Builder that creates a boxed `Provider` instance from a token bundle and
/// provider-specific configuration. Each provider registers its own builder.
#[async_trait::async_trait]
pub trait ProviderFactory: Send + Sync {
    /// Create a provider instance authenticated with the given token bundle.
    async fn create(&self, token_bundle: &TokenBundle) -> ProviderResult<Box<dyn Provider>>;

    /// Refresh an expired access token using the refresh token.
    async fn refresh_token(&self, token_bundle: &TokenBundle) -> ProviderResult<TokenBundle>;

    /// Revoke the provider token (best-effort).
    async fn revoke(&self, token_bundle: &TokenBundle) -> ProviderResult<()>;
}
