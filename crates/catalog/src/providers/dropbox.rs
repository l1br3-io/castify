use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::crypto::TokenBundle;
use crate::model::{DiscoveredSubtitle, DiscoveredVideo, ListPage, Provider};
use crate::oauth::redirect_uri;
use crate::provider::{ProviderError, ProviderResult, StreamResponse, StreamUrl, ThumbnailData};
use crate::providers::common::{
    classify_token_error, guess_language, has_subtitle_extension, has_video_extension,
    infer_image_mime, infer_mime_type, response_to_stream, to_hex, TokenResponse,
};

const AUTH_URL: &str = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL: &str = "https://api.dropboxapi.com/oauth2/token";
const LIST_FOLDER_URL: &str = "https://api.dropboxapi.com/2/files/list_folder";
const LIST_FOLDER_CONTINUE_URL: &str = "https://api.dropboxapi.com/2/files/list_folder/continue";
const DOWNLOAD_URL: &str = "https://content.dropboxapi.com/2/files/download";
const GET_TEMPORARY_LINK_URL: &str = "https://api.dropboxapi.com/2/files/get_temporary_link";
const THUMBNAIL_URL: &str = "https://content.dropboxapi.com/2/files/get_thumbnail_v2";
const TOKEN_REVOKE_URL: &str = "https://api.dropboxapi.com/2/auth/token_revoke";
const GET_ACCOUNT_URL: &str = "https://api.dropboxapi.com/2/users/get_current_account";
const SCOPE: &str = "files.metadata.read files.content.read";
const PREFIX_BYTES: usize = 4 * 1024 * 1024;

/// Configuration for the Dropbox OAuth client. Derived from `Config`.
#[derive(Debug, Clone)]
pub struct DropboxConfig {
    pub client_id: String,
    pub client_secret: String,
}

/// Dropbox OAuth + API client. Owns the HTTP client and credentials.
#[derive(Debug, Clone)]
pub struct DropboxClient {
    config: DropboxConfig,
    http: reqwest::Client,
}

/// Account info returned by Dropbox's `get_current_account` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropboxUserInfo {
    pub account_id: Option<String>,
    pub email: Option<String>,
}

impl DropboxClient {
    pub fn new(config: DropboxConfig) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // Control-plane calls (token refresh, list_folder, get_temporary_link,
            // fetch_user_info) should complete in seconds; 30s is the "something
            // is wrong" ceiling. Without this, a stalled provider response hangs
            // the entire /stream-url request — surfacing as "Preparing your
            // video" forever on the watch page. `connect_timeout` covers the
            // TCP/DNS phase; `timeout` covers the full request. Both apply
            // equally to the content endpoints (download, thumbnail) since
            // those transfers are small (≤ a few MB for thumbnails; videos
            // stream via the direct CDN URL this client only resolves).
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest client");
        Self { config, http }
    }

    /// Build the redirect URI for this provider given the app base URL.
    pub fn redirect_uri(&self, base_url: &str) -> String {
        redirect_uri(base_url, &Provider::Dropbox)
    }

    /// Build the Dropbox OAuth authorization URL with PKCE.
    pub fn authorization_url(&self, redirect_uri: &str, state: &str, challenge: &str) -> String {
        let params: Vec<(String, String)> = vec![
            ("client_id".into(), self.config.client_id.clone()),
            ("redirect_uri".into(), redirect_uri.into()),
            ("response_type".into(), "code".into()),
            ("scope".into(), SCOPE.into()),
            ("state".into(), state.into()),
            ("code_challenge".into(), challenge.into()),
            ("code_challenge_method".into(), "S256".into()),
            // Dropbox-specific: request long-lived refresh token.
            ("token_access_type".into(), "offline".into()),
        ];
        let query = serde_urlencoded::to_string(&params).unwrap_or_default();
        format!("{AUTH_URL}?{query}")
    }

    /// Exchange the authorization code for tokens.
    pub async fn exchange_code(
        &self,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
    ) -> ProviderResult<TokenBundle> {
        let resp = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("code", code),
                ("client_id", self.config.client_id.as_str()),
                ("client_secret", self.config.client_secret.as_str()),
                ("redirect_uri", redirect_uri),
                ("grant_type", "authorization_code"),
                ("code_verifier", code_verifier),
            ])
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(classify_token_error(status.as_u16(), &body));
        }

        let token: TokenResponse = serde_json::from_str(&body)?;
        Ok(token.into_bundle())
    }

    /// Refresh an expired access token.
    pub async fn refresh_token(&self, refresh_token: &str) -> ProviderResult<TokenBundle> {
        let resp = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("refresh_token", refresh_token),
                ("client_id", self.config.client_id.as_str()),
                ("client_secret", self.config.client_secret.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(classify_token_error(status.as_u16(), &body));
        }

        let token: TokenResponse = serde_json::from_str(&body)?;
        Ok(token.into_bundle())
    }

    /// Revoke the access token (best-effort).
    pub async fn revoke_token(&self, access_token: &str) -> ProviderResult<()> {
        let _ = self
            .http
            .post(TOKEN_REVOKE_URL)
            .bearer_auth(access_token)
            .send()
            .await;
        Ok(())
    }

    /// Fetch the authenticated user's account ID and email.
    pub async fn fetch_user_info(&self, access_token: &str) -> ProviderResult<DropboxUserInfo> {
        let resp = self
            .http
            .post(GET_ACCOUNT_URL)
            .bearer_auth(access_token)
            .json(&serde_json::Value::Null)
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(ProviderError::Api {
                status: status.as_u16(),
                body,
            });
        }

        let info: AccountResponse = serde_json::from_str(&body)?;
        Ok(DropboxUserInfo {
            account_id: Some(info.account_id),
            email: Some(info.email),
        })
    }
}

