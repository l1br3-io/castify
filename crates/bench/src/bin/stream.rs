//! bench-stream: streaming performance benchmarks for `/stream` and `/stream-url`.
//!
//! Three scenarios:
//!   1. `stream-url resolve` — latency of `/api/videos/{id}/stream-url` (p50/p99/mean)
//!   2. `stream seek RTT`   — Range request round-trip time through `/api/videos/{id}/stream` (p50/p99/mean)
//!   3. `stream throughput`  — sustained throughput over a fixed-duration sample (Mbps)
//!
//! Works against any running server (e2e mock or real provider). Against the
//! e2e mock, numbers are useful for regression detection but throughput is
//! capped by the mock's small (24-byte) payload. For meaningful throughput
//! numbers, run against a server backed by real provider content.
//!
//! Usage:
//!   cargo run -p castify-bench --bin stream -- --session <token> [--base-url URL]
//!
//! Override sample counts/durations via `BENCH_WARMUP`, `BENCH_RUNS`,
//! `BENCH_THROUGHPUT_SECS` env vars (defaults: 20 warmup, 200 timed, 10s throughput).

use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

struct Args {
    base_url: String,
    session: String,
    warmup: usize,
    runs: usize,
    throughput_secs: u64,
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
    let throughput_secs = std::env::var("BENCH_THROUGHPUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    Ok(Args {
        base_url,
        session,
        warmup,
        runs,
        throughput_secs,
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

    async fn get_with_range(&self, path: &str, range: &str) -> Result<reqwest::Response> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .get(&url)
            .header("cookie", self.cookie_header())
            .header("range", range)
            .send()
            .await
            .with_context(|| format!("request failed: {url}"))?;
        Ok(resp)
    }

    async fn find_first_video_id(&self) -> Result<String> {
        let resp = self.get("/api/videos?page=1&limit=1").await?;
        if !resp.status().is_success() {
            bail!("failed to fetch videos (status {})", resp.status());
        }
        let parsed: VideoPageDto = resp.json().await?;
        parsed
            .videos
            .into_iter()
            .next()
            .map(|v| v.id)
            .context("no videos found in catalog")
    }

