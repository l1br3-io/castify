//! S3-compatible object-storage provider (Cloudflare R2, Backblaze B2, MinIO,
//! Wasabi, AWS S3, …).
//!
//! One connection = one bucket on one endpoint; every S3 service rides this
//! code with different [`S3Credentials`]. Built on `aws-sdk-s3`, which owns
//! SigV4 signing and presigning.
//!
//! Object keys are the `provider_file_id`s; `path` is `"/{key}"` so the
//! folder tree derives from key prefixes exactly like the OAuth providers'
//! path conventions. Classification goes through the shared `common.rs`
//! extension tables — S3 listings carry no MIME type, so `.ts` stays a
//! non-video (the same rule Dropbox applies without corroboration).

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::Client;
use sha2::{Digest, Sha256};

use crate::crypto::{Credential, S3Credentials};
use crate::model::{DiscoveredFile, DiscoveredSubtitle, DiscoveredVideo, FileKind, ListPage};
use crate::provider::{
    ConnectFlow, CredentialField, CredentialsSchema, Provider, ProviderError, ProviderFactory,
    ProviderResult, StreamResponse, StreamUrl, ThumbnailData,
};
use crate::providers::common::{
    classify_kind, discovered_file_of_kind, guess_language, has_subtitle_extension,
    has_video_extension, infer_mime_type, to_hex,
};

/// Prefix-hash read window, shared with the other providers
/// (`Range: bytes=0-4194303`).
const PREFIX_BYTES: usize = 4 * 1024 * 1024;

/// Presigned-GET lifetime (OQ-1: 1 h, matching existing CDN-URL lifetimes).
/// Owner-configurable TTL was considered and deferred — a constant keeps the
/// stream-url response shape stable.
pub(crate) const PRESIGN_TTL_SECS: u64 = 3600;

/// Reported `expires_at` lead over the real presign expiry, so the frontend
/// refreshes before the object store starts returning 403s. Same idea as the
/// Dropbox temporary-link buffer, scaled to the shorter TTL.
const PRESIGN_EXPIRY_BUFFER_SECS: i64 = 300;

/// `ListObjectsV2` page size — 1000 is the S3 maximum.
const LIST_PAGE_SIZE: i32 = 1000;

// ── Pure classification logic (unit-tested; no network) ──────────────

/// One listed object, decoupled from the SDK's `Object` so the partition
/// rules are testable without a client.
struct ObjectEntry {
    key: String,
    size: i64,
    last_modified: Option<String>,
}

/// S3 represents folders as zero-byte keys ending in `/` (directory
/// markers); they are never files.
fn is_directory_key(key: &str) -> bool {
    key.ends_with('/')
}

/// Last `/`-segment of an object key — the file's display name.
fn object_name(key: &str) -> &str {
    key.rsplit('/').next().unwrap_or(key)
}

/// Full key as a Dropbox-style path (`"/Movies/clip.mp4"`) so the scanner's
/// folder tree derives from key prefixes.
fn object_path(key: &str) -> String {
    format!("/{key}")
}

/// Normalize a user-supplied key-prefix to folder semantics (OQ-2): trim,
/// drop a leading `/`, ensure a trailing `/`. Bare `"media"` must not match
/// `"mediaX/…"` keys. Empty/absent → `None` (scan the whole bucket).
fn normalize_prefix(prefix: Option<&str>) -> Option<String> {
    let trimmed = prefix?.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.ends_with('/') {
        Some(trimmed.to_string())
    } else {
        Some(format!("{trimmed}/"))
    }
}

/// Stable, secret-free identity for the `(provider, provider_account_id)`
/// uniqueness constraint: first 32 hex chars of `sha256(endpoint + bucket)`.
/// Two credentials for the same bucket on the same endpoint collide (by
/// design — that is the rotate-on-reconnect path); keys never enter the id.
fn derive_account_id(endpoint: &str, bucket: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(endpoint.as_bytes());
    hasher.update(bucket.as_bytes());
    to_hex(&hasher.finalize())[..32].to_string()
}

