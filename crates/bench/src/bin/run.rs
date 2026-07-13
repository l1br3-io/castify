//! bench-run: HTTP latency benchmark against a live API on a seeded 10K catalog.
//!
//! Runs five scenarios (no-filter, FTS5 search, composed filters, folders,
//! thumbnail cache hit), each with a warmup phase followed by timed requests.
//! Computes p50 / p99 / mean, asserts PRD NFR thresholds, and prints a table.
//! Exits non-zero if any scenario exceeds its target.
//!
//! Usage:
//!   cargo run -p castify-bench --bin run -- --session <token> [--base-url URL]
//!
//! The session token is the `castify_session` cookie value obtained from
//! `POST /api/setup` (or login). Override sample counts via `BENCH_WARMUP`
//! and `BENCH_RUNS` env vars (defaults: 20 warmup, 200 timed).

use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

struct Args {
    base_url: String,
    session: String,
    warmup: usize,
    runs: usize,
}

fn parse_args() -> Result<Args> {
    let argv: Vec<String> = std::env::args().collect();
    let mut base_url = "http://localhost:8427".to_string();
    let mut session = String::new();
    let mut i = 1;
    while i < argv.len() {
        match argv[i].as_str() {
            "--base-url" => {
                base_url = argv
                    .get(i + 1)
                    .cloned()
                    .context("--base-url needs a value")?;
                i += 2;
            }
            "--session" => {
                session = argv
                    .get(i + 1)
                    .cloned()
                    .context("--session needs a value")?;
                i += 2;
            }
            other => {
                bail!("unknown argument: {other}");
            }
        }
    }
    if session.is_empty() {
        bail!("--session <token> is required (the castify_session cookie value)");
    }
    let warmup = env_usize("BENCH_WARMUP", 20);
    let runs = env_usize("BENCH_RUNS", 200);
    Ok(Args {
        base_url,
        session,
        warmup,
        runs,
    })
}

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[derive(Deserialize)]
struct VideoPageDto {
    videos: Vec<VideoSummaryDto>,
}

#[derive(Deserialize)]
struct VideoSummaryDto {
    id: String,
    #[serde(default)]
    thumbnail_status: String,
}

struct Bench {
    client: reqwest::Client,
    base_url: String,
    session: String,
    warmup: usize,
    runs: usize,
}

impl Bench {
    fn cookie_header(&self) -> String {
        format!("castify_session={}", self.session)
    }

    async fn get(&self, path: &str) -> Result<reqwest::Response> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .get(&url)
            .header("cookie", self.cookie_header())
            .send()
            .await
            .with_context(|| format!("request failed: {url}"))?;
        Ok(resp)
    }

    async fn timed_get(&self, path: &str) -> Result<Duration> {
        let start = Instant::now();
        let resp = self.get(path).await?;
        let status = resp.status();
        let _body = resp.bytes().await?;
        if !status.is_success() {
            bail!("non-200 response ({status}) for {path}");
        }
        Ok(start.elapsed())
    }

    async fn run_scenario(&self, name: &str, path: &str, target_ms: f64) -> Result<ScenarioResult> {
        for _ in 0..self.warmup {
            let _ = self.timed_get(path).await?;
        }

        let mut samples: Vec<f64> = Vec::with_capacity(self.runs);
        for _ in 0..self.runs {
            let dur = self.timed_get(path).await?;
            samples.push(dur.as_secs_f64() * 1000.0);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());

        let p50 = percentile(&samples, 50.0);
        let p99 = percentile(&samples, 99.0);
        let mean = samples.iter().sum::<f64>() / samples.len() as f64;

        Ok(ScenarioResult {
            name: name.to_string(),
            p50_ms: p50,
            p99_ms: p99,
            mean_ms: mean,
            target_ms,
            passed: p99 < target_ms,
        })
    }

    async fn find_cached_thumbnail_id(&self) -> Result<String> {
        for page in 1..=5 {
            let path = format!("/api/videos?page={page}&limit=50");
            let resp = self.get(&path).await?;
            if !resp.status().is_success() {
                bail!(
                    "failed to fetch videos page {page} (status {})",
                    resp.status()
                );
            }
            let parsed: VideoPageDto = resp.json().await?;
            for v in &parsed.videos {
                if v.thumbnail_status == "cached" {
                    return Ok(v.id.clone());
                }
            }
        }
        bail!("no video with thumbnail_status=cached found in first 5 pages");
    }
}

struct ScenarioResult {
    name: String,
    p50_ms: f64,
    p99_ms: f64,
    mean_ms: f64,
    target_ms: f64,
    passed: bool,
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args()?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;

    let bench = Bench {
        client,
        base_url: args.base_url.clone(),
        session: args.session.clone(),
        warmup: args.warmup,
        runs: args.runs,
    };

    println!(
        "== bench-run: HTTP latency ({} requests, {} warmup) ==",
        args.runs, args.warmup
    );
    println!("  target: {}", args.base_url);

    let cached_thumb_id = bench.find_cached_thumbnail_id().await?;
    let thumb_path = format!("/api/videos/{cached_thumb_id}/thumbnail");

    let scenarios: &[(&str, &str, f64)] = &[
        (
            "GET /api/videos (no filter)",
            "/api/videos?page=1&limit=50",
            500.0,
        ),
        (
            "GET /api/videos?q=concert (FTS5)",
            "/api/videos?q=concert&page=1&limit=50",
            500.0,
        ),
        (
            "GET /api/videos?provider+height+duration",
            "/api/videos?provider=google_drive&min_height=720&duration_min=300000&page=1&limit=50",
            500.0,
        ),
        ("GET /api/videos/folders", "/api/videos/folders", 200.0),
        (
            "GET /api/videos/{id}/thumbnail (cache hit)",
            &thumb_path,
            50.0,
        ),
    ];

    let mut results = Vec::new();
    for &(name, path, target) in scenarios {
        eprint!("  running: {name} ... ");
        match bench.run_scenario(name, path, target).await {
            Ok(r) => {
                eprintln!("p99={:.1}ms", r.p99_ms);
                results.push(r);
            }
            Err(e) => {
                eprintln!("ERROR: {e:#}");
                bail!("scenario \"{name}\" failed: {e:#}");
            }
        }
    }

    println!();
    println!(
        "  {:<44} {:>8} {:>8} {:>8} {:>10}  verdict",
        "Scenario", "p50", "p99", "mean", "target"
    );
    println!("  {}", "-".repeat(100));
    for r in &results {
        let verdict = if r.passed { "PASS" } else { "FAIL" };
        println!(
            "  {:<44} {:>6.1}ms {:>6.1}ms {:>6.1}ms {:>7.0}ms  {}",
            r.name, r.p50_ms, r.p99_ms, r.mean_ms, r.target_ms, verdict,
        );
    }
    println!("  {}", "-".repeat(100));

    let passed = results.iter().filter(|r| r.passed).count();
    let total = results.len();
    if passed == total {
        println!();
        println!("  {passed}/{total} scenarios passed — all PRD NFR targets met.");
        Ok(())
    } else {
        println!();
        println!("  {passed}/{total} scenarios passed — some targets exceeded.");
        bail!("{passed}/{total} benchmark scenarios failed");
    }
}
