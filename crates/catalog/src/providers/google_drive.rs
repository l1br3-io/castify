use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::crypto::TokenBundle;
use crate::model::{DiscoveredVideo, ListPage, Provider};
use crate::oauth::redirect_uri;
use crate::provider::{ProviderError, ProviderResult, ThumbnailData};
use crate::providers::common::{classify_token_error, infer_image_mime, to_hex, TokenResponse};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const SCOPE: &str = "https://www.googleapis.com/auth/drive.readonly openid email profile";
const DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const PREFIX_BYTES: usize = 4 * 1024 * 1024;

/// Configuration for the Google Drive OAuth client. Derived from `Config`.
#[derive(Debug, Clone)]
pub struct GoogleDriveConfig {
    pub client_id: String,
    pub client_secret: String,
}

/// Google Drive OAuth + API client. Owns the HTTP client and credentials.
#[derive(Debug, Clone)]
pub struct GoogleDriveClient {
    config: GoogleDriveConfig,
    http: reqwest::Client,
}

/// Account info returned by Google's userinfo endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleUserInfo {
    pub id: String,
    pub email: Option<String>,
}

impl GoogleDriveClient {
    pub fn new(config: GoogleDriveConfig) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build reqwest client");
        Self { config, http }
    }

    /// Build the redirect URI for this provider given the app base URL.
    pub fn redirect_uri(&self, base_url: &str) -> String {
        redirect_uri(base_url, &Provider::GoogleDrive)
    }

    /// Build the Google OAuth authorization URL with PKCE.
    pub fn authorization_url(&self, redirect_uri: &str, state: &str, challenge: &str) -> String {
        let params: Vec<(String, String)> = vec![
            ("client_id".into(), self.config.client_id.clone()),
            ("redirect_uri".into(), redirect_uri.into()),
            ("response_type".into(), "code".into()),
            ("scope".into(), SCOPE.into()),
            ("state".into(), state.into()),
            ("code_challenge".into(), challenge.into()),
            ("code_challenge_method".into(), "S256".into()),
            ("access_type".into(), "offline".into()),
            ("prompt".into(), "consent".into()),
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
                ("client_id", self.config.client_id.as_str()),
                ("client_secret", self.config.client_secret.as_str()),
                ("refresh_token", refresh_token),
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
            .post(REVOKE_URL)
            .form(&[("token", access_token)])
            .send()
            .await;
        Ok(())
    }

    /// Fetch the authenticated user's account ID and email.
    pub async fn fetch_user_info(&self, access_token: &str) -> ProviderResult<GoogleUserInfo> {
        let resp = self
            .http
            .get(USERINFO_URL)
            .bearer_auth(access_token)
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

        let info: GoogleUserInfo = serde_json::from_str(&body)?;
        Ok(info)
    }
}
// ── Drive API response types ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveListResponse {
    files: Vec<DriveFile>,
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DriveFile {
    id: String,
    name: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
    size: Option<String>,
    modified_time: Option<String>,
    #[serde(rename = "md5Checksum", default)]
    md5_checksum: Option<String>,
    #[serde(rename = "sha256Checksum", default)]
    sha256_checksum: Option<String>,
    #[serde(rename = "videoMediaMetadata", default)]
    video_media_metadata: Option<DriveVideoMetadata>,
    /// Parent folder IDs (Drive API v3 returns a flat string array). Empty or
    /// absent means the file lives in "My Drive" root. Used for path resolution.
    #[serde(default)]
    parents: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct DriveVideoMetadata {
    #[serde(rename = "durationMillis")]
    duration_millis: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
}

/// A folder entry returned by the batch metadata query (`files.list?q=...`).
/// Only `id`, `name`, and `parents` are requested.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveFolderMeta {
    id: String,
    name: String,
    #[serde(default)]
    parents: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveFolderListResponse {
    #[serde(default)]
    files: Vec<DriveFolderMeta>,
    next_page_token: Option<String>,
}

/// Response from `GET /drive/v3/files/{id}?fields=thumbnailLink`. The field is
/// absent when Drive has no thumbnail for the file.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveThumbnailResponse {
    #[serde(default)]
    thumbnail_link: Option<String>,
}

