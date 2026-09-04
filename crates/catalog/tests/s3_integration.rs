//! Integration tests for the S3-compatible provider against ephemeral
//! MinIO containers (task 006 of the s3-compatible-storage effort).
//!
//! These exercise the real `aws-sdk-s3` paths — SigV4 signing,
//! `ListObjectsV2` pagination, range reads, presigning — against a live
//! object store, not mocks. Each test starts its own MinIO (≈1 s once the
//! image is cached) with its own bucket and drops the container when it
//! ends, so parallel tests never share state.
//!
//! When docker is unavailable every test here SKIPs with a message rather
//! than failing — see the GOTCHA on [`docker_available`].

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as AdminClient;
use castify_catalog::crypto::{Credential, S3Credentials};
use castify_catalog::provider::{BodyStream, Provider, ProviderError, ProviderFactory, StreamUrl};
use castify_catalog::providers::s3::{S3Factory, S3Provider};
use castify_catalog::FileKind;
use futures::{stream, StreamExt};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::time::Duration;
use testcontainers::runners::AsyncRunner;
use testcontainers::ContainerAsync;
use testcontainers_modules::minio::MinIO;

// ── Harness ──────────────────────────────────────────────────────────

/// The provider's prefix-hash read window (mirrors `PREFIX_BYTES` in
/// `providers/s3.rs` — 4 MiB).
const PREFIX_BYTES: usize = 4 * 1024 * 1024;

/// One ephemeral MinIO: endpoint + an SDK admin client for seeding. The
/// container handle lives in the test's scope so testcontainers removes
/// the container when the test returns.
struct Minio {
    endpoint: String,
    admin: AdminClient,
    _container: ContainerAsync<MinIO>,
}

// GOTCHA: `cargo test --all` (CI, `just test`) also runs on machines with
// no docker — these tests must skip, not fail, there. The probe resolves
// docker exactly like testcontainers itself would (DOCKER_HOST env var,
// rootless and default sockets) and pings the daemon, rather than checking
// for a `docker` binary: a binary without a running daemon must skip too,
// and a remote DOCKER_HOST must not.
async fn docker_available() -> bool {
    match testcontainers::core::client::docker_client_instance().await {
        Ok(docker) => docker.ping().await.is_ok(),
        Err(_) => false,
    }
}

/// Start MinIO, or return `None` (after printing why) when docker is
/// unavailable — the caller's `let Some(minio) = … else { return; }` turns
/// that into a skip.
async fn start_minio() -> Option<Minio> {
    if !docker_available().await {
        eprintln!("SKIP: docker is not available — s3 integration tests need a MinIO container");
        return None;
    }
    let container = match MinIO::default().start().await {
        Ok(container) => container,
        Err(err) => {
            eprintln!("SKIP: MinIO container failed to start: {err}");
            return None;
        }
    };
    let port = container
        .get_host_port_ipv4(9000)
        .await
        .expect("minio exposes port 9000");
    let endpoint = format!("http://127.0.0.1:{port}");
    let admin = admin_client(&endpoint);
    Some(Minio {
        endpoint,
        admin,
        _container: container,
    })
}

/// Seeding client using MinIO's default root credentials. Path-style, like
/// the provider's own client.
fn admin_client(endpoint: &str) -> AdminClient {
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::v2026_01_12())
        .endpoint_url(endpoint)
        .region(Region::new("us-east-1"))
        .credentials_provider(Credentials::new(
            "minioadmin",
            "minioadmin",
            None,
            None,
            "castify-s3-integration-test",
        ))
        .force_path_style(true)
        .build();
    AdminClient::from_conf(config)
}

/// The bucket every test in its own MinIO instance seeds and scans.
const BUCKET: &str = "media";

/// Create the test bucket. The container's wait strategy (stdout "API:")
/// can race the listener by a few milliseconds on slow machines, so retry
/// transient failures briefly before giving up loudly.
async fn create_bucket(minio: &Minio) {
    let mut last_err = None;
    for _ in 0..20 {
        match minio.admin.create_bucket().bucket(BUCKET).send().await {
            Ok(_) => return,
            Err(err) => {
                last_err = Some(err.to_string());
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    panic!("minio never accepted CreateBucket for {BUCKET}: {last_err:?}");
}

/// Seed one object.
async fn put(minio: &Minio, key: &str, body: Vec<u8>) {
    minio
        .admin
        .put_object()
        .bucket(BUCKET)
        .key(key)
        .body(ByteStream::from(body))
        .send()
        .await
        .unwrap_or_else(|err| panic!("seed put of {key} failed: {err}"));
}

/// Provider credentials for the test MinIO (valid keys, `media` bucket).
fn s3_creds(endpoint: &str, prefix: Option<&str>) -> S3Credentials {
    S3Credentials {
        endpoint: endpoint.to_string(),
        region: "us-east-1".into(),
        bucket: BUCKET.into(),
        access_key_id: "minioadmin".into(),
        secret_access_key: "minioadmin".into(),
        prefix: prefix.map(String::from),
    }
}

/// Deterministic pseudorandom bytes (xorshift64) — the tests hash and
/// range-compare these locally, so the content must be reproducible.
fn deterministic_bytes(len: usize) -> Vec<u8> {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 56) as u8
        })
        .collect()
}