/// Partition one `ListObjectsV2` page into (videos, sidecar subtitles,
/// non-media files) — the S3 twin of Dropbox's `partition_dropbox_entries`.
fn partition_objects(
    entries: Vec<ObjectEntry>,
) -> (
    Vec<DiscoveredVideo>,
    Vec<DiscoveredSubtitle>,
    Vec<DiscoveredFile>,
) {
    let mut videos = Vec::new();
    let mut subtitles = Vec::new();
    let mut files = Vec::new();

    for entry in entries {
        let name = object_name(&entry.key).to_string();
        let path = object_path(&entry.key);
        if has_video_extension(&name) {
            let mime_type = infer_mime_type(&name);
            videos.push(DiscoveredVideo {
                provider_file_id: entry.key,
                name,
                path: Some(path),
                size_bytes: entry.size,
                mime_type,
                duration_ms: None,
                width: None,
                height: None,
                // S3 ETags are MD5 (or multipart digest) sums — not the
                // SHA-family hashes `native_hash` feeds, so they stay out.
                native_hash: None,
                native_hash_algo: None,
                provider_modified_at: entry.last_modified,
            });
        } else if has_subtitle_extension(&name) {
            let language = guess_language(&name);
            files.push(discovered_file_of_kind(
                FileKind::Subtitle,
                entry.key.clone(),
                name.clone(),
                Some(path.clone()),
                entry.size,
                None,
                entry.last_modified.clone(),
            ));
            subtitles.push(DiscoveredSubtitle {
                provider_file_id: entry.key,
                name,
                path: Some(path),
                language,
            });
        } else {
            files.push(discovered_file_of_kind(
                classify_kind(&name, None),
                entry.key,
                name,
                Some(path),
                entry.size,
                None,
                entry.last_modified,
            ));
        }
    }

    (videos, subtitles, files)
}

/// Classify an S3 service response into the provider-error conventions
/// shared with the OAuth providers (401/403 → auth, 404 → not found,
/// 429/503 → retryable, else Api).
fn classify_s3_error(status: u16, code: Option<&str>) -> ProviderError {
    match status {
        401 | 403 => ProviderError::Unauthorized,
        404 => ProviderError::NotFound(format!(
            "s3 object or bucket not found{}",
            code.map(|c| format!(" ({c})")).unwrap_or_default()
        )),
        429 | 503 => ProviderError::RateLimited {
            retry_after_secs: None,
        },
        _ => ProviderError::Api {
            status,
            body: code.map(String::from).unwrap_or_default(),
        },
    }
}

/// 206 when the store honored the Range (a `Content-Range` came back), 200
/// for full content.
fn stream_status_for(range_honored: bool) -> u16 {
    if range_honored {
        206
    } else {
        200
    }
}

