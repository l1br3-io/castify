use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::crypto::{Credential, TokenBundle};
use crate::model::{DiscoveredSubtitle, DiscoveredVideo, FileKind, ListPage, Provider};
use crate::oauth::redirect_uri;
use crate::provider::{ProviderError, ProviderResult, StreamResponse, StreamUrl, ThumbnailData};
use crate::providers::common::{
    classify_kind, classify_token_error, discovered_file_of_kind, guess_language,
    has_subtitle_extension, has_video_extension, infer_image_mime, is_mpeg_ts_name,
    response_to_stream, to_hex, TokenResponse,
};

const AUTH_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_ROOT: &str = "https://graph.microsoft.com/v1.0";
const DELTA_URL: &str = "https://graph.microsoft.com/v1.0/me/drive/root/delta";
const ME_URL: &str = "https://graph.microsoft.com/v1.0/me";
const REVOKE_URL: &str = "https://graph.microsoft.com/v1.0/me/revokeSignInSessions";
const SCOPE: &str = "files.read.all offline_access";
const PREFIX_BYTES: usize = 4 * 1024 * 1024;
/// GOTCHA: Graph upload-session chunks (except the last) MUST be
/// multiples of 320 KiB — 5 MiB (320 KiB × 16) sits in Microsoft's
/// recommended 5–10 MiB window and keeps exactly one bounded buffer in
/// flight; the bound is enforced where the chunker fills it.
const UPLOAD_CHUNK_SIZE: usize = 5 * 1024 * 1024;

/// Configuration for the OneDrive OAuth client. Derived from `Config`.
#[derive(Debug, Clone)]
pub struct OneDriveConfig {
    pub client_id: String,
    pub client_secret: String,
}

/// OneDrive OAuth + Microsoft Graph client. Owns the HTTP client and credentials.
#[derive(Debug, Clone)]
pub struct OneDriveClient {
    config: OneDriveConfig,
    http: reqwest::Client,
    /// Separate client for preauthenticated download URLs — follows redirects
    /// to the CDN. The main `http` client disables redirects (consistent with
    /// other providers and safe for Graph API endpoints, which never redirect).
    http_download: reqwest::Client,
    /// Upload client: chunk PUTs carry megabytes over a home uplink — a
    /// total-request timeout could abort legitimate transfers, so this
    /// client caps only connection establishment.
    http_upload: reqwest::Client,
    /// Graph API base. Defaults to Microsoft's; tests override to a
    /// local wiremock server (the google_drive `drive_files_base`
    /// pattern).
    graph_base: String,
    /// Upload chunk size in bytes (the wiremock tests shrink it so a
    /// small fixture spans several chunks).
    upload_chunk_size: usize,
}

/// Account info returned by Microsoft Graph `/me`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OneDriveUserInfo {
    pub account_id: Option<String>,
    pub email: Option<String>,
}

