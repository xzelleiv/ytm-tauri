// native lrclib lookup

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const LRCLIB_BASE: &str = "https://lrclib.net/api";
const YTM_BROWSE_URL: &str = "https://ytmbrowseproxy.zvz.be/browse?prettyPrint=false";
const MAX_BROWSE_ID_LEN: usize = 96;
const QUERY_SPACING: Duration = Duration::from_millis(250);
const MAX_RETRY_AFTER_SECONDS: u64 = 86_400;
const DEFAULT_RETRY_AFTER_SECONDS: u64 = 60;
const MAX_TRAILING_DURATION_MS: i64 = 3_000;
const LEADING_PAD_THRESHOLD_MS: i64 = 300;

static BLOCKED_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Default, Deserialize)]
pub struct TrackQuery {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub browse_id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct LyricsResult {
    pub title: String,
    pub artists: Vec<String>,
    pub lines: Option<Vec<LyricLine>>,
    pub lyrics: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub time: String,
    pub time_in_ms: i64,
    pub duration: i64,
    pub text: String,
    pub words: Vec<LyricWord>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LyricWord {
    pub time_in_ms: i64,
    pub word: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LrcLibItem {
    #[serde(default)]
    track_name: Option<String>,
    #[serde(default)]
    artist_name: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    instrumental: bool,
    #[serde(default)]
    synced_lyrics: Option<String>,
    #[serde(default)]
    plain_lyrics: Option<String>,
}

impl LrcLibItem {
    fn has_lyrics(&self) -> bool {
        !self.instrumental && (non_empty(&self.synced_lyrics) || non_empty(&self.plain_lyrics))
    }

    fn score(&self, query: &TrackQuery) -> f64 {
        score_candidate(
            self.artist_name.as_deref().unwrap_or_default(),
            self.track_name.as_deref().unwrap_or_default(),
            self.duration.unwrap_or(0.0),
            query,
        )
    }
}

fn non_empty(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
}

enum Fetch<T> {
    Found(T),
    Missing,
    RateLimited,
}

pub fn lookup(query: &TrackQuery) -> Result<Option<LyricsResult>, String> {
    match query.browse_id.as_deref() {
        Some(browse_id) => lookup_ytm(browse_id, query),
        None => lookup_lrclib(query),
    }
}

fn is_valid_browse_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_BROWSE_ID_LEN
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn lookup_ytm(browse_id: &str, query: &TrackQuery) -> Result<Option<LyricsResult>, String> {
    if !is_valid_browse_id(browse_id) {
        return Err("invalid browse id".to_string());
    }
    let body = serde_json::json!({
        "browseId": browse_id,
        "context": { "client": { "clientName": "26", "clientVersion": "7.01.05" } },
    });
    let response = client()?
        .post(YTM_BROWSE_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let browse: serde_json::Value = response.json().map_err(|error| error.to_string())?;
    Ok(parse_ytm_browse(&browse, query))
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn join_runs(value: Option<&serde_json::Value>) -> Option<String> {
    let runs = value?.as_array()?;
    let text = runs
        .iter()
        .filter_map(|run| run.get("text").and_then(serde_json::Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn ms_field(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::String(text) => text.trim().parse().ok(),
        serde_json::Value::Number(number) => number.as_i64(),
        _ => None,
    }
}

pub fn parse_ytm_browse(browse: &serde_json::Value, query: &TrackQuery) -> Option<LyricsResult> {
    let contents = browse.get("contents")?;
    let timed = contents
        .pointer("/elementRenderer/newElement/type/componentType/model/timedLyricsModel/lyricsData/timedLyricsData")
        .and_then(serde_json::Value::as_array);

    let mut lines: Option<Vec<LyricLine>> = timed
        .filter(|items| {
            items
                .first()
                .is_some_and(|item| item.get("cueRange").is_some())
        })
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let start = ms_field(item.pointer("/cueRange/startTimeMilliseconds")?)?;
                    let end = ms_field(item.pointer("/cueRange/endTimeMilliseconds")?)?;
                    if end < start {
                        return None;
                    }
                    let text = collapse_whitespace(
                        item.get("lyricLine")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default(),
                    );
                    Some(LyricLine {
                        time: format_time(start),
                        time_in_ms: start,
                        duration: end - start,
                        text: if text == "\u{266a}" {
                            String::new()
                        } else {
                            text
                        },
                        words: Vec::new(),
                    })
                })
                .collect()
        });
    if let Some(list) = lines.as_mut() {
        if let Some(first) = list.first().map(|line| line.time_in_ms) {
            if first > LEADING_PAD_THRESHOLD_MS {
                list.insert(
                    0,
                    LyricLine {
                        time: format_time(0),
                        time_in_ms: 0,
                        duration: first,
                        text: String::new(),
                        words: Vec::new(),
                    },
                );
            }
        }
    }
    let lines = lines.filter(|list| !list.is_empty());

    let lyrics = if lines.is_some() {
        None
    } else if let Some(items) = timed {
        Some(
            items
                .iter()
                .filter_map(|item| item.get("lyricLine").and_then(serde_json::Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    } else {
        join_runs(contents.pointer("/messageRenderer/text/runs")).or_else(|| {
            join_runs(contents.pointer(
                "/sectionListRenderer/contents/0/musicDescriptionShelfRenderer/description/runs",
            ))
        })
    };
    let lyrics = lyrics.filter(|text| !text.trim().is_empty() && text != "Lyrics not available");

    if lines.is_none() && lyrics.is_none() {
        return None;
    }
    Some(LyricsResult {
        title: query.title.clone(),
        artists: vec![query.artist.clone()],
        lines,
        lyrics,
    })
}

fn lookup_lrclib(query: &TrackQuery) -> Result<Option<LyricsResult>, String> {
    if is_rate_limited() || query.title.trim().is_empty() {
        return Ok(None);
    }
    let client = client()?;
    let clean_title = clean_song_title(&query.title);
    let clean_art = clean_artist(&query.artist);

    if !clean_title.is_empty() && !clean_art.is_empty() {
        let mut params = vec![
            ("track_name", clean_title.clone()),
            ("artist_name", clean_art.clone()),
        ];
        if let Some(album) = query.album.as_deref().filter(|album| !album.is_empty()) {
            params.push(("album_name", album.to_string()));
        }
        if query.duration > 0.0 {
            params.push(("duration", format!("{}", query.duration.round() as i64)));
        }
        match fetch_json::<LrcLibItem>(&client, "get", &params) {
            Fetch::RateLimited => return Ok(None),
            Fetch::Found(item) if item.has_lyrics() && item.score(query) > 0.0 => {
                return Ok(Some(into_result(item, query, false)));
            }
            _ => {}
        }
    }

    let artist_or_raw = if clean_art.is_empty() {
        query.artist.clone()
    } else {
        clean_art.clone()
    };
    let mut searches: Vec<Vec<(&str, String)>> = Vec::new();
    if !clean_title.is_empty() {
        let mut params = vec![
            ("artist_name", artist_or_raw.clone()),
            ("track_name", clean_title.clone()),
        ];
        if let Some(album) = query.album.as_deref().filter(|album| !album.is_empty()) {
            params.push(("album_name", album.to_string()));
        }
        searches.push(params);
    }
    searches.push(vec![
        ("artist_name", query.artist.clone()),
        ("track_name", query.title.clone()),
    ]);
    let title_or_raw = if clean_title.is_empty() {
        &query.title
    } else {
        &clean_title
    };
    searches.push(vec![(
        "q",
        format!("{artist_or_raw} {title_or_raw}").trim().to_string(),
    )]);

    for params in searches {
        thread::sleep(QUERY_SPACING);
        match fetch_json::<Vec<LrcLibItem>>(&client, "search", &params) {
            Fetch::RateLimited => return Ok(None),
            Fetch::Found(items) if !items.is_empty() => {
                return Ok(best_candidate(items, query).map(|item| into_result(item, query, true)));
            }
            _ => {}
        }
    }
    Ok(None)
}

fn best_candidate(items: Vec<LrcLibItem>, query: &TrackQuery) -> Option<LrcLibItem> {
    items
        .into_iter()
        .filter(LrcLibItem::has_lyrics)
        .map(|item| (item.score(query), item))
        .filter(|(score, _)| *score > 0.0)
        .max_by(|(left, _), (right, _)| left.total_cmp(right))
        .map(|(_, item)| item)
}

fn into_result(item: LrcLibItem, query: &TrackQuery, split_artists: bool) -> LyricsResult {
    let artists = match item.artist_name.as_deref().filter(|name| !name.is_empty()) {
        Some(name) if split_artists => name
            .split(['&', ','])
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect(),
        Some(name) => vec![name.to_string()],
        None => vec![query.artist.clone()],
    };
    LyricsResult {
        title: item
            .track_name
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| query.title.clone()),
        artists,
        lines: item
            .synced_lyrics
            .filter(|text| !text.trim().is_empty())
            .map(|text| parse_lrc(&text))
            .filter(|lines| !lines.is_empty()),
        lyrics: item.plain_lyrics.filter(|text| !text.trim().is_empty()),
    }
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .user_agent(concat!(
            "ytm-tauri/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/xzelleiv/ytm-tauri)"
        ))
        .build()
        .map_err(|error| error.to_string())
}

fn fetch_json<T: for<'de> Deserialize<'de>>(
    client: &reqwest::blocking::Client,
    endpoint: &str,
    params: &[(&str, String)],
) -> Fetch<T> {
    if is_rate_limited() {
        return Fetch::RateLimited;
    }
    let Ok(mut url) = url::Url::parse(&format!("{LRCLIB_BASE}/{endpoint}")) else {
        return Fetch::Missing;
    };
    url.query_pairs_mut()
        .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
    let Ok(response) = client
        .get(url)
        .header(
            "Lrclib-Client",
            concat!("ytm-tauri/", env!("CARGO_PKG_VERSION")),
        )
        .send()
    else {
        return Fetch::Missing;
    };
    if response.status().as_u16() == 429 {
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map_or(DEFAULT_RETRY_AFTER_SECONDS, parse_retry_after);
        BLOCKED_UNTIL_MS.store(now_ms() + retry_after * 1000, Ordering::Relaxed);
        return Fetch::RateLimited;
    }
    if !response.status().is_success() {
        return Fetch::Missing;
    }
    response.json::<T>().map_or(Fetch::Missing, Fetch::Found)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

fn is_rate_limited() -> bool {
    now_ms() < BLOCKED_UNTIL_MS.load(Ordering::Relaxed)
}

fn parse_retry_after(value: &str) -> u64 {
    match value.trim().parse::<u64>() {
        Ok(seconds) if seconds > 0 => seconds.min(MAX_RETRY_AFTER_SECONDS),
        _ => DEFAULT_RETRY_AFTER_SECONDS,
    }
}

struct Patterns {
    suffixes: Vec<Regex>,
    leading_number: Regex,
    brackets: Regex,
    dash_suffix: Regex,
    featuring: Regex,
    whitespace: Regex,
    timestamp: Regex,
    tag: Regex,
    word: Regex,
    section: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let compile = |pattern: &str| Regex::new(pattern).expect("static lyrics regex");
        Patterns {
            suffixes: [
                r"(?i)\s*(- topic)$",
                r"(?i)\s*vevo$",
                r"(?i)\s*[(|\[](official|audio|video|lyrics?|visualizer|remaster(ed)?|demo|live|extended|draft|special edition|deluxe|explicit|clean|4k|hd|hq|performance|clip|full album|slowed|reverb|sped up|sped-up|slowed\s*\+\s*reverb|color coded|eng sub|rom|han|eng|lyrics video).*?[)|\]]",
                r"(?i)\s*[(|\[](20\d\d|19\d\d)\s*(remaster|version|edition|mix|anniversary)?[)|\]]",
                r"(?i)\s*[(|\[](hd|hq|4k|upgrade|live|acoustic|instrumental)[)|\]]$",
            ]
            .into_iter()
            .map(compile)
            .collect(),
            leading_number: compile(r"^\d+[\s.-]+\s*"),
            brackets: compile(r"[(\[{][^)\]}]*[)\]}]"),
            dash_suffix: compile(r"(?i)\s*-\s*(official|audio|video|lyrics?|visualizer|remaster(ed)?|demo|live|extended|draft|special edition|deluxe).*$"),
            featuring: compile(r"(?i)\s+(feat|ft)\.?\s+.*$"),
            whitespace: compile(r"\s+"),
            timestamp: compile(r"^\[(\d+):(\d+)(?:[.,:](\d+))?\]"),
            tag: compile(r"^\[(\w+):\s*(.+?)\s*\]$"),
            word: compile(r"<(\d+):(\d+)(?:[.,:](\d+))?>\s*(\S+)"),
            section: compile(r"(?i)^\[(verse|chorus|bridge|intro|outro|hook|interlude)[^\]]*\]\s*"),
        }
    })
}

fn cleanup_name(name: &str) -> String {
    let mut value = name.to_string();
    for suffix in &patterns().suffixes {
        value = suffix.replace_all(&value, "").into_owned();
    }
    value.trim().to_string()
}

pub fn clean_song_title(title: &str) -> String {
    let p = patterns();
    let value = p.leading_number.replace(title, "");
    let value = p.brackets.replace_all(&value, " ");
    let value = p.dash_suffix.replace_all(&value, " ");
    let value = p.featuring.replace_all(&value, " ");
    let value = p.whitespace.replace_all(&value, " ");
    cleanup_name(value.trim())
}

pub fn clean_artist(artist: &str) -> String {
    let p = patterns();
    let value = p.brackets.replace_all(artist, " ");
    let value = p.featuring.replace_all(&value, " ");
    let value = p.whitespace.replace_all(&value, " ");
    cleanup_name(value.trim())
}

// bigram dice coefficient
fn dice(first: &str, second: &str) -> f64 {
    if first.is_empty() || second.is_empty() {
        return 0.0;
    }
    if first == second {
        return 1.0;
    }
    let first: Vec<char> = first.chars().collect();
    let second: Vec<char> = second.chars().collect();
    if first.len() < 2 || second.len() < 2 {
        return 0.0;
    }
    let mut bigrams: HashMap<(char, char), usize> = HashMap::new();
    for pair in first.windows(2) {
        *bigrams.entry((pair[0], pair[1])).or_default() += 1;
    }
    let mut intersection = 0;
    for pair in second.windows(2) {
        if let Some(count) = bigrams
            .get_mut(&(pair[0], pair[1]))
            .filter(|count| **count > 0)
        {
            *count -= 1;
            intersection += 1;
        }
    }
    (2.0 * intersection as f64) / (first.len() + second.len() - 2) as f64
}

fn jaro_winkler(left: &str, right: &str) -> f64 {
    if left == right {
        return 1.0;
    }
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let range = (left.len().max(right.len()) / 2).saturating_sub(1);
    let mut left_matches = vec![false; left.len()];
    let mut right_matches = vec![false; right.len()];
    let mut matches = 0usize;
    for (i, &ch) in left.iter().enumerate() {
        let start = i.saturating_sub(range);
        let end = (i + range + 1).min(right.len());
        for j in start..end {
            if right_matches[j] || ch != right[j] {
                continue;
            }
            left_matches[i] = true;
            right_matches[j] = true;
            matches += 1;
            break;
        }
    }
    if matches == 0 {
        return 0.0;
    }
    let left_chars = left.iter().zip(&left_matches).filter(|(_, m)| **m);
    let right_chars = right.iter().zip(&right_matches).filter(|(_, m)| **m);
    let transpositions = left_chars
        .zip(right_chars)
        .filter(|((a, _), (b, _))| a != b)
        .count() as f64
        / 2.0;
    let m = matches as f64;
    let jaro = (m / left.len() as f64 + m / right.len() as f64 + (m - transpositions) / m) / 3.0;
    let prefix = left
        .iter()
        .zip(&right)
        .take(4)
        .take_while(|(a, b)| a == b)
        .count() as f64;
    jaro + prefix * 0.1 * (1.0 - jaro)
}

fn similarity(
    target_raw: &str,
    target_clean: &str,
    candidate_raw: &str,
    candidate_clean: &str,
) -> f64 {
    [
        dice(target_clean, candidate_clean),
        dice(target_raw, candidate_clean),
        dice(target_clean, candidate_raw),
        jaro_winkler(target_clean, candidate_clean),
        jaro_winkler(target_raw, candidate_clean),
    ]
    .into_iter()
    .fold(0.0, f64::max)
}

pub fn score_candidate(artist: &str, title: &str, duration: f64, query: &TrackQuery) -> f64 {
    if artist.is_empty() || title.is_empty() {
        return -1.0;
    }
    let title_sim = similarity(
        &query.title.to_lowercase(),
        &clean_song_title(&query.title).to_lowercase(),
        &title.to_lowercase(),
        &clean_song_title(title).to_lowercase(),
    );
    let artist_sim = similarity(
        &query.artist.to_lowercase(),
        &clean_artist(&query.artist).to_lowercase(),
        &artist.to_lowercase(),
        &clean_artist(artist).to_lowercase(),
    );
    if title_sim < 0.65 || artist_sim < 0.55 {
        return -1.0;
    }
    let mut score = title_sim * 0.6 + artist_sim * 0.4;
    if query.duration > 0.0 && duration > 0.0 {
        let diff = (duration - query.duration).abs();
        // reject other recordings
        if diff > 2.5 {
            return -1.0;
        }
        score += 0.1;
    }
    score
}

fn timestamp_ms(minutes: &str, seconds: &str, fraction: Option<&str>) -> i64 {
    let fraction_ms = fraction.map_or(0, |value| {
        let digits: String = value.chars().take(3).collect();
        format!("{digits:0<3}").parse::<i64>().unwrap_or(0)
    });
    minutes.parse::<i64>().unwrap_or(0) * 60_000
        + seconds.parse::<i64>().unwrap_or(0) * 1_000
        + fraction_ms
}

pub fn format_time(ms: i64) -> String {
    let ms = ms.max(0);
    format!(
        "{:02}:{:02}.{:02}",
        ms / 60_000,
        (ms % 60_000) / 1_000,
        (ms % 1_000) / 10
    )
}

pub fn parse_lrc(text: &str) -> Vec<LyricLine> {
    let p = patterns();
    let mut lines: Vec<LyricLine> = Vec::new();
    let mut offset = 0i64;

    for raw in text.lines() {
        let mut rest = raw.trim();
        if !rest.starts_with('[') {
            continue;
        }
        let mut stamps = Vec::new();
        while let Some(captures) = p.timestamp.captures(rest) {
            let minutes = &captures[1];
            let seconds = &captures[2];
            let fraction = captures.get(3).map(|m| m.as_str());
            stamps.push((
                format!("{minutes}:{seconds}.{}", fraction.unwrap_or("00")),
                timestamp_ms(minutes, seconds, fraction),
            ));
            rest = &rest[captures[0].len()..];
        }

        if stamps.is_empty() {
            if let Some(tag) = p.tag.captures(rest) {
                if &tag[1] == "offset" {
                    offset = tag[2].trim().parse().unwrap_or(0);
                }
            }
            continue;
        }

        let mut line_text = rest.trim().to_string();
        let words: Vec<LyricWord> = p
            .word
            .captures_iter(&line_text)
            .map(|captures| LyricWord {
                time_in_ms: timestamp_ms(
                    &captures[1],
                    &captures[2],
                    captures.get(3).map(|m| m.as_str()),
                ),
                word: captures[4].to_string(),
            })
            .collect();
        if !words.is_empty() {
            line_text = words
                .iter()
                .map(|word| word.word.as_str())
                .collect::<Vec<_>>()
                .join(" ");
        }
        let line_text = p.section.replace(&line_text, "").into_owned();

        for (time, time_in_ms) in stamps {
            lines.push(LyricLine {
                time,
                time_in_ms,
                duration: -1,
                text: line_text.clone(),
                words: words.clone(),
            });
        }
    }

    lines.sort_by_key(|line| line.time_in_ms);
    let starts: Vec<i64> = lines.iter().map(|line| line.time_in_ms).collect();
    for (index, line) in lines.iter_mut().enumerate() {
        line.time_in_ms += offset;
        line.duration = starts
            .get(index + 1)
            .map_or(MAX_TRAILING_DURATION_MS, |next| {
                (next - starts[index]).max(0)
            });
    }

    if let Some(first) = lines.first().map(|line| line.time_in_ms) {
        if first > LEADING_PAD_THRESHOLD_MS {
            lines.insert(
                0,
                LyricLine {
                    time: format_time(0),
                    time_in_ms: 0,
                    duration: first,
                    text: String::new(),
                    words: Vec::new(),
                },
            );
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(title: &str, artist: &str, duration: f64) -> TrackQuery {
        TrackQuery {
            title: title.to_string(),
            artist: artist.to_string(),
            album: None,
            duration,
            browse_id: None,
        }
    }

    #[test]
    fn parses_flexible_timestamps_and_strips_section_headers() {
        let lrc = "[re:LRCLIB]\n[00:10,50][Verse 1] Comma decimal\n[00:20.123][Chorus] Three digit millis\n[00:30] Integer seconds\n[00:40:50] Colon subseconds";
        let lines = parse_lrc(lrc);
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[0].time_in_ms, 0);
        assert_eq!(lines[0].duration, 10_500);
        assert_eq!(lines[1].time_in_ms, 10_500);
        assert_eq!(lines[1].text, "Comma decimal");
        assert_eq!(lines[2].time_in_ms, 20_123);
        assert_eq!(lines[2].text, "Three digit millis");
        assert_eq!(lines[3].time_in_ms, 30_000);
        assert_eq!(lines[3].text, "Integer seconds");
        assert_eq!(lines[4].time_in_ms, 40_500);
        assert_eq!(lines[4].duration, 3_000);
    }

    #[test]
    fn parses_repeated_stamps_offsets_and_word_timing() {
        let lrc =
            "[offset:+200]\n[00:01.00][00:05.00]Echo\n[00:03.00]<00:03.00> Hello <00:03.50> world";
        let lines = parse_lrc(lrc);
        let texts: Vec<_> = lines.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(texts, ["", "Echo", "Hello world", "Echo"]);
        assert_eq!(lines[1].time_in_ms, 1_200);
        assert_eq!(lines[2].words.len(), 2);
        assert_eq!(lines[2].words[1].time_in_ms, 3_500);
    }

    #[test]
    fn cleans_titles_and_artists() {
        assert_eq!(
            clean_song_title("01. Song (Official Video) feat. Someone"),
            "Song"
        );
        assert_eq!(clean_song_title("Song - Remastered 2011"), "Song");
        assert_eq!(clean_artist("Artist - Topic"), "Artist");
        assert_eq!(clean_artist("ArtistVEVO"), "Artist");
    }

    #[test]
    fn rejects_different_duration_or_artist() {
        let info = query("Song", "Artist", 180.0);
        assert!(score_candidate("Artist", "Song", 181.0, &info) > 0.0);
        assert_eq!(score_candidate("Artist", "Song", 190.0, &info), -1.0);
        assert_eq!(score_candidate("Somebody Else", "Song", 180.0, &info), -1.0);
    }

    #[test]
    fn similarity_handles_unicode() {
        assert_eq!(dice("夜に駆ける", "夜に駆ける"), 1.0);
        assert!(jaro_winkler("夜に駆ける", "夜に駆け") > 0.9);
    }

    #[test]
    fn picks_highest_scoring_candidate() {
        let info = query("Song", "Artist", 0.0);
        let items: Vec<LrcLibItem> = serde_json::from_str(
            r#"[{"trackName":"Other","artistName":"Nobody","plainLyrics":"x"},
                {"trackName":"Song","artistName":"Artist","syncedLyrics":"[00:01.00]Hi"},
                {"trackName":"Song","artistName":"Artist","instrumental":true}]"#,
        )
        .expect("items");
        let best = best_candidate(items, &info).expect("candidate");
        let result = into_result(best, &info, true);
        assert_eq!(result.artists, ["Artist"]);
        assert_eq!(result.lines.expect("lines")[1].text, "Hi");
    }

    #[test]
    fn parses_timed_ytm_lyrics() {
        let browse = serde_json::json!({
            "contents": { "elementRenderer": { "newElement": { "type": { "componentType": { "model": {
                "timedLyricsModel": { "lyricsData": { "timedLyricsData": [
                    { "lyricLine": "First  line", "cueRange": { "startTimeMilliseconds": "1000", "endTimeMilliseconds": "2500" } },
                    { "lyricLine": "\u{266a}", "cueRange": { "startTimeMilliseconds": "2500", "endTimeMilliseconds": "4000" } },
                    { "lyricLine": "Broken", "cueRange": { "startTimeMilliseconds": "9", "endTimeMilliseconds": "1" } }
                ] } }
            } } } } } }
        });
        let result = parse_ytm_browse(&browse, &query("Song", "Artist", 0.0)).expect("lyrics");
        let lines = result.lines.expect("lines");
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].duration, 1_000);
        assert_eq!(lines[1].text, "First line");
        assert_eq!(lines[1].duration, 1_500);
        assert_eq!(lines[2].text, "");
    }

    #[test]
    fn parses_plain_ytm_lyrics_and_skips_unavailable() {
        let plain = serde_json::json!({ "contents": { "sectionListRenderer": { "contents": [
            { "musicDescriptionShelfRenderer": { "description": { "runs": [{ "text": "Line one" }, { "text": "Line two" }] } } }
        ] } } });
        let result = parse_ytm_browse(&plain, &query("Song", "Artist", 0.0)).expect("plain");
        assert_eq!(result.lyrics.as_deref(), Some("Line one\nLine two"));

        let missing = serde_json::json!({ "contents": { "messageRenderer": { "text": { "runs": [{ "text": "Lyrics not available" }] } } } });
        assert!(parse_ytm_browse(&missing, &query("Song", "Artist", 0.0)).is_none());
    }

    #[test]
    fn browse_ids_are_validated() {
        assert!(is_valid_browse_id("MPLYt_abc-123"));
        assert!(!is_valid_browse_id("../etc"));
        assert!(!is_valid_browse_id(""));
    }

    #[test]
    fn retry_after_is_bounded() {
        assert_eq!(parse_retry_after("30"), 30);
        assert_eq!(parse_retry_after("999999"), MAX_RETRY_AFTER_SECONDS);
        assert_eq!(parse_retry_after("bogus"), DEFAULT_RETRY_AFTER_SECONDS);
    }
}