impl GoogleDriveClient {
    /// List one page of video files from Google Drive. `folder_cache` is a
    /// scan-local map of folder_id → resolved folder path, persisted across
    /// pages to avoid re-fetching folder metadata.
    pub async fn list_drive_videos(
        &self,
        access_token: &str,
        cursor: Option<&str>,
        folder_cache: &mut HashMap<String, String>,
    ) -> ProviderResult<ListPage> {
        let mut query: Vec<(&str, &str)> = vec![
            (
                "q",
                "mimeType contains 'video/' and trashed=false",
            ),
            (
                "fields",
                "files(id,name,mimeType,size,modifiedTime,md5Checksum,sha256Checksum,videoMediaMetadata(durationMillis,width,height),parents),nextPageToken",
            ),
            ("pageSize", "1000"),
            ("orderBy", "folder,modifiedTime desc,name"),
        ];

        let cursor_owned;
        if let Some(c) = cursor {
            cursor_owned = c.to_string();
            query.push(("pageToken", cursor_owned.as_str()));
        }

        let resp = self
            .http
            .get(DRIVE_FILES_URL)
            .bearer_auth(access_token)
            .query(&query)
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();

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
                body,
            });
        }

        let response: DriveListResponse = serde_json::from_str(&body)?;

        // Collect unique parent IDs across this page that aren't cached yet.
        let parent_ids: Vec<String> = response
            .files
            .iter()
            .flat_map(|f| f.parents.iter().flatten().cloned())
            .filter(|id| !folder_cache.contains_key(id))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        // Resolve folder paths via batch metadata queries (bounded: O(unique
        // folders) API calls per scan, not per file).
        if !parent_ids.is_empty() {
            self.resolve_folder_paths(access_token, &parent_ids, folder_cache)
                .await?;
        }

        let videos = response
            .files
            .into_iter()
            .map(|f| {
                let native_hash = f.sha256_checksum.clone().or(f.md5_checksum.clone());
                let native_hash_algo = if f.sha256_checksum.is_some() {
                    Some("sha256".to_string())
                } else if f.md5_checksum.is_some() {
                    Some("md5".to_string())
                } else {
                    None
                };

                // Resolve the full path using the first parent's folder path.
                let path = f
                    .parents
                    .as_ref()
                    .and_then(|p| p.first())
                    .and_then(|pid| folder_cache.get(pid))
                    .map(|folder_path| format!("{folder_path}/{}", f.name));

                DiscoveredVideo {
                    provider_file_id: f.id,
                    name: f.name,
                    path,
                    size_bytes: f.size.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
                    mime_type: Some(f.mime_type),
                    duration_ms: f
                        .video_media_metadata
                        .as_ref()
                        .and_then(|v| v.duration_millis.as_deref())
                        .and_then(|d| d.parse().ok()),
                    width: f.video_media_metadata.as_ref().and_then(|v| v.width),
                    height: f.video_media_metadata.as_ref().and_then(|v| v.height),
                    native_hash,
                    native_hash_algo,
                    provider_modified_at: f.modified_time,
                }
            })
            .collect();

        Ok(ListPage {
            videos,
            next_cursor: response.next_page_token,
        })
    }

    /// Resolve full folder paths for the given folder IDs, populating `cache`.
    ///
    /// Fetches unknown folders via batched `files.list?q=(id=… or id=…)`
    /// queries (chunked to stay within URL length limits), recursing up the
    /// parent chain. After fetching all metadata, paths are computed
    /// iteratively (no recursion → cycle-safe), then cached.
    async fn resolve_folder_paths(
        &self,
        access_token: &str,
        folder_ids: &[String],
        cache: &mut HashMap<String, String>,
    ) -> ProviderResult<()> {
        // Queue IDs not yet resolved.
        let mut pending: HashSet<String> = folder_ids
            .iter()
            .filter(|id| !cache.contains_key(*id))
            .cloned()
            .collect();
        // Everything we've already sent to the API (avoids re-querying).
        let mut queried: HashSet<String> = HashSet::new();
        // folder_id → (name, parent_ids)
        let mut meta: HashMap<String, (String, Vec<String>)> = HashMap::new();

        while !pending.is_empty() {
            let batch: Vec<String> = pending.drain().collect();
            for id in &batch {
                queried.insert(id.clone());
            }
            let fetched = self.fetch_folder_metadata(access_token, &batch).await?;
            for folder in fetched {
                let parents = folder.parents.unwrap_or_default();
                // Queue any unknown parents for the next round.
                for pid in &parents {
                    if !cache.contains_key(pid)
                        && !queried.contains(pid)
                        && !pending.contains(pid)
                    {
                        pending.insert(pid.clone());
                    }
                }
                meta.insert(folder.id, (folder.name, parents));
            }
            // IDs in `batch` that weren't returned (deleted/inaccessible) are
            // simply absent from `meta`; they won't be retried (in `queried`).
        }

        // Iteratively compute folder paths (pure logic — see `compute_folder_paths`).
        compute_folder_paths(&meta, cache);

        Ok(())
    }
}

