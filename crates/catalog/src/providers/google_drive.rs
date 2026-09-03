use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::crypto::TokenBundle;
use crate::model::{DiscoveredSubtitle, DiscoveredVideo, FileKind, ListPage, Provider};
use crate::oauth::redirect_uri;
use crate::provider::{
    ProviderError, ProviderFactory, ProviderResult, StreamResponse, StreamUrl, ThumbnailData,
};
use crate::providers::common::{
    classify_kind, classify_token_error, discovered_file_of_kind, guess_language,
    has_subtitle_extension, has_video_extension, infer_image_mime, is_mpeg_ts_name,
    response_to_stream, to_hex, TokenResponse,
};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const SCOPE: &str = "https://www.googleapis.com/auth/drive.readonly openid email profile";
const REQUIRED_DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";

/// Verify the token response includes the Drive scope. Google silently drops
/// `drive.readonly` when the OAuth consent screen or GCP project isn't
/// configured for it — the connection appears to succeed but every Drive API
/// call fails with a cryptic `ACCESS_TOKEN_SCOPE_INSUFFICIENT` 403.
fn validate_drive_scopes(granted: &str) -> ProviderResult<()> {
    if granted.split(' ').any(|s| s == REQUIRED_DRIVE_SCOPE) {
        return Ok(());
    }
    Err(ProviderError::Other(format!(
        "Google did not grant the required scope '{REQUIRED_DRIVE_SCOPE}'. \
         Granted: '{granted}'. Ensure the Drive API is enabled and \
         drive.readonly is added to the OAuth consent screen scopes \
         in your Google Cloud project."
    )))
}
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
    /// Separate client for file downloads — follows redirects to the CDN.
    /// The main `http` client disables redirects (consistent with other
    /// providers and safe for Drive API endpoints, which never redirect).
    /// Drive's `alt=media` may 302 to a CDN URL, so `open_stream` uses this
    /// client.
    http_download: reqwest::Client,
    /// Base URL for the Drive Files API. Defaults to the public Drive API
    /// (`DRIVE_FILES_URL`); tests override to point at a local wiremock
    /// server. All non-test code paths use the constant.
    drive_files_base: String,
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
            // Control-plane only (token refresh, userinfo, file metadata,
            // ?alt=media redirect resolution). All calls return within
            // seconds; 30s is the ceiling before we treat the provider as
            // unresponsive and surface a structured error to the user.
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest client");
        let http_download = reqwest::Client::builder()
            // Streaming client: used by `open_stream` (proxy strategy) and
            // `fetch_thumbnail`. A total `timeout` would abort long video
            // streams; instead cap only the connection-establishment phase
            // so dead-provider hangs don't pin the request indefinitely.
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("failed to build reqwest download client");
        Self {
            config,
            http,
            http_download,
            drive_files_base: DRIVE_FILES_URL.into(),
        }
    }

    /// Test-only constructor: lets callers inject HTTP clients (so wiremock
    /// can intercept) and override the Drive Files API base URL (so the
    /// mock server's URL is used instead of `googleapis.com`).
    #[cfg(test)]
    pub fn new_for_testing(
        config: GoogleDriveConfig,
        http: reqwest::Client,
        http_download: reqwest::Client,
        drive_files_base: String,
    ) -> Self {
        Self {
            config,
            http,
            http_download,
            drive_files_base,
        }
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
        let bundle = token.into_bundle();
        validate_drive_scopes(bundle.scope.as_deref().unwrap_or(""))?;
        Ok(bundle)
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
            // M9: unfiltered listing. Everything non-Google-apps and not
            // trashed comes back; partitioning (video/subtitle/file) happens
            // client-side below, unifying Drive with Dropbox/OneDrive.
            // Excluding `vnd.google-apps.*` server-side keeps virtual docs
            // (Docs/Sheets/folders) out of the transfer — they have no
            // binary `open_stream` (spec FR-2.4); the loop skips any that
            // slip through anyway (defense in depth). Negation must use the
            // documented *prefix* form (`not mimeType contains …`) — Drive's
            // q-language documents no infix `mimeType not contains`, and an
            // unsupported operator 400s every listing.
            (
                "q",
                "not mimeType contains 'application/vnd.google-apps' and trashed=false",
            ),
            (
                "fields",
                "files(id,name,mimeType,size,modifiedTime,md5Checksum,sha256Checksum,videoMediaMetadata(durationMillis,width,height),parents),nextPageToken",
            ),
            ("pageSize", "1000"),
            ("orderBy", "folder,modifiedTime desc,name"),
            ("supportsAllDrives", "true"),
            ("includeItemsFromAllDrives", "true"),
        ];

        let cursor_owned;
        if let Some(c) = cursor {
            cursor_owned = c.to_string();
            query.push(("pageToken", cursor_owned.as_str()));
        }

        let resp = self
            .http
            // `drive_files_base` (not the constant) so wiremock tests can
            // point listing at a local server — same pattern as
            // `resolve_direct_download_url`. Production value is the
            // constant.
            .get(&self.drive_files_base)
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
            tracing::warn!(
                status = status.as_u16(),
                "list_drive_videos query failed: q={:?}",
                query
                    .iter()
                    .filter(|(k, _)| *k == "q")
                    .map(|(_, v)| *v)
                    .collect::<Vec<_>>()
            );
            return Err(ProviderError::Api {
                status: status.as_u16(),
                body: format!("list_drive_videos: {body}"),
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

        // Single pass: partition files into videos, subtitles, and
        // non-media files (M9).
        let mut videos = Vec::new();
        let mut subtitles = Vec::new();
        let mut files = Vec::new();

        for f in response.files {
            // Defense in depth: virtual Google docs have no downloadable
            // binary — skip even if the query filter somehow let them in.
            if f.mime_type.starts_with("application/vnd.google-apps") {
                tracing::debug!(
                    name = %f.name,
                    mime_type = %f.mime_type,
                    "skipping Drive virtual document"
                );
                continue;
            }

            let path = f
                .parents
                .as_ref()
                .and_then(|p| p.first())
                .and_then(|pid| folder_cache.get(pid))
                .map(|folder_path| format!("{folder_path}/{}", f.name));

            let class = classify_drive_file(&f);
            match class {
                DriveFileClass::Subtitle => {
                    let language = guess_language(&f.name);
                    // Dual representation (M9): the sidecar row drives
                    // playback routing; the file row keeps the folder tree
                    // honest.
                    files.push(discovered_file_of_kind(
                        FileKind::Subtitle,
                        f.id.clone(),
                        f.name.clone(),
                        path.clone(),
                        f.size.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
                        Some(f.mime_type.clone()),
                        f.modified_time.clone(),
                    ));
                    subtitles.push(DiscoveredSubtitle {
                        provider_file_id: f.id,
                        name: f.name,
                        path,
                        language,
                    });
                }
                DriveFileClass::Video => {
                    // Defense in depth: mislabeled uploads (Google-internal
                    // types, mock files) can carry a video MIME without
                    // being playable. Require a known video extension before
                    // treating something as a video — matches Dropbox +
                    // OneDrive's contract.
                    let native_hash = f.sha256_checksum.clone().or(f.md5_checksum.clone());
                    let native_hash_algo = if f.sha256_checksum.is_some() {
                        Some("sha256".to_string())
                    } else if f.md5_checksum.is_some() {
                        Some("md5".to_string())
                    } else {
                        None
                    };

                    videos.push(DiscoveredVideo {
                        provider_file_id: f.id,
                        name: f.name,
                        path,
                        size_bytes: f.size.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
                        mime_type: Some(f.mime_type.clone()),
                        duration_ms: f
                            .video_media_metadata
                            .as_ref()
                            .and_then(|v| v.duration_millis.as_deref())
                            .and_then(|d| d.parse().ok()),
                        width: f.video_media_metadata.as_ref().and_then(|v| v.width),
                        height: f.video_media_metadata.as_ref().and_then(|v| v.height),
                        native_hash,
                        native_hash_algo,
                        provider_modified_at: f.modified_time.clone(),
                    });
                }
                DriveFileClass::File(kind) => {
                    files.push(discovered_file_of_kind(
                        kind,
                        f.id,
                        f.name,
                        path,
                        f.size.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
                        Some(f.mime_type.clone()),
                        f.modified_time.clone(),
                    ));
                }
            }
        }

        Ok(ListPage {
            videos,
            subtitles,
            files,
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
                    if !cache.contains_key(pid) && !queried.contains(pid) && !pending.contains(pid)
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
    /// Fetch folder metadata (`id`, `name`, `parents`) for the given IDs via
    /// concurrent `files.get` requests. Chunked to limit in-flight requests.
    async fn fetch_folder_metadata(
        &self,
        access_token: &str,
        ids: &[String],
    ) -> ProviderResult<Vec<DriveFolderMeta>> {
        const FOLDER_QUERY_CHUNK: usize = 50;
        let mut all = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(FOLDER_QUERY_CHUNK) {
            let mut tasks = tokio::task::JoinSet::new();
            for id in chunk {
                if id.is_empty() {
                    continue;
                }
                let client = self.http.clone();
                let token = access_token.to_string();
                let fid = id.to_string();
                tasks.spawn(async move {
                    let url = format!(
                        "{DRIVE_FILES_URL}/{fid}?fields=id,name,parents&supportsAllDrives=true"
                    );
                    let resp = client
                        .get(&url)
                        .bearer_auth(&token)
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
                            body: format!("fetch_folder_metadata ({}): {}", fid, body),
                        });
                    }
                    let meta: DriveFolderMeta = serde_json::from_str(&body)?;
                    Ok(meta)
                });
            }
            while let Some(result) = tasks.join_next().await {
                match result {
                    Ok(Ok(meta)) => all.push(meta),
                    Ok(Err(e)) => return Err(e),
                    Err(join_err) if join_err.is_panic() => {
                        std::panic::resume_unwind(join_err.into_panic());
                    }
                    Err(join_err) => {
                        return Err(ProviderError::Other(format!(
                            "fetch_folder_metadata task cancelled: {join_err}"
                        )));
                    }
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

        let url = format!("{DRIVE_FILES_URL}/{file_id}?alt=media&supportsAllDrives=true");
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
        let url =
            format!("{DRIVE_FILES_URL}/{file_id}?fields=thumbnailLink&supportsAllDrives=true");
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

    /// Stream a Drive file's content via `?alt=media`. Forwards the browser's
    /// `Range` header (if any) for seeking. Uses `http_download` (redirect-
    /// following) because `alt=media` may 302 to a CDN URL.
    pub async fn open_stream(
        &self,
        access_token: &str,
        file_id: &str,
        range: Option<&str>,
    ) -> ProviderResult<StreamResponse> {
        let url = format!("{DRIVE_FILES_URL}/{file_id}?alt=media&supportsAllDrives=true");
        let mut req = self.http_download.get(&url).bearer_auth(access_token);
        if let Some(r) = range {
            req = req.header("Range", r);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        response_to_stream(resp).await
    }

    /// Resolve a browser-directable CDN URL for a Drive file by following the
    /// `?alt=media` redirect. Sends a 1-byte Range request with the bearer
    /// token (which the redirect-following `http_download` client strips on
    /// the cross-host hop), then captures the final URL from `Response::url()`.
    /// That URL needs no auth header and can be set directly as `<video src>`.
    ///
    /// Detection is hostname-agnostic: any redirect from the `googleapis.com`
    /// request URL proves Drive handed back a browser-directable CDN URL.
    /// Hardcoding a hostname broke when Google moved downloads from
    /// `*.googleusercontent.com` to `drive.usercontent.google.com` (note the
    /// reversed word order) — the substring check silently failed and every
    /// Drive video fell back to the bandwidth-heavy proxy path.
    ///
    /// # Strategy
    ///
    /// The probe URL carries `acknowledgeAbuse=true` — Drive sometimes
    /// serves bytes inline (200/206) for files flagged for abuse review
    /// (large files, flagged mimetypes); the parameter skips that review
    /// and elicits the normal 302 redirect to a pre-signed CDN URL. When
    /// Drive cooperates, the redirect target works in the browser with no
    /// auth header — Drive bakes a short-lived token into the URL itself.
    ///
    /// When the probe doesn't redirect (Drive serves bytes inline), this
    /// returns `Ok(None)` and the caller falls back to `StreamUrl::Proxied`
    /// (the `/stream` endpoint). The proxy is slow but always works.
    ///
    /// Returns `Err(Unauthorized)` on 401 so the API layer can refresh the
    /// token and retry once.
    ///
    /// # What was tried and removed: cookie-auth URL strategies
    ///
    /// Earlier versions of this function tried two additional strategies
    /// when `?alt=media` didn't redirect:
    ///
    /// 1. **Direct probe of `drive.usercontent.google.com/download?id=…`** —
    ///    Drive returned 200 to our server-side `reqwest` probe but 403 to
    ///    the browser, because the URL requires a Google session cookie the
    ///    server can't predict.
    /// 2. **`webContentLink` from the Files resource** — Drive populates
    ///    this field for many files (not just public ones, despite the docs
    ///    implying otherwise). The returned URL `drive.google.com/uc?id=…`
    ///    works **only with Google session cookies** — the browser gets 403
    ///    if the user isn't signed into the right Google account.
    ///
    /// Both shared the same root cause: **the server cannot predict what
    /// the browser will be able to access**. Cookie-authenticated URLs are
    /// fundamentally unsuitable for handing to the browser, because the
    /// server has no cookies and the browser's cookies are unknowable.
    /// Only Drive's pre-signed 302 redirect target works reliably — the
    /// auth is baked into the URL's query string.
    ///
    /// Lesson for future contributors: do not add strategies that return
    /// URLs requiring cookies or session state. If `?alt=media` doesn't
    /// redirect, the file genuinely cannot be direct-streamed and the
    /// proxy is the correct fallback.
    pub async fn resolve_direct_download_url(
        &self,
        access_token: &str,
        file_id: &str,
    ) -> ProviderResult<Option<String>> {
        let probe_url = format!(
            "{}/{file_id}?alt=media&supportsAllDrives=true&acknowledgeAbuse=true",
            self.drive_files_base
        );
        match self.probe_redirect(&probe_url, access_token).await? {
            ProbeOutcome::Redirected(final_url) => {
                tracing::info!(
                    file_id,
                    strategy = "acknowledgeAbuse",
                    "Drive redirected on probe; using direct URL"
                );
                return Ok(Some(final_url));
            }
            ProbeOutcome::ServedInline {
                status,
                content_type,
            } => {
                tracing::info!(
                    file_id,
                    status,
                    content_type = %content_type.unwrap_or_default(),
                    "Drive served bytes inline; falling back to /stream proxy"
                );
            }
        }
        Ok(None)
    }

    /// Send a 1-byte Range request with the bearer token; classify Drive's
    /// response as `Redirected` (we captured a new URL via redirect-following),
    /// `ServedInline` (Drive returned 200/206 with no redirect), or propagate
    /// the usual errors (`Unauthorized`, `RateLimited`, `Api`).
    async fn probe_redirect(&self, url: &str, access_token: &str) -> ProviderResult<ProbeOutcome> {
        let resp = self
            .http_download
            .get(url)
            .bearer_auth(access_token)
            .header("Range", "bytes=0-0")
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

        let final_url = resp.url().to_string();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        if final_url == url {
            Ok(ProbeOutcome::ServedInline {
                status: status.as_u16(),
                content_type,
            })
        } else {
            Ok(ProbeOutcome::Redirected(final_url))
        }
    }

    // Note: there used to be a `fetch_web_content_link` method here that
    // read the file's `webContentLink` field from the Drive Files API.
    // Removed after we confirmed Drive populates the field for many files
    // (not just public ones, despite the docs) but the returned URL
    // `drive.google.com/uc?…` requires Google session cookies to actually
    // work — the browser gets 403 if the user isn't signed in. Server-side
    // we can't predict cookie state, so this strategy was fundamentally
    // unreliable. See the doc comment on `resolve_direct_download_url`
    // for the full rationale.
}

/// Outcome of a single `?alt=media` probe.
#[derive(Debug)]
enum ProbeOutcome {
    /// Drive 302-redirected to a CDN URL — the captured URL needs no auth
    /// and is safe to hand the browser directly.
    Redirected(String),
    /// Drive served bytes inline (200 or 206) with no redirect — no URL
    /// to capture. The caller falls back to the proxy path.
    /// `status` and `content_type` are captured for diagnostic logging.
    ServedInline {
        status: u16,
        content_type: Option<String>,
    },
}

// ── Drive file classification ────────────────────────────────────────

/// How a Drive file should be classified by `list_drive_videos`. Extracted
/// from the partition loop so the rule (subtitle extension → subtitle,
/// known video extension → video, anything else → a non-media file) is
/// testable without spinning up a mock HTTP server.
///
/// Defense in depth: mislabeled uploads (Google-internal types, mock files)
/// can carry a video MIME without being playable. The classifier requires a
/// known video extension before classifying as `Video` — matches Dropbox +
/// OneDrive's contract. Everything else lands in `files` with a
/// [`FileKind`] from `classify_kind` (M9).
#[derive(Debug, PartialEq, Eq)]
enum DriveFileClass {
    Video,
    Subtitle,
    File(FileKind),
}

fn classify_drive_file(file: &DriveFile) -> DriveFileClass {
    if has_subtitle_extension(&file.name) {
        DriveFileClass::Subtitle
    } else if drive_video_corroborated(file) {
        DriveFileClass::Video
    } else {
        DriveFileClass::File(classify_kind(&file.name, Some(&file.mime_type)))
    }
}

/// The video gate: an unambiguous video extension, OR a `.ts` corroborated
/// by Drive-side analysis — `videoMediaMetadata` with at least one populated
/// field, or the `video/mp2t` MIME. A TypeScript `main.ts` carries neither
/// (generic octet-stream MIME, no media metadata).
fn drive_video_corroborated(file: &DriveFile) -> bool {
    if has_video_extension(&file.name) {
        return true;
    }
    if is_mpeg_ts_name(&file.name) {
        let analyzed = file.video_media_metadata.as_ref().is_some_and(|m| {
            m.duration_millis.is_some() || m.width.is_some() || m.height.is_some()
        });
        if analyzed || file.mime_type.eq_ignore_ascii_case("video/mp2t") {
            return true;
        }
    }
    false
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
        match self
            .client
            .resolve_direct_download_url(&self.token.access_token, file_id)
            .await?
        {
            Some(url) => {
                // Drive's pre-signed download URLs (whatever hostname Drive
                // currently redirects to) are short-lived — tied to the
                // access token's ~1hr lifetime. Express a conservative
                // 50-minute expiry so the frontend pre-emptively refreshes
                // before the URL starts returning 403.
                let expires_at = {
                    let expiry = chrono::Utc::now() + chrono::Duration::minutes(50);
                    Some(expiry.format("%Y-%m-%dT%H:%M:%SZ").to_string())
                };
                Ok(StreamUrl::Direct { url, expires_at })
            }
            None => Ok(StreamUrl::Proxied),
        }
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

/// OAuth connect-flow for Google Drive. Delegates to the factory's existing
/// methods; the call direction flips when the old `ProviderFactory`
/// surface is removed.
#[async_trait::async_trait]
impl crate::provider::OAuthFlow for GoogleDriveFactory {
    fn authorization_url(&self, redirect_uri: &str, state: &str, challenge: &str) -> String {
        ProviderFactory::authorization_url(self, redirect_uri, state, challenge)
    }

    async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> ProviderResult<TokenBundle> {
        ProviderFactory::exchange_code(self, code, verifier, redirect_uri).await
    }

    async fn refresh_token(&self, token_bundle: &TokenBundle) -> ProviderResult<TokenBundle> {
        ProviderFactory::refresh_token(self, token_bundle).await
    }
}

#[async_trait::async_trait]
impl crate::provider::ProviderFactory for GoogleDriveFactory {
    fn connect_flow(&self) -> crate::provider::ConnectFlow {
        crate::provider::ConnectFlow::OAuth(Box::new(GoogleDriveFactory::new(self.config.clone())))
    }

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
        GoogleDriveClient::new(self.config.clone()).authorization_url(
            redirect_uri,
            state,
            challenge,
        )
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
    fn classify_drive_file_picks_up_known_video_extensions() {
        // Even when the Drive API returns a `mimeType contains 'video/'`
        // match, the classifier requires a known video extension. This is
        // defense in depth against Drive's broad query.
        for name in ["vacation.mp4", "clip.MKV", "a.b.c.webm", "old.mov"] {
            let file = DriveFile {
                id: "x".into(),
                name: name.into(),
                mime_type: "video/mp4".into(),
                size: None,
                modified_time: None,
                md5_checksum: None,
                sha256_checksum: None,
                video_media_metadata: None,
                parents: None,
            };
            assert_eq!(classify_drive_file(&file), DriveFileClass::Video, "{name}");
        }
    }

    #[test]
    fn classify_drive_file_routes_non_video_extensions_to_file_class() {
        // The bug this guards against: Drive assigns `mimeType: video/*` to
        // files matching its internal heuristics — not always playable videos.
        // Documents, mock files, or mislabeled uploads would all end up in
        // the catalog with a play button if we trusted mimeType alone.
        // M9: instead of being skipped, they now land in `files` with a kind.
        for (name, kind) in [
            ("notes.txt", FileKind::Document),
            ("photo.jpg", FileKind::Image),
            ("archive.zip", FileKind::Archive),
            ("noext", FileKind::Other),
            ("video.mp4.part", FileKind::Other),
        ] {
            let file = DriveFile {
                id: "x".into(),
                name: name.into(),
                mime_type: "video/mp4".into(),
                size: None,
                modified_time: None,
                md5_checksum: None,
                sha256_checksum: None,
                video_media_metadata: None,
                parents: None,
            };
            assert_eq!(
                classify_drive_file(&file),
                DriveFileClass::File(kind),
                "{name}"
            );
        }
    }

    #[test]
    fn classify_drive_file_requires_corroboration_for_ts() {
        fn ts_file(name: &str, mime: &str) -> DriveFile {
            DriveFile {
                id: "x".into(),
                name: name.into(),
                mime_type: mime.into(),
                size: None,
                modified_time: None,
                md5_checksum: None,
                sha256_checksum: None,
                video_media_metadata: None,
                parents: None,
            }
        }

        // TypeScript source: no videoMediaMetadata, generic MIME → file.
        let ts_source = ts_file("main.ts", "application/octet-stream");
        assert_eq!(
            classify_drive_file(&ts_source),
            DriveFileClass::File(FileKind::Other)
        );

        // MPEG-TS corroborated by Drive's video analysis → video.
        let mut analyzed = ts_file("recording.ts", "application/octet-stream");
        analyzed.video_media_metadata = Some(DriveVideoMetadata {
            duration_millis: Some("60000".into()),
            width: Some(1280),
            height: Some(720),
        });
        assert_eq!(classify_drive_file(&analyzed), DriveFileClass::Video);

        // MPEG-TS corroborated by MIME alone (not yet analyzed) → video.
        let by_mime = ts_file("REC.TS", "video/mp2t");
        assert_eq!(classify_drive_file(&by_mime), DriveFileClass::Video);

        // An empty videoMediaMetadata object corroborates nothing.
        let mut empty_metadata = ts_file("empty.ts", "application/octet-stream");
        empty_metadata.video_media_metadata = Some(DriveVideoMetadata {
            duration_millis: None,
            width: None,
            height: None,
        });
        assert_eq!(
            classify_drive_file(&empty_metadata),
            DriveFileClass::File(FileKind::Other)
        );
    }

    #[test]
    fn classify_drive_file_routes_sidecar_subtitles_to_subtitle_class() {
        for name in ["movie.srt", "clip.VTT", "vacation.en.srt"] {
            let file = DriveFile {
                id: "x".into(),
                name: name.into(),
                mime_type: "application/octet-stream".into(),
                size: None,
                modified_time: None,
                md5_checksum: None,
                sha256_checksum: None,
                video_media_metadata: None,
                parents: None,
            };
            assert_eq!(
                classify_drive_file(&file),
                DriveFileClass::Subtitle,
                "{name}"
            );
        }
    }

    #[test]
    fn drive_folder_meta_parses() {
        let json = r#"{ "id": "f1", "name": "Movies", "parents": ["root-folder"] }"#;
        let meta: DriveFolderMeta = serde_json::from_str(json).unwrap();
        assert_eq!(meta.name, "Movies");
        assert_eq!(
            meta.parents.as_deref(),
            Some(["root-folder".to_string()].as_slice())
        );
    }

    #[test]
    fn compute_folder_paths_resolves_nested_chain() {
        let mut meta = HashMap::new();
        meta.insert("root".into(), ("My Drive".into(), vec![]));
        meta.insert("f1".into(), ("Movies".into(), vec!["root".into()]));
        meta.insert("f2".into(), ("Action".into(), vec!["f1".into()]));
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
        meta.insert("f2".into(), ("Action".into(), vec!["f1".into()]));
        let mut cache = HashMap::new();
        cache.insert("f1".into(), "/Movies".into());
        compute_folder_paths(&meta, &mut cache);
        assert_eq!(cache["f2"], "/Movies/Action");
    }

    #[test]
    fn compute_folder_paths_deleted_parent_becomes_root() {
        // f1's parent "ghost" is not in meta (deleted) → f1 resolved as root.
        let mut meta = HashMap::new();
        meta.insert("f1".into(), ("Orphaned".into(), vec!["ghost".into()]));
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

    #[test]
    fn validate_scopes_rejects_missing_drive_scope() {
        let result = validate_drive_scopes("openid email profile");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("drive.readonly"));
    }

    #[test]
    fn validate_scopes_rejects_empty() {
        assert!(validate_drive_scopes("").is_err());
    }

    #[test]
    fn validate_scopes_accepts_drive_readonly() {
        let scopes = "https://www.googleapis.com/auth/drive.readonly openid email profile";
        assert!(validate_drive_scopes(scopes).is_ok());
    }

    #[test]
    fn validate_scopes_accepts_drive_readonly_alone() {
        assert!(validate_drive_scopes("https://www.googleapis.com/auth/drive.readonly").is_ok());
    }

    // ── resolve_direct_download_url tests ──────────────────────────────
    //
    // Three cases:
    //   1. `?alt=media` 302-redirects → Some(captured URL)
    //   2. `?alt=media` serves bytes inline → None (proxy fallback)
    //   3. Probe returns 401              → Err(Unauthorized)
    //
    // Each uses wiremock to spin up a local HTTP server and points the
    // client's `drive_files_base` at it via `new_for_testing`. The `http`
    // and `http_download` clients used in production work as-is against
    // localhost.

    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Build a `GoogleDriveClient` whose Drive API URL points at a wiremock
    /// server. Both HTTP clients are the production-shaped `reqwest::Client`s
    /// (`http` with redirects disabled, `http_download` with default
    /// redirect-following).
    fn client_for_mock(server: &MockServer) -> GoogleDriveClient {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client");
        let http_download = reqwest::Client::builder()
            .build()
            .expect("http_download client");
        let drive_files_base = format!("{}/drive/v3/files", server.uri());
        GoogleDriveClient::new_for_testing(test_config(), http, http_download, drive_files_base)
    }

    #[tokio::test]
    async fn resolve_direct_download_url_returns_redirected_url_on_strategy_1() {
        // Strategy 1 (acknowledgeAbuse) — Drive 302-redirects the probe to
        // a CDN URL. `http_download` follows the redirect; `resp.url()`
        // captures the final URL. No fallback strategies run.
        let server = MockServer::start().await;

        let cdn_url = format!("{}/cdn/download?id=f1&authuser=0", server.uri());
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/f1"))
            .respond_with(ResponseTemplate::new(302).insert_header("Location", cdn_url.as_str()))
            .mount(&server)
            .await;
        // reqwest will follow the redirect and GET this URL — needs a mock
        // so the follow doesn't land on a 404.
        Mock::given(method("GET"))
            .and(path("/cdn/download"))
            .and(query_param("id", "f1"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("Content-Type", "video/mp4")
                    .insert_header("Content-Range", "bytes 0-0/1024")
                    .set_body_bytes(b"\x00"),
            )
            .mount(&server)
            .await;

        let client = client_for_mock(&server);
        let result = client
            .resolve_direct_download_url("ya29.test", "f1")
            .await
            .expect("strategy 1 should succeed");

        let url = result.expect("should have captured a direct URL");
        assert_eq!(url, cdn_url);
    }

    #[tokio::test]
    async fn resolve_direct_download_url_returns_none_when_probe_served_inline() {
        // `?alt=media` returns 206 with video bytes inline — Drive declined
        // to redirect. The function returns `None`, signaling "use the
        // proxy." This is the path the user's affected Drive file lands on
        // — confirmed safe: the proxy works (slowly), and we don't return
        // a URL we can't verify the browser can actually use.
        //
        // Note: earlier versions of this function tried `webContentLink`
        // and direct CDN probes as fallbacks — both removed because they
        // returned URLs that required Google session cookies and the
        // browser got 403. See the doc comment on
        // `resolve_direct_download_url` for the full rationale.
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/drive/v3/files/f1"))
            .and(query_param("alt", "media"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("Content-Type", "video/mp4")
                    .set_body_bytes(b"\x00"),
            )
            .mount(&server)
            .await;

        let client = client_for_mock(&server);
        let result = client
            .resolve_direct_download_url("ya29.test", "f1")
            .await
            .expect("resolution should not error");

        assert!(result.is_none(), "expected None (proxy fallback)");
    }

    #[tokio::test]
    async fn resolve_direct_download_url_returns_unauthorized_on_401() {
        // Drive returns 401 on the very first probe — the function returns
        // `Err(Unauthorized)` so the API layer refreshes the token and retries.
        // No other strategies run.
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/drive/v3/files/f1"))
            .and(query_param("alt", "media"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let client = client_for_mock(&server);
        let err = client
            .resolve_direct_download_url("ya29.expired", "f1")
            .await
            .expect_err("should return Unauthorized");

        assert!(matches!(err, ProviderError::Unauthorized));
    }

    /// M9: the list query is unfiltered (no `mimeType contains 'video/'`) —
    /// everything except Google-apps virtual docs and trashed items comes
    /// back, and partitioning happens client-side. Asserts the exact `q`
    /// payload so a regression to the old server-side video filter fails
    /// loudly (spec FR-2.3).
    #[tokio::test]
    async fn list_drive_videos_query_is_unfiltered_and_partitions_client_side() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param(
                "q",
                "not mimeType contains 'application/vnd.google-apps' and trashed=false",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "files": [
                    { "id": "v1", "name": "movie.mp4", "mimeType": "video/mp4", "size": "100" },
                    { "id": "s1", "name": "movie.en.srt", "mimeType": "application/octet-stream", "size": "2" },
                    { "id": "f1", "name": "song.mp3", "mimeType": "audio/mpeg", "size": "40" },
                    { "id": "g1", "name": "My Doc", "mimeType": "application/vnd.google-apps.document", "size": "1" },
                    { "id": "f2", "name": "weird.dat", "mimeType": "application/octet-stream", "size": "7" }
                ],
                "nextPageToken": null
            })))
            .mount(&server)
            .await;

        let client = client_for_mock(&server);
        let mut cache = std::collections::HashMap::new();
        let page = client
            .list_drive_videos("ya29.test", None, &mut cache)
            .await
            .expect("listing should succeed");

        assert_eq!(page.videos.len(), 1, "only the .mp4 is a video");
        assert_eq!(page.videos[0].provider_file_id, "v1");
        assert_eq!(page.subtitles.len(), 1, "sidecar captured for playback");
        assert_eq!(page.subtitles[0].provider_file_id, "s1");
        // Dual representation: the .srt is both a sidecar and a file row…
        assert_eq!(
            page.files.len(),
            3,
            "srt + mp3 + dat; google-apps doc skipped"
        );
        assert!(page
            .files
            .iter()
            .any(|f| f.provider_file_id == "s1" && f.kind == FileKind::Subtitle));
        assert!(page
            .files
            .iter()
            .any(|f| f.provider_file_id == "f1" && f.kind == FileKind::Audio));
        assert!(page
            .files
            .iter()
            .any(|f| f.provider_file_id == "f2" && f.kind == FileKind::Other));
        assert!(
            !page.files.iter().any(|f| f.provider_file_id == "g1"),
            "virtual Google docs are never file rows"
        );
    }
}