/// Lowercase hex, matching the provider's `to_hex` output format.
fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Drain a provider streaming body into a Vec.
async fn collect_body(body: BodyStream) -> Vec<u8> {
    let mut out = Vec::new();
    let mut body = body;
    while let Some(chunk) = body.next().await {
        out.extend_from_slice(&chunk.expect("stream chunk"));
    }
    out
}

// ── Tests ────────────────────────────────────────────────────────────

/// 1001 keys under `bulk/` (one more than the provider's max-keys page
/// size): page one comes back full with a continuation token, page two
/// finishes the listing, and the `bulk/` prefix keeps an outside key out.
#[tokio::test]
async fn list_videos_paginates_with_continuation_and_applies_prefix() {
    let Some(minio) = start_minio().await else {
        return;
    };
    create_bucket(&minio).await;

    let keys: Vec<String> = (0..=1000).map(|i| format!("bulk/obj-{i:04}.bin")).collect();
    let minio_ref = &minio;
    stream::iter(keys.clone())
        .for_each_concurrent(16, move |key| async move {
            put(minio_ref, &key, vec![b'.'; 8]).await;
        })
        .await;
    put(&minio, "outside/leak.mp4", b"must-not-appear".to_vec()).await;

    let provider = S3Provider::new(&s3_creds(&minio.endpoint, Some("bulk")));

    let page_one = provider.list_videos(None).await.unwrap();
    let page_one_len = page_one.videos.len() + page_one.subtitles.len() + page_one.files.len();
    assert_eq!(page_one_len, 1000, "first page must be full (S3 max-keys)");
    assert!(
        page_one.videos.is_empty() && page_one.subtitles.is_empty(),
        ".bin keys classify as Other files, never media"
    );
    let cursor = page_one
        .next_cursor
        .expect("1001 keys must leave a continuation token");

    let page_two = provider.list_videos(Some(cursor.as_str())).await.unwrap();
    let page_two_len = page_two.videos.len() + page_two.subtitles.len() + page_two.files.len();
    assert_eq!(page_two_len, 1, "second page carries the remainder");
    assert!(page_two.next_cursor.is_none(), "pagination must terminate");

    let listed: BTreeSet<String> = page_one
        .files
        .iter()
        .chain(&page_two.files)
        .map(|file| file.provider_file_id.clone())
        .collect();
    let expected: BTreeSet<String> = keys.into_iter().collect();
    assert_eq!(
        listed, expected,
        "the prefix must include every bulk key and nothing else (no outside/ leak)"
    );
    assert!(
        page_one
            .files
            .iter()
            .all(|file| file.kind == FileKind::Other),
        ".bin classifies as Other on real keys"
    );
}