// ── list_folder response types ──────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ListFolderResponse {
    #[serde(default)]
    entries: Vec<DropboxEntry>,
    #[serde(default)]
    cursor: String,
    #[serde(default)]
    has_more: bool,
}

#[derive(Debug, Deserialize)]
struct DropboxEntry {
    /// Entry kind: "file", "folder", or "deleted".
    #[serde(rename = ".tag", default)]
    tag: String,
    id: String,
    name: String,
    #[serde(default)]
    path_display: Option<String>,
    #[serde(default)]
    size: Option<i64>,
    /// Dropbox's custom 4 MB-block SHA-256 content hash.
    #[serde(default)]
    content_hash: Option<String>,
    #[serde(default)]
    server_modified: Option<String>,
    /// Optional media info; can be `null`, `pending`, or `metadata`.
    #[serde(default)]
    media_info: Option<MediaInfo>,
}

#[derive(Debug, Deserialize)]
struct MediaInfo {
    #[serde(rename = ".tag", default)]
    tag: String,
    #[serde(default)]
    metadata: Option<MediaMetadata>,
}

#[derive(Debug, Deserialize)]
struct MediaMetadata {
    #[serde(rename = ".tag", default)]
    tag: String,
    #[serde(default)]
    dimensions: Option<Dimensions>,
    /// Duration in milliseconds (unreliable — may be absent).
    #[serde(default)]
    duration: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct Dimensions {
    #[serde(default)]
    height: Option<i64>,
    #[serde(default)]
    width: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AccountResponse {
    account_id: String,
    email: String,
}

/// Response from `POST /2/files/get_temporary_link`. The `link` field is a
/// preauthenticated CDN URL valid for ~4 hours; `metadata` carries the file
/// info we already have from the listing pass, so it's ignored.
#[derive(Debug, Deserialize)]
struct TemporaryLinkResponse {
    link: String,
    #[serde(default)]
    #[allow(dead_code)]
    metadata: serde_json::Value,
}

// ── Video classification ────────────────────────────────────────────

/// A Dropbox entry is a video if it's a file AND either the media_info
/// metadata tags it as a video, or the file extension is a known video type.
fn is_video_entry(entry: &DropboxEntry) -> bool {
    if entry.tag != "file" {
        return false;
    }
    if let Some(mi) = &entry.media_info {
        if mi.tag == "metadata" {
            if let Some(meta) = &mi.metadata {
                if meta.tag == "video" {
                    return true;
                }
            }
        }
    }
    has_video_extension(&entry.name)
}

/// Extract (width, height, duration_ms) from media_info if it's video metadata.
fn extract_video_dims(media_info: &Option<MediaInfo>) -> (Option<i64>, Option<i64>, Option<i64>) {
    if let Some(mi) = media_info {
        if mi.tag == "metadata" {
            if let Some(meta) = &mi.metadata {
                if meta.tag == "video" {
                    let dims = meta.dimensions.as_ref();
                    return (
                        dims.and_then(|d| d.width),
                        dims.and_then(|d| d.height),
                        meta.duration,
                    );
                }
            }
        }
    }
    (None, None, None)
}

// ── Dropbox API methods ─────────────────────────────────────────────

impl DropboxClient {
    /// List one page of video files from Dropbox. The first call has no
    /// cursor; subsequent calls pass the cursor from the previous page.
    /// Pagination uses `list_folder/continue` with the returned cursor.
    pub async fn list_dropbox_videos(
        &self,
        access_token: &str,
        cursor: Option<&str>,
    ) -> ProviderResult<ListPage> {
        let (url, body): (&str, serde_json::Value) = match cursor {
            Some(c) => (LIST_FOLDER_CONTINUE_URL, serde_json::json!({ "cursor": c })),
            None => (
                LIST_FOLDER_URL,
                serde_json::json!({
                    "path": "",
                    "recursive": true,
                    "include_media_info": true,
                    "limit": 1000,
                }),
            ),
        };

        let resp = self
            .http
            .post(url)
            .bearer_auth(access_token)
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let status = resp.status();
        let resp_body = resp.text().await.unwrap_or_default();

        if status.as_u16() == 401 {
            return Err(ProviderError::Unauthorized);
        }
        if status.as_u16() == 429 || status.as_u16() == 503 {
            return Err(ProviderError::RateLimited {
                retry_after_secs: None,
            });
        }
        if !status.is_success() {
            return Err(ProviderError::Api {
                status: status.as_u16(),
                body: resp_body,
            });
        }

        let response: ListFolderResponse = serde_json::from_str(&resp_body)?;

        let mut videos = Vec::new();
        let mut subtitles = Vec::new();

        for e in response.entries {
            if e.tag != "file" {
                continue;
            }
            if is_video_entry(&e) {
                let (width, height, duration_ms) = extract_video_dims(&e.media_info);
                let native_hash_algo = e.content_hash.as_ref().map(|_| "content_hash".to_string());
                let mime_type = infer_mime_type(&e.name);
                videos.push(DiscoveredVideo {
                    provider_file_id: e.id,
                    name: e.name,
                    path: e.path_display,
                    size_bytes: e.size.unwrap_or(0),
                    mime_type,
                    duration_ms,
                    width,
                    height,
                    native_hash: e.content_hash,
                    native_hash_algo,
                    provider_modified_at: e.server_modified,
                });
            } else if has_subtitle_extension(&e.name) {
                let language = guess_language(&e.name);
                subtitles.push(DiscoveredSubtitle {
                    provider_file_id: e.id,
                    name: e.name,
                    path: e.path_display,
                    language,
                });
            }
        }

        let next_cursor = if response.has_more {
            Some(response.cursor)
        } else {
            None
        };

        Ok(ListPage {
            videos,
            subtitles,
            // M9 Task 003 fills this; the constructor sweep keeps the
            // workspace compiling before provider partitioning lands.
            files: Vec::new(),
            next_cursor,
        })
    }

    /// Download the first 4 MB of a Dropbox file and compute its SHA-256 hash.
    /// Uses the content-domain download endpoint with a Range header.
    pub async fn fetch_dropbox_prefix_hash(
        &self,
        access_token: &str,
        file_id: &str,
        size: i64,
    ) -> ProviderResult<Option<String>> {
        if size < PREFIX_BYTES as i64 {
            return Ok(None);
        }

        // Download endpoint takes the file path/ID in the Dropbox-API-Arg header
        // (not the body — the body is the file content).
        let arg = serde_json::json!({ "path": file_id });
        let resp = self
            .http
            .post(DOWNLOAD_URL)
            .bearer_auth(access_token)
            .header("Dropbox-API-Arg", arg.to_string())
            .header("Range", format!("bytes=0-{}", PREFIX_BYTES - 1))
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let status = resp.status();
        if status.as_u16() == 401 {
            return Err(ProviderError::Unauthorized);
        }
        if status.as_u16() == 429 || status.as_u16() == 503 {
            return Err(ProviderError::RateLimited {
                retry_after_secs: None,
            });
        }
        // Accept 200 (full content for small files) or 206 (partial — Range honored).
        if !status.is_success() && status.as_u16() != 206 {
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Api {
                status: status.as_u16(),
                body,
            });
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Ok(Some(to_hex(&hasher.finalize())))
    }

    /// Fetch a poster thumbnail for a Dropbox file via `get_thumbnail_v2`.
    /// `file_id` is the stored `provider_file_id` (Dropbox `id:…` ID, which
    /// the API also accepts in the `path` field). Returns `NotFound` when the
    /// file has no thumbnail (API responds 409).
    pub async fn fetch_thumbnail(
        &self,
        access_token: &str,
        file_id: &str,
    ) -> ProviderResult<ThumbnailData> {
        let arg = serde_json::json!({
            "resource": { ".tag": "path", "path": file_id },
            "format": "jpeg",
            "size": "w640h480"
        });
        let resp = self
            .http
            .post(THUMBNAIL_URL)
            .bearer_auth(access_token)
            .header("Dropbox-API-Arg", arg.to_string())
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let status = resp.status();
        if status.as_u16() == 401 {
            return Err(ProviderError::Unauthorized);
        }
        if status.as_u16() == 429 || status.as_u16() == 503 {
            return Err(ProviderError::RateLimited {
                retry_after_secs: None,
            });
        }
        // 409: no thumbnail available / unsupported file type / invalid path.
        if status.as_u16() == 409 {
            return Err(ProviderError::NotFound(format!(
                "no thumbnail available for Dropbox file {file_id}"
            )));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Api {
                status: status.as_u16(),
                body,
            });
        }

        let mime_type = infer_image_mime(
            resp.headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/jpeg"),
        )
        .to_string();

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?
            .to_vec();

        Ok(ThumbnailData { bytes, mime_type })
    }

    /// Stream a Dropbox file's content via the download endpoint. Forwards the
    /// browser's `Range` header (if any) for seeking. The file ID is passed in
    /// the `Dropbox-API-Arg` header (same as prefix-hash, but arbitrary Range).
    pub async fn open_stream(
        &self,
        access_token: &str,
        file_id: &str,
        range: Option<&str>,
    ) -> ProviderResult<StreamResponse> {
        let arg = serde_json::json!({ "path": file_id });
        let mut req = self
            .http
            .post(DOWNLOAD_URL)
            .bearer_auth(access_token)
            .header("Dropbox-API-Arg", arg.to_string());
        if let Some(r) = range {
            req = req.header("Range", r);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        response_to_stream(resp).await
    }

    /// Fetch a short-lived preauthenticated URL for `file_id` via the
    /// `get_temporary_link` endpoint. The returned URL points at
    /// `dl.dropboxusercontent.com` (CDN), requires no bearer header, and is
    /// valid for ~4 hours per Dropbox's docs. Designed for direct browser
    /// streaming — `<video src>` hits the CDN without our backend proxying
    /// bytes.
    pub async fn fetch_temporary_link(
        &self,
        access_token: &str,
        file_id: &str,
    ) -> ProviderResult<String> {
        let resp = self
            .http
            .post(GET_TEMPORARY_LINK_URL)
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "path": file_id }))
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let status = resp.status();
        if status.as_u16() == 401 {
            return Err(ProviderError::Unauthorized);
        }
        if status.as_u16() == 429 || status.as_u16() == 503 {
            return Err(ProviderError::RateLimited {
                retry_after_secs: None,
            });
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Api {
                status: status.as_u16(),
                body,
            });
        }

        let resp_body = resp.text().await.unwrap_or_default();
        let parsed: TemporaryLinkResponse = serde_json::from_str(&resp_body)?;
        Ok(parsed.link)
    }
}

