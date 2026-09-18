//! Virtual-collections classification cascade (library-collections, F1).
//!
//! Pure, dependency-free heuristics over file names, paths, and provider
//! timestamps. Deterministic — no ML, no I/O, no DB. The cascade is:
//!
//! 1. **TV episode** — `SxxEyy` / `SxxEyy-Ezz` / `1x02` / `Episode N`
//!    patterns → show name (parent folder preferred, parsed title
//!    fallback), season, episode.
//! 2. **Movie** — `Title (19xx|20xx)` in the filename or a parent folder
//!    → title + year.
//! 3. **Temporal** — gap-based clustering over `provider_modified_at`
//!    (break on a >3-day gap, keep clusters of ≥3) with month labels
//!    ("June 2026"). Driven by [`cluster_by_time`], not [`classify_name`].
//!
//! Unmatched inputs return `None` — nothing is ever force-classified.
//! Results are derived hints only: they stage suggestions and never
//! become user-visible state without acceptance (spec F1/F2).
//!
//! Junk tokens (`1080p`, `x264`, `WEB-DL`, `BluRay`, release-group
//! suffixes …) are stripped before title extraction, and every result
//! carries a canonical [`ParsedName::signature`] used to suppress
//! re-suggestions across scans (spec F2).

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

/// The collection flavor a classification or suggestion produces.
/// `manual` (spec F3) exists only at the persistence layer — the
/// cascade never proposes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionKind {
    Show,
    Movie,
    Time,
}

impl CollectionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            CollectionKind::Show => "show",
            CollectionKind::Movie => "movie",
            CollectionKind::Time => "time",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "show" => Ok(CollectionKind::Show),
            "movie" => Ok(CollectionKind::Movie),
            "time" => Ok(CollectionKind::Time),
            other => Err(format!("unknown collection kind: {other}")),
        }
    }
}

impl std::fmt::Display for CollectionKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// A name-tier classification result: tiers 1–2 of the cascade.
///
/// `season` is `None` for the `Episode N` form (no season evidence in
/// the name); `episode_end` carries the tail of multi-episode files
/// (`S01E05-E07`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedName {
    Show {
        show: String,
        season: Option<u32>,
        episode: u32,
        episode_end: Option<u32>,
    },
    Movie {
        title: String,
        year: u32,
    },
}

impl ParsedName {
    pub fn kind(&self) -> CollectionKind {
        match self {
            ParsedName::Show { .. } => CollectionKind::Show,
            ParsedName::Movie { .. } => CollectionKind::Movie,
        }
    }

    /// Junk-stripped display name for the suggested collection
    /// (spec's `ClassifyHint.title`): bare show name, or
    /// `Title (Year)` for movies.
    pub fn collection_title(&self) -> String {
        match self {
            ParsedName::Show { show, .. } => show.clone(),
            ParsedName::Movie { title, year } => format!("{title} ({year})"),
        }
    }

    /// Canonical suppression/re-suggest key (spec F2): stable across
    /// case, punctuation, and quality/junk variants of the same title,
    /// so a dismissed suggestion can never resurrect under a different
    /// release encoding.
    pub fn signature(&self) -> String {
        match self {
            ParsedName::Show { show, .. } => format!("show:{}", normalize_key(show)),
            ParsedName::Movie { title, year } => {
                format!("movie:{}{year}", normalize_key(title))
            }
        }
    }
}

/// Gap threshold for temporal clustering: consecutive videos more than
/// this many days apart (strictly greater) land in different clusters.
pub const TIME_CLUSTER_GAP_DAYS: i64 = 3;

/// Minimum videos per temporal cluster — smaller groups stay in plain
/// browse instead of becoming noise suggestions.
pub const TIME_CLUSTER_MIN_SIZE: usize = 3;

/// One temporal cluster: a display label, its suppression signature,
/// and the **input** indices of member videos in chronological order
/// (callers map indices back to rows — the classifier never sees ids).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeCluster {
    pub label: String,
    pub signature: String,
    pub indices: Vec<usize>,
}

