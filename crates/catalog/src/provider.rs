use std::pin::Pin;

use bytes::Bytes;
use futures::Stream;
use serde::{Deserialize, Serialize};

use crate::crypto::{Credential, TokenBundle};
use crate::model::ListPage;

/// Error returned by provider API operations.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("network error: {0}")]
    Network(String),
    #[error("rate limited; retry after {retry_after_secs:?} seconds")]
    RateLimited { retry_after_secs: Option<u64> },
    /// The **access token** is expired/revoked, but a refresh may still
    /// recover it. The caller should refresh once and retry.
    #[error("unauthorized: token may be expired or revoked")]
    Unauthorized,
    /// The **refresh token/grant** is expired, revoked, or otherwise unusable.
    /// Per [RFC 6749 §5.2](https://datatracker.ietf.org/doc/html/rfc6749#section-5.2)
    /// this is signalled by `error: "invalid_grant"` from the token endpoint.
    /// No amount of retrying will recover it — the user must re-authenticate
    /// (disconnect + reconnect). Surfaced to the client as
    /// `401 code: "reauth_required"`.
    #[error("refresh token revoked or expired; re-authentication required")]
    ReauthRequired,
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

/// Streaming byte body for video playback. Providers return this from
/// [`Provider::open_stream`]; the API layer forwards it to the browser via
/// `axum::body::Body::from_stream`.
pub type BodyStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

/// A streaming video response from a cloud provider. The API layer converts
/// this into an HTTP response with Range support (200 for full content, 206
/// for partial content).
pub struct StreamResponse {
    /// HTTP status code: `200` (full content) or `206` (partial — Range honored).
    pub status: u16,
    /// MIME type of the video (e.g. `video/mp4`).
    pub content_type: String,
    /// Total or partial content length in bytes (from `Content-Length` header).
    pub content_length: Option<u64>,
    /// Content range for 206 responses (from `Content-Range` header).
    pub content_range: Option<String>,
    /// Streaming body — bytes are forwarded to the client as they arrive.
    pub body: BodyStream,
}

/// A preauthenticated URL the browser can fetch directly, OR a signal that
/// this provider can't direct-stream and the caller should fall back to
/// [`Provider::open_stream`] through our backend proxy.
///
/// OneDrive and Dropbox can issue short-lived CDN URLs that the browser hits
/// directly — the backend resolves the URL via one metadata call and hands it
/// to the client, never touching a video byte. Google Drive's `?alt=media`
/// endpoint 302-redirects to a short-lived pre-signed download URL (the
/// hostname has changed over time — `*.googleusercontent.com`, then
/// `drive.usercontent.google.com`); the backend follows the redirect once and
/// hands the final URL to the client.
///
/// `expires_at` is an ISO-8601 UTC string (matching `TokenBundle::expires_at`'s
/// format) — when known, the frontend uses it to pre-emptively refresh before
/// the CDN URL stops working.
#[derive(Debug, Clone)]
pub enum StreamUrl {
    /// Browser-fetchable CDN URL. No auth header required (the provider bakes
    /// a short-lived token into the URL itself, or — for Google Drive —
    /// responds to `?alt=media` with a 302 to a pre-signed download URL that
    /// needs no auth).
    Direct {
        url: String,
        expires_at: Option<String>,
    },
    /// No direct URL available — the caller should use the existing proxy
    /// endpoint (`/api/videos/{id}/stream`).
    Proxied,
    /// The hot-video disk cache has this video (M4). The caller should use
    /// the cached-stream endpoint (`/api/videos/{id}/cached-stream`). The
    /// `path` field carries that URL for the frontend's `<video src>`.
    Cached { url: String, size_bytes: u64 },
    /// The video's codec is browser-incompatible; the caller should use
    /// the transcode endpoint (M6). The `master_url` points at the HLS
    /// master playlist. Frontend uses hls.js (or native HLS on Safari)
    /// to consume.
    Transcode { master_url: String },
}

impl std::fmt::Debug for StreamResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamResponse")
            .field("status", &self.status)
            .field("content_type", &self.content_type)
            .field("content_length", &self.content_length)
            .field("content_range", &self.content_range)
            .field("body", &"<stream>")
            .finish()
    }
}

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

    /// Open a streaming download for `file_id`, forwarding the browser's
    /// `Range` header (if any) to the provider. Returns a [`StreamResponse`]
    /// whose body streams bytes directly from the provider to the client.
    ///
    /// `range` is the raw `Range` header value (e.g. `"bytes=0-1023"` or
    /// `None` for a full-content request). The provider maps 401 to
    /// [`ProviderError::Unauthorized`] so the caller can refresh the token
    /// and retry.
    async fn open_stream(
        &self,
        file_id: &str,
        range: Option<&str>,
    ) -> ProviderResult<StreamResponse>;

    /// Resolve a browser-directable URL for `file_id` when the provider
    /// supports it (OneDrive + Dropbox issue short-lived preauthenticated CDN
    /// URLs). The default returns [`StreamUrl::Proxied`] — providers that
    /// can't issue a direct URL fall back to the existing proxy path with no
    /// new code.
    ///
    /// When `Proxied` is returned, the caller (`GET /api/videos/{id}/stream-url`)
    /// signals the browser to use the existing `/api/videos/{id}/stream`
    /// endpoint. When `Direct` is returned, the browser hits the CDN URL
    /// itself and our backend never touches a video byte — the proxy stays
    /// available as a fallback for providers like Google Drive that need
    /// bearer headers on every download.
    async fn open_stream_url(&self, _file_id: &str) -> ProviderResult<StreamUrl> {
        Ok(StreamUrl::Proxied)
    }

    /// Fetch the full content of a subtitle file (buffered). Subtitle files are
    /// small (typically < 100 KB), so the body is collected into a `Vec<u8>`
    /// rather than streamed. The default implementation reuses
    /// [`Provider::open_stream`] — provider download endpoints are generic file
    /// download, not video-specific. Override only for test mocks that need
    /// subtitle-specific canned content.
    async fn fetch_subtitle_content(&self, file_id: &str) -> ProviderResult<Vec<u8>> {
        let resp = self.open_stream(file_id, None).await?;
        collect_body(resp.body).await
    }

    /// Revoke the provider token (best-effort — network failure should not
    /// prevent local connection deletion).
    ///
    /// The default is a **documented no-op**: static-credential providers
    /// (S3-compatible storage) have no grant to revoke server-side — access
    /// keys rotate at the provider's console, outside Castify's control.
    /// OAuth providers override this to call their token-revocation
    /// endpoint.
    async fn revoke(&self, _token_bundle: &TokenBundle) -> ProviderResult<()> {
        Ok(())
    }
}