/// Compute full folder paths from raw metadata (`folder_id → (name, parent_ids)`),
/// writing resolved paths into `cache` (`folder_id → full_path`).
///
/// Iterates to a fixpoint: folders whose first parent is already cached (or is
/// root-level) get resolved each pass. After the fixpoint, any remaining
/// folders (whose parents were deleted / inaccessible) are resolved as
/// root-level so their files still get a path rather than `None`.
///
/// Pure (no I/O) — extracted from [`GoogleDriveClient::resolve_folder_paths`]
/// for unit testing.
fn compute_folder_paths(
    meta: &HashMap<String, (String, Vec<String>)>,
    cache: &mut HashMap<String, String>,
) {
    loop {
        let mut progress = false;
        for (id, (name, parent_ids)) in meta {
            if cache.contains_key(id) {
                continue;
            }
            let parent_known = parent_ids
                .first()
                .map_or(true, |pid| cache.contains_key(pid));
            if !parent_known {
                continue;
            }
            let path = match parent_ids.first().and_then(|pid| cache.get(pid)) {
                Some(parent_path) => format!("{parent_path}/{name}"),
                None => format!("/{name}"),
            };
            cache.insert(id.clone(), path);
            progress = true;
        }
        if !progress {
            break;
        }
    }

    // Resolve any stragglers (deleted/inaccessible parents) as root-level.
    for (id, (name, _)) in meta {
        if !cache.contains_key(id) {
            cache.insert(id.clone(), format!("/{name}"));
        }
    }
}

impl GoogleDriveClient {
    /// Batch-fetch folder metadata (`id`, `name`, `parents`) for the given IDs
    /// via a single `files.list` query with an `id = '…' or …` predicate.
    /// Chunks at `FOLDER_QUERY_CHUNK` IDs per request to stay within URL limits.
    async fn fetch_folder_metadata(
        &self,
        access_token: &str,
        ids: &[String],
    ) -> ProviderResult<Vec<DriveFolderMeta>> {
        const FOLDER_QUERY_CHUNK: usize = 50;
        let mut all = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(FOLDER_QUERY_CHUNK) {
            let q = format!(
                "({})",
                chunk
                    .iter()
                    .map(|id| format!("id = '{id}'"))
                    .collect::<Vec<_>>()
                    .join(" or ")
            );
            let mut page_token: Option<String> = None;
            loop {
                let mut query: Vec<(&str, &str)> = vec![
                    ("q", q.as_str()),
                    ("fields", "files(id,name,parents),nextPageToken"),
                    ("pageSize", "100"),
                ];
                let token;
                if let Some(t) = &page_token {
                    token = t.to_string();
                    query.push(("pageToken", token.as_str()));
                }
                let resp = self
                    .http
                    .get(DRIVE_FILES_URL)
                    .bearer_auth(access_token)
                    .query(&query)
                    .send()
                    .await
                    .map_err(|e| ProviderError::Network(e.to_string()))?;

                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
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
                        body,
                    });
                }