/// Run tiers 1–2 of the cascade over one file name (extension
/// included) and its provider path (full path including the file name,
/// e.g. `/TV/Buffy/Episode 3.mkv`).
///
/// Returns `None` when nothing matches — the video keeps its home in
/// the flat grid / folder organizer and may still feed
/// [`cluster_by_time`] (tier 3).
pub fn classify_name(name: &str, path: Option<&str>) -> Option<ParsedName> {
    let base = strip_extension(name);

    // Tier 1 — TV episode. A marker with no derivable show name is
    // still unmatched: an unnamed "1x02" suggests nothing usable.
    if let Some(marker) = find_episode_marker(base) {
        let show = show_title_from_path(path).or_else(|| {
            let parsed = clean_title(&base[..marker.start], YearPolicy::Drop);
            (!parsed.is_empty()).then_some(parsed)
        });
        return show.map(|show| ParsedName::Show {
            show,
            season: marker.season,
            episode: marker.episode,
            episode_end: marker.episode_end,
        });
    }

    // Tier 2 — movie. The filename wins over folder evidence; folders
    // rescue bare-copy names ("inception.mkv" under "Inception (2010)").
    if let Some((idx, year)) = find_movie_year(base) {
        let title = clean_title(&base[..idx], YearPolicy::Keep);
        if !title.is_empty() {
            return Some(ParsedName::Movie { title, year });
        }
    }
    if let Some(path) = path.filter(|p| !p.is_empty()) {
        if let Some((title, year)) = movie_title_from_path(path) {
            return Some(ParsedName::Movie { title, year });
        }
    }

    None
}

/// Tier 3: gap-based clustering over `provider_modified_at` values.
///
/// Sorts by time (input order is irrelevant), breaks a cluster when the
/// gap to the previous video strictly exceeds [`TIME_CLUSTER_GAP_DAYS`],
/// and drops clusters smaller than [`TIME_CLUSTER_MIN_SIZE`]. Label and
/// signature come from the cluster's earliest timestamp.
pub fn cluster_by_time(timestamps: &[DateTime<Utc>]) -> Vec<TimeCluster> {
    let mut order: Vec<usize> = (0..timestamps.len()).collect();
    order.sort_by_key(|&i| timestamps[i]);

    let gap = chrono::Duration::days(TIME_CLUSTER_GAP_DAYS);
    let mut grouped: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for &i in &order {
        let breaks_cluster = current
            .last()
            .is_some_and(|&prev| timestamps[i] - timestamps[prev] > gap);
        if breaks_cluster {
            grouped.push(std::mem::take(&mut current));
        }
        current.push(i);
    }
    if !current.is_empty() {
        grouped.push(current);
    }

    grouped
        .into_iter()
        .filter(|group| group.len() >= TIME_CLUSTER_MIN_SIZE)
        .map(|indices| {
            let first = timestamps[indices[0]];
            TimeCluster {
                label: first.format("%B %Y").to_string(),
                signature: first.format("time:%Y-%m").to_string(),
                indices,
            }
        })
        .collect()
}

/// Parse a provider timestamp (RFC 3339, e.g. `2024-06-01T12:30:00Z`)
/// into a UTC instant. Providers emit RFC 3339 modified times; anything
/// else fails open as `None` (video skips the temporal tier).
pub fn parse_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Extract a date-shaped folder segment from a path — `2024-06-01` or
/// DCIM-style `20240601` — as a temporal-cluster anchor for videos
/// missing `provider_modified_at` (spec F1, tier 3). Scans from the
/// deepest segment up; returns the first valid date.
pub fn date_from_path(path: &str) -> Option<NaiveDate> {
    path.rsplit('/').find_map(parse_date_segment)
}