/// Extension classification on real listed keys: video by extension,
/// sidecar subtitles dual-represented, audio/document/other by table,
/// and zero-byte directory-marker keys (`Movies/`) never surface.
#[tokio::test]
async fn list_videos_classifies_real_keys() {
    let Some(minio) = start_minio().await else {
        return;
    };
    create_bucket(&minio).await;

    let video_bytes = b"fake-matroska-bytes".to_vec();
    put(&minio, "Movies/", Vec::new()).await;
    put(&minio, "Movies/blade.mkv", video_bytes.clone()).await;
    put(
        &minio,
        "Movies/blade.en.srt",
        b"1\n00:00:01 --> x\nhi\n".to_vec(),
    )
    .await;
    put(&minio, "Movies/notes.vtt", b"WEBVTT\n".to_vec()).await;
    put(&minio, "Music/song.mp3", b"id3".to_vec()).await;
    put(&minio, "docs/readme.md", b"# hi".to_vec()).await;
    put(&minio, "src/main.ts", b"export {}".to_vec()).await;
    put(&minio, "weird.dat", b"\x00\x01".to_vec()).await;

    let provider = S3Provider::new(&s3_creds(&minio.endpoint, None));
    let page = provider.list_videos(None).await.unwrap();
    assert!(page.next_cursor.is_none(), "eight objects fit one page");

    assert_eq!(page.videos.len(), 1);
    let video = &page.videos[0];
    assert_eq!(video.provider_file_id, "Movies/blade.mkv");
    assert_eq!(video.name, "blade.mkv");
    assert_eq!(video.path.as_deref(), Some("/Movies/blade.mkv"));
    assert_eq!(video.size_bytes, video_bytes.len() as i64);
    assert_eq!(video.mime_type.as_deref(), Some("video/x-matroska"));
    assert!(
        video.provider_modified_at.is_some(),
        "MinIO always reports LastModified"
    );

    assert_eq!(page.subtitles.len(), 2);
    assert_eq!(page.subtitles[0].provider_file_id, "Movies/blade.en.srt");
    assert_eq!(page.subtitles[0].language.as_deref(), Some("en"));
    assert_eq!(page.subtitles[1].provider_file_id, "Movies/notes.vtt");

    let kinds: std::collections::BTreeMap<String, FileKind> = page
        .files
        .iter()
        .map(|file| (file.provider_file_id.clone(), file.kind))
        .collect();
    assert_eq!(kinds.get("Music/song.mp3"), Some(&FileKind::Audio));
    assert_eq!(kinds.get("docs/readme.md"), Some(&FileKind::Document));
    // `.ts` without MIME corroboration stays non-video.
    assert_eq!(kinds.get("src/main.ts"), Some(&FileKind::Other));
    assert_eq!(kinds.get("weird.dat"), Some(&FileKind::Other));
    // Sidecars dual-represent as Subtitle file rows.
    assert_eq!(kinds.get("Movies/blade.en.srt"), Some(&FileKind::Subtitle));
    assert_eq!(kinds.get("Movies/notes.vtt"), Some(&FileKind::Subtitle));
    // The directory-marker key must not appear anywhere.
    assert!(!kinds.contains_key("Movies/"));
}

/// The prefix hash equals a locally computed SHA-256 of the first 4 MiB
/// (proving the Range read really stops at the window), and the size gate
/// returns None for sub-4-MiB files.
#[tokio::test]
async fn fetch_prefix_hash_matches_locally_computed_sha256() {
    let Some(minio) = start_minio().await else {
        return;
    };
    create_bucket(&minio).await;

    let big = deterministic_bytes(PREFIX_BYTES + 1000);
    put(&minio, "Movies/big.mkv", big.clone()).await;
    put(&minio, "small.txt", b"tiny-file".to_vec()).await;

    let provider = S3Provider::new(&s3_creds(&minio.endpoint, None));

    let mut hasher = Sha256::new();
    hasher.update(&big[..PREFIX_BYTES]);
    let expected = hex_lower(&hasher.finalize());

    let fetched = provider
        .fetch_prefix_hash("Movies/big.mkv", big.len() as i64)
        .await
        .unwrap()
        .expect("4 MiB+ object must be hashed");
    assert_eq!(
        fetched, expected,
        "range read must cover exactly the first 4 MiB"
    );

    assert_eq!(
        provider.fetch_prefix_hash("small.txt", 10).await.unwrap(),
        None,
        "files under the 4 MiB window are never hashed"
    );
}

/// `open_stream` without a Range serves the full object (200); with a
/// Range it serves 206 + `Content-Range` + exactly the requested slice.
#[tokio::test]
async fn open_stream_serves_full_and_partial_content() {
    let Some(minio) = start_minio().await else {
        return;
    };
    create_bucket(&minio).await;

    let big = deterministic_bytes(PREFIX_BYTES + 1000);
    let key = "Movies/big.mkv";
    put(&minio, key, big.clone()).await;

    let provider = S3Provider::new(&s3_creds(&minio.endpoint, None));

    let full = provider.open_stream(key, None).await.unwrap();
    assert_eq!(full.status, 200);
    assert_eq!(full.content_range, None);
    assert_eq!(full.content_length, Some(big.len() as u64));
    assert_eq!(collect_body(full.body).await, big);

    let partial = provider
        .open_stream(key, Some("bytes=100-199"))
        .await
        .unwrap();
    assert_eq!(partial.status, 206);
    let expected_range = format!("bytes 100-199/{}", big.len());
    assert_eq!(
        partial.content_range.as_deref(),
        Some(expected_range.as_str())
    );
    assert_eq!(partial.content_length, Some(100));
    assert_eq!(collect_body(partial.body).await, big[100..200].to_vec());
}

