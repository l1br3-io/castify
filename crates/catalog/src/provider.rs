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

/// Raw thumbnail image bytes plus their MIME type. Providers return this from
/// [`Provider::fetch_thumbnail`]; the API layer caches and serves it.
#[derive(Debug, Clone)]
pub struct ThumbnailData {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

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

    /// Fetch a poster thumbnail for `file_id`. Returns [`ProviderError::NotFound`]
    /// when the provider has no thumbnail for the file (e.g. unsupported type or
    /// not yet generated). Each implementation owns its provider-specific
    /// thumbnail endpoint; no shared thumbnail logic lives outside the trait.
    async fn fetch_thumbnail(&self, file_id: &str) -> ProviderResult<ThumbnailData>;

    /// Revoke the provider token (best-effort — network failure should not
    /// prevent local connection deletion).
    async fn revoke(&self, token_bundle: &TokenBundle) -> ProviderResult<()>;
}

/// Builder that creates a boxed `Provider` instance from a token bundle and
/// provider-specific configuration. Each provider registers its own builder.
///
/// The factory owns the provider's full OAuth lifecycle: authorization URL
/// construction, code exchange, user-info fetch, token refresh, and revocation.
/// Shared code (e.g. `connections.rs`) dispatches through this trait rather
/// than `match provider {}` blocks.
#[async_trait::async_trait]
pub trait ProviderFactory: Send + Sync {
    /// Create a provider instance authenticated with the given token bundle.
    async fn create(&self, token_bundle: &TokenBundle) -> ProviderResult<Box<dyn Provider>>;

    /// Refresh an expired access token using the refresh token.
    async fn refresh_token(&self, token_bundle: &TokenBundle) -> ProviderResult<TokenBundle>;

    /// Revoke the provider token (best-effort).
    async fn revoke(&self, token_bundle: &TokenBundle) -> ProviderResult<()>;

    /// Build the OAuth authorization URL with PKCE. Infallible — pure string
    /// construction from the configured client id.
    fn authorization_url(&self, redirect_uri: &str, state: &str, challenge: &str) -> String;

    /// Exchange the authorization code for a token bundle.
    async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> ProviderResult<TokenBundle>;

    /// Fetch the authenticated user's account info. Returns
    /// `(provider_account_id, provider_account_email)` — both optional since
    /// providers differ on what they expose and whether the user has an email.
    async fn fetch_user_info(
        &self,
        token_bundle: &TokenBundle,
    ) -> ProviderResult<(Option<String>, Option<String>)>;
}