    /// Scenario 1: `/stream-url` resolution latency.
    /// Measures the time from request to response (JSON body received).
    async fn run_stream_url_resolve(&self, video_id: &str) -> Result<ScenarioResult> {
        let path = format!("/api/videos/{video_id}/stream-url");
        for _ in 0..self.warmup {
            let resp = self.get(&path).await?;
            if !resp.status().is_success() {
                bail!("warmup request failed for {path}");
            }
        }
        let mut samples: Vec<f64> = Vec::with_capacity(self.runs);
        for _ in 0..self.runs {
            let start = Instant::now();
            let resp = self.get(&path).await?;
            let _body = resp.bytes().await?;
            let elapsed = start.elapsed();
            samples.push(elapsed.as_secs_f64() * 1000.0);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        Ok(ScenarioResult::latency(
            "GET /stream-url resolve",
            &samples,
            500.0,
        ))
    }

    /// Scenario 2: seek RTT via Range requests.
    /// Issues small Range requests (`bytes=0-3`) and measures round-trip.
    /// Each request is a new HTTP connection (browser-like seek behavior).
    async fn run_stream_seek_rtt(&self, video_id: &str) -> Result<ScenarioResult> {
        let path = format!("/api/videos/{video_id}/stream");
        for _ in 0..self.warmup {
            let resp = self.get_with_range(&path, "bytes=0-3").await?;
            if !resp.status().is_success() {
                bail!("warmup range request failed for {path}");
            }
        }
        let mut samples: Vec<f64> = Vec::with_capacity(self.runs);
        for _ in 0..self.runs {
            let start = Instant::now();
            let resp = self.get_with_range(&path, "bytes=0-3").await?;
            let _body = resp.bytes().await?;
            let elapsed = start.elapsed();
            samples.push(elapsed.as_secs_f64() * 1000.0);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        Ok(ScenarioResult::latency(
            "GET /stream seek RTT (Range)",
            &samples,
            500.0,
        ))
    }

    /// Scenario 3: sustained throughput over a fixed duration.
    /// Issues full-content GET requests in a loop until `duration_secs` elapse.
    /// Reports total bytes / elapsed = throughput in Mbps.
    async fn run_stream_throughput(
        &self,
        video_id: &str,
        duration_secs: u64,
    ) -> Result<ScenarioResult> {
        let path = format!("/api/videos/{video_id}/stream");
        // Warmup: one request.
        let resp = self.get(&path).await?;
        if !resp.status().is_success() {
            bail!("warmup throughput request failed for {path}");
        }
        let _ = resp.bytes().await?;

        let deadline = Instant::now() + Duration::from_secs(duration_secs);
        let mut total_bytes: u64 = 0;
        let mut request_count: u64 = 0;
        while Instant::now() < deadline {
            let resp = self.get(&path).await?;
            let status = resp.status();
            let bytes = resp.bytes().await?;
            if !status.is_success() {
                bail!("throughput request failed ({status}) for {path}");
            }
            total_bytes += bytes.len() as u64;
            request_count += 1;
        }
        let elapsed = Duration::from_secs(duration_secs);
        let throughput_mbps = (total_bytes as f64 * 8.0) / (elapsed.as_secs_f64() * 1_000_000.0);

        Ok(ScenarioResult::throughput(
            "GET /stream sustained throughput",
            throughput_mbps,
            total_bytes,
            request_count,
            duration_secs,
            50.0,
        ))
    }
}

struct ScenarioResult {
    name: String,
    /// Latency results (Some) or throughput result (None).
    p50_ms: Option<f64>,
    p99_ms: Option<f64>,
    mean_ms: Option<f64>,
    target_ms: Option<f64>,
    /// Throughput in Mbps (Some for throughput scenario).
    throughput_mbps: Option<f64>,
    total_bytes: Option<u64>,
    request_count: Option<u64>,
    duration_secs: Option<u64>,
    /// Target throughput (Mbps) for pass/fail.
    target_mbps: Option<f64>,
    passed: bool,
}

impl ScenarioResult {
    fn latency(name: &str, sorted_samples: &[f64], target_ms: f64) -> Self {
        let p50 = percentile(sorted_samples, 50.0);
        let p99 = percentile(sorted_samples, 99.0);
        let mean = sorted_samples.iter().sum::<f64>() / sorted_samples.len() as f64;
        ScenarioResult {
            name: name.to_string(),
            p50_ms: Some(p50),
            p99_ms: Some(p99),
            mean_ms: Some(mean),
            target_ms: Some(target_ms),
            throughput_mbps: None,
            total_bytes: None,
            request_count: None,
            duration_secs: None,
            target_mbps: None,
            passed: p99 < target_ms,
        }
    }

    fn throughput(
        name: &str,
        throughput_mbps: f64,
        total_bytes: u64,
        request_count: u64,
        duration_secs: u64,
        target_mbps: f64,
    ) -> Self {
        ScenarioResult {
            name: name.to_string(),
            p50_ms: None,
            p99_ms: None,
            mean_ms: None,
            target_ms: None,
            throughput_mbps: Some(throughput_mbps),
            total_bytes: Some(total_bytes),
            request_count: Some(request_count),
            duration_secs: Some(duration_secs),
            target_mbps: Some(target_mbps),
            passed: throughput_mbps >= target_mbps,
        }
    }
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
        .timeout(Duration::from_secs(30))
        .build()?;

    let bench = Bench {
        client,
        base_url: args.base_url.clone(),
        session: args.session.clone(),
        warmup: args.warmup,
        runs: args.runs,
    };

    println!(
        "== bench-stream: streaming perf ({} samples, {} warmup, {}s throughput) ==",
        args.runs, args.warmup, args.throughput_secs
    );
    println!("  target: {}", args.base_url);

    let video_id = bench.find_first_video_id().await?;
    println!("  video:  {video_id}");

    let mut results = Vec::new();

    eprint!("  running: /stream-url resolve ... ");
    match bench.run_stream_url_resolve(&video_id).await {
        Ok(r) => {
            eprintln!("p99={:.1}ms", r.p99_ms.unwrap_or(0.0));
            results.push(r);
        }
        Err(e) => {
            eprintln!("ERROR: {e:#}");
            bail!("stream-url scenario failed: {e:#}");
        }
    }

    eprint!("  running: /stream seek RTT ... ");
    match bench.run_stream_seek_rtt(&video_id).await {
        Ok(r) => {
            eprintln!("p99={:.1}ms", r.p99_ms.unwrap_or(0.0));
            results.push(r);
        }
        Err(e) => {
            eprintln!("ERROR: {e:#}");
            bail!("seek RTT scenario failed: {e:#}");
        }
    }

    eprint!(
        "  running: /stream throughput ({}s) ... ",
        args.throughput_secs
    );
    match bench
        .run_stream_throughput(&video_id, args.throughput_secs)
        .await
    {
        Ok(r) => {
            eprintln!("{:.2} Mbps", r.throughput_mbps.unwrap_or(0.0));
            results.push(r);
        }
        Err(e) => {
            eprintln!("ERROR: {e:#}");
            bail!("throughput scenario failed: {e:#}");
        }
    }

    println!();
    print_latency_table(&results);
    print_throughput_table(&results);

    let passed = results.iter().filter(|r| r.passed).count();
    let total = results.len();
    println!();
    if passed == total {
        println!("  {passed}/{total} scenarios passed — all targets met.");
        Ok(())
    } else {
        println!("  {passed}/{total} scenarios passed — some targets missed.");
        bail!("{passed}/{total} benchmark scenarios failed");
    }
}

fn print_latency_table(results: &[ScenarioResult]) {
    let latency: Vec<&ScenarioResult> = results.iter().filter(|r| r.p50_ms.is_some()).collect();
    if latency.is_empty() {
        return;
    }
    println!(
        "  {:<44} {:>8} {:>8} {:>8} {:>10}  verdict",
        "Latency scenario", "p50", "p99", "mean", "target"
    );
    println!("  {}", "-".repeat(100));
    for r in &latency {
        let verdict = if r.passed { "PASS" } else { "FAIL" };
        println!(
            "  {:<44} {:>6.1}ms {:>6.1}ms {:>6.1}ms {:>7.0}ms  {}",
            r.name,
            r.p50_ms.unwrap(),
            r.p99_ms.unwrap(),
            r.mean_ms.unwrap(),
            r.target_ms.unwrap(),
            verdict,
        );
    }
    println!("  {}", "-".repeat(100));
}

fn print_throughput_table(results: &[ScenarioResult]) {
    let throughput: Vec<&ScenarioResult> = results
        .iter()
        .filter(|r| r.throughput_mbps.is_some())
        .collect();
    if throughput.is_empty() {
        return;
    }
    println!();
    println!(
        "  {:<44} {:>12} {:>10} {:>8} {:>8} {:>12}  verdict",
        "Throughput scenario", "throughput", "total MB", "reqs", "secs", "target"
    );
    println!("  {}", "-".repeat(110));
    for r in &throughput {
        let verdict = if r.passed { "PASS" } else { "FAIL" };
        let total_mb = (r.total_bytes.unwrap() as f64) / (1024.0 * 1024.0);
        println!(
            "  {:<44} {:>9.2} Mbps {:>8.2} MB {:>6} {:>6}s {:>9.0} Mbps  {}",
            r.name,
            r.throughput_mbps.unwrap(),
            total_mb,
            r.request_count.unwrap(),
            r.duration_secs.unwrap(),
            r.target_mbps.unwrap(),
            verdict,
        );
    }
    println!("  {}", "-".repeat(110));
}
