use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::crypto::{Credential, TokenBundle};
use crate::model::{DiscoveredSubtitle, DiscoveredVideo, FileKind, ListPage, Provider};
use crate::oauth::redirect_uri;
use crate::provider::{ProviderError, ProviderResult, StreamResponse, StreamUrl, ThumbnailData};
use crate::providers::common::{
    classify_kind, classify_token_error, discovered_file_of_kind, guess_language,
    has_subtitle_extension, has_video_extension, infer_image_mime, infer_mime_type,
    response_to_stream, to_hex, TokenResponse,
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

/// GOTCHA: Dropbox caps one upload-session request at 150 MB. Chunks
/// of 32 MiB stay well under it while keeping round-trips low for
/// personal-library files; the bound is enforced where the buffer fills
/// (`UploadChunker::next`), so memory stays one chunk regardless of
/// file size.
const UPLOAD_CHUNK_SIZE: usize = 32 * 1024 * 1024;

/// Dropbox OAuth + API client. Owns the HTTP client and credentials.
#[derive(Debug, Clone)]
pub struct DropboxClient {
    config: DropboxConfig,
    http: reqwest::Client,
    /// Upload client: session appends carry up to [`UPLOAD_CHUNK_SIZE`]
    /// bytes over a home uplink — a total-request timeout could abort
    /// legitimate transfers, so this client caps only connection
    /// establishment.
    http_upload: reqwest::Client,
    /// Content-domain base. Defaults to Dropbox's; tests override to a
    /// local wiremock server (the google_drive `drive_files_base`
    /// pattern).
    content_base: String,
    /// Upload chunk size in bytes (the wiremock tests shrink it so a
    /// small fixture spans several chunks).
    upload_chunk_size: usize,
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
        let http_upload = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("failed to build reqwest upload client");
        Self {
            config,
            http,
            http_upload,
            content_base: "https://content.dropboxapi.com".into(),
            upload_chunk_size: UPLOAD_CHUNK_SIZE,
        }
    }

    /// Test-only constructor: overrides the content-domain base (so
    /// wiremock intercepts the session endpoints) and the chunk size
    /// (so small fixtures span several chunks).
    #[cfg(test)]
    pub(crate) fn new_for_testing(
        config: DropboxConfig,
        content_base: String,
        chunk: usize,
    ) -> Self {
        let mut client = Self::new(config);
        client.content_base = content_base;
        client.upload_chunk_size = chunk;
        client
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

/// Partition a `list_folder` page into (videos, sidecar subtitles,
/// non-media files). Extracted from the listing method so the classification
/// rules are testable without a mock HTTP server (same pattern as Drive's
/// `classify_drive_file`).
///
/// M9: files that aren't videos or sidecar subtitles are no longer skipped —
/// they become `DiscoveredFile` rows (metadata-only) so the folder tree
/// mirrors the user's cloud. Sidecar subtitles are dual-represented:
/// `DiscoveredSubtitle` drives playback routing, the file row keeps the
/// tree honest.
fn partition_dropbox_entries(
    entries: Vec<DropboxEntry>,
) -> (
    Vec<DiscoveredVideo>,
    Vec<DiscoveredSubtitle>,
    Vec<crate::model::DiscoveredFile>,
) {
    let mut videos = Vec::new();
    let mut subtitles = Vec::new();
    let mut files = Vec::new();

    for e in entries {
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
            // Dropbox's list_folder carries no MIME type; the extension
            // tables do the classifying here.
            files.push(discovered_file_of_kind(
                FileKind::Subtitle,
                e.id.clone(),
                e.name.clone(),
                e.path_display.clone(),
                e.size.unwrap_or(0),
                None,
                e.server_modified.clone(),
            ));
            subtitles.push(DiscoveredSubtitle {
                provider_file_id: e.id,
                name: e.name,
                path: e.path_display,
                language,
            });
        } else {
            files.push(discovered_file_of_kind(
                classify_kind(&e.name, None),
                e.id,
                e.name,
                e.path_display,
                e.size.unwrap_or(0),
                None,
                e.server_modified,
            ));
        }
    }

    (videos, subtitles, files)
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

        let (videos, subtitles, files) = partition_dropbox_entries(response.entries);

        let next_cursor = if response.has_more {
            Some(response.cursor)
        } else {
            None
        };

        Ok(ListPage {
            videos,
            subtitles,
            files,
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

    /// Upload one file via an upload session (drag-and-drop task 009):
    /// start → bounded appends → finish carrying the final chunk. One
    /// [`UploadChunker`](crate::providers::common::UploadChunker)
    /// window in flight, never the whole file; a stream error aborts
    /// with no finish attempted (the abandoned session expires
    /// provider-side — no local cleanup state).
    pub async fn upload_file(
        &self,
        access_token: &str,
        dir: &str,
        filename: &str,
        size_bytes: u64,
        mut stream: crate::provider::BodyStream,
    ) -> ProviderResult<crate::provider::UploadResult> {
        let path = dropbox_upload_path(dir, filename);
        let io_err = |e: std::io::Error| ProviderError::Network(e.to_string());

        // ── Start the session ────────────────────────────────────────
        let start_resp = self
            .http_upload
            .post(format!(
                "{}/2/files/upload_session/start",
                self.content_base
            ))
            .bearer_auth(access_token)
            .header("Dropbox-API-Arg", r#"{"close": false}"#)
            .body("{}")
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        let status = start_resp.status();
        let body = start_resp.text().await.unwrap_or_default();
        check_upload_status(status.as_u16(), &body)?;
        let session: UploadSessionStart =
            serde_json::from_str(&body).map_err(ProviderError::from)?;

        // ── Append every chunk but the last ──────────────────────────
        // Read-ahead: `current` becomes "the last chunk" only when the
        // next read comes back empty — the finish call carries it.
        let mut chunker = crate::providers::common::UploadChunker::new();
        let mut offset: u64 = 0;
        let mut current = chunker
            .next(&mut stream, self.upload_chunk_size)
            .await
            .map_err(io_err)?;
        while let Some(next) = chunker
            .next(&mut stream, self.upload_chunk_size)
            .await
            .map_err(io_err)?
        {
            let bytes = current.take().expect("loop guard keeps current Some");
            self.append_session_chunk(access_token, &session.session_id, offset, &bytes)
                .await?;
            offset += bytes.len() as u64;
            current = Some(next);
        }

        // ── Finish with the final chunk ──────────────────────────────
        let final_bytes = current.unwrap_or_default();
        let arg = serde_json::json!({
            "cursor": { "session_id": session.session_id, "offset": offset },
            "commit": {
                "path": path,
                "mode": "add",
                "autorename": true,
                "mute": false,
            },
        });
        let finish_resp = self
            .http_upload
            .post(format!(
                "{}/2/files/upload_session/finish",
                self.content_base
            ))
            .bearer_auth(access_token)
            .header("Dropbox-API-Arg", arg.to_string())
            .body(final_bytes)
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        let status = finish_resp.status();
        let body = finish_resp.text().await.unwrap_or_default();
        check_upload_status(status.as_u16(), &body)?;
        let file: UploadedFileMetadata =
            serde_json::from_str(&body).map_err(ProviderError::from)?;

        Ok(crate::provider::UploadResult {
            provider_file_id: file.id,
            size_bytes,
        })
    }

    /// `append_v2` — one bounded chunk at `offset`. The cursor's offset
    /// must always equal the session's received total.
    async fn append_session_chunk(
        &self,
        access_token: &str,
        session_id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> ProviderResult<()> {
        let arg = serde_json::json!({
            "cursor": { "session_id": session_id, "offset": offset },
            "close": false,
        });
        let resp = self
            .http_upload
            .post(format!(
                "{}/2/files/upload_session/append_v2",
                self.content_base
            ))
            .bearer_auth(access_token)
            .header("Dropbox-API-Arg", arg.to_string())
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        check_upload_status(status.as_u16(), &body)
    }
}

/// Destination path for an upload — Dropbox path-root semantics: every
/// file path starts at `/`; an empty dir puts the file at the root.
fn dropbox_upload_path(dir: &str, filename: &str) -> String {
    let dir = dir.trim_matches('/');
    if dir.is_empty() {
        format!("/{filename}")
    } else {
        format!("/{dir}/{filename}")
    }
}

/// The upload endpoints' status ladder — the same conventions as every
/// other Dropbox call (401 → auth, 429/503 → retryable, else Api).
fn check_upload_status(status: u16, body: &str) -> ProviderResult<()> {
    match status {
        401 => Err(ProviderError::Unauthorized),
        429 | 503 => Err(ProviderError::RateLimited {
            retry_after_secs: None,
        }),
        s if (200..300).contains(&s) => Ok(()),
        s => Err(ProviderError::Api {
            status: s,
            body: body.to_string(),
        }),
    }
}

/// `upload_session/start` response.
#[derive(Debug, Deserialize)]
struct UploadSessionStart {
    session_id: String,
}

/// The file metadata `upload_session/finish` returns — only the id
/// matters to the catalog (the scanner resolves the rest).
#[derive(Debug, Deserialize)]
struct UploadedFileMetadata {
    id: String,
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

    async fn upload(
        &self,
        dir: &str,
        filename: &str,
        size_bytes: u64,
        stream: crate::provider::BodyStream,
    ) -> ProviderResult<crate::provider::UploadResult> {
        self.client
            .upload_file(&self.token.access_token, dir, filename, size_bytes, stream)
            .await
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

/// OAuth connect-flow for Dropbox: authorization URL, code exchange, token
/// refresh (with refresh-token carry-forward), and account-info lookup.
#[async_trait::async_trait]
impl crate::provider::OAuthFlow for DropboxFactory {
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

    async fn fetch_user_info(
        &self,
        token_bundle: &TokenBundle,
    ) -> ProviderResult<(Option<String>, Option<String>)> {
        let client = DropboxClient::new(self.config.clone());
        let info = client.fetch_user_info(&token_bundle.access_token).await?;
        Ok((info.account_id, info.email))
    }
}

#[async_trait::async_trait]
impl crate::provider::ProviderFactory for DropboxFactory {
    fn name(&self) -> &'static str {
        "dropbox"
    }

    fn connect_flow(&self) -> crate::provider::ConnectFlow {
        crate::provider::ConnectFlow::OAuth(Box::new(DropboxFactory::new(self.config.clone())))
    }

    async fn create(
        &self,
        credential: &Credential,
    ) -> ProviderResult<Box<dyn crate::provider::Provider>> {
        let token_bundle = credential.as_oauth().ok_or_else(|| {
            ProviderError::Other(
                "dropbox connects via OAuth; static credentials are not supported".into(),
            )
        })?;
        Ok(Box::new(DropboxProvider {
            client: DropboxClient::new(self.config.clone()),
            token: token_bundle.clone(),
        }))
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

    /// `.ts` is ambiguous (MPEG-TS video vs TypeScript source). Dropbox
    /// listings carry no MIME type, so only Dropbox's own media analysis
    /// (`media_info` video tag) can corroborate a `.ts` as a video.
    #[test]
    fn is_video_entry_requires_media_info_for_ts() {
        // No media_info → not a video (TypeScript source).
        let entry_json = r#"{ ".tag": "file", "id": "id:1", "name": "main.ts" }"#;
        let entry: DropboxEntry = serde_json::from_str(entry_json).unwrap();
        assert!(!is_video_entry(&entry));

        // media_info video tag → MPEG-TS video.
        let entry_json = r#"{
            ".tag": "file",
            "id": "id:2",
            "name": "recording.ts",
            "media_info": { ".tag": "metadata", "metadata": { ".tag": "video" } }
        }"#;
        let entry: DropboxEntry = serde_json::from_str(entry_json).unwrap();
        assert!(is_video_entry(&entry));
    }

    /// M9: non-video, non-sidecar files are emitted as `DiscoveredFile`
    /// rows instead of being dropped; sidecars are dual-represented.
    #[test]
    fn partition_dropbox_entries_emits_files_and_dual_sidecars() {
        let page_json = r#"{
            "entries": [
                { ".tag": "file", "id": "id:1", "name": "clip.mp4", "path_display": "/Media/clip.mp4", "size": 100 },
                { ".tag": "file", "id": "id:2", "name": "movie.en.srt", "path_display": "/Media/movie.en.srt", "size": 2 },
                { ".tag": "file", "id": "id:3", "name": "song.mp3", "path_display": "/Music/song.mp3", "size": 40 },
                { ".tag": "file", "id": "id:4", "name": "weird.dat", "size": 7 },
                { ".tag": "folder", "id": "id:5", "name": "Photos" }
            ]
        }"#;
        let response: ListFolderResponse = serde_json::from_str(page_json).unwrap();

        let (videos, subtitles, files) = partition_dropbox_entries(response.entries);

        assert_eq!(videos.len(), 1);
        assert_eq!(videos[0].provider_file_id, "id:1");
        assert_eq!(subtitles.len(), 1);
        assert_eq!(subtitles[0].provider_file_id, "id:2");

        // srt (dual) + mp3 + dat; folder dropped.
        assert_eq!(files.len(), 3);
        let srt = files.iter().find(|f| f.provider_file_id == "id:2").unwrap();
        assert_eq!(srt.kind, FileKind::Subtitle);
        assert_eq!(srt.path.as_deref(), Some("/Media/movie.en.srt"));
        let mp3 = files.iter().find(|f| f.provider_file_id == "id:3").unwrap();
        assert_eq!(mp3.kind, FileKind::Audio);
        assert_eq!(mp3.size_bytes, 40);
        let dat = files.iter().find(|f| f.provider_file_id == "id:4").unwrap();
        assert_eq!(dat.kind, FileKind::Other);
        assert!(
            !files.iter().any(|f| f.provider_file_id == "id:5"),
            "folders are never file rows"
        );
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

        let provider = factory.create(&Credential::OAuth(bundle)).await.unwrap();
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

    // ── upload session (drag-and-drop task 009) ─────────────────────

    mod upload_tests {
        use super::super::*;
        use crate::provider::BodyStream;
        use futures::stream;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        fn client(server: &MockServer, chunk: usize) -> DropboxClient {
            DropboxClient::new_for_testing(super::test_config(), server.uri(), chunk)
        }

        /// 192 KiB deterministic fixture; at 64 KiB chunks it spans
        /// exactly 3 appends + a finish-carried final chunk... at 64 KiB:
        /// chunks of 64,64,64 → the first two append, the last rides
        /// finish.
        fn fixture() -> Vec<u8> {
            (0..192 * 1024).map(|i| (i % 249) as u8).collect()
        }

        fn chunked(bytes: Vec<u8>) -> BodyStream {
            Box::pin(stream::iter(
                bytes
                    .chunks(8 * 1024)
                    .map(|c| Ok(bytes::Bytes::copy_from_slice(c)))
                    .collect::<Vec<Result<bytes::Bytes, std::io::Error>>>(),
            ))
        }

        async fn session_mocks(server: &MockServer, finish_body: &str) {
            Mock::given(method("POST"))
                .and(path("/2/files/upload_session/start"))
                .respond_with(
                    ResponseTemplate::new(200).set_body_string(r#"{"session_id": "sid-1"}"#),
                )
                .mount(server)
                .await;
            Mock::given(method("POST"))
                .and(path("/2/files/upload_session/append_v2"))
                .respond_with(ResponseTemplate::new(200))
                .mount(server)
                .await;
            Mock::given(method("POST"))
                .and(path("/2/files/upload_session/finish"))
                .respond_with(ResponseTemplate::new(200).set_body_string(finish_body))
                .mount(server)
                .await;
        }

        #[tokio::test]
        async fn upload_sessions_span_chunks_and_reassemble_byte_exact() {
            let server = MockServer::start().await;
            session_mocks(&server, r#"{"id": "id:abc123"}"#).await;
            let data = fixture();

            let result = client(&server, 64 * 1024)
                .upload_file(
                    "token",
                    "/Movies",
                    "clip.mp4",
                    data.len() as u64,
                    chunked(data.clone()),
                )
                .await
                .unwrap();

            assert_eq!(result.provider_file_id, "id:abc123");
            assert_eq!(result.size_bytes, 192 * 1024);

            let requests = server.received_requests().await.unwrap();
            let mut body = Vec::new();
            let mut append_offsets = Vec::new();
            let mut finish_arg = None;
            for r in &requests {
                match r.url.path() {
                    "/2/files/upload_session/append_v2" => {
                        let arg = r
                            .headers
                            .get("dropbox-api-arg")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or_default()
                            .to_string();
                        let parsed: serde_json::Value = serde_json::from_str(&arg).unwrap();
                        append_offsets.push(parsed["cursor"]["offset"].as_u64().unwrap());
                        body.extend_from_slice(&r.body);
                    }
                    "/2/files/upload_session/finish" => {
                        body.extend_from_slice(&r.body);
                        finish_arg = r
                            .headers
                            .get("dropbox-api-arg")
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_string);
                    }
                    _ => {}
                }
            }
            assert_eq!(body, data, "appends + finish reassemble the fixture");

            // Exactly two intermediate appends at sequential offsets
            // (64 KiB chunks: 0 and 65536; the third rides finish).
            assert_eq!(append_offsets, vec![0, 65536]);

            // Finish's commit path lands the file at dir/filename.
            let arg: serde_json::Value =
                serde_json::from_str(&finish_arg.expect("finish carries its arg")).unwrap();
            assert_eq!(arg["cursor"]["offset"], serde_json::json!(131072));
            assert_eq!(arg["commit"]["path"], serde_json::json!("/Movies/clip.mp4"));
            assert_eq!(arg["commit"]["autorename"], serde_json::json!(true));
        }

        #[tokio::test]
        async fn upload_at_root_uses_bare_path() {
            let server = MockServer::start().await;
            session_mocks(&server, r#"{"id": "id:root"}"#).await;
            let data = b"tiny".to_vec();
            client(&server, 64 * 1024)
                .upload_file("token", "", "notes.txt", 4, chunked(data.clone()))
                .await
                .unwrap();

            let requests = server.received_requests().await.unwrap();
            let finish = requests
                .iter()
                .find(|r| r.url.path() == "/2/files/upload_session/finish")
                .expect("finish called");
            let arg: serde_json::Value = serde_json::from_str(
                finish
                    .headers
                    .get("dropbox-api-arg")
                    .and_then(|v| v.to_str().ok())
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(arg["commit"]["path"], serde_json::json!("/notes.txt"));
            // A single-chunk upload never calls append.
            assert!(!requests
                .iter()
                .any(|r| r.url.path() == "/2/files/upload_session/append_v2"));
        }

        #[tokio::test]
        async fn upload_aborts_after_a_chunk_error_and_never_finishes() {
            let server = MockServer::start().await;
            session_mocks(&server, r#"{"id": "id:never"}"#).await;

            // Promise three chunks, die during the second read.
            let pieces: Vec<Result<bytes::Bytes, std::io::Error>> = vec![
                Ok(bytes::Bytes::from(vec![1u8; 64 * 1024])),
                Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionAborted,
                    "client aborted",
                )),
            ];
            let stream: BodyStream = Box::pin(stream::iter(pieces));

            let result = client(&server, 64 * 1024)
                .upload_file("token", "/Movies", "clip.mp4", 192 * 1024, stream)
                .await;
            assert!(result.is_err(), "an aborted stream must never succeed");

            let requests = server.received_requests().await.unwrap();
            assert!(
                !requests
                    .iter()
                    .any(|r| r.url.path() == "/2/files/upload_session/finish"),
                "finish-after-abort is never attempted"
            );
        }

        #[tokio::test]
        async fn upload_maps_a_401_to_unauthorized() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/2/files/upload_session/start"))
                .respond_with(ResponseTemplate::new(401))
                .mount(&server)
                .await;

            let data = b"x".to_vec();
            match client(&server, 64 * 1024)
                .upload_file("token", "", "f.bin", 1, chunked(data))
                .await
            {
                Err(ProviderError::Unauthorized) => {}
                other => panic!("expected Unauthorized, got {other:?}"),
            }
        }

        #[test]
        fn dropbox_upload_path_shapes() {
            assert_eq!(dropbox_upload_path("", "a.mp4"), "/a.mp4");
            assert_eq!(dropbox_upload_path("/", "a.mp4"), "/a.mp4");
            assert_eq!(
                dropbox_upload_path("/Movies/Sci-fi", "a.mp4"),
                "/Movies/Sci-fi/a.mp4"
            );
        }
    }
}