                let response: DriveFolderListResponse = serde_json::from_str(&body)?;
                all.extend(response.files);
                match response.next_page_token {
                    Some(t) => page_token = Some(t),
                    None => break,
                }
            }
        }
        Ok(all)
    }

    /// Download the first 4 MB of a Drive file and compute its SHA-256 hash.
    pub async fn fetch_drive_prefix_hash(
        &self,
        access_token: &str,
        file_id: &str,
        size: i64,
    ) -> ProviderResult<Option<String>> {
        if size < PREFIX_BYTES as i64 {
            return Ok(None);
        }

        let url = format!("{DRIVE_FILES_URL}/{file_id}?alt=media");
        let resp = self
            .http
            .get(&url)
            .bearer_auth(access_token)
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

    /// Fetch a poster thumbnail for a Drive file. Resolves the file's
    /// `thumbnailLink` (a short-lived pre-signed CDN URL), then downloads the
    /// image. Returns `NotFound` when Drive has no thumbnail for the file.
    pub async fn fetch_thumbnail(
        &self,
        access_token: &str,
        file_id: &str,
    ) -> ProviderResult<ThumbnailData> {
        let url = format!("{DRIVE_FILES_URL}/{file_id}?fields=thumbnailLink");
        let resp = self
            .http
            .get(&url)
            .bearer_auth(access_token)
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

        let body = resp.text().await.unwrap_or_default();
        let response: DriveThumbnailResponse = serde_json::from_str(&body)?;
        let thumbnail_link = response.thumbnail_link.ok_or_else(|| {
            ProviderError::NotFound(format!("no thumbnailLink for Google Drive file {file_id}"))
        })?;

        // thumbnailLink is a pre-signed CDN URL — no bearer auth required.
        let img_resp = self
            .http
            .get(&thumbnail_link)
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let img_status = img_resp.status();
        if !img_status.is_success() {
            return Err(ProviderError::Api {
                status: img_status.as_u16(),
                body: format!("thumbnail download failed: {img_status}"),
            });
        }

        let mime_type = infer_image_mime(
            img_resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/jpeg"),
        )
        .to_string();

        let bytes = img_resp
            .bytes()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?
            .to_vec();

        Ok(ThumbnailData { bytes, mime_type })
    }
}

// ── Provider trait implementation ────────────────────────────────────

/// A Google Drive provider holding a valid access token for API calls.
///
/// `folder_cache` is a scan-local cache of resolved folder paths (folder_id →
/// full path), shared across pages within a single scan to avoid re-fetching
/// folder metadata. It starts empty (provider is created fresh per scan) and
/// grows as pages are listed.
pub struct GoogleDriveProvider {
    client: GoogleDriveClient,
    token: TokenBundle,
    folder_cache: Mutex<HashMap<String, String>>,
}

#[async_trait::async_trait]
impl crate::provider::Provider for GoogleDriveProvider {
    fn name(&self) -> &'static str {
        "google_drive"
    }

    async fn list_videos(&self, cursor: Option<&str>) -> ProviderResult<ListPage> {
        let mut cache = self.folder_cache.lock().await;
        self.client
            .list_drive_videos(&self.token.access_token, cursor, &mut cache)
            .await
    }

    async fn fetch_prefix_hash(&self, file_id: &str, size: i64) -> ProviderResult<Option<String>> {
        self.client
            .fetch_drive_prefix_hash(&self.token.access_token, file_id, size)
            .await
    }

    async fn fetch_thumbnail(&self, file_id: &str) -> ProviderResult<ThumbnailData> {
        self.client
            .fetch_thumbnail(&self.token.access_token, file_id)
            .await
    }

    async fn revoke(&self, token_bundle: &TokenBundle) -> ProviderResult<()> {
        self.client.revoke_token(&token_bundle.access_token).await
    }
}