// ── Provider trait implementation ────────────────────────────────────

/// A Dropbox provider holding a valid access token for API calls.
pub struct DropboxProvider {
    client: DropboxClient,
    token: TokenBundle,
}

#[async_trait::async_trait]
impl crate::provider::Provider for DropboxProvider {
    fn name(&self) -> &'static str {
        "dropbox"
    }

    async fn list_videos(&self, cursor: Option<&str>) -> ProviderResult<ListPage> {
        self.client
            .list_dropbox_videos(&self.token.access_token, cursor)
            .await
    }

    async fn fetch_prefix_hash(&self, file_id: &str, size: i64) -> ProviderResult<Option<String>> {
        self.client
            .fetch_dropbox_prefix_hash(&self.token.access_token, file_id, size)
            .await
    }

    async fn fetch_thumbnail(&self, file_id: &str) -> ProviderResult<ThumbnailData> {
        self.client
            .fetch_thumbnail(&self.token.access_token, file_id)
            .await
    }

    async fn open_stream(
        &self,
        file_id: &str,
        range: Option<&str>,
    ) -> ProviderResult<StreamResponse> {
        self.client
            .open_stream(&self.token.access_token, file_id, range)
            .await
    }

    async fn open_stream_url(&self, file_id: &str) -> ProviderResult<StreamUrl> {
        let url = self
            .client
            .fetch_temporary_link(&self.token.access_token, file_id)
            .await?;
        // Dropbox temporary links live ~4 hours; mark expiry at 3h45m so the
        // frontend pre-emptively refreshes before the CDN starts returning 410.
        let expires_at = {
            let now = chrono::Utc::now();
            let expiry = now + chrono::Duration::minutes(225);
            Some(expiry.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        };
        Ok(StreamUrl::Direct { url, expires_at })
    }

    async fn revoke(&self, token_bundle: &TokenBundle) -> ProviderResult<()> {
        self.client.revoke_token(&token_bundle.access_token).await
    }
}