/// Format an SDK timestamp as the house RFC-3339 string
/// (`"%Y-%m-%dT%H:%M:%SZ"`, matching `provider_modified_at` elsewhere).
fn rfc3339(t: &aws_sdk_s3::primitives::DateTime) -> Option<String> {
    chrono::DateTime::from_timestamp(t.secs(), t.subsec_nanos())
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// Convert a [`ByteStream`](aws_sdk_s3::primitives::ByteStream) into the
/// trait's streaming body type. This SDK version no longer implements
/// `futures::Stream` for `ByteStream` publicly (only `poll_next`), so a
/// small adapter bridges it — bytes are never buffered here.
fn body_stream(byte_stream: aws_sdk_s3::primitives::ByteStream) -> crate::provider::BodyStream {
    struct SdkStreamCompat(aws_sdk_s3::primitives::ByteStream);
    impl futures::Stream for SdkStreamCompat {
        type Item = Result<bytes::Bytes, std::io::Error>;
        fn poll_next(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Self::Item>> {
            let inner = std::pin::Pin::new(&mut self.get_mut().0);
            aws_sdk_s3::primitives::ByteStream::poll_next(inner, cx)
                .map(|poll| poll.map(|result| result.map_err(std::io::Error::other)))
        }
    }
    Box::pin(SdkStreamCompat(byte_stream))
}

/// Map an SDK operation error to a `ProviderError`. Service errors carry
/// both the HTTP status and the S3 error code; transport-level failures
/// (connect, DNS, timeout) surface as `Network`.
fn map_sdk_error<E: ProvideErrorMetadata>(err: SdkError<E>) -> ProviderError {
    match err {
        SdkError::ServiceError(se) => {
            classify_s3_error(se.raw().status().as_u16(), se.into_err().meta().code())
        }
        other => ProviderError::Network(other.to_string()),
    }
}

/// The declarative credentials form rendered generically by the frontend.
/// Field order is form order.
fn credentials_schema() -> CredentialsSchema {
    CredentialsSchema {
        fields: vec![
            CredentialField {
                key: "endpoint".into(),
                label: "Endpoint".into(),
                secret: false,
                placeholder: Some("https://<account>.r2.cloudflarestorage.com".into()),
            },
            CredentialField {
                key: "region".into(),
                label: "Region".into(),
                secret: false,
                placeholder: Some("auto (Cloudflare R2) · us-east-1 (MinIO)".into()),
            },
            CredentialField {
                key: "bucket".into(),
                label: "Bucket".into(),
                secret: false,
                placeholder: Some("media".into()),
            },
            CredentialField {
                key: "access_key_id".into(),
                label: "Access key ID".into(),
                secret: true,
                placeholder: Some("AKIA…".into()),
            },
            CredentialField {
                key: "secret_access_key".into(),
                label: "Secret access key".into(),
                secret: true,
                placeholder: Some("paste the secret access key".into()),
            },
            CredentialField {
                key: "prefix".into(),
                label: "Key prefix (optional)".into(),
                secret: false,
                placeholder: Some("media/".into()),
            },
        ],
    }
}

// ── SDK-backed provider ──────────────────────────────────────────────

/// An authenticated S3 bucket view: SDK client + bucket + normalized scan
/// prefix. Built per connection from its decrypted `S3Credentials`.
pub struct S3Provider {
    client: Client,
    bucket: String,
    prefix: Option<String>,
}

fn build_client(creds: &S3Credentials) -> Client {
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::v2026_01_12())
        .endpoint_url(&creds.endpoint)
        .region(Region::new(creds.region.clone()))
        .credentials_provider(Credentials::new(
            creds.access_key_id.clone(),
            creds.secret_access_key.clone(),
            None,
            None,
            "castify-s3-connection",
        ))
        // Path-style addressing (bucket in the path, not a subdomain):
        // MinIO/R2 and friends require it, and it survives endpoints with
        // ports where virtual-host style cannot work at all.
        .force_path_style(true)
        .build();
    Client::from_conf(config)
}

impl S3Provider {
    pub fn new(creds: &S3Credentials) -> Self {
        Self {
            client: build_client(creds),
            bucket: creds.bucket.clone(),
            prefix: normalize_prefix(creds.prefix.as_deref()),
        }
    }

    /// `HeadBucket` — cheapest authoritative "bucket exists and these keys
    /// can list it" probe. Used by the factory's `verify`.
    async fn assert_bucket_reachable(&self) -> ProviderResult<()> {
        self.client
            .head_bucket()
            .bucket(&self.bucket)
            .send()
            .await
            .map(|_| ())
            .map_err(map_sdk_error)
    }

    /// Delete one object. Not part of the `Provider` trait — Castify never
    /// mutates provider storage; this exists for the e2e hook that
    /// simulates owner-side deletions (catalog-prune) against real MinIO.
    pub async fn delete_object(&self, key: &str) -> ProviderResult<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map(|_| ())
            .map_err(map_sdk_error)
    }

    /// Put one object — the e2e hook's restore counterpart to
    /// [`Self::delete_object`]. `content_type` should mirror what `mc cp`
    /// set on the original object, or downstream consumers (stream proxy,
    /// browser `<video>`) see `application/octet-stream`.
    pub async fn put_object(
        &self,
        key: &str,
        body: Vec<u8>,
        content_type: Option<&str>,
    ) -> ProviderResult<()> {
        let mut request = self.client.put_object().bucket(&self.bucket).key(key);
        if let Some(ct) = content_type {
            request = request.content_type(ct);
        }
        request
            .body(body.into())
            .send()
            .await
            .map(|_| ())
            .map_err(map_sdk_error)
    }
}