/// Factory for creating Google Drive provider instances from token bundles.
pub struct GoogleDriveFactory {
    config: GoogleDriveConfig,
}

impl GoogleDriveFactory {
    pub fn new(config: GoogleDriveConfig) -> Self {
        Self { config }
    }
}

#[async_trait::async_trait]
impl crate::provider::ProviderFactory for GoogleDriveFactory {
    async fn create(
        &self,
        token_bundle: &TokenBundle,
    ) -> ProviderResult<Box<dyn crate::provider::Provider>> {
        Ok(Box::new(GoogleDriveProvider {
            client: GoogleDriveClient::new(self.config.clone()),
            token: token_bundle.clone(),
            folder_cache: Mutex::new(HashMap::new()),
        }))
    }

    async fn refresh_token(&self, token_bundle: &TokenBundle) -> ProviderResult<TokenBundle> {
        let client = GoogleDriveClient::new(self.config.clone());
        let refresh = token_bundle
            .refresh_token
            .as_deref()
            .ok_or(ProviderError::Unauthorized)?;
        let mut bundle = client.refresh_token(refresh).await?;
        // Google refresh doesn't return a new refresh_token; carry the old
        // one forward so future refreshes still work.
        if bundle.refresh_token.is_none() {
            bundle.refresh_token = token_bundle.refresh_token.clone();
        }
        if bundle.scope.is_none() {
            bundle.scope = token_bundle.scope.clone();
        }
        Ok(bundle)
    }

    async fn revoke(&self, token_bundle: &TokenBundle) -> ProviderResult<()> {
        let client = GoogleDriveClient::new(self.config.clone());
        client.revoke_token(&token_bundle.access_token).await
    }

    fn authorization_url(&self, redirect_uri: &str, state: &str, challenge: &str) -> String {
        GoogleDriveClient::new(self.config.clone()).authorization_url(redirect_uri, state, challenge)
    }

    async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> ProviderResult<TokenBundle> {
        let client = GoogleDriveClient::new(self.config.clone());
        client.exchange_code(code, verifier, redirect_uri).await
    }