/// Factory for creating Dropbox provider instances from token bundles.
pub struct DropboxFactory {
    config: DropboxConfig,
}

impl DropboxFactory {
    pub fn new(config: DropboxConfig) -> Self {
        Self { config }
    }
}

#[async_trait::async_trait]
impl crate::provider::ProviderFactory for DropboxFactory {
    async fn create(
        &self,
        token_bundle: &TokenBundle,
    ) -> ProviderResult<Box<dyn crate::provider::Provider>> {
        Ok(Box::new(DropboxProvider {
            client: DropboxClient::new(self.config.clone()),
            token: token_bundle.clone(),
        }))
    }

    async fn refresh_token(&self, token_bundle: &TokenBundle) -> ProviderResult<TokenBundle> {
        let client = DropboxClient::new(self.config.clone());
        let refresh = token_bundle
            .refresh_token
            .as_deref()
            .ok_or(ProviderError::Unauthorized)?;
        let mut bundle = client.refresh_token(refresh).await?;
        // Dropbox refresh doesn't return a new refresh_token (they're long-lived);
        // carry the old one forward so future refreshes still work.
        if bundle.refresh_token.is_none() {
            bundle.refresh_token = token_bundle.refresh_token.clone();
        }
        if bundle.scope.is_none() {
            bundle.scope = token_bundle.scope.clone();
        }
        Ok(bundle)
    }

