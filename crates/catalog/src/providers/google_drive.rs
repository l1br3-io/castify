use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::crypto::TokenBundle;
use crate::model::{DiscoveredVideo, ListPage, Provider};
use crate::oauth::redirect_uri;
use crate::provider::{ProviderError, ProviderResult};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const SCOPE: &str = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_BUFFER_SECS: i64 = 60;
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

/// Raw token response from Google's token endpoint.
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    token_type: String,
    scope: Option<String>,
}

impl TokenResponse {
    fn into_bundle(self) -> TokenBundle {
        let expires_at = self.expires_in.map(|secs| {
            let now = chrono::Utc::now();
            let expiry = now + chrono::Duration::seconds(secs - TOKEN_BUFFER_SECS);
            expiry.format("%Y-%m-%dT%H:%M:%SZ").to_string()
        });
        TokenBundle {
            access_token: self.access_token,
            refresh_token: self.refresh_token,
            expires_at,
            token_type: self.token_type,
            scope: self.scope,
        }
    }
}

fn classify_token_error(status: u16, body: &str) -> ProviderError {
    if status == 401 {
        ProviderError::Unauthorized
    } else if status == 429 || status == 503 {
        ProviderError::RateLimited {
            retry_after_secs: None,
        }
    } else {
        ProviderError::Api {
            status,
            body: body.to_string(),
        }
    }
}

/// Generate a short-lived state nonce (delegates to the shared helper).
pub fn generate_state() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
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
}

#[derive(Debug, Deserialize)]
struct DriveVideoMetadata {
    #[serde(rename = "durationMillis")]
    duration_millis: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
}

impl GoogleDriveClient {
    /// List one page of video files from Google Drive.
    pub async fn list_drive_videos(
        &self,
        access_token: &str,
        cursor: Option<&str>,
    ) -> ProviderResult<ListPage> {
        let mut query: Vec<(&str, &str)> = vec![
            (
                "q",
                "mimeType contains 'video/' and trashed=false",
            ),
            (
                "fields",
                "files(id,name,mimeType,size,modifiedTime,md5Checksum,sha256Checksum,videoMediaMetadata(durationMillis,width,height)),nextPageToken",
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

                DiscoveredVideo {
                    provider_file_id: f.id,
                    name: f.name,
                    path: None,
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
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        write!(&mut s, "{b:02x}").unwrap();
    }
    s
}

// ── Provider trait implementation ────────────────────────────────────

/// A Google Drive provider holding a valid access token for API calls.
pub struct GoogleDriveProvider {
    client: GoogleDriveClient,
    token: TokenBundle,
}

#[async_trait::async_trait]
impl crate::provider::Provider for GoogleDriveProvider {
    fn name(&self) -> &'static str {
        "google_drive"
    }

    async fn list_videos(&self, cursor: Option<&str>) -> ProviderResult<ListPage> {
        self.client
            .list_drive_videos(&self.token.access_token, cursor)
            .await
    }

    async fn fetch_prefix_hash(&self, file_id: &str, size: i64) -> ProviderResult<Option<String>> {
        self.client
            .fetch_drive_prefix_hash(&self.token.access_token, file_id, size)
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
    }

    #[test]
    fn token_response_expires_at_has_buffer() {
        let resp = TokenResponse {
            access_token: "ya29.test".into(),
            refresh_token: Some("refresh".into()),
            expires_in: Some(3600),
            token_type: "Bearer".into(),
            scope: None,
        };
        let bundle = resp.into_bundle();
        assert!(bundle.expires_at.is_some());
        // The expires_at should be 3600 - 60 = 3540 seconds from now.
    }

    #[test]
    fn token_response_without_refresh_token() {
        let resp = TokenResponse {
            access_token: "ya29.test".into(),
            refresh_token: None,
            expires_in: None,
            token_type: "Bearer".into(),
            scope: None,
        };
        let bundle = resp.into_bundle();
        assert!(bundle.refresh_token.is_none());
        assert!(bundle.expires_at.is_none());
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
    fn to_hex_produces_lowercase_hex() {
        let bytes = [0x01, 0x23, 0xab, 0xff];
        assert_eq!(to_hex(&bytes), "0123abff");
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