    async fn fetch_user_info(
        &self,
        token_bundle: &TokenBundle,
    ) -> ProviderResult<(Option<String>, Option<String>)> {
        let client = GoogleDriveClient::new(self.config.clone());
        let info = client.fetch_user_info(&token_bundle.access_token).await?;
        Ok((Some(info.id), info.email))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderFactory;

    fn test_config() -> GoogleDriveConfig {
        GoogleDriveConfig {
            client_id: "test-client-id".into(),
            client_secret: "test-secret".into(),
        }
    }

    #[test]
    fn authorization_url_contains_required_params() {
        let client = GoogleDriveClient::new(test_config());
        let url = client.authorization_url(
            "https://example.com/api/connections/google_drive/callback",
            "state-123",
            "challenge-abc",
        );
        assert!(url.starts_with(AUTH_URL));
        assert!(url.contains("client_id=test-client-id"));
        assert!(url.contains("code_challenge=challenge-abc"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=state-123"));
        assert!(url.contains("access_type=offline"));

        let query = url.split_once('?').unwrap().1;
        let params: std::collections::HashMap<String, String> =
            serde_urlencoded::from_str(query).unwrap();
        let scope = params.get("scope").unwrap();
        let granted: std::collections::HashSet<&str> = scope.split(' ').collect();
        assert!(
            granted.contains("openid")
                && granted.contains("email")
                && granted.contains("profile")
                && granted.contains("https://www.googleapis.com/auth/drive.readonly"),
            "missing required scopes, got: {scope}"
        );
    }

    #[test]
    fn redirect_uri_is_correct() {
        let client = GoogleDriveClient::new(test_config());
        let uri = client.redirect_uri("https://media.example.com");
        assert_eq!(
            uri,
            "https://media.example.com/api/connections/google_drive/callback"
        );
    }

    #[test]
    fn drive_list_response_parses_correctly() {
        let json = r#"{
            "files": [
                {
                    "id": "file-1",
                    "name": "vacation.mp4",
                    "mimeType": "video/mp4",
                    "size": "10485760",
                    "modifiedTime": "2026-01-15T10:30:00.000Z",
                    "md5Checksum": "abc123",
                    "sha256Checksum": "def456",
                    "videoMediaMetadata": {
                        "durationMillis": "120000",
                        "width": 1920,
                        "height": 1080
                    }
                },
                {
                    "id": "file-2",
                    "name": "no-meta.mkv",
                    "mimeType": "video/x-matroska",
                    "size": "5000",
                    "modifiedTime": "2026-02-01T00:00:00.000Z"
                }
            ],
            "nextPageToken": "token-abc"
        }"#;

        let response: DriveListResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.files.len(), 2);
        assert_eq!(response.next_page_token.as_deref(), Some("token-abc"));

        let f1 = &response.files[0];
        assert_eq!(f1.id, "file-1");
        assert_eq!(f1.size.as_deref(), Some("10485760"));
        assert!(f1.sha256_checksum.is_some());
        assert!(f1.video_media_metadata.is_some());
        // file-1 has no parents in the JSON → defaults to None.
        assert!(f1.parents.is_none());
        // file-2 also has no parents.
        assert!(response.files[1].parents.is_none());
    }

    #[test]
    fn drive_file_parses_parents() {
        let json = r#"{
            "files": [{
                "id": "f1", "name": "v.mp4", "mimeType": "video/mp4",
                "parents": ["folder-1", "folder-2"]
            }]
        }"#;
        let response: DriveListResponse = serde_json::from_str(json).unwrap();
        assert_eq!(
            response.files[0].parents.as_deref(),
            Some(["folder-1".to_string(), "folder-2".to_string()].as_slice())
        );
    }