fn parse_date_segment(segment: &str) -> Option<NaiveDate> {
    if segment.len() == 10 {
        NaiveDate::parse_from_str(segment, "%Y-%m-%d").ok()
    } else if segment.len() == 8 && segment.bytes().all(|b| b.is_ascii_digit()) {
        NaiveDate::parse_from_str(segment, "%Y%m%d").ok()
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Internal parsing machinery — byte scanning, no regex dependency.
// ---------------------------------------------------------------------------

/// One matched episode marker in a filename base (extension stripped).
#[derive(Debug, Clone, Copy)]
struct EpisodeMarker {
    /// Byte offset where the marker starts; everything before it is
    /// candidate show-title material.
    start: usize,
    season: Option<u32>,
    episode: u32,
    episode_end: Option<u32>,
}

fn is_digit(b: u8) -> bool {
    b.is_ascii_digit()
}

fn is_alnum(b: u8) -> bool {
    b.is_ascii_alphanumeric()
}

/// True when the byte before `idx` does not continue an ASCII word —
/// markers must start at a token boundary so junk like quality strings
/// can never mid-word fake a match. Non-ASCII bytes count as
/// boundaries, so unicode titles slice cleanly.
fn starts_at_boundary(bytes: &[u8], idx: usize) -> bool {
    idx == 0 || !is_alnum(bytes[idx - 1])
}

fn ends_at_boundary(bytes: &[u8], idx: usize) -> bool {
    idx >= bytes.len() || !is_alnum(bytes[idx])
}

/// Parse up to `max` ASCII digits at the front of `rest` into `u32`.
/// Returns the value and how many digits were consumed (0 = none).
fn parse_u32_prefix(rest: &[u8], max: usize) -> (u32, usize) {
    let mut value: u32 = 0;
    let mut len = 0;
    while len < rest.len() && len < max && is_digit(rest[len]) {
        value = value * 10 + u32::from(rest[len] - b'0');
        len += 1;
    }
    (value, len)
}

/// Find the earliest episode marker across all three TV forms.
fn find_episode_marker(base: &str) -> Option<EpisodeMarker> {
    let bytes = base.as_bytes();
    let candidates = [
        scan_sxxeyy(bytes),
        scan_nxm(bytes),
        scan_episode_word(bytes),
    ];
    candidates
        .into_iter()
        .flatten()
        .min_by_key(|marker| marker.start)
}

/// `S01E05`, `S01E05-E07`, `S01E05E06`, `s1e5` — case-insensitive,
/// season ≤ 2 digits, episode ≤ 4 digits, optional dash-less or dashed
/// episode range.
fn scan_sxxeyy(b: &[u8]) -> Option<EpisodeMarker> {
    for i in 0..b.len() {
        if (b[i] != b'S' && b[i] != b's') || !starts_at_boundary(b, i) {
            continue;
        }
        let (season, season_len) = parse_u32_prefix(&b[i + 1..], 2);
        if season_len == 0 {
            continue;
        }
        let mut j = i + 1 + season_len;
        if b.get(j).is_none_or(|&c| c != b'e' && c != b'E') {
            continue;
        }
        j += 1;
        let (episode, episode_len) = parse_u32_prefix(&b[j..], 4);
        if episode_len == 0 {
            continue;
        }
        j += episode_len;
        let episode_end = match b.get(j) {
            Some(&c) if c == b'-' || c == b'e' || c == b'E' => {
                // Range continuation: `-E07` or bare `E07`.
                let mut k = j + usize::from(c == b'-');
                match b.get(k) {
                    Some(&d) if d == b'e' || d == b'E' => {
                        k += 1;
                        let (end, end_len) = parse_u32_prefix(&b[k..], 4);
                        if end_len == 0 {
                            continue;
                        }
                        j = k + end_len;
                        Some(end)
                    }
                    _ => continue,
                }
            }
            _ => None,
        };
        if ends_at_boundary(b, j) {
            return Some(EpisodeMarker {
                start: i,
                season: Some(season),
                episode,
                episode_end,
            });
        }
    }
    None
}

/// `1x02` — 1–2 digit season, `x`, 1–4 digit episode.
// GOTCHA: resolution strings (`1920x1080`, `720x480`) must never parse
// as episodes. Two guards make that hold without regex: the season is
// capped at 2 digits (rejecting 3–4 digit widths), and the marker must
// start at a token boundary — every 2-digit window inside `1920x1080`
// is preceded by another digit, so `20x1080` can never match.
fn scan_nxm(b: &[u8]) -> Option<EpisodeMarker> {
    for i in 0..b.len() {
        if !is_digit(b[i]) || !starts_at_boundary(b, i) {
            continue;
        }
        let (season, season_len) = parse_u32_prefix(&b[i..], 2);
        if season_len == 0 {
            continue;
        }
        let mut j = i + season_len;
        if b.get(j).is_none_or(|&c| c != b'x' && c != b'X') {
            continue;
        }
        j += 1;
        let (episode, episode_len) = parse_u32_prefix(&b[j..], 4);
        if episode_len == 0 {
            continue;
        }
        j += episode_len;
        if ends_at_boundary(b, j) {
            return Some(EpisodeMarker {
                start: i,
                season: Some(season),
                episode,
                episode_end: None,
            });
        }
    }
    None
}

/// `Episode 3` (case-insensitive), with `.`, `_`, `-`, or spaces
/// between the word and the number. No season evidence in the name —
/// season stays `None`.
fn scan_episode_word(b: &[u8]) -> Option<EpisodeMarker> {
    const WORD: &[u8; 7] = b"episode";
    for i in 0..b.len() {
        if !starts_at_boundary(b, i) {
            continue;
        }
        let candidate = &b[i..];
        if candidate.len() < WORD.len() {
            break;
        }
        if !candidate
            .iter()
            .zip(WORD)
            .all(|(&c, &w)| c.eq_ignore_ascii_case(&w))
        {
            continue;
        }
        let mut j = i + WORD.len();
        while j < b.len() && matches!(b[j], b'.' | b'_' | b'-' | b' ') {
            j += 1;
        }
        let (episode, episode_len) = parse_u32_prefix(&b[j..], 3);
        if episode_len == 0 {
            continue;
        }
        j += episode_len;
        if ends_at_boundary(b, j) {
            return Some(EpisodeMarker {
                start: i,
                season: None,
                episode,
                episode_end: None,
            });
        }
    }
    None
}

/// Find the first `(19xx|20xx)` group in `base`. Returns the byte index
/// of the opening paren and the year. Bare-year tokens (`Movie.2019`)
/// are deliberately ignored — the paren form is the unambiguous movie
/// signal per spec F1.
fn find_movie_year(base: &str) -> Option<(usize, u32)> {
    let b = base.as_bytes();
    for i in 0..b.len() {
        if b[i] != b'(' {
            continue;
        }
        let rest = &b[i + 1..];
        if rest.len() < 5 || !rest[..4].iter().all(|&c| is_digit(c)) || rest[4] != b')' {
            continue;
        }
        let (year, _) = parse_u32_prefix(rest, 4);
        if (1900..=2099).contains(&year) {
            return Some((i, year));
        }
    }
    None
}

/// Show-name derivation from the path (spec F1: parent folder
/// preferred, parsed filename fallback). Walks parent segments from
/// nearest to farthest, skipping season-shaped folders (`Season 1`,
/// `S01`, `Specials`) and generic roots (`TV`, `Movies`) — the first
/// remaining folder that yields a non-empty title wins.
fn show_title_from_path(path: Option<&str>) -> Option<String> {
    let path = path.filter(|p| !p.is_empty())?;
    for segment in parent_segments(path).into_iter().rev() {
        if season_shaped_folder(segment) || generic_folder(segment) {
            continue;
        }
        let title = clean_title(segment, YearPolicy::Drop);
        if !title.is_empty() {
            return Some(title);
        }
    }
    None
}

/// Movie evidence from a parent folder: the nearest ancestor carrying a
/// `Title (Year)` pattern.
fn movie_title_from_path(path: &str) -> Option<(String, u32)> {
    for segment in parent_segments(path).into_iter().rev() {
        if generic_folder(segment) {
            continue;
        }
        if let Some((idx, year)) = find_movie_year(segment) {
            let title = clean_title(&segment[..idx], YearPolicy::Keep);
            if !title.is_empty() {
                return Some((title, year));
            }
        }
    }
    None
}

/// Path segments with the final (filename) segment removed.
fn parent_segments(path: &str) -> Vec<&str> {
    let mut segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    segments.pop();
    segments
}

/// Season-folder shapes that must never become show names
/// (`Season 1`, `season02`, `S01`, `Specials`, `Extras`).
fn season_shaped_folder(segment: &str) -> bool {
    let normalized: String = segment
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();
    matches!(normalized.as_str(), "season" | "specials" | "extras")
        || normalized.strip_prefix("season").is_some_and(|rest| {
            !rest.is_empty() && rest.len() <= 2 && rest.chars().all(|c| c.is_ascii_digit())
        })
        || (normalized.starts_with('s')
            && normalized.len() <= 3
            && normalized[1..].chars().all(|c| c.is_ascii_digit())
            && !normalized[1..].is_empty())
}

/// Generic library roots that carry no show/movie signal.
fn generic_folder(segment: &str) -> bool {
    let normalized = segment.trim().to_lowercase();
    matches!(
        normalized.as_str(),
        "tv" | "television"
            | "shows"
            | "series"
            | "movies"
            | "movie"
            | "films"
            | "media"
            | "video"
            | "videos"
            | "downloads"
            | "download"
            | "new"
            | "unsorted"
            | "root"
            | "library"
    )
}

/// How [`clean_title`] treats bare 4-digit year tokens. Show titles
/// drop them (scene releases embed the year: `Show.2019.S01E01`);
/// movie titles keep them (`Blade Runner 2049 (2017)`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum YearPolicy {
    Keep,
    Drop,
}

/// Release-metadata tokens stripped from titles before display and
/// signature derivation. Compared lowercased against `.`/`_`/space
/// split tokens. Short ambiguous words (`web`, `dvd`, `ts`) stay out —
/// they appear in real titles (`Charlotte's Web`) far more often than
/// as lone tags.
const JUNK_TOKENS: &[&str] = &[
    // resolution / scan
    "480p",
    "480i",
    "576p",
    "576i",
    "720p",
    "720i",
    "1080p",
    "1080i",
    "2160p",
    "4k",
    "8k",
    "uhd",
    // codecs
    "x264",
    "x265",
    "h264",
    "h265",
    "h.264",
    "h.265",
    "xvid",
    "divx",
    "hevc",
    "avc",
    "av1",
    "vp9",
    "vp8",
    // sources
    "web-dl",
    "webdl",
    "webrip",
    "web-rip",
    "bluray",
    "blu-ray",
    "brrip",
    "bdrip",
    "bdremux",
    "remux",
    "dvdrip",
    "dvdscr",
    "screener",
    "hdrip",
    "hdtv",
    "pdtv",
    "telesync",
    "telecine",
    "hdcam",
    // audio
    "aac",
    "ac3",
    "eac3",
    "dts",
    "truehd",
    "atmos",
    "flac",
    // streaming / release flags
    "amzn",
    "nf",
    "dsnp",
    "atvp",
    "hulu",
    "max",
    "proper",
    "repack",
    "rerip",
    "internal",
    "limited",
    "extended",
    "remastered",
    "unrated",
    "hybrid",
    "10bit",
    "8bit",
    "hdr10",
    "sdr",
    "multi",
    "subbed",
    "korsub",
];

/// Token-level junk test after case normalization.
fn is_junk_token(token: &str) -> bool {
    let lower = token.to_lowercase();
    if JUNK_TOKENS.contains(&lower.as_str()) {
        return true;
    }
    // Resolution forms: `1080p`, `720i`, `2160p` (case-insensitive tail).
    if lower.len() >= 4 {
        let (digits, tail) = lower.split_at(lower.len() - 1);
        if (tail == "p" || tail == "i")
            && !digits.is_empty()
            && digits.bytes().all(|b| b.is_ascii_digit())
        {
            return true;
        }
    }
    // Framerate tags: `24fps`, `60fps`.
    if let Some(digits) = lower.strip_suffix("fps") {
        if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
            return true;
        }
    }
    // Resolution pairs: `1920x1080`.
    if let Some((left, right)) = lower.split_once('x') {
        if left.bytes().all(|b| b.is_ascii_digit())
            && right.bytes().all(|b| b.is_ascii_digit())
            && !left.is_empty()
            && !right.is_empty()
        {
            return true;
        }
    }
    false
}