/// The presigned URL fetches anonymously (SigV4 query auth baked in),
/// honors Range like any GET, and `expires_at` leads the 1 h real expiry
/// by the 300 s refresh buffer.
#[tokio::test]
async fn presigned_url_fetches_without_auth_honors_range_and_expires() {
    let Some(minio) = start_minio().await else {
        return;
    };
    create_bucket(&minio).await;

    let big = deterministic_bytes(PREFIX_BYTES + 1000);
    let key = "Movies/big.mkv";
    put(&minio, key, big.clone()).await;

    let provider = S3Provider::new(&s3_creds(&minio.endpoint, None));

    let StreamUrl::Direct { url, expires_at } = provider.open_stream_url(key).await.unwrap() else {
        panic!("s3 must direct-stream via a presigned URL");
    };
    assert!(url.contains("X-Amz-Signature="), "SigV4 query auth: {url}");
    assert!(url.contains("X-Amz-Expires=3600"), "OQ-1 1 h TTL: {url}");

    let expires_at = expires_at.expect("presigned URL reports expires_at");
    let expires = chrono::NaiveDateTime::parse_from_str(&expires_at, "%Y-%m-%dT%H:%M:%SZ")
        .expect("RFC-3339 UTC format")
        .and_utc();
    let lead = expires
        .signed_duration_since(chrono::Utc::now())
        .num_seconds();
    assert!(
        (3200..=3400).contains(&lead),
        "expires_at must lead now by ~3300 s (1 h TTL minus 300 s buffer), got {lead} s"
    );

    let http = reqwest::Client::new();
    let response = http.get(&url).send().await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.bytes().await.unwrap().to_vec(), big);

    let response = http
        .get(&url)
        .header("Range", "bytes=0-99")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 206);
    assert_eq!(
        response.bytes().await.unwrap().to_vec(),
        big[..100].to_vec()
    );
}

/// Error mapping against real MinIO responses: wrong secret keys → 403 →
/// `Unauthorized` (both listing and the factory's connect-time `verify`),
/// missing object → 404 → `NotFound`, missing bucket → 404 → `NotFound`.
#[tokio::test]
async fn sdk_errors_map_to_provider_error_conventions() {
    let Some(minio) = start_minio().await else {
        return;
    };
    create_bucket(&minio).await;
    put(&minio, "Movies/blade.mkv", b"v".to_vec()).await;

    // Bad secret key.
    let mut bad = s3_creds(&minio.endpoint, None);
    bad.secret_access_key = "wrong-secret".into();
    match S3Provider::new(&bad).list_videos(None).await {
        Err(ProviderError::Unauthorized) => {}
        Err(other) => panic!("bad keys must map to Unauthorized, got {other:?}"),
        Ok(_) => panic!("wrong secret must not list the bucket"),
    }
    // The connect path hardens identically: verify rejects bad keys.
    match S3Factory.verify(&Credential::S3(bad)).await {
        Err(ProviderError::Unauthorized) => {}
        Err(other) => panic!("verify must reject bad keys as Unauthorized, got {other:?}"),
        Ok(_) => panic!("verify must reject wrong credentials"),
    }

    // Happy-path verify: reachability proven, account id derived (32
    // lowercase hex chars, secret-free — see the unit tests in s3.rs).
    let (account_id, email) = S3Factory
        .verify(&Credential::S3(s3_creds(&minio.endpoint, None)))
        .await
        .unwrap();
    let account_id = account_id.expect("verify derives the account id");
    assert_eq!(account_id.len(), 32);
    assert!(
        account_id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "account id is 32 lowercase hex chars: {account_id}"
    );
    assert!(email.is_none(), "s3 has no account email");

    // Missing object.
    let provider = S3Provider::new(&s3_creds(&minio.endpoint, None));
    match provider.open_stream("no/such/object.mp4", None).await {
        Err(ProviderError::NotFound(_)) => {}
        Err(other) => panic!("missing object must map to NotFound, got {other:?}"),
        Ok(_) => panic!("missing object must not stream"),
    }

    // Missing bucket.
    let mut ghost = s3_creds(&minio.endpoint, None);
    ghost.bucket = "no-such-bucket".into();
    match S3Provider::new(&ghost).list_videos(None).await {
        Err(ProviderError::NotFound(_)) => {}
        Err(other) => panic!("missing bucket must map to NotFound, got {other:?}"),
        Ok(_) => panic!("missing bucket must not list"),
    }
}