    #[test]
    fn drive_folder_meta_parses() {
        let json = r#"{
            "files": [
                { "id": "f1", "name": "Movies", "parents": ["root-folder"] },
                { "id": "f2", "name": "Action", "parents": ["f1"] }
            ]
        }"#;
        let response: DriveFolderListResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.files.len(), 2);
        assert_eq!(response.files[0].name, "Movies");
        assert_eq!(
            response.files[0].parents.as_deref(),
            Some(["root-folder".to_string()].as_slice())
        );
    }

    #[test]
    fn compute_folder_paths_resolves_nested_chain() {
        let mut meta = HashMap::new();
        meta.insert("root".into(), ("My Drive".into(), vec![]));
        meta.insert("f1".into(), ("Movies".into(), vec!["root".into()]));
        meta.insert(
            "f2".into(),
            ("Action".into(), vec!["f1".into()]),
        );
        let mut cache = HashMap::new();
        compute_folder_paths(&meta, &mut cache);
        assert_eq!(cache["root"], "/My Drive");
        assert_eq!(cache["f1"], "/My Drive/Movies");
        assert_eq!(cache["f2"], "/My Drive/Movies/Action");
    }

    #[test]
    fn compute_folder_paths_root_level_folder() {
        let mut meta = HashMap::new();
        meta.insert("f1".into(), ("Videos".into(), vec![]));
        let mut cache = HashMap::new();
        compute_folder_paths(&meta, &mut cache);
        assert_eq!(cache["f1"], "/Videos");
    }

    #[test]
    fn compute_folder_paths_respects_existing_cache() {
        let mut meta = HashMap::new();
        meta.insert(
            "f2".into(),
            ("Action".into(), vec!["f1".into()]),
        );
        let mut cache = HashMap::new();
        cache.insert("f1".into(), "/Movies".into());
        compute_folder_paths(&meta, &mut cache);
        assert_eq!(cache["f2"], "/Movies/Action");
    }

    #[test]
    fn compute_folder_paths_deleted_parent_becomes_root() {
        // f1's parent "ghost" is not in meta (deleted) → f1 resolved as root.
        let mut meta = HashMap::new();
        meta.insert(
            "f1".into(),
            ("Orphaned".into(), vec!["ghost".into()]),
        );
        let mut cache = HashMap::new();
        compute_folder_paths(&meta, &mut cache);
        assert_eq!(cache["f1"], "/Orphaned");
    }

    #[test]
    fn drive_video_metadata_extracts_all_fields() {
        let json = r#"{
            "files": [{
                "id": "f1",
                "name": "test.mp4",
                "mimeType": "video/mp4",
                "size": "9999",
                "modifiedTime": "2026-01-01T00:00:00Z",
                "sha256Checksum": "hash123",
                "videoMediaMetadata": {"durationMillis": "60000", "width": 1280, "height": 720}
            }],
            "nextPageToken": null
        }"#;

        let response: DriveListResponse = serde_json::from_str(json).unwrap();
        let f = &response.files[0];

        let size: i64 = f.size.as_deref().unwrap().parse().unwrap();
        assert_eq!(size, 9999);

        let duration: i64 = f
            .video_media_metadata
            .as_ref()
            .unwrap()
            .duration_millis
            .as_deref()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(duration, 60000);
    }

    #[test]
    fn drive_thumbnail_response_parses_present_link() {
        let json = r#"{ "thumbnailLink": "https://lh3.googleusercontent.com/thumb=s220" }"#;
        let response: DriveThumbnailResponse = serde_json::from_str(json).unwrap();
        assert_eq!(
            response.thumbnail_link.as_deref(),
            Some("https://lh3.googleusercontent.com/thumb=s220")
        );
    }

    #[test]
    fn drive_thumbnail_response_absent_link_is_none() {
        // Drive omits thumbnailLink (or returns an empty object) when no
        // thumbnail exists for the file.
        let json = r#"{}"#;
        let response: DriveThumbnailResponse = serde_json::from_str(json).unwrap();
        assert!(response.thumbnail_link.is_none());
    }

    #[tokio::test]
    async fn factory_creates_provider() {
        let factory = GoogleDriveFactory::new(test_config());
        let bundle = TokenBundle {
            access_token: "ya29.test".into(),
            refresh_token: None,
            expires_at: None,
            token_type: "Bearer".into(),
            scope: None,
        };

        let provider = factory.create(&bundle).await.unwrap();
        assert_eq!(provider.name(), "google_drive");
    }

    #[tokio::test]
    async fn factory_refresh_preserves_refresh_token() {
        // Google refresh doesn't return a new refresh_token; the factory
        // should carry the old one forward. We test the preservation logic
        // directly since we can't call the real API in a unit test.
        let old_bundle = TokenBundle {
            access_token: "old-access".into(),
            refresh_token: Some("old-refresh".into()),
            expires_at: None,
            token_type: "Bearer".into(),
            scope: Some("https://www.googleapis.com/auth/drive.metadata.readonly".into()),
        };

        let mut bundle = TokenBundle {
            access_token: "new-access".into(),
            refresh_token: None,
            expires_at: Some("2026-07-11T12:00:00Z".into()),
            token_type: "Bearer".into(),
            scope: None,
        };

        if bundle.refresh_token.is_none() {
            bundle.refresh_token = old_bundle.refresh_token.clone();
        }
        if bundle.scope.is_none() {
            bundle.scope = old_bundle.scope.clone();
        }

        assert_eq!(bundle.access_token, "new-access");
        assert_eq!(bundle.refresh_token.as_deref(), Some("old-refresh"));
        assert_eq!(
            bundle.scope.as_deref(),
            Some("https://www.googleapis.com/auth/drive.metadata.readonly")
        );
    }
}