/// Scene release-group suffix: a trailing `-ALLCAPS` (2–20 chars, at
/// least one letter — `x264-CMRG` → `x264`, `Show-CMRG` → `Show`).
/// Lowercase hyphenated titles (`Spider-Man`) never match, and
/// year-dash-year (`2012-2009`) is protected by the letter rule.
fn strip_group_suffix(token: &str) -> &str {
    let Some((head, tail)) = token.rsplit_once('-') else {
        return token;
    };
    let plausible_group = tail.len() >= 2
        && tail.len() <= 20
        && tail
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        && tail.bytes().any(|b| b.is_ascii_uppercase());
    if plausible_group && !head.is_empty() {
        head
    } else {
        token
    }
}

/// Turn a raw title region (filename prefix or folder name) into a
/// display title: split on `.`/`_`/whitespace, drop junk tokens (and
/// bare years under [`YearPolicy::Drop`]), strip a release-group
/// suffix from the final token, rejoin with single spaces. Tokens
/// without any alphanumeric content (`-`, `…`) vanish.
fn clean_title(raw: &str, years: YearPolicy) -> String {
    let tokens: Vec<&str> = raw
        .split(|c: char| c == '.' || c == '_' || c.is_whitespace())
        .filter(|t| !t.is_empty())
        .collect();

    let mut kept: Vec<String> = Vec::new();
    for (i, token) in tokens.iter().enumerate() {
        let token = if i + 1 == tokens.len() {
            strip_group_suffix(token)
        } else {
            *token
        };
        if is_junk_token(token) {
            continue;
        }
        if years == YearPolicy::Drop && is_bare_year(token) {
            continue;
        }
        if token.chars().any(char::is_alphanumeric) {
            kept.push(display_cased(token));
        }
    }
    kept.join(" ")
}