#[async_trait::async_trait]
impl crate::provider::Provider for S3Provider {
    fn name(&self) -> &'static str {
        "s3"
    }

    async fn list_videos(&self, cursor: Option<&str>) -> ProviderResult<ListPage> {
        let mut request = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .max_keys(LIST_PAGE_SIZE);
        if let Some(prefix) = &self.prefix {
            request = request.prefix(prefix);
        }
        if let Some(token) = cursor {
            request = request.continuation_token(token);
        }
        let response = request.send().await.map_err(map_sdk_error)?;

        let entries = response
            .contents()
            .iter()
            .filter(|object| object.key().is_some_and(|key| !is_directory_key(key)))
            .map(|object| ObjectEntry {
                key: object.key().unwrap().to_string(),
                size: object.size().unwrap_or(0),
                last_modified: object.last_modified().and_then(rfc3339),
            })
            .collect();
        let (videos, subtitles, files) = partition_objects(entries);

        Ok(ListPage {
            videos,
            subtitles,
            files,
            next_cursor: response.next_continuation_token().map(String::from),
        })
    }

    async fn fetch_prefix_hash(&self, file_id: &str, size: i64) -> ProviderResult<Option<String>> {
        if size < PREFIX_BYTES as i64 {
            return Ok(None);
        }
        let output = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(file_id)
            .range(format!("bytes=0-{}", PREFIX_BYTES - 1))
            .send()
            .await
            .map_err(map_sdk_error)?;
        let mut reader = output.body.into_async_read();
        let mut bytes = Vec::with_capacity(PREFIX_BYTES);
        tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut bytes)
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Ok(Some(to_hex(&hasher.finalize())))
    }

    /// Spec assumption 5: S3 media gets no synthesized thumbnails — the
    /// catalog's existing no-thumbnail rendering covers poster tiles.
    async fn fetch_thumbnail(&self, _file_id: &str) -> ProviderResult<ThumbnailData> {
        Err(ProviderError::NotFound(
            "S3-compatible storage has no thumbnails".into(),
        ))
    }

    async fn open_stream(
        &self,
        file_id: &str,
        range: Option<&str>,
    ) -> ProviderResult<StreamResponse> {
        let mut request = self.client.get_object().bucket(&self.bucket).key(file_id);
        if let Some(range) = range {
            request = request.range(range);
        }
        let output = request.send().await.map_err(map_sdk_error)?;

        let content_range = output.content_range().map(String::from);
        let status = stream_status_for(content_range.is_some());
        let content_type = output
            .content_type()
            .unwrap_or("application/octet-stream")
            .to_string();
        let content_length = output.content_length().map(|len| len as u64);
        let body = body_stream(output.body);

        Ok(StreamResponse {
            status,
            content_type,
            content_length,
            content_range,
            body: Box::pin(body),
        })
    }

    /// Presigned GET, handed to the browser so video bytes never transit
    /// the Castify server — the R2 zero-egress win that motivates direct
    /// streaming for this provider. Presigning is pure local SigV4
    /// computation (no network round-trip), so this can never stall a
    /// playback request. TTL is [`PRESIGN_TTL_SECS`] (OQ-1: 1 h); proxy
    /// streaming via `open_stream` remains the fallback path.
    async fn open_stream_url(&self, file_id: &str) -> ProviderResult<StreamUrl> {
        let config = PresigningConfig::expires_in(std::time::Duration::from_secs(PRESIGN_TTL_SECS))
            .map_err(|e| ProviderError::Other(format!("presigning config: {e}")))?;
        let presigned = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(file_id)
            .presigned(config)
            .await
            .map_err(map_sdk_error)?;
        let expires_at = (chrono::Utc::now()
            + chrono::Duration::seconds(PRESIGN_TTL_SECS as i64 - PRESIGN_EXPIRY_BUFFER_SECS))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
        Ok(StreamUrl::Direct {
            url: presigned.uri().to_string(),
            expires_at: Some(expires_at),
        })
    }
}