impl OneDriveClient {
    pub fn new(config: OneDriveConfig) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // Control-plane only (token refresh, /me, driveitem lookup,
            // preauthenticated URL resolution). All calls return within
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
        let http_upload = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("failed to build reqwest upload client");
        Self {
            config,
            http,
            http_download,
            http_upload,
            graph_base: GRAPH_ROOT.into(),
            upload_chunk_size: UPLOAD_CHUNK_SIZE,
        }
    }

    /// Test-only constructor: overrides the Graph base (so wiremock
    /// intercepts the session endpoints) and the chunk size (so small
    /// fixtures span several chunks).
    #[cfg(test)]
    pub(crate) fn new_for_testing(
        config: OneDriveConfig,
        graph_base: String,
        chunk: usize,
    ) -> Self {
        let mut client = Self::new(config);
        client.graph_base = graph_base;
        client.upload_chunk_size = chunk;
        client
    }

    /// Build the redirect URI for this provider given the app base URL.
    pub fn redirect_uri(&self, base_url: &str) -> String {
        redirect_uri(base_url, &Provider::OneDrive)
    }

    /// Build the Microsoft OAuth authorization URL with PKCE.
    pub fn authorization_url(&self, redirect_uri: &str, state: &str, challenge: &str) -> String {
        let params: Vec<(String, String)> = vec![
            ("client_id".into(), self.config.client_id.clone()),
            ("redirect_uri".into(), redirect_uri.into()),
            ("response_type".into(), "code".into()),
            ("scope".into(), SCOPE.into()),
            ("state".into(), state.into()),
            ("code_challenge".into(), challenge.into()),
            ("code_challenge_method".into(), "S256".into()),
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
                ("scope", SCOPE),
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
                ("scope", SCOPE),
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

    /// Revoke the access token (best-effort). Microsoft does not provide a
    /// standard RFC-7009 revocation endpoint; `revokeSignInSessions` works for
    /// work/school accounts and may fail silently for personal accounts.
    /// Practical revocation is the deletion of the stored (encrypted) token.
    pub async fn revoke_token(&self, access_token: &str) -> ProviderResult<()> {
        let _ = self
            .http
            .post(REVOKE_URL)
            .bearer_auth(access_token)
            .send()
            .await;
        Ok(())
    }

    /// Fetch the authenticated user's account ID and email.
    pub async fn fetch_user_info(&self, access_token: &str) -> ProviderResult<OneDriveUserInfo> {
        let resp = self
            .http
            .get(ME_URL)
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

        let info: MeResponse = serde_json::from_str(&body)?;
        Ok(OneDriveUserInfo {
            account_id: Some(info.id),
            email: info.mail.or(info.user_principal_name),
        })
    }
}

// ── Graph delta response types ──────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeltaResponse {
    #[serde(default)]
    value: Vec<DriveItem>,
    #[serde(rename = "@odata.nextLink", default)]
    next_link: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveItem {
    id: String,
    name: String,
    #[serde(default)]
    size: Option<i64>,
    /// Present when the item is a file.
    #[serde(default)]
    file: Option<FileFacet>,
    /// Present when the item is a video — richest metadata of all providers.
    #[serde(default)]
    video: Option<VideoFacet>,
    #[serde(default)]
    last_modified_date_time: Option<String>,
    #[serde(default)]
    parent_reference: Option<ParentReference>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileFacet {
    #[serde(default)]
    mime_type: Option<String>,
    #[serde(default)]
    hashes: Option<FileHashes>,
}

#[derive(Debug, Deserialize)]
struct FileHashes {
    #[serde(rename = "quickXorHash", default)]
    quick_xor_hash: Option<String>,
    #[serde(rename = "sha1Hash", default)]
    sha1_hash: Option<String>,
    #[serde(rename = "sha256Hash", default)]
    sha256_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VideoFacet {
    /// Duration in milliseconds.
    #[serde(default)]
    duration: Option<i64>,
    #[serde(default)]
    width: Option<i64>,
    #[serde(default)]
    height: Option<i64>,
    #[serde(default)]
    #[allow(dead_code)]
    bitrate: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ParentReference {
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    id: String,
    #[serde(default)]
    mail: Option<String>,
    #[serde(default)]
    user_principal_name: Option<String>,
}

// ── Video classification ────────────────────────────────────────────

/// A drive item is a video if it's a file AND either the `video` facet
/// carries actual metadata, or the file extension is a known video type.
///
/// Graph materializes explicitly `$select`ed facets as empty objects —
/// `"video": {}` comes back on non-video items (and on videos Graph hasn't
/// analyzed yet). An empty facet must NOT gate a file into `videos`, or
/// every file in the drive gets cataloged as a video. Same stance as
/// Drive's `classify_drive_file`: a known extension (or here, a facet with
/// at least one populated field) is required before classifying as video.
fn is_video_item(item: &DriveItem) -> bool {
    if item.file.is_none() {
        return false;
    }
    if item
        .video
        .as_ref()
        .is_some_and(|v| v.duration.is_some() || v.width.is_some() || v.height.is_some())
    {
        return true;
    }
    if has_video_extension(&item.name) {
        return true;
    }
    // `.ts` is ambiguous (MPEG-TS video vs TypeScript source); the
    // `video/mp2t` MIME corroborates when Graph hasn't analyzed the file.
    is_mpeg_ts_name(&item.name)
        && item
            .file
            .as_ref()
            .and_then(|f| f.mime_type.as_deref())
            .is_some_and(|m| m.eq_ignore_ascii_case("video/mp2t"))
}

/// Partition a delta page into (videos, sidecar subtitles, non-media
/// files). Extracted from the listing method so the classification rules
/// are testable without a mock HTTP server (same pattern as Drive's
/// `classify_drive_file` and Dropbox's `partition_dropbox_entries`).
///
/// M9: non-video, non-sidecar files are emitted as `DiscoveredFile` rows
/// instead of being dropped; sidecar subtitles are dual-represented
/// (playback routing + folder-tree visibility).
fn partition_onedrive_items(
    items: Vec<DriveItem>,
) -> (
    Vec<DiscoveredVideo>,
    Vec<DiscoveredSubtitle>,
    Vec<crate::model::DiscoveredFile>,
) {
    let mut videos = Vec::new();
    let mut subtitles = Vec::new();
    let mut files = Vec::new();

    for item in items {
        // Items without a file facet are folders (or deleted tombstones) —
        // never catalog rows.
        if item.file.is_none() {
            continue;
        }
        let path = item
            .parent_reference
            .as_ref()
            .and_then(|p| p.path.as_ref())
            .map(|p| {
                let parent = p.split(':').nth(1).unwrap_or("");
                if parent.is_empty() {
                    format!("/{}", item.name)
                } else {
                    format!("{parent}/{}", item.name)
                }
            });
        let mime_type = item.file.as_ref().and_then(|f| f.mime_type.clone());

        if has_subtitle_extension(&item.name) {
            let language = guess_language(&item.name);
            files.push(discovered_file_of_kind(
                FileKind::Subtitle,
                item.id.clone(),
                item.name.clone(),
                path.clone(),
                item.size.unwrap_or(0),
                mime_type.clone(),
                item.last_modified_date_time.clone(),
            ));
            subtitles.push(DiscoveredSubtitle {
                provider_file_id: item.id,
                name: item.name,
                path,
                language,
            });
        } else if is_video_item(&item) {
            let hashes = item.file.as_ref().and_then(|f| f.hashes.as_ref());

            let (native_hash, native_hash_algo) = match hashes {
                Some(h) => {
                    if let Some(qx) = &h.quick_xor_hash {
                        (Some(qx.clone()), Some("quickxor".to_string()))
                    } else if let Some(s256) = &h.sha256_hash {
                        (Some(s256.clone()), Some("sha256".to_string()))
                    } else if let Some(s1) = &h.sha1_hash {
                        (Some(s1.clone()), Some("sha1".to_string()))
                    } else {
                        (None, None)
                    }
                }
                None => (None, None),
            };

            let (duration_ms, width, height) = item
                .video
                .as_ref()
                .map(|v| (v.duration, v.width, v.height))
                .unwrap_or((None, None, None));

            videos.push(DiscoveredVideo {
                provider_file_id: item.id,
                name: item.name,
                path,
                size_bytes: item.size.unwrap_or(0),
                mime_type,
                duration_ms,
                width,
                height,
                native_hash,
                native_hash_algo,
                provider_modified_at: item.last_modified_date_time,
            });
        } else {
            // M9: every remaining file is cataloged metadata-only.
            files.push(discovered_file_of_kind(
                classify_kind(&item.name, mime_type.as_deref()),
                item.id,
                item.name,
                path,
                item.size.unwrap_or(0),
                mime_type,
                item.last_modified_date_time,
            ));
        }
    }

    (videos, subtitles, files)
}

// ── OneDrive Graph API methods ──────────────────────────────────────

impl OneDriveClient {
    /// List one page of video files from OneDrive via the delta API. The
    /// first call has no cursor (hits the delta endpoint directly); subsequent
    /// calls pass the `@odata.nextLink` URL from the previous page.
    pub async fn list_onedrive_videos(
        &self,
        access_token: &str,
        cursor: Option<&str>,
    ) -> ProviderResult<ListPage> {
        let url = match cursor {
            // nextLink is a full URL with delta token already encoded.
            Some(c) => c.to_string(),
            // First page: request only the fields we need.
            None => format!(
                "{DELTA_URL}?$select=id,name,size,file,video,lastModifiedDateTime,parentReference"
            ),
        };

        let resp = self
            .http
            .get(&url)
            .bearer_auth(access_token)
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

        let response: DeltaResponse = serde_json::from_str(&resp_body)?;

        let (videos, subtitles, files) = partition_onedrive_items(response.value);

        Ok(ListPage {
            videos,
            subtitles,
            files,
            next_cursor: response.next_link,
        })
    }

    /// Download the first 4 MB of a OneDrive file and compute its SHA-256
    /// hash. Uses the preauthenticated `@microsoft.graph.downloadUrl` which
    /// is fetched on-demand from the Graph item endpoint (the URL is
    /// short-lived and may not be available from the listing).
    pub async fn fetch_onedrive_prefix_hash(
        &self,
        access_token: &str,
        file_id: &str,
        size: i64,
    ) -> ProviderResult<Option<String>> {
        if size < PREFIX_BYTES as i64 {
            return Ok(None);
        }

        // Step 1: fetch the preauthenticated download URL from Graph.
        let download_url = self.fetch_download_url(access_token, file_id).await?;

        // Step 2: Range request on the preauthenticated URL (no bearer auth).
        let resp = self
            .http_download
            .get(&download_url)
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

    /// Fetch a poster thumbnail for a OneDrive item. The Graph
    /// `thumbnails/0/c400x400/content` endpoint responds 302 to a
    /// preauthenticated CDN URL; `http_download` follows the redirect (same
    /// client used for prefix-hash downloads). Returns `NotFound` (404) when
    /// the item has no thumbnail.
    pub async fn fetch_thumbnail(
        &self,
        access_token: &str,
        file_id: &str,
    ) -> ProviderResult<ThumbnailData> {
        let url = format!("{GRAPH_ROOT}/me/drive/items/{file_id}/thumbnails/0/c400x400/content");
        let resp = self
            .http_download
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
        if status.as_u16() == 404 {
            return Err(ProviderError::NotFound(format!(
                "no thumbnail for OneDrive item {file_id}"
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

    /// Stream a OneDrive file's content via the preauthenticated
    /// `@microsoft.graph.downloadUrl`. Two-step: (1) fetch the short-lived
    /// download URL from Graph, (2) GET that URL with the browser's `Range`
    /// header (no auth on the CDN URL). Uses `http_download` (redirect-
    /// following) for step 2.
    pub async fn open_stream(
        &self,
        access_token: &str,
        file_id: &str,
        range: Option<&str>,
    ) -> ProviderResult<StreamResponse> {
        // Step 1: fetch the preauthenticated download URL from Graph.
        let download_url = self.fetch_download_url(access_token, file_id).await?;

        // Step 2: GET the preauthenticated URL with Range (no bearer auth).
        let mut req = self.http_download.get(&download_url);
        if let Some(r) = range {
            req = req.header("Range", r);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        response_to_stream(resp).await
    }

    /// Fetch the short-lived preauthenticated `@microsoft.graph.downloadUrl`
    /// for a OneDrive item. Shared by [`Self::fetch_onedrive_prefix_hash`],
    /// [`Self::open_stream`], and the trait's `open_stream_url` impl. The
    /// URL is browser-directable (no bearer auth on the CDN host) and
    /// typically valid for ~1 hour.
    pub async fn fetch_download_url(
        &self,
        access_token: &str,
        file_id: &str,
    ) -> ProviderResult<String> {
        let item_url =
            format!("{GRAPH_ROOT}/me/drive/items/{file_id}?$select=@microsoft.graph.downloadUrl");
        let resp = self
            .http
            .get(&item_url)
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

        let resp_body = resp.text().await.unwrap_or_default();
        let item: DownloadUrlResponse = serde_json::from_str(&resp_body)?;
        item.download_url.ok_or_else(|| {
            ProviderError::NotFound(format!(
                "no downloadUrl for OneDrive item {file_id} — may be a folder or restricted"
            ))
        })
    }
}

/// Response from `GET /me/drive/items/{id}?$select=@microsoft.graph.downloadUrl`.
#[derive(Debug, Deserialize)]
struct DownloadUrlResponse {
    #[serde(rename = "@microsoft.graph.downloadUrl", default)]
    download_url: Option<String>,
}

/// `createUploadSession` response — only the preauthenticated upload
/// URL matters (chunk PUTs go there, no bearer header).
#[derive(Debug, Deserialize)]
struct UploadSessionResponse {
    #[serde(rename = "uploadUrl")]
    upload_url: String,
}

/// The driveItem the final chunk PUT returns — only the id matters to
/// the catalog.
#[derive(Debug, Deserialize)]
struct UploadedDriveItem {
    id: String,
}

impl OneDriveClient {
    /// Upload one file via a Graph upload session (drag-and-drop task
    /// 009): create the session → ranged PUTs of bounded chunks → the
    /// LAST chunk's PUT returns the driveItem. One chunk window in
    /// flight, never the whole file; a stream error aborts with the
    /// session abandoned (Graph expires it server-side — no local
    /// cleanup state). `conflictBehavior: rename` mirrors Dropbox's
    /// `autorename`: the destination keeps existing files.
    pub async fn upload_file(
        &self,
        access_token: &str,
        dir: &str,
        filename: &str,
        size_bytes: u64,
        mut stream: crate::provider::BodyStream,
    ) -> ProviderResult<crate::provider::UploadResult> {
        let path = graph_upload_path(dir, filename);
        let io_err = |e: std::io::Error| ProviderError::Network(e.to_string());

        // ── Create the session ───────────────────────────────────────
        let create_resp = self
            .http
            .post(format!(
                "{}/me/drive/root:/{}:/createUploadSession",
                self.graph_base, path
            ))
            .bearer_auth(access_token)
            .json(&serde_json::json!({
                "item": { "@microsoft.graph.conflictBehavior": "rename" }
            }))
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        let status = create_resp.status();
        let body = create_resp.text().await.unwrap_or_default();
        check_upload_status(status.as_u16(), &body)?;
        let session: UploadSessionResponse =
            serde_json::from_str(&body).map_err(ProviderError::from)?;

        // ── Ranged chunk PUTs ────────────────────────────────────────
        // Read-ahead: the current chunk is only known "last" when the
        // next read comes back empty — the final PUT carries it and
        // returns the driveItem.
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
            self.put_session_chunk(&session.upload_url, offset, &bytes, size_bytes)
                .await?;
            offset += bytes.len() as u64;
            current = Some(next);
        }

        let final_bytes = current.unwrap_or_default();
        let end_inclusive = if final_bytes.is_empty() {
            0
        } else {
            offset + final_bytes.len() as u64 - 1
        };
        // The preauthenticated upload URL takes NO Authorization header
        // (the token is baked in; sending one is a Graph error).
        let resp = self
            .http_upload
            .put(&session.upload_url)
            .header("Content-Length", final_bytes.len())
            .header(
                "Content-Range",
                format!("bytes {offset}-{end_inclusive}/{size_bytes}"),
            )
            .body(final_bytes)
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        check_upload_status(status.as_u16(), &body)?;
        let item: UploadedDriveItem = serde_json::from_str(&body).map_err(ProviderError::from)?;

        Ok(crate::provider::UploadResult {
            provider_file_id: item.id,
            size_bytes,
        })
    }

    /// One intermediate ranged chunk PUT — Graph answers 202 Accepted
    /// until the final chunk lands.
    async fn put_session_chunk(
        &self,
        upload_url: &str,
        offset: u64,
        bytes: &[u8],
        total: u64,
    ) -> ProviderResult<()> {
        let end_inclusive = offset + bytes.len() as u64 - 1;
        let resp = self
            .http_upload
            .put(upload_url)
            .header("Content-Length", bytes.len())
            .header(
                "Content-Range",
                format!("bytes {offset}-{end_inclusive}/{total}"),
            )
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        check_upload_status(status.as_u16(), &body)
    }
}

/// Destination path for `root:/…:/createUploadSession` —
/// `/`-separated segments, each URL-encoded so spaces and Unicode
/// survive the URL; an empty dir puts the file at the drive root.
fn graph_upload_path(dir: &str, filename: &str) -> String {
    let dir = dir.trim_matches('/');
    let segments: Vec<&str> = if dir.is_empty() {
        vec![filename]
    } else {
        dir.split('/').chain([filename]).collect()
    };
    segments
        .iter()
        .map(|segment| urlencoding_simple(segment))
        .collect::<Vec<_>>()
        .join("/")
}

/// Percent-encode the Graph-path-unsafe subset (the encoded-path
/// variant reqwest won't do for us): everything outside the unreserved
/// set, keeping `/` to the caller.
fn urlencoding_simple(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~');
        if unreserved {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The upload endpoints' status ladder — Graph's conventions match the
/// rest of the provider (401 → auth, 429/503 → retryable, else Api).
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

// ── Provider trait implementation ────────────────────────────────────

/// A OneDrive provider holding a valid access token for API calls.
pub struct OneDriveProvider {
    client: OneDriveClient,
    token: TokenBundle,
}

#[async_trait::async_trait]
impl crate::provider::Provider for OneDriveProvider {
    fn name(&self) -> &'static str {
        "onedrive"
    }

    async fn list_videos(&self, cursor: Option<&str>) -> ProviderResult<ListPage> {
        self.client
            .list_onedrive_videos(&self.token.access_token, cursor)
            .await
    }

    async fn fetch_prefix_hash(&self, file_id: &str, size: i64) -> ProviderResult<Option<String>> {
        self.client
            .fetch_onedrive_prefix_hash(&self.token.access_token, file_id, size)
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
            .fetch_download_url(&self.token.access_token, file_id)
            .await?;
        // Microsoft's preauthenticated downloadUrl is short-lived (~1 hour).
        // Express an expiry so the frontend can pre-emptively re-fetch before
        // the CDN starts returning 403/410.
        let expires_at = {
            let now = chrono::Utc::now();
            let expiry = now + chrono::Duration::minutes(55);
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

/// Factory for creating OneDrive provider instances from token bundles.
pub struct OneDriveFactory {
    config: OneDriveConfig,
}

impl OneDriveFactory {
    pub fn new(config: OneDriveConfig) -> Self {
        Self { config }
    }
}

/// OAuth connect-flow for OneDrive: authorization URL, code exchange, token
/// refresh (with refresh-token carry-forward), and account-info lookup.
#[async_trait::async_trait]
impl crate::provider::OAuthFlow for OneDriveFactory {
    fn authorization_url(&self, redirect_uri: &str, state: &str, challenge: &str) -> String {
        OneDriveClient::new(self.config.clone()).authorization_url(redirect_uri, state, challenge)
    }

    async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> ProviderResult<TokenBundle> {
        let client = OneDriveClient::new(self.config.clone());
        client.exchange_code(code, verifier, redirect_uri).await
    }

    async fn refresh_token(&self, token_bundle: &TokenBundle) -> ProviderResult<TokenBundle> {
        let client = OneDriveClient::new(self.config.clone());
        let refresh = token_bundle
            .refresh_token
            .as_deref()
            .ok_or(ProviderError::Unauthorized)?;
        let mut bundle = client.refresh_token(refresh).await?;
        // Microsoft refresh may omit refresh_token (depends on account type);
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
        let client = OneDriveClient::new(self.config.clone());
        let info = client.fetch_user_info(&token_bundle.access_token).await?;
        Ok((info.account_id, info.email))
    }
}

#[async_trait::async_trait]
impl crate::provider::ProviderFactory for OneDriveFactory {
    fn name(&self) -> &'static str {
        "onedrive"
    }

    fn connect_flow(&self) -> crate::provider::ConnectFlow {
        crate::provider::ConnectFlow::OAuth(Box::new(OneDriveFactory::new(self.config.clone())))
    }

    async fn create(
        &self,
        credential: &Credential,
    ) -> ProviderResult<Box<dyn crate::provider::Provider>> {
        let token_bundle = credential.as_oauth().ok_or_else(|| {
            ProviderError::Other(
                "onedrive connects via OAuth; static credentials are not supported".into(),
            )
        })?;
        Ok(Box::new(OneDriveProvider {
            client: OneDriveClient::new(self.config.clone()),
            token: token_bundle.clone(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderFactory;

    fn test_config() -> OneDriveConfig {
        OneDriveConfig {
            client_id: "test-client-id".into(),
            client_secret: "test-secret".into(),
        }
    }

    #[test]
    fn authorization_url_contains_required_params() {
        let client = OneDriveClient::new(test_config());
        let url = client.authorization_url(
            "https://example.com/api/connections/onedrive/callback",
            "state-123",
            "challenge-abc",
        );
        assert!(url.starts_with(AUTH_URL));
        assert!(url.contains("client_id=test-client-id"));
        assert!(url.contains("code_challenge=challenge-abc"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=state-123"));
        // Scope includes offline_access (Microsoft's way to get refresh tokens).
        assert!(url.contains("offline_access"));
        assert!(url.contains("files.read.all"));
    }

    #[test]
    fn redirect_uri_is_correct() {
        let client = OneDriveClient::new(test_config());
        let uri = client.redirect_uri("https://media.example.com");
        assert_eq!(
            uri,
            "https://media.example.com/api/connections/onedrive/callback"
        );
    }

    #[test]
    fn delta_response_parses_correctly() {
        let json = r#"{
            "value": [
                {
                    "id": "item-1",
                    "name": "vacation.mp4",
                    "size": 10485760,
                    "file": {
                        "mimeType": "video/mp4",
                        "hashes": {
                            "quickXorHash": "qx-hash-123",
                            "sha1Hash": "sha1-hash-456",
                            "sha256Hash": "sha256-hash-789"
                        }
                    },
                    "video": {
                        "duration": 120000,
                        "width": 1920,
                        "height": 1080,
                        "bitrate": 5000000
                    },
                    "lastModifiedDateTime": "2026-01-15T10:30:00Z",
                    "parentReference": { "path": "/drive/root:/Videos" }
                },
                {
                    "id": "item-2",
                    "name": "no-video-meta.mkv",
                    "size": 5000,
                    "file": {
                        "mimeType": "video/x-matroska"
                    },
                    "lastModifiedDateTime": "2026-02-01T00:00:00Z"
                },
                {
                    "id": "item-3",
                    "name": "Documents",
                    "folder": {},
                    "size": 0
                }
            ],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=abc"
        }"#;

        let response: DeltaResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.value.len(), 3);
        assert_eq!(
            response.next_link.as_deref(),
            Some("https://graph.microsoft.com/v1.0/me/drive/root/delta?token=abc")
        );

        let f1 = &response.value[0];
        assert_eq!(f1.id, "item-1");
        assert_eq!(f1.size, Some(10485760));
        assert!(f1.file.is_some());
        assert!(f1.video.is_some());
        assert_eq!(
            f1.file
                .as_ref()
                .and_then(|f| f.hashes.as_ref())
                .and_then(|h| h.quick_xor_hash.as_deref()),
            Some("qx-hash-123")
        );

        // Folder item (no file facet).
        assert!(response.value[2].file.is_none());
    }

    #[test]
    fn is_video_item_classifies_correctly() {
        // Video with video facet.
        let json = r#"{ "id": "1", "name": "clip.mp4",
            "file": { "mimeType": "video/mp4" }, "video": { "duration": 1000 } }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        assert!(is_video_item(&item));

        // Video by extension, no video facet.
        let json = r#"{ "id": "2", "name": "clip.mkv",
            "file": { "mimeType": "video/x-matroska" } }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        assert!(is_video_item(&item));

        // Non-video file (no video extension, no video facet).
        let json = r#"{ "id": "3", "name": "notes.txt",
            "file": { "mimeType": "text/plain" } }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        assert!(!is_video_item(&item));

        // Folder is never a video.
        let json = r#"{ "id": "4", "name": "videos.mp4" }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        assert!(!is_video_item(&item));
    }

    /// Regression: Graph materializes `$select`ed facets as empty objects —
    /// `"video": {}` appears on non-video files. An empty facet must not
    /// classify the file as a video (every file in the drive would become
    /// one).
    #[test]
    fn is_video_item_rejects_empty_video_facet() {
        // Empty facet on a non-video file → not a video.
        let json = r#"{ "id": "1", "name": "notes.txt",
            "file": { "mimeType": "text/plain" }, "video": {} }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        assert!(!is_video_item(&item));

        // Empty facet + known video extension → still a video.
        let json = r#"{ "id": "2", "name": "clip.mp4",
            "file": { "mimeType": "video/mp4" }, "video": {} }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        assert!(is_video_item(&item));

        // Populated facet on an unrecognized extension → video (Graph
        // analyzed it; trust the metadata).
        let json = r#"{ "id": "3", "name": "clip.m2ts",
            "file": { "mimeType": "application/octet-stream" },
            "video": { "duration": 1000, "width": 1920, "height": 1080 } }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        assert!(is_video_item(&item));
    }

    /// `.ts` is ambiguous (MPEG-TS video vs TypeScript source). The
    /// extension alone must not gate it into `videos`; a populated video
    /// facet (Graph's analysis) or the `video/mp2t` MIME corroborates.
    #[test]
    fn is_video_item_requires_corroboration_for_ts() {
        // TypeScript source: empty facet + generic MIME → file.
        let json = r#"{ "id": "1", "name": "main.ts",
            "file": { "mimeType": "application/octet-stream" }, "video": {} }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        assert!(!is_video_item(&item));

        // MPEG-TS corroborated by MIME alone (Graph hasn't analyzed it).
        let json = r#"{ "id": "2", "name": "recording.ts",
            "file": { "mimeType": "video/mp2t" }, "video": {} }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        assert!(is_video_item(&item));

        // MPEG-TS corroborated by a populated facet (analysis wins even
        // with an octet-stream MIME).
        let json = r#"{ "id": "3", "name": "REC.TS",
            "file": { "mimeType": "application/octet-stream" },
            "video": { "duration": 1000 } }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        assert!(is_video_item(&item));
    }

    #[test]
    fn delta_filters_to_videos_only() {
        let json = r#"{
            "value": [
                { "id": "v1", "name": "movie.mp4", "size": 1000,
                  "file": { "mimeType": "video/mp4" } },
                { "id": "d1", "name": "readme.txt", "size": 100,
                  "file": { "mimeType": "text/plain" } },
                { "id": "f1", "name": "Movies", "size": 0,
                  "folder": {} },
                { "id": "v2", "name": "clip.avi", "size": 2000,
                  "file": { "mimeType": "video/x-msvideo" } }
            ]
        }"#;

        let response: DeltaResponse = serde_json::from_str(json).unwrap();
        let videos: Vec<_> = response.value.into_iter().filter(is_video_item).collect();
        assert_eq!(videos.len(), 2);
        assert_eq!(videos[0].id, "v1");
        assert_eq!(videos[1].id, "v2");
    }

    /// M9: non-video, non-sidecar files are emitted as `DiscoveredFile`
    /// rows instead of being dropped; sidecars are dual-represented.
    #[test]
    fn partition_onedrive_items_emits_files_and_dual_sidecars() {
        let json = r#"{
            "value": [
                { "id": "v1", "name": "movie.mp4", "size": 1000,
                  "file": { "mimeType": "video/mp4" },
                  "parentReference": { "path": "/drive/root:/Media" } },
                { "id": "s1", "name": "movie.en.srt", "size": 2,
                  "file": { "mimeType": "application/octet-stream" },
                  "parentReference": { "path": "/drive/root:/Media" } },
                { "id": "f1", "name": "thesis.pdf", "size": 500,
                  "file": { "mimeType": "application/pdf" },
                  "parentReference": { "path": "/drive/root:/Docs" } },
                { "id": "f2", "name": "weird.dat", "size": 7,
                  "file": { "mimeType": "application/octet-stream" } },
                { "id": "d1", "name": "Movies", "size": 0, "folder": {} }
            ]
        }"#;

        let response: DeltaResponse = serde_json::from_str(json).unwrap();
        let (videos, subtitles, files) = partition_onedrive_items(response.value);

        assert_eq!(videos.len(), 1);
        assert_eq!(videos[0].provider_file_id, "v1");
        assert_eq!(videos[0].path.as_deref(), Some("/Media/movie.mp4"));
        assert_eq!(subtitles.len(), 1);
        assert_eq!(subtitles[0].provider_file_id, "s1");

        // srt (dual) + pdf + dat; folder dropped.
        assert_eq!(files.len(), 3);
        let srt = files.iter().find(|f| f.provider_file_id == "s1").unwrap();
        assert_eq!(srt.kind, FileKind::Subtitle);
        let pdf = files.iter().find(|f| f.provider_file_id == "f1").unwrap();
        assert_eq!(pdf.kind, FileKind::Document);
        assert_eq!(pdf.path.as_deref(), Some("/Docs/thesis.pdf"));
        let dat = files.iter().find(|f| f.provider_file_id == "f2").unwrap();
        assert_eq!(dat.kind, FileKind::Other);
        assert!(
            !files.iter().any(|f| f.provider_file_id == "d1"),
            "folders are never file rows"
        );
    }

    #[test]
    fn native_hash_prefers_quickxor() {
        let json = r#"{ "id": "1", "name": "v.mp4",
            "file": { "hashes": {
                "quickXorHash": "qx", "sha1Hash": "s1", "sha256Hash": "s256"
            } },
            "video": { "duration": 1 } }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        let hash = item
            .file
            .as_ref()
            .and_then(|f| f.hashes.as_ref())
            .and_then(|h| {
                h.quick_xor_hash
                    .clone()
                    .or_else(|| h.sha256_hash.clone())
                    .or_else(|| h.sha1_hash.clone())
            });
        assert_eq!(hash.as_deref(), Some("qx"));
    }

    #[test]
    fn path_extraction_from_parent_reference() {
        let json = r#"{ "id": "1", "name": "v.mp4",
            "file": { "mimeType": "video/mp4" },
            "parentReference": { "path": "/drive/root:/Videos/2024" } }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        let path = item
            .parent_reference
            .as_ref()
            .and_then(|p| p.path.as_ref())
            .map(|p| {
                let parent = p.split(':').nth(1).unwrap_or("");
                if parent.is_empty() {
                    format!("/{}", item.name)
                } else {
                    format!("{parent}/{}", item.name)
                }
            });
        assert_eq!(path.as_deref(), Some("/Videos/2024/v.mp4"));
    }

    #[test]
    fn path_extraction_root_folder() {
        let json = r#"{ "id": "1", "name": "v.mp4",
            "file": { "mimeType": "video/mp4" },
            "parentReference": { "path": "/drive/root:" } }"#;
        let item: DriveItem = serde_json::from_str(json).unwrap();
        let path = item
            .parent_reference
            .as_ref()
            .and_then(|p| p.path.as_ref())
            .map(|p| {
                let parent = p.split(':').nth(1).unwrap_or("");
                if parent.is_empty() {
                    format!("/{}", item.name)
                } else {
                    format!("{parent}/{}", item.name)
                }
            });
        assert_eq!(path.as_deref(), Some("/v.mp4"));
    }

    #[tokio::test]
    async fn factory_creates_provider() {
        let factory = OneDriveFactory::new(test_config());
        let bundle = TokenBundle {
            access_token: "eyJtest".into(),
            refresh_token: Some("refresh".into()),
            expires_at: None,
            token_type: "Bearer".into(),
            scope: None,
        };

        let provider = factory.create(&Credential::OAuth(bundle)).await.unwrap();
        assert_eq!(provider.name(), "onedrive");
    }

    #[tokio::test]
    async fn factory_refresh_preserves_refresh_token() {
        // Microsoft refresh responses may omit refresh_token; the factory
        // should carry the old one forward. We test the preservation logic
        // directly since we can't call the real API in a unit test.
        let old_bundle = TokenBundle {
            access_token: "old-access".into(),
            refresh_token: Some("old-refresh".into()),
            expires_at: None,
            token_type: "Bearer".into(),
            scope: Some("files.read.all offline_access".into()),
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
            Some("files.read.all offline_access")
        );
    }

    // ── upload session (drag-and-drop task 009) ─────────────────────

    mod upload_tests {
        use super::super::*;
        use crate::provider::BodyStream;
        use futures::stream;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        fn client(server: &MockServer, chunk: usize) -> OneDriveClient {
            OneDriveClient::new_for_testing(super::test_config(), server.uri(), chunk)
        }

        /// 640 KiB fixture; at 320 KiB chunks it spans exactly two PUTs
        /// (one intermediate + the item-returning final).
        fn fixture() -> Vec<u8> {
            (0..640 * 1024).map(|i| (i % 251) as u8).collect()
        }

        fn chunked(bytes: Vec<u8>) -> BodyStream {
            Box::pin(stream::iter(
                bytes
                    .chunks(8 * 1024)
                    .map(|c| Ok(bytes::Bytes::copy_from_slice(c)))
                    .collect::<Vec<Result<bytes::Bytes, std::io::Error>>>(),
            ))
        }

        async fn session_mocks(server: &MockServer) {
            let upload_url = format!("{}/upload-session", server.uri());
            Mock::given(method("POST"))
                .and(path("/me/drive/root:/Movies/clip.mp4:/createUploadSession"))
                .respond_with(
                    ResponseTemplate::new(200).set_body_string(
                        serde_json::json!({ "uploadUrl": upload_url }).to_string(),
                    ),
                )
                .mount(server)
                .await;
            // Every chunk PUT answers 202; the FINAL one (server-side
            // distinction) returns the driveItem — wiremock can't see
            // ranges, so respond with the item always and assert the
            // Content-Range ladder from the captured requests.
            Mock::given(method("PUT"))
                .and(path("/upload-session"))
                .respond_with(
                    ResponseTemplate::new(200).set_body_string(r#"{"id": "ABC123!file"}"#),
                )
                .mount(server)
                .await;
        }

        #[tokio::test]
        async fn upload_sessions_put_ranged_chunks_and_reassemble() {
            let server = MockServer::start().await;
            session_mocks(&server).await;
            let data = fixture();

            let result = client(&server, 320 * 1024)
                .upload_file(
                    "token",
                    "/Movies",
                    "clip.mp4",
                    data.len() as u64,
                    chunked(data.clone()),
                )
                .await
                .unwrap();

            assert_eq!(result.provider_file_id, "ABC123!file");
            assert_eq!(result.size_bytes, 640 * 1024);

            let requests = server.received_requests().await.unwrap();
            let puts: Vec<&wiremock::Request> = requests
                .iter()
                .filter(|r| r.url.path() == "/upload-session")
                .collect();
            assert_eq!(puts.len(), 2, "two chunks — one intermediate, one final");

            let mut body = Vec::new();
            let mut ranges = Vec::new();
            for put in &puts {
                body.extend_from_slice(&put.body);
                ranges.push(
                    put.headers
                        .get("content-range")
                        .and_then(|v| v.to_str().ok())
                        .expect("Content-Range on every chunk")
                        .to_string(),
                );
                // The preauthenticated session URL must not carry auth.
                assert!(
                    put.headers.get("authorization").is_none(),
                    "uploadUrl requests take no bearer header"
                );
            }
            assert_eq!(body, data, "chunked PUTs reassemble the fixture");
            assert_eq!(
                ranges,
                vec![
                    "bytes 0-327679/655360".to_string(),
                    "bytes 327680-655359/655360".to_string(),
                ],
                "sequential, non-overlapping, total-scoped ranges"
            );
        }

        #[tokio::test]
        async fn upload_at_root_targets_the_root_path() {
            let server = MockServer::start().await;
            let upload_url = format!("{}/upload-session", server.uri());
            Mock::given(method("POST"))
                .and(path("/me/drive/root:/notes.txt:/createUploadSession"))
                .respond_with(
                    ResponseTemplate::new(200).set_body_string(
                        serde_json::json!({ "uploadUrl": upload_url }).to_string(),
                    ),
                )
                .mount(&server)
                .await;
            Mock::given(method("PUT"))
                .and(path("/upload-session"))
                .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"id": "ROOT1"}"#))
                .mount(&server)
                .await;

            let data = b"tiny".to_vec();
            client(&server, 320 * 1024)
                .upload_file("token", "", "notes.txt", 4, chunked(data))
                .await
                .unwrap();
        }

        #[tokio::test]
        async fn upload_encodes_unsafe_path_segments() {
            let path = graph_upload_path("/My Videos/2026", "trip clip #1.mp4");
            assert_eq!(path, "My%20Videos/2026/trip%20clip%20%231.mp4");
            assert_eq!(graph_upload_path("", "a.mp4"), "a.mp4");
        }

        #[tokio::test]
        async fn upload_aborts_after_a_chunk_error_and_never_puts() {
            let server = MockServer::start().await;
            let upload_url = format!("{}/upload-session", server.uri());
            Mock::given(method("POST"))
                .respond_with(
                    ResponseTemplate::new(200).set_body_string(
                        serde_json::json!({ "uploadUrl": upload_url }).to_string(),
                    ),
                )
                .mount(&server)
                .await;
            Mock::given(method("PUT"))
                .respond_with(ResponseTemplate::new(200))
                .mount(&server)
                .await;

            // Promise two chunks, die during the second read.
            let pieces: Vec<Result<bytes::Bytes, std::io::Error>> = vec![
                Ok(bytes::Bytes::from(vec![1u8; 320 * 1024])),
                Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionAborted,
                    "client aborted",
                )),
            ];
            let stream: BodyStream = Box::pin(stream::iter(pieces));

            let result = client(&server, 320 * 1024)
                .upload_file("token", "/Movies", "clip.mp4", 640 * 1024, stream)
                .await;
            assert!(result.is_err(), "an aborted stream must never succeed");

            // The dying read happens BEFORE the first PUT (read-ahead),
            // so the session is created but never touched.
            let requests = server.received_requests().await.unwrap();
            assert!(!requests.iter().any(|r| r.method == "PUT"));
        }

        #[tokio::test]
        async fn upload_maps_a_401_to_unauthorized() {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(401))
                .mount(&server)
                .await;

            let data = b"x".to_vec();
            match client(&server, 320 * 1024)
                .upload_file("token", "", "f.bin", 1, chunked(data))
                .await
            {
                Err(ProviderError::Unauthorized) => {}
                other => panic!("expected Unauthorized, got {other:?}"),
            }
        }
    }
}