/// Filename titles arrive in arbitrary casing. Capitalize the first
/// letter of words that are entirely lowercase (scene releases); leave
/// anything with an uppercase letter untouched (`iPhone`, `McHale`).
fn display_cased(token: &str) -> String {
    if token.chars().any(|c| c.is_uppercase()) {
        return token.to_string();
    }
    let mut chars = token.chars();
    match chars.next() {
        Some(first) => {
            let mut out: String = first.to_uppercase().collect();
            out.push_str(chars.as_str());
            out
        }
        None => String::new(),
    }
}

/// Exactly four digits in the release-year range — dropped from show
/// titles where it is metadata, kept inside movie titles where it can
/// be part of the name.
fn is_bare_year(token: &str) -> bool {
    token.len() == 4 && token.bytes().all(|b| b.is_ascii_digit()) && token.starts_with(['1', '2'])
}

/// Signature normalization: lowercase, keep only alphanumeric
/// characters. Punctuation, spacing, and case differences vanish so
/// quality variants of the same release collide by construction.
fn normalize_key(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

// GOTCHA: `.ts` is both a TypeScript suffix and an MPEG transport
// stream — and providers already require MIME corroboration before a
// `.ts` file enters the catalog as a video (see
// `classify_drive_file_requires_corroboration_for_ts`). Here the
// extension is simply stripped for base-name parsing; DVR machine
// names underneath (`20240601235900-0-0.ts`) match no tier and stay
// unmatched.
fn strip_extension(name: &str) -> &str {
    let Some((base, ext)) = name.rsplit_once('.') else {
        return name;
    };
    let plausible_extension = !base.is_empty()
        && !ext.is_empty()
        && ext.len() <= 5
        && ext.bytes().all(|b| b.is_ascii_alphanumeric());
    if plausible_extension {
        base
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn classify(name: &str, path: Option<&str>) -> Option<ParsedName> {
        classify_name(name, path)
    }

    fn show_of(parsed: &ParsedName) -> &str {
        match parsed {
            ParsedName::Show { show, .. } => show,
            other => panic!("expected show, got {other:?}"),
        }
    }

    fn ts(y: i32, m: u32, d: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, 12, 0, 0).unwrap()
    }

    // ----- Tier 1: TV -----

    #[test]
    fn scene_sxxeyy_parses_show_season_episode() {
        let parsed = classify("Show.Name.S01E05.720p.x264-GROUP.mkv", None).unwrap();
        assert_eq!(
            parsed,
            ParsedName::Show {
                show: "Show Name".into(),
                season: Some(1),
                episode: 5,
                episode_end: None,
            }
        );
    }

    #[test]
    fn parent_folder_preferred_over_parsed_filename() {
        let parsed = classify(
            "breaking.bad.s01e05.mkv",
            Some("/TV/Breaking Bad/breaking.bad.s01e05.mkv"),
        )
        .unwrap();
        assert_eq!(show_of(&parsed), "Breaking Bad");
    }

    #[test]
    fn season_shaped_folder_falls_back_to_grandparent() {
        let parsed = classify(
            "Show.Name.S01E05.mkv",
            Some("/TV/Folder Show/Season 1/Show.Name.S01E05.mkv"),
        )
        .unwrap();
        assert_eq!(show_of(&parsed), "Folder Show");
    }

    #[test]
    fn generic_root_folder_falls_back_to_filename() {
        let parsed = classify("Show.Name.S01E05.mkv", Some("/TV/Show.Name.S01E05.mkv")).unwrap();
        assert_eq!(show_of(&parsed), "Show Name");
    }

    #[test]
    fn short_nxm_form_matches() {
        let parsed = classify("My Show 1x02.mkv", None).unwrap();
        assert_eq!(
            parsed,
            ParsedName::Show {
                show: "My Show".into(),
                season: Some(1),
                episode: 2,
                episode_end: None,
            }
        );
        let from_folder = classify("1x02.mkv", Some("/TV/Buffy/1x02.mkv")).unwrap();
        assert_eq!(show_of(&from_folder), "Buffy");
    }

    #[test]
    fn episode_word_matches_with_folder() {
        let parsed = classify("Episode 3.mkv", Some("/TV/Buffy/Episode 3.mkv")).unwrap();
        assert_eq!(
            parsed,
            ParsedName::Show {
                show: "Buffy".into(),
                season: None,
                episode: 3,
                episode_end: None,
            }
        );
    }

    #[test]
    fn episode_word_without_any_show_source_is_none() {
        assert_eq!(classify("Episode 3.mkv", None), None);
        assert_eq!(classify("Episode 3.mkv", Some("/TV/Episode 3.mkv")), None);
    }

    #[test]
    fn multi_episode_range_parses_end() {
        let parsed = classify("Show.Name.S01E05-E07.1080p.WEB-DL.x264.mkv", None).unwrap();
        assert_eq!(
            parsed,
            ParsedName::Show {
                show: "Show Name".into(),
                season: Some(1),
                episode: 5,
                episode_end: Some(7),
            }
        );
    }

    #[test]
    fn adjacent_double_episode_without_dash_parses() {
        let parsed = classify("Show.Name.S01E05E06.720p.mkv", None).unwrap();
        match parsed {
            ParsedName::Show {
                episode,
                episode_end,
                ..
            } => {
                assert_eq!(episode, 5);
                assert_eq!(episode_end, Some(6));
            }
            other => panic!("expected show, got {other:?}"),
        }
    }

    // GOTCHA: `1x02` vs resolution tokens — the NxM scanner must never
    // fire inside `1920x1080` / `720x480`.
    #[test]
    fn resolution_tokens_never_match_as_episode() {
        assert_eq!(classify("Some Clip 1920x1080 30fps.mp4", None), None);
        assert_eq!(classify("Old Cam 720x480.mp4", None), None);
    }

    // ----- Tier 2: Movie -----

    #[test]
    fn movie_year_in_filename() {
        let parsed = classify("The Matrix (1999).mkv", None).unwrap();
        assert_eq!(
            parsed,
            ParsedName::Movie {
                title: "The Matrix".into(),
                year: 1999,
            }
        );
    }

    #[test]
    fn movie_year_in_parent_folder() {
        let parsed = classify(
            "inception.mkv",
            Some("/Movies/Inception (2010)/inception.mkv"),
        )
        .unwrap();
        assert_eq!(
            parsed,
            ParsedName::Movie {
                title: "Inception".into(),
                year: 2010,
            }
        );
    }

    #[test]
    fn movie_title_keeps_embedded_year_words() {
        let parsed = classify("Blade Runner 2049 (2017).mkv", None).unwrap();
        assert_eq!(
            parsed,
            ParsedName::Movie {
                title: "Blade Runner 2049".into(),
                year: 2017,
            }
        );
    }

    #[test]
    fn movie_years_outside_range_are_not_movies() {
        assert_eq!(classify("Trip (1899).mkv", None), None);
        assert_eq!(classify("Future (2100).mkv", None), None);
    }

    #[test]
    fn movie_with_empty_title_is_none() {
        assert_eq!(classify("(2019).mkv", None), None);
    }

    #[test]
    fn tv_tier_wins_over_movie_tier() {
        let parsed = classify("Show.Name.S01E05.(2019).mkv", None).unwrap();
        assert_eq!(parsed.kind(), CollectionKind::Show);
    }

    // ----- Junk stripping -----

    #[test]
    fn junk_tokens_stripped_from_titles() {
        let parsed = classify("Show.Name.1080p.WEB-DL.x265.HEVC.S01E01.mkv", None).unwrap();
        assert_eq!(show_of(&parsed), "Show Name");
    }

    #[test]
    fn release_group_suffix_stripped_from_folder_titles() {
        let parsed = classify(
            "Show.S01E01.mkv",
            Some("/TV/Show Name-CMRG/Show.S01E01.mkv"),
        )
        .unwrap();
        assert_eq!(show_of(&parsed), "Show Name");
    }

    #[test]
    fn hyphenated_titles_keep_their_hyphen() {
        let parsed = classify("Spider-Man.S01E01.mkv", None).unwrap();
        assert_eq!(show_of(&parsed), "Spider-Man");
    }

    #[test]
    fn unicode_titles_survive() {
        let parsed = classify("Amélie.S01E01.mkv", None).unwrap();
        assert_eq!(show_of(&parsed), "Amélie");
    }

    // ----- Unmatched -----

    #[test]
    fn unmatched_names_return_none() {
        assert_eq!(classify("randomvideo123.mkv", None), None);
        assert_eq!(classify("VID_20240601_123456.mp4", None), None);
    }

    // GOTCHA: `.ts` MPEG-TS DVR machine names carry no episode/movie
    // evidence — they must stay unmatched (temporal tier decides).
    #[test]
    fn dvr_transport_stream_names_stay_unmatched() {
        assert_eq!(classify("20240601235900-0-0.ts", None), None);
        assert_eq!(classify("2024-06-01 200001-01.ts", None), None);
    }

    // ----- Signatures -----

    #[test]
    fn signature_stable_across_quality_variants() {
        let a = classify("Show.Name.S01E05.720p.x264-GROUP.mkv", None).unwrap();
        let b = classify("show name s01e05 1080p WEB-DL x265-OTHER.mkv", None).unwrap();
        assert_eq!(a.signature(), b.signature());
        assert_eq!(a.collection_title(), b.collection_title());
        assert_eq!(a.signature(), "show:showname");
    }

    #[test]
    fn movie_signature_includes_year() {
        let a = classify("The Matrix (1999).mkv", None).unwrap();
        let b = classify("The Matrix (2003).mkv", None).unwrap();
        assert_eq!(a.signature(), "movie:thematrix1999");
        assert_ne!(a.signature(), b.signature());
    }

    #[test]
    fn punctuation_insensitive_signatures() {
        let parsed = classify("Spider-Man (2002).mkv", None).unwrap();
        assert_eq!(parsed.signature(), "movie:spiderman2002");
        assert_eq!(parsed.collection_title(), "Spider-Man (2002)");
    }

    // ----- Tier 3: temporal clustering -----

    #[test]
    fn gap_over_three_days_breaks_cluster() {
        let times = [
            ts(2026, 6, 1),
            ts(2026, 6, 2),
            ts(2026, 6, 3),
            ts(2026, 6, 10),
            ts(2026, 6, 11),
            ts(2026, 6, 12),
        ];
        let clusters = cluster_by_time(&times);
        assert_eq!(clusters.len(), 2);
        assert_eq!(clusters[0].indices, vec![0, 1, 2]);
        assert_eq!(clusters[1].indices, vec![3, 4, 5]);
    }

    #[test]
    fn gap_of_exactly_three_days_stays_together() {
        let times = [ts(2026, 6, 4), ts(2026, 6, 1), ts(2026, 6, 5)];
        let clusters = cluster_by_time(&times);
        assert_eq!(clusters.len(), 1);
        assert_eq!(clusters[0].indices, vec![1, 0, 2]); // chronological
    }

    #[test]
    fn clusters_smaller_than_three_are_dropped() {
        let times = [
            ts(2026, 6, 1),
            ts(2026, 6, 2),
            ts(2026, 6, 10),
            ts(2026, 6, 11),
            ts(2026, 6, 12),
        ];
        let clusters = cluster_by_time(&times);
        assert_eq!(clusters.len(), 1);
        assert_eq!(clusters[0].indices, vec![2, 3, 4]);
    }

    #[test]
    fn cluster_label_and_signature_use_first_timestamp() {
        let times = [ts(2026, 6, 30), ts(2026, 7, 2), ts(2026, 6, 29)];
        let clusters = cluster_by_time(&times);
        assert_eq!(clusters.len(), 1);
        assert_eq!(clusters[0].label, "June 2026");
        assert_eq!(clusters[0].signature, "time:2026-06");
    }

    #[test]
    fn empty_input_yields_no_clusters() {
        assert!(cluster_by_time(&[]).is_empty());
    }

    // ----- Timestamps and date folders -----

    #[test]
    fn parse_timestamp_accepts_rfc3339() {
        let t = parse_timestamp("2024-06-01T12:30:00Z").unwrap();
        assert_eq!(t, Utc.with_ymd_and_hms(2024, 6, 1, 12, 30, 0).unwrap());
    }

    #[test]
    fn parse_timestamp_rejects_junk() {
        assert!(parse_timestamp("not a date").is_none());
        assert!(parse_timestamp("").is_none());
    }

    #[test]
    fn date_from_path_finds_iso_and_dcim_dates() {
        assert_eq!(
            date_from_path("/Camera Uploads/2024-06-01/IMG_1234.mp4"),
            NaiveDate::from_ymd_opt(2024, 6, 1)
        );
        assert_eq!(
            date_from_path("/DCIM/20240601/IMG_1234.mp4"),
            NaiveDate::from_ymd_opt(2024, 6, 1)
        );
        assert_eq!(date_from_path("/Videos/IMG_1234.mp4"), None);
        assert_eq!(date_from_path("/x/2024-13-45/a.mp4"), None);
    }

    // ----- Wire forms -----

    #[test]
    fn collection_kind_round_trips() {
        for kind in [
            CollectionKind::Show,
            CollectionKind::Movie,
            CollectionKind::Time,
        ] {
            assert_eq!(CollectionKind::parse(kind.as_str()).unwrap(), kind);
        }
        assert!(CollectionKind::parse("manual").is_err());
        assert_eq!(
            serde_json::to_string(&CollectionKind::Time).unwrap(),
            "\"time\""
        );
    }
}