/// Collect a streaming body into a `Vec<u8>`. Used by the default
/// `fetch_subtitle_content` implementation.
async fn collect_body(mut body: BodyStream) -> ProviderResult<Vec<u8>> {
    use futures::StreamExt;
    let mut bytes = Vec::new();
    while let Some(chunk) = body.next().await {
        bytes.extend_from_slice(&chunk.map_err(|e| ProviderError::Other(e.to_string()))?);
    }
    Ok(bytes)
}

/// OAuth connect-flow operations. Implemented by providers that connect
/// through an OAuth authorization-code round-trip (Google Drive, Dropbox,
/// OneDrive).
///
/// Obtained via [`ProviderFactory::connect_flow`] returning
/// [`ConnectFlow::OAuth`]. Split out of `ProviderFactory` so
/// credential-based providers (S3-compatible storage) don't have to stub
/// OAuth methods — see `docs/specs/s3-compatible-storage/extending-providers.md`.
#[async_trait::async_trait]
pub trait OAuthFlow: Send + Sync {
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

    /// Refresh an expired access token using the refresh token.
    async fn refresh_token(&self, token_bundle: &TokenBundle) -> ProviderResult<TokenBundle>;

    /// Fetch the authenticated user's account info. Returns
    /// `(provider_account_id, provider_account_email)` — both optional since
    /// providers differ on what they expose and whether the user has an email.
    async fn fetch_user_info(
        &self,
        token_bundle: &TokenBundle,
    ) -> ProviderResult<(Option<String>, Option<String>)>;
}

/// One renderable field of a [`CredentialsSchema`] form.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialField {
    /// Machine key the API layer expects in the submitted form (snake_case).
    pub key: String,
    /// Human label for the form input.
    pub label: String,
    /// Mask the input (password-style) — true for secrets.
    pub secret: bool,
    /// Optional placeholder hint.
    pub placeholder: Option<String>,
}

/// Declarative description of the credential form a credential-based
/// provider needs. The frontend renders this generically; adding a field
/// (or a whole credential provider) requires zero frontend code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialsSchema {
    pub fields: Vec<CredentialField>,
}

/// How a provider connects: an OAuth round-trip or a submitted credential
/// form. Returned by [`ProviderFactory::connect_flow`].
pub enum ConnectFlow {
    OAuth(Box<dyn OAuthFlow>),
    Credentials(CredentialsSchema),
}

/// Builder that creates a boxed `Provider` instance from a credential and
/// provider-specific configuration. Each provider registers its own builder.
///
/// The factory is the provider's **core**: its identity (`name`), how it
/// connects (`connect_flow`), and how to build/validate an authenticated
/// instance (`create`/`verify`). Connect-flow-specific operations live on
/// [`OAuthFlow`] (obtained from [`ProviderFactory::connect_flow`]) — shared
/// code (e.g. `connections.rs`) dispatches through this trait rather than
/// `match provider {}` blocks.
#[async_trait::async_trait]
pub trait ProviderFactory: Send + Sync {
    /// Machine identifier of the provider this factory builds (matches
    /// `Provider::as_str`, e.g. "google_drive").
    fn name(&self) -> &'static str;

    /// How this provider connects. Callers dispatch on the variant — OAuth
    /// methods live on [`OAuthFlow`], credential providers describe their
    /// form via [`CredentialsSchema`].
    fn connect_flow(&self) -> ConnectFlow;

    /// Create a provider instance authenticated with the given credential.
    /// OAuth factories reject static credentials; credential-based
    /// factories reject OAuth bundles.
    async fn create(&self, credential: &Credential) -> ProviderResult<Box<dyn Provider>>;

    /// Validate a fresh credential before persisting the connection.
    /// Returns `(provider_account_id, provider_account_email)` used by the
    /// `(provider, account_id)` uniqueness constraint. The default verifies
    /// OAuth credentials via the provider's [`OAuthFlow`]; credential-based
    /// providers override with their own reachability check.
    async fn verify(
        &self,
        credential: &Credential,
    ) -> ProviderResult<(Option<String>, Option<String>)> {
        match self.connect_flow() {
            ConnectFlow::OAuth(flow) => {
                let bundle = credential.as_oauth().ok_or_else(|| {
                    ProviderError::Other(
                        "this provider connects via OAuth; static credentials are not supported"
                            .into(),
                    )
                })?;
                flow.fetch_user_info(bundle).await
            }
            ConnectFlow::Credentials(_) => Err(ProviderError::Other(
                "this provider connects via a credentials form; OAuth verification not supported"
                    .into(),
            )),
        }
    }
}
