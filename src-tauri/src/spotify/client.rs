use super::models::{SpotifyPlaylist, SpotifyTrack};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::Read;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

pub const DESKTOP_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const TOTP_SEED_URL: &str =
    "https://code.thetadev.de/ThetaDev/spotify-secrets/raw/branch/main/secrets/secretDict.json";
const TOTP_SEED_MAX_BYTES: u64 = 64 * 1024;
const TOKEN_REFRESH_SKEW_SECS: u64 = 30;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct PagedResponse<T> {
    #[serde(default = "Vec::new")]
    items: Vec<T>,
    #[serde(default)]
    total: usize,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct SavedTrackItem {
    added_at: Option<String>,
    track: Option<ApiTrack>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct PlaylistItem {
    added_at: Option<String>,
    track: Option<ApiTrack>,
    item: Option<ApiTrack>,
}

#[derive(Debug, Deserialize)]
struct ApiTrack {
    id: Option<String>,
    name: Option<String>,
    artists: Option<Vec<ApiArtist>>,
    album: Option<ApiAlbum>,
    duration_ms: Option<u64>,
    explicit: Option<bool>,
    preview_url: Option<String>,
    uri: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiArtist {
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ApiAlbum {
    name: Option<String>,
    images: Option<Vec<ApiImage>>,
}

#[derive(Debug, Deserialize)]
struct ApiImage {
    url: String,
    width: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct ApiPlaylist {
    id: String,
    name: String,
    description: Option<String>,
    images: Option<Vec<ApiImage>>,
    owner: Option<ApiOwner>,
    tracks: Option<ApiTracksRef>,
    collaborative: Option<bool>,
    snapshot_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiOwner {
    id: Option<String>,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiTracksRef {
    total: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct UserProfile {
    id: String,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    access_token_expiration_timestamp_ms: u64,
}

#[derive(Debug, Deserialize)]
pub struct OAuthTokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: u64,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedCredential {
    pub access_token: String,
    pub expires_at_unix: u64,
    pub sp_dc: Option<String>,
}

#[derive(Clone)]
struct TotpSeed {
    version: u32,
    bytes: Vec<u8>,
}

struct TotpSeedCache {
    fetched_at: Instant,
    seed: TotpSeed,
}

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    let len_bits = (data.len() as u64) * 8;
    let mut padded = data.to_vec();
    padded.push(0x80);
    while (padded.len() + 8) % 64 != 0 {
        padded.push(0);
    }
    padded.extend_from_slice(&len_bits.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;

        for (i, item) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1u32),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDCu32),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };

            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*item);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut out = [0u8; 20];
    out[0..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

fn hmac_sha1(key: &[u8], data: &[u8]) -> [u8; 20] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        let hash = sha1(key);
        k[..20].copy_from_slice(&hash);
    } else {
        k[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0u8; 64];
    let mut opad = [0u8; 64];
    for i in 0..64 {
        ipad[i] = k[i] ^ 0x36;
        opad[i] = k[i] ^ 0x5c;
    }

    let mut inner = Vec::with_capacity(64 + data.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(data);
    let inner_hash = sha1(&inner);

    let mut outer = Vec::with_capacity(64 + 20);
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&inner_hash);
    sha1(&outer)
}

fn base32_decode(s: &str) -> Vec<u8> {
    const BASE32_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut bits = 0u64;
    let mut bit_count = 0;
    let mut out = Vec::new();

    for byte in s.bytes() {
        if let Some(val) = BASE32_CHARS
            .iter()
            .position(|&c| c == byte.to_ascii_uppercase())
        {
            bits = (bits << 5) | (val as u64);
            bit_count += 5;
            if bit_count >= 8 {
                bit_count -= 8;
                out.push((bits >> bit_count) as u8);
                bits &= (1 << bit_count) - 1;
            }
        }
    }
    out
}

fn hex_to_base32(hex_str: &str) -> String {
    const BASE32_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut bits = String::new();
    for i in (0..hex_str.len()).step_by(2) {
        if let Ok(b) = u8::from_str_radix(&hex_str[i..i + 2.min(hex_str.len() - i)], 16) {
            bits.push_str(&format!("{:08b}", b));
        }
    }
    let mut out = String::new();
    let chunks = bits.as_bytes().chunks(5);
    for chunk in chunks {
        let mut padded = chunk.to_vec();
        while padded.len() < 5 {
            padded.push(b'0');
        }
        let chunk_str = String::from_utf8_lossy(&padded);
        if let Ok(val) = usize::from_str_radix(&chunk_str, 2) {
            out.push(BASE32_ALPHABET[val] as char);
        }
    }
    out.trim_end_matches('=').to_string()
}

fn hex_encode(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 2);
    for &b in data {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

fn fallback_totp_seed() -> TotpSeed {
    TotpSeed {
        version: 61,
        bytes: vec![
            44, 55, 47, 42, 70, 40, 34, 114, 76, 74, 50, 111, 120, 97, 75, 76, 94, 102, 43, 69, 49,
            120, 118, 80, 64, 78,
        ],
    }
}

fn parse_totp_seed_dictionary(body: &[u8]) -> Result<TotpSeed, String> {
    let values: BTreeMap<String, Vec<u8>> =
        serde_json::from_slice(body).map_err(|e| format!("invalid TOTP seed data: {e}"))?;
    let (version, bytes) = values
        .into_iter()
        .filter_map(|(version, bytes)| version.parse::<u32>().ok().map(|v| (v, bytes)))
        .max_by_key(|(version, _)| *version)
        .ok_or_else(|| "TOTP seed data is empty".to_string())?;

    if !(16..=64).contains(&bytes.len()) {
        return Err("TOTP seed has an invalid length".to_string());
    }

    Ok(TotpSeed { version, bytes })
}

fn fetch_latest_totp_seed() -> Result<TotpSeed, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(TOTP_SEED_URL)
        .header(reqwest::header::USER_AGENT, DESKTOP_USER_AGENT)
        .send()
        .map_err(|e| format!("TOTP seed request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("TOTP seed request returned {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > TOTP_SEED_MAX_BYTES)
    {
        return Err("TOTP seed response is too large".to_string());
    }

    let mut body = Vec::new();
    response
        .take(TOTP_SEED_MAX_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|e| format!("failed reading TOTP seed data: {e}"))?;
    if body.len() as u64 > TOTP_SEED_MAX_BYTES {
        return Err("TOTP seed response is too large".to_string());
    }

    parse_totp_seed_dictionary(&body)
}

fn current_totp_seed() -> TotpSeed {
    static CACHE: OnceLock<Mutex<Option<TotpSeedCache>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    {
        let cached = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(cached) = cached.as_ref() {
            if cached.fetched_at.elapsed() < Duration::from_secs(15 * 60) {
                return cached.seed.clone();
            }
        }
    }

    let seed = fetch_latest_totp_seed().unwrap_or_else(|_| fallback_totp_seed());
    let mut cached = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cached = Some(TotpSeedCache {
        fetched_at: Instant::now(),
        seed: seed.clone(),
    });
    seed
}

fn generate_totp_code() -> (String, u32) {
    let seed = current_totp_seed();
    let transformed: Vec<u8> = seed
        .bytes
        .iter()
        .enumerate()
        .map(|(i, &b)| b ^ (((i % 33) as u8) + 9))
        .collect();

    let joined: String = transformed.iter().map(|b| b.to_string()).collect();
    let hex_str = hex_encode(joined.as_bytes());
    let base32_secret = hex_to_base32(&hex_str);
    let key_bytes = base32_decode(&base32_secret);

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let counter = now_secs / 30;
    let counter_bytes = counter.to_be_bytes();

    let hmac = hmac_sha1(&key_bytes, &counter_bytes);
    let offset = (hmac[19] & 0x0f) as usize;
    let code = (((hmac[offset] & 0x7f) as u32) << 24)
        | ((hmac[offset + 1] as u32) << 16)
        | ((hmac[offset + 2] as u32) << 8)
        | (hmac[offset + 3] as u32);
    let totp = format!("{:06}", code % 1_000_000);
    (totp, seed.version)
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn resolve_token_or_cookie(token_or_cookie: &str) -> Result<ResolvedCredential, String> {
    let raw = token_or_cookie.trim();
    if raw.is_empty() {
        return Err("empty token".to_string());
    }

    if !raw.starts_with("sp_dc=")
        && (raw.starts_with("BQ") || raw.len() > 100 || get_user_profile(raw).is_ok())
    {
        return Ok(ResolvedCredential {
            access_token: raw.to_string(),
            expires_at_unix: unix_now() + 3600,
            sp_dc: None,
        });
    }

    let cookie_val = if let Some(stripped) = raw.strip_prefix("sp_dc=") {
        stripped.trim()
    } else {
        raw
    };

    let (totp, version) = generate_totp_code();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "https://open.spotify.com/api/token?reason=init&productType=web-player&totp={totp}&totpVer={version}&totpServer={totp}"
    );

    let resp = client
        .get(&url)
        .header(reqwest::header::COOKIE, format!("sp_dc={cookie_val}"))
        .header(reqwest::header::USER_AGENT, DESKTOP_USER_AGENT)
        .header(reqwest::header::REFERER, "https://open.spotify.com/")
        .header(reqwest::header::ORIGIN, "https://open.spotify.com")
        .send()
        .map_err(|e| format!("cookie auth failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("cookie auth rejected (http {})", resp.status()));
    }

    let token_resp: TokenResponse = resp
        .json()
        .map_err(|e| format!("invalid token response: {e}"))?;
    if token_resp.access_token.is_empty() {
        return Err("empty access token returned".to_string());
    }

    let expires_at_unix = if token_resp.access_token_expiration_timestamp_ms > 0 {
        token_resp.access_token_expiration_timestamp_ms / 1000
    } else {
        unix_now() + 3600
    };

    Ok(ResolvedCredential {
        access_token: token_resp.access_token,
        expires_at_unix: expires_at_unix.max(unix_now() + TOKEN_REFRESH_SKEW_SECS),
        sp_dc: Some(cookie_val.to_string()),
    })
}

pub fn exchange_oauth_code(
    client_id: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<OAuthTokenResponse, String> {
    oauth_token_request(&[
        ("client_id", client_id),
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ])
}

pub fn refresh_oauth_token(
    client_id: &str,
    refresh_token: &str,
) -> Result<OAuthTokenResponse, String> {
    oauth_token_request(&[
        ("client_id", client_id),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ])
}

fn oauth_token_request(form: &[(&str, &str)]) -> Result<OAuthTokenResponse, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post("https://accounts.spotify.com/api/token")
        .header(reqwest::header::USER_AGENT, DESKTOP_USER_AGENT)
        .form(form)
        .send()
        .map_err(|e| format!("Spotify OAuth token request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Spotify OAuth token request returned {}",
            response.status()
        ));
    }

    let token: OAuthTokenResponse = response
        .json()
        .map_err(|e| format!("invalid Spotify OAuth token response: {e}"))?;
    if token.access_token.is_empty() {
        return Err("Spotify returned an empty access token".to_string());
    }
    Ok(token)
}

pub fn get_user_profile(token: &str) -> Result<(String, Option<String>), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = send_with_retry(&client, "https://api.spotify.com/v1/me", token)?;
    let profile: UserProfile = resp.json().map_err(|e| e.to_string())?;
    Ok((profile.id, profile.display_name))
}

pub fn get_liked_songs_count(token: &str) -> Result<usize, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = send_with_retry(
        &client,
        "https://api.spotify.com/v1/me/tracks?limit=1",
        token,
    )?;
    let page: PagedResponse<SavedTrackItem> = resp.json().map_err(|e| e.to_string())?;
    Ok(page.total)
}

pub fn fetch_all_liked_songs<F>(
    token: &str,
    mut progress_cb: F,
) -> Result<Vec<SpotifyTrack>, String>
where
    F: FnMut(usize, usize),
{
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let mut tracks = Vec::new();
    let mut offset = 0;
    let limit = 50;

    loop {
        let url = format!("https://api.spotify.com/v1/me/tracks?limit={limit}&offset={offset}");
        let resp = send_with_retry(&client, &url, token)?;

        let page: PagedResponse<SavedTrackItem> = resp.json().map_err(|e| e.to_string())?;
        let total = page.total;
        let page_count = page.items.len();

        for item in page.items {
            if let Some(t) = item.track {
                if let Some(track) = convert_api_track(t) {
                    tracks.push(track);
                }
            }
        }

        progress_cb(tracks.len(), total);
        offset += limit;
        if offset >= total || tracks.len() >= total || page_count == 0 {
            break;
        }
    }

    Ok(tracks)
}

pub fn fetch_user_playlists(
    token: &str,
    current_user_id: Option<&str>,
) -> Result<Vec<SpotifyPlaylist>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let mut playlists = Vec::new();
    let mut offset = 0;
    let limit = 50;

    // fetch liked count
    if let Ok(liked_count) = get_liked_songs_count(token) {
        if liked_count > 0 {
            playlists.push(SpotifyPlaylist {
                id: "liked_songs".to_string(),
                name: "Liked Songs".to_string(),
                description: Some(format!("{liked_count} saved songs")),
                track_count: liked_count,
                image_url: None,
                owner_name: Some("You".to_string()),
                is_liked_songs: true,
                is_collaborative: false,
                is_owner: true,
                snapshot_id: None,
            });
        }
    }

    loop {
        let url = format!("https://api.spotify.com/v1/me/playlists?limit={limit}&offset={offset}");
        let resp = send_with_retry(&client, &url, token)?;

        let page: PagedResponse<ApiPlaylist> = resp.json().map_err(|e| e.to_string())?;
        let total = page.total;
        let page_count = page.items.len();

        for item in page.items {
            let is_collab = item.collaborative.unwrap_or(false);
            let is_owner = item
                .owner
                .as_ref()
                .and_then(|o| o.id.as_deref())
                .zip(current_user_id)
                .map(|(a, b)| a == b)
                .unwrap_or(true);

            let image_url = item
                .images
                .and_then(|imgs| imgs.into_iter().max_by_key(|i| i.width.unwrap_or(0)))
                .map(|i| i.url);

            playlists.push(SpotifyPlaylist {
                id: item.id,
                name: item.name,
                description: item.description,
                track_count: item.tracks.and_then(|t| t.total).unwrap_or(0),
                image_url,
                owner_name: item.owner.and_then(|o| o.display_name),
                is_liked_songs: false,
                is_collaborative: is_collab,
                is_owner,
                snapshot_id: item.snapshot_id,
            });
        }

        offset += limit;
        if offset >= total || page_count == 0 {
            break;
        }
    }

    Ok(playlists)
}

pub fn fetch_playlist_items<F>(
    token: &str,
    playlist_id: &str,
    mut progress_cb: F,
) -> Result<(SpotifyPlaylist, Vec<SpotifyTrack>), String>
where
    F: FnMut(usize, usize),
{
    if playlist_id == "liked_songs" || playlist_id == "collection" {
        let tracks = fetch_all_liked_songs(token, &mut progress_cb)?;
        let count = tracks.len();
        let playlist = SpotifyPlaylist {
            id: "liked_songs".to_string(),
            name: "Liked Songs".to_string(),
            description: Some(format!("{count} songs")),
            track_count: count,
            image_url: None,
            owner_name: Some("You".to_string()),
            is_liked_songs: true,
            is_collaborative: false,
            is_owner: true,
            snapshot_id: None,
        };
        return Ok((playlist, tracks));
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // get playlist details
    let meta_url = format!("https://api.spotify.com/v1/playlists/{playlist_id}");
    let meta_resp = send_with_retry(&client, &meta_url, token)?;
    let api_pl: ApiPlaylist = meta_resp.json().map_err(|e| e.to_string())?;

    let image_url = api_pl
        .images
        .and_then(|imgs| imgs.into_iter().max_by_key(|i| i.width.unwrap_or(0)))
        .map(|i| i.url);

    let playlist = SpotifyPlaylist {
        id: api_pl.id.clone(),
        name: api_pl.name.clone(),
        description: api_pl.description.clone(),
        track_count: api_pl.tracks.as_ref().and_then(|t| t.total).unwrap_or(0),
        image_url,
        owner_name: api_pl.owner.and_then(|o| o.display_name),
        is_liked_songs: false,
        is_collaborative: api_pl.collaborative.unwrap_or(false),
        is_owner: true,
        snapshot_id: api_pl.snapshot_id,
    };

    let mut tracks = Vec::new();
    let mut offset = 0;
    let limit = 100;

    loop {
        let items_url = format!(
            "https://api.spotify.com/v1/playlists/{playlist_id}/items?limit={limit}&offset={offset}"
        );
        let resp = match send_with_retry(&client, &items_url, token) {
            Ok(r) => r,
            Err(e) => {
                // fallback tracks endpoint
                let legacy_url = format!(
                    "https://api.spotify.com/v1/playlists/{playlist_id}/tracks?limit={limit}&offset={offset}"
                );
                send_with_retry(&client, &legacy_url, token)
                    .map_err(|_| format!("fetch items failed {e}"))?
            }
        };

        let page: PagedResponse<PlaylistItem> = resp.json().map_err(|e| e.to_string())?;
        let total = page.total;
        let page_count = page.items.len();

        for item in page.items {
            let api_t = item.track.or(item.item);
            if let Some(t) = api_t {
                if let Some(track) = convert_api_track(t) {
                    tracks.push(track);
                }
            }
        }

        progress_cb(tracks.len(), total);
        offset += limit;
        if offset >= total || tracks.len() >= total || page_count == 0 {
            break;
        }
    }

    Ok((playlist, tracks))
}

fn send_with_retry(
    client: &reqwest::blocking::Client,
    url: &str,
    token: &str,
) -> Result<reqwest::blocking::Response, String> {
    for _ in 0..3 {
        let resp = client
            .get(url)
            .header(reqwest::header::USER_AGENT, DESKTOP_USER_AGENT)
            .bearer_auth(token)
            .send()
            .map_err(|e| e.to_string())?;

        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry_after = resp
                .headers()
                .get("Retry-After")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(2);
            thread::sleep(Duration::from_secs(retry_after.clamp(1, 10)));
            continue;
        }

        if resp.status().is_success() {
            return Ok(resp);
        }

        return Err(format!("http status {}", resp.status()));
    }

    Err("max retries exceeded".to_string())
}

fn convert_api_track(t: ApiTrack) -> Option<SpotifyTrack> {
    let title = t.name?.trim().to_string();
    if title.is_empty() {
        return None;
    }

    let artists = t
        .artists
        .unwrap_or_default()
        .into_iter()
        .filter_map(|a| a.name)
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect();

    let id = t.id.unwrap_or_else(|| title.clone());
    let uri = t.uri.unwrap_or_else(|| format!("spotify:track:{id}"));

    Some(SpotifyTrack {
        id,
        title,
        artists,
        album: t.album.and_then(|a| a.name),
        duration_ms: t.duration_ms.unwrap_or(0),
        is_explicit: t.explicit.unwrap_or(false),
        preview_url: t.preview_url,
        uri,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha1_calculation() {
        let digest = sha1(b"The quick brown fox jumps over the lazy dog");
        let hex = hex_encode(&digest);
        assert_eq!(hex, "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12");
    }

    #[test]
    fn test_totp_code_generation() {
        let (totp, version) = generate_totp_code();
        assert_eq!(totp.len(), 6);
        assert!(totp.chars().all(|c| c.is_ascii_digit()));
        assert!(version >= 61);
    }

    #[test]
    fn newest_totp_seed_is_selected() {
        let seed = parse_totp_seed_dictionary(
            br#"{"60":[1,2],"62":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]}"#,
        )
        .expect("seed dictionary");
        assert_eq!(seed.version, 62);
        assert_eq!(seed.bytes.len(), 16);
    }

    #[test]
    fn malformed_totp_seed_is_rejected() {
        assert!(parse_totp_seed_dictionary(br#"{"62":[1,2]}"#).is_err());
    }
}