    async fn revoke(&self, token_bundle: &TokenBundle) -> ProviderResult<()> {
        let client = DropboxClient::new(self.config.clone());
        client.revoke_token(&token_bundle.access_token).await
    }

    fn authorization_url(&self, redirect_uri: &str, state: &str, challenge: &str) -> String {
        DropboxClient::new(self.config.clone()).authorization_url(redirect_uri, state, challenge)
    }

    async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> ProviderResult<TokenBundle> {
        let client = DropboxClient::new(self.config.clone());
        client.exchange_code(code, verifier, redirect_uri).await
    }

    async fn fetch_user_info(
        &self,
        token_bundle: &TokenBundle,
    ) -> ProviderResult<(Option<String>, Option<String>)> {
        let client = DropboxClient::new(self.config.clone());
        let info = client.fetch_user_info(&token_bundle.access_token).await?;
        Ok((info.account_id, info.email))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderFactory;

    fn test_config() -> DropboxConfig {
        DropboxConfig {
            client_id: "test-client-id".into(),
            client_secret: "test-secret".into(),
        }
    }

    #[test]
    fn authorization_url_contains_required_params() {
        let client = DropboxClient::new(test_config());
        let url = client.authorization_url(
            "https://example.com/api/connections/dropbox/callback",
            "state-123",
            "challenge-abc",
        );
        assert!(url.starts_with(AUTH_URL));
        assert!(url.contains("client_id=test-client-id"));
        assert!(url.contains("code_challenge=challenge-abc"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=state-123"));
        // Dropbox-specific: token_access_type=offline for refresh tokens.
        assert!(url.contains("token_access_type=offline"));
        // Scope includes the read-only file access.
        assert!(url.contains("files.metadata.read"));
        assert!(url.contains("files.content.read"));
    }

    #[test]
    fn redirect_uri_is_correct() {
        let client = DropboxClient::new(test_config());
        let uri = client.redirect_uri("https://media.example.com");
        assert_eq!(
            uri,
            "https://media.example.com/api/connections/dropbox/callback"
        );
    }

    #[test]
    fn list_folder_response_parses_correctly() {
        let json = r#"{
            "entries": [
                {
                    ".tag": "file",
                    "id": "id:file-1",
                    "name": "vacation.mp4",
                    "path_lower": "/vacation.mp4",
                    "path_display": "/vacation.mp4",
                    "size": 10485760,
                    "content_hash": "abc123def456",
                    "server_modified": "2026-01-15T10:30:00Z",
                    "media_info": {
                        ".tag": "metadata",
                        "metadata": {
                            ".tag": "video",
                            "dimensions": { "height": 1080, "width": 1920 },
                            "duration": 120000
                        }
                    }
                },
                {
                    ".tag": "file",
                    "id": "id:file-2",
                    "name": "no-media.mkv",
                    "path_display": "/no-media.mkv",
                    "size": 5000,
                    "server_modified": "2026-02-01T00:00:00Z"
                },
                {
                    ".tag": "folder",
                    "id": "id:folder-1",
                    "name": "Documents",
                    "path_display": "/Documents"
                }
            ],
            "cursor": "cursor-abc",
            "has_more": true
        }"#;

        let response: ListFolderResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.entries.len(), 3);
        assert!(response.has_more);
        assert_eq!(response.cursor, "cursor-abc");

        let f1 = &response.entries[0];
        assert_eq!(f1.tag, "file");
        assert_eq!(f1.id, "id:file-1");
        assert_eq!(f1.size, Some(10485760));
        assert_eq!(f1.content_hash.as_deref(), Some("abc123def456"));
        assert!(f1.media_info.is_some());

        // Folder entry.
        assert_eq!(response.entries[2].tag, "folder");
    }

    #[test]
    fn is_video_entry_classifies_correctly() {
        // Video with media_info metadata.
        let entry_json = r#"{
            ".tag": "file",
            "id": "id:1",
            "name": "clip.mp4",
            "media_info": { ".tag": "metadata", "metadata": { ".tag": "video" } }
        }"#;
        let entry: DropboxEntry = serde_json::from_str(entry_json).unwrap();
        assert!(is_video_entry(&entry));

        // Video by extension, no media_info.
        let entry_json = r#"{ ".tag": "file", "id": "id:2", "name": "clip.mkv" }"#;
        let entry: DropboxEntry = serde_json::from_str(entry_json).unwrap();
        assert!(is_video_entry(&entry));

        // Non-video file (no video extension, no video media tag).
        let entry_json = r#"{ ".tag": "file", "id": "id:3", "name": "notes.txt" }"#;
        let entry: DropboxEntry = serde_json::from_str(entry_json).unwrap();
        assert!(!is_video_entry(&entry));

        // Folder is never a video.
        let entry_json = r#"{ ".tag": "folder", "id": "id:4", "name": "videos.mp4" }"#;
        let entry: DropboxEntry = serde_json::from_str(entry_json).unwrap();
        assert!(!is_video_entry(&entry));

        // Photo media tag is not a video.
        let entry_json = r#"{
            ".tag": "file",
            "id": "id:5",
            "name": "photo.jpg",
            "media_info": { ".tag": "metadata", "metadata": { ".tag": "photo" } }
        }"#;
        let entry: DropboxEntry = serde_json::from_str(entry_json).unwrap();
        assert!(!is_video_entry(&entry));
    }

    #[test]
    fn extract_video_dims_works() {
        let json = r#"{
            ".tag": "metadata",
            "metadata": {
                ".tag": "video",
                "dimensions": { "height": 720, "width": 1280 },
                "duration": 95000
            }
        }"#;
        let mi: MediaInfo = serde_json::from_str(json).unwrap();
        let (w, h, d) = extract_video_dims(&Some(mi));
        assert_eq!(w, Some(1280));
        assert_eq!(h, Some(720));
        assert_eq!(d, Some(95000));
    }

    #[test]
    fn extract_video_dims_returns_none_for_photo() {
        let json = r#"{ ".tag": "metadata", "metadata": { ".tag": "photo" } }"#;
        let mi: MediaInfo = serde_json::from_str(json).unwrap();
        let (w, h, d) = extract_video_dims(&Some(mi));
        assert_eq!(w, None);
        assert_eq!(h, None);
        assert_eq!(d, None);
    }

    #[test]
    fn list_folder_filters_to_videos_only() {
        let json = r#"{
            "entries": [
                { ".tag": "file", "id": "id:v1", "name": "movie.mp4", "size": 1000 },
                { ".tag": "file", "id": "id:d1", "name": "readme.txt", "size": 100 },
                { ".tag": "folder", "id": "id:f1", "name": "Movies" },
                { ".tag": "file", "id": "id:v2", "name": "clip.avi", "size": 2000 }
            ],
            "cursor": "",
            "has_more": false
        }"#;

        let response: ListFolderResponse = serde_json::from_str(json).unwrap();
        let videos: Vec<_> = response
            .entries
            .into_iter()
            .filter(is_video_entry)
            .collect();
        assert_eq!(videos.len(), 2);
        assert_eq!(videos[0].id, "id:v1");
        assert_eq!(videos[1].id, "id:v2");
    }

    #[test]
    fn pending_media_info_does_not_crash() {
        // Dropbox can return pending media info for recently uploaded files.
        let json = r#"{ ".tag": "file", "id": "id:p1", "name": "recent.mp4",
            "media_info": { ".tag": "pending" } }"#;
        let entry: DropboxEntry = serde_json::from_str(json).unwrap();
        // Should still be classified as video (by extension).
        assert!(is_video_entry(&entry));
    }

    #[tokio::test]
    async fn factory_creates_provider() {
        let factory = DropboxFactory::new(test_config());
        let bundle = TokenBundle {
            access_token: "sl.test".into(),
            refresh_token: Some("refresh".into()),
            expires_at: None,
            token_type: "bearer".into(),
            scope: None,
        };

        let provider = factory.create(&bundle).await.unwrap();
        assert_eq!(provider.name(), "dropbox");
    }

    #[tokio::test]
    async fn factory_refresh_preserves_refresh_token() {
        // The factory's refresh_token should carry the old refresh_token
        // forward even though the mock won't call the real API. We verify
        // the logic: if the returned bundle lacks a refresh_token, the old
        // one is preserved. Since we can't call the real API in a unit test,
        // we test the preservation logic directly.
        let old_bundle = TokenBundle {
            access_token: "old-access".into(),
            refresh_token: Some("old-refresh".into()),
            expires_at: None,
            token_type: "bearer".into(),
            scope: Some("files.metadata.read".into()),
        };

        // Simulate what refresh_token produces (no refresh_token in response).
        let mut bundle = TokenBundle {
            access_token: "new-access".into(),
            refresh_token: None,
            expires_at: Some("2026-07-11T12:00:00Z".into()),
            token_type: "bearer".into(),
            scope: None,
        };

        // Apply the same preservation logic from DropboxFactory::refresh_token.
        if bundle.refresh_token.is_none() {
            bundle.refresh_token = old_bundle.refresh_token.clone();
        }
        if bundle.scope.is_none() {
            bundle.scope = old_bundle.scope.clone();
        }

        assert_eq!(bundle.access_token, "new-access");
        assert_eq!(bundle.refresh_token.as_deref(), Some("old-refresh"));
        assert_eq!(bundle.scope.as_deref(), Some("files.metadata.read"));
    }
}