// ── Factory ──────────────────────────────────────────────────────────

/// Credential-form factory for S3-compatible storage. No server-level
/// configuration exists (unlike the OAuth client id/secrets) — the registry
/// always hands this out.
pub struct S3Factory;

fn expect_s3(credential: &Credential) -> ProviderResult<&S3Credentials> {
    match credential {
        Credential::S3(creds) => Ok(creds),
        _ => Err(ProviderError::Other(
            "s3 connects via a credentials form; other credential kinds are not supported".into(),
        )),
    }
}

#[async_trait::async_trait]
impl ProviderFactory for S3Factory {
    fn name(&self) -> &'static str {
        "s3"
    }

    fn connect_flow(&self) -> ConnectFlow {
        ConnectFlow::Credentials(credentials_schema())
    }

    async fn create(
        &self,
        credential: &Credential,
    ) -> ProviderResult<Box<dyn crate::provider::Provider>> {
        let creds = expect_s3(credential)?;
        Ok(Box::new(S3Provider::new(creds)))
    }

    /// `HeadBucket` + one `ListObjectsV2` page: proves the endpoint is
    /// reachable, the bucket exists, and the keys can read it before the
    /// connection is persisted. Logs endpoint + bucket only — never keys.
    async fn verify(
        &self,
        credential: &Credential,
    ) -> ProviderResult<(Option<String>, Option<String>)> {
        let creds = expect_s3(credential)?;
        let provider = S3Provider::new(creds);
        provider.assert_bucket_reachable().await?;
        provider.list_videos(None).await?;
        tracing::debug!(endpoint = %creds.endpoint, bucket = %creds.bucket, "s3 credential verified");
        Ok((
            Some(derive_account_id(&creds.endpoint, &creds.bucket)),
            None,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::TokenBundle;
    use crate::provider::ProviderFactory;

    fn entry(key: &str, size: i64) -> ObjectEntry {
        ObjectEntry {
            key: key.into(),
            size,
            last_modified: Some("2026-09-01T12:00:00Z".into()),
        }
    }

    /// OQ-1's working decision, pinned: 1 h presign TTL.
    #[test]
    fn presign_ttl_is_one_hour() {
        assert_eq!(PRESIGN_TTL_SECS, 3600);
    }

    #[test]
    fn derive_account_id_is_stable_32_hex_and_secret_free() {
        let id = derive_account_id("https://acct.r2.cloudflarestorage.com", "media");
        assert_eq!(id.len(), 32);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        // Deterministic: same inputs, same id.
        assert_eq!(
            id,
            derive_account_id("https://acct.r2.cloudflarestorage.com", "media")
        );
        // Different bucket or endpoint → different id (separate connections).
        assert_ne!(
            id,
            derive_account_id("https://acct.r2.cloudflarestorage.com", "other")
        );
        assert_ne!(id, derive_account_id("http://localhost:9000", "media"));
        // The identity never embeds secret material.
        assert!(!id.contains("secret"));
    }

    #[test]
    fn normalize_prefix_applies_folder_semantics() {
        assert_eq!(normalize_prefix(None), None);
        assert_eq!(normalize_prefix(Some("")), None);
        assert_eq!(normalize_prefix(Some("   ")), None);
        assert_eq!(normalize_prefix(Some("/")), None);
        assert_eq!(normalize_prefix(Some("media")), Some("media/".into()));
        assert_eq!(normalize_prefix(Some("media/")), Some("media/".into()));
        assert_eq!(normalize_prefix(Some("/media")), Some("media/".into()));
        // Bare "media" must not match "mediaX/…" keys.
        assert_eq!(normalize_prefix(Some("a/b")), Some("a/b/".into()));
    }

    #[test]
    fn is_directory_key_detects_markers() {
        assert!(is_directory_key("Movies/"));
        assert!(is_directory_key("/"));
        assert!(!is_directory_key("Movies/clip.mp4"));
    }

    /// The classification contract: extension tables decide, `.ts` stays
    /// non-video (S3 listings carry no MIME to corroborate it), sidecars
    /// dual-represent, unknowns degrade to `Other`.
    #[test]
    fn partition_objects_classifies_keys() {
        let (videos, subtitles, files) = partition_objects(vec![
            entry("Movies/blade.mkv", 1),
            entry("trailers/teaser.MP4", 2),
            entry("Movies/blade.en.srt", 3),
            entry("Movies/notes.vtt", 4),
            entry("Music/song.mp3", 5),
            entry("Pics/cover.jpg", 6),
            entry("src/main.ts", 7),
            entry("weird.dat", 8),
        ]);

        assert_eq!(videos.len(), 2);
        assert_eq!(videos[0].provider_file_id, "Movies/blade.mkv");
        assert_eq!(videos[0].mime_type.as_deref(), Some("video/x-matroska"));
        assert_eq!(
            videos[0].provider_modified_at.as_deref(),
            Some("2026-09-01T12:00:00Z")
        );

        assert_eq!(subtitles.len(), 2);
        assert_eq!(subtitles[0].provider_file_id, "Movies/blade.en.srt");
        assert_eq!(subtitles[0].language.as_deref(), Some("en"));

        let kinds: Vec<(String, FileKind)> = files
            .iter()
            .map(|f| (f.provider_file_id.clone(), f.kind))
            .collect();
        assert!(kinds.contains(&("Music/song.mp3".into(), FileKind::Audio)));
        assert!(kinds.contains(&("Pics/cover.jpg".into(), FileKind::Image)));
        // `.ts` without corroboration: not a video, not a subtitle — Other.
        assert!(kinds.contains(&("src/main.ts".into(), FileKind::Other)));
        assert!(kinds.contains(&("weird.dat".into(), FileKind::Other)));
        // Sidecar dual-representation: srt/vtt appear as file rows too.
        assert!(kinds.contains(&("Movies/blade.en.srt".into(), FileKind::Subtitle)));
        assert!(kinds.contains(&("Movies/notes.vtt".into(), FileKind::Subtitle)));
    }

    #[test]
    fn partition_maps_key_to_id_name_and_slash_path() {
        let (videos, subtitles, files) = partition_objects(vec![
            entry("Movies/Sci-fi/blade.mkv", 42),
            entry("trailer.mp4", 7),
            entry("docs/readme.txt", 1),
        ]);
        assert_eq!(videos[0].provider_file_id, "Movies/Sci-fi/blade.mkv");
        assert_eq!(videos[0].name, "blade.mkv");
        assert_eq!(videos[0].path.as_deref(), Some("/Movies/Sci-fi/blade.mkv"));
        assert_eq!(videos[0].size_bytes, 42);
        assert_eq!(videos[1].name, "trailer.mp4");
        assert_eq!(videos[1].path.as_deref(), Some("/trailer.mp4"));
        assert_eq!(subtitles.len(), 0);
        assert_eq!(files[0].kind, FileKind::Document);
        assert_eq!(files[0].path.as_deref(), Some("/docs/readme.txt"));
    }

    #[test]
    fn object_name_extracts_last_segment() {
        assert_eq!(object_name("a/b/clip.mp4"), "clip.mp4");
        assert_eq!(object_name("clip.mp4"), "clip.mp4");
    }

    /// SDK error mapping per `ProviderError` conventions: 401/403 →
    /// Unauthorized (S3 signals bad keys with 403), 404 → NotFound, 429/503
    /// → RateLimited, other statuses → Api.
    #[test]
    fn classify_s3_error_maps_statuses() {
        assert!(matches!(
            classify_s3_error(401, None),
            ProviderError::Unauthorized
        ));
        assert!(matches!(
            classify_s3_error(403, Some("AccessDenied")),
            ProviderError::Unauthorized
        ));
        assert!(matches!(
            classify_s3_error(404, Some("NoSuchKey")),
            ProviderError::NotFound(_)
        ));
        assert!(matches!(
            classify_s3_error(429, Some("RequestThrottled")),
            ProviderError::RateLimited { .. }
        ));
        assert!(matches!(
            classify_s3_error(503, Some("SlowDown")),
            ProviderError::RateLimited { .. }
        ));
        assert!(matches!(
            classify_s3_error(500, None),
            ProviderError::Api { status: 500, .. }
        ));
        assert!(matches!(
            classify_s3_error(400, Some("InvalidRequest")),
            ProviderError::Api { status: 400, .. }
        ));
    }

    #[test]
    fn stream_status_follows_content_range_presence() {
        assert_eq!(stream_status_for(true), 206);
        assert_eq!(stream_status_for(false), 200);
    }

    /// The schema is the rendered form's contract — assert the exact
    /// serialized shape so adding a field is a deliberate, visible change.
    #[test]
    fn credentials_schema_shape_is_the_form_contract() {
        let json = serde_json::to_value(credentials_schema()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "fields": [
                    { "key": "endpoint", "label": "Endpoint", "secret": false,
                      "placeholder": "https://<account>.r2.cloudflarestorage.com" },
                    { "key": "region", "label": "Region", "secret": false,
                      "placeholder": "auto (Cloudflare R2) · us-east-1 (MinIO)" },
                    { "key": "bucket", "label": "Bucket", "secret": false,
                      "placeholder": "media" },
                    { "key": "access_key_id", "label": "Access key ID", "secret": true,
                      "placeholder": "AKIA…" },
                    { "key": "secret_access_key", "label": "Secret access key", "secret": true,
                      "placeholder": "paste the secret access key" },
                    { "key": "prefix", "label": "Key prefix (optional)", "secret": false,
                      "placeholder": "media/" }
                ]
            })
        );
    }

    fn oauth_credential() -> Credential {
        Credential::OAuth(TokenBundle {
            access_token: "ya29.test".into(),
            refresh_token: None,
            expires_at: None,
            token_type: "Bearer".into(),
            scope: None,
        })
    }

    /// The credential-flow factory rejects OAuth bundles before any client
    /// is built — no network, just the type gate. (`match` rather than
    /// `unwrap_err` — the boxed provider isn't `Debug`.)
    #[tokio::test]
    async fn factory_rejects_oauth_credential() {
        match S3Factory.create(&oauth_credential()).await {
            Err(ProviderError::Other(_)) => {}
            Err(other) => panic!("expected Other, got {other:?}"),
            Ok(_) => panic!("create must reject OAuth credentials"),
        }
        match S3Factory.verify(&oauth_credential()).await {
            Err(ProviderError::Other(_)) => {}
            Err(other) => panic!("expected Other, got {other:?}"),
            Ok(_) => panic!("verify must reject OAuth credentials"),
        }
    }

    /// `create` builds a provider locally (no network) — proving the
    /// factory wiring and the trait dispatch end-to-end.
    #[tokio::test]
    async fn factory_creates_s3_provider_from_credentials() {
        let credential = Credential::S3(S3Credentials {
            endpoint: "http://localhost:9000".into(),
            region: "us-east-1".into(),
            bucket: "media".into(),
            access_key_id: "minioadmin".into(),
            secret_access_key: "minioadmin".into(),
            prefix: Some("media".into()),
        });
        let provider = S3Factory.create(&credential).await.unwrap();
        assert_eq!(provider.name(), "s3");
    }

    /// The factory's connect flow is the declarative credentials schema the
    /// frontend renders generically.
    #[test]
    fn factory_connect_flow_is_credentials_schema() {
        match S3Factory.connect_flow() {
            ConnectFlow::Credentials(schema) => {
                let keys: Vec<&str> = schema.fields.iter().map(|f| f.key.as_str()).collect();
                assert_eq!(
                    keys,
                    vec![
                        "endpoint",
                        "region",
                        "bucket",
                        "access_key_id",
                        "secret_access_key",
                        "prefix"
                    ]
                );
                let secret_flags: Vec<bool> = schema.fields.iter().map(|f| f.secret).collect();
                assert_eq!(secret_flags, vec![false, false, false, true, true, false]);
            }
            ConnectFlow::OAuth(_) => panic!("s3 must connect via a credentials form"),
        }
    }
}
