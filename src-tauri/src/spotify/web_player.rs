// native spotify web player access
#![allow(dead_code)]

use super::models::{SpotifyPlaylist, SpotifyTrack};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, ORIGIN, REFERER};
use reqwest::redirect::Policy;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    fmt,
    io::Read,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const PATHFINDER_URL: &str = "https://api-partner.spotify.com/pathfinder/v2/query";
const WEB_PLAYER_URL: &str = "https://open.spotify.com/";
const CLIENT_TOKEN_URL: &str = "https://clienttoken.spotify.com/v1/clienttoken";
const PATHFINDER_ORIGIN: &str = "https://open.spotify.com";
const PATHFINDER_REFERER: &str = "https://open.spotify.com/";
const WEB_PLAYER_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_PAGE_LIMIT: usize = 100;
const MAX_OFFSET: usize = 1_000_000_000;
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
static RATE_LIMIT_UNTIL_UNIX: AtomicU64 = AtomicU64::new(0);

// surface stale persisted query hashes
const PROFILE_ATTRIBUTES_HASH: &str =
    "08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0";
const LIBRARY_V3_HASH: &str = "390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455";
const FETCH_PLAYLIST_HASH: &str =
    "86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0";
const FETCH_LIBRARY_TRACKS_HASH: &str =
    "087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpotifyProfile {
    pub id: String,
    pub display_name: Option<String>,
    pub image_url: Option<String>,
    pub uri: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpotifyPage<T> {
    pub items: Vec<T>,
    // raw entries before filtering
    pub raw_count: usize,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpotifyPlaylistPage {
    pub playlist: SpotifyPlaylist,
    pub tracks: SpotifyPage<SpotifyTrack>,
}

#[derive(Debug)]
pub enum WebPlayerError {
    MissingAccessToken,
    MissingClientId,
    MissingDeviceId,
    MissingClientToken,
    MissingAppVersion,
    InvalidPage { offset: usize, limit: usize },
    Request(String),
    RateLimited { retry_after_seconds: Option<u64> },
    Authentication { status: u16 },
    HashStale { operation: &'static str },
    GraphQl { operation: &'static str },
    Bootstrap(&'static str),
    ResponseTooLarge,
    Decode,
    Schema(&'static str),
}

impl fmt::Display for WebPlayerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingAccessToken => f.write_str("Spotify Web Player access token is missing"),
            Self::MissingClientId => f.write_str("Spotify Web Player client ID is missing"),
            Self::MissingDeviceId => f.write_str("Spotify Web Player device ID is missing"),
            Self::MissingClientToken => f.write_str("Spotify Web Player client token is missing"),
            Self::MissingAppVersion => f.write_str("Spotify Web Player app version is missing"),
            Self::InvalidPage { offset, limit } => {
                write!(f, "invalid Spotify page (offset={offset}, limit={limit})")
            }
            Self::Request(_) => f.write_str("Spotify Web Player request failed"),
            Self::RateLimited {
                retry_after_seconds,
            } => match retry_after_seconds {
                Some(seconds) => {
                    write!(f, "Spotify Web Player rate limited; retry after {seconds}s")
                }
                None => f.write_str("Spotify Web Player rate limited"),
            },
            Self::Authentication { status } => write!(
                f,
                "Spotify Web Player authentication failed (HTTP {status})"
            ),
            Self::HashStale { operation } => {
                write!(f, "Spotify Web Player query hash is stale for {operation}")
            }
            Self::GraphQl { operation } => {
                write!(
                    f,
                    "Spotify Web Player GraphQL request failed for {operation}"
                )
            }
            Self::Bootstrap(stage) => write!(f, "Spotify Web Player bootstrap failed at {stage}"),
            Self::ResponseTooLarge => f.write_str("Spotify Web Player response is too large"),
            Self::Decode => f.write_str("Spotify Web Player response was not valid JSON"),
            Self::Schema(name) => write!(f, "Spotify Web Player response is missing {name}"),
        }
    }
}

impl std::error::Error for WebPlayerError {}

#[derive(Clone)]
pub struct WebPlayerClient {
    client: Client,
    access_token: String,
    client_token: Option<String>,
    app_version: Option<String>,
}

impl WebPlayerClient {
    // bootstrap without browser state
    pub fn bootstrap(
        access_token: impl Into<String>,
        client_id: impl Into<String>,
    ) -> Result<Self, WebPlayerError> {
        let device_id = generated_device_id();
        Self::bootstrap_with_device_id(access_token, client_id, device_id)
    }

    // reuse native device identity
    pub fn bootstrap_with_device_id(
        access_token: impl Into<String>,
        client_id: impl Into<String>,
        device_id: impl Into<String>,
    ) -> Result<Self, WebPlayerError> {
        let access_token = access_token.into().trim().to_string();
        if access_token.is_empty() {
            return Err(WebPlayerError::MissingAccessToken);
        }
        let client_id =
            clean_optional(Some(client_id.into())).ok_or(WebPlayerError::MissingClientId)?;
        let device_id =
            clean_optional(Some(device_id.into())).ok_or(WebPlayerError::MissingDeviceId)?;
        let bootstrap_client = native_http_client()?;
        let app_version = fetch_app_version(&bootstrap_client)?;
        let client_token =
            fetch_client_token(&bootstrap_client, &app_version, &client_id, &device_id)?;
        Self::new(access_token, Some(client_token), Some(app_version))
    }

    // keep credentials in native clients
    pub fn new(
        access_token: impl Into<String>,
        client_token: Option<String>,
        app_version: Option<String>,
    ) -> Result<Self, WebPlayerError> {
        let access_token = access_token.into().trim().to_string();
        if access_token.is_empty() {
            return Err(WebPlayerError::MissingAccessToken);
        }
        let client_token =
            clean_optional(client_token).ok_or(WebPlayerError::MissingClientToken)?;
        let app_version = clean_optional(app_version).ok_or(WebPlayerError::MissingAppVersion)?;

        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .redirect(Policy::none())
            .user_agent(WEB_PLAYER_USER_AGENT)
            .build()
            .map_err(|error| WebPlayerError::Request(error.to_string()))?;

        Ok(Self {
            client,
            access_token,
            client_token: Some(client_token),
            app_version: Some(app_version),
        })
    }

    // cache encrypted bootstrap metadata
    pub fn metadata(&self) -> (&str, &str) {
        (
            self.client_token.as_deref().unwrap_or_default(),
            self.app_version.as_deref().unwrap_or_default(),
        )
    }

    pub fn profile(&self) -> Result<SpotifyProfile, WebPlayerError> {
        let root = self.query("profileAttributes", PROFILE_ATTRIBUTES_HASH, json!({}))?;
        parse_profile_response(&root)
    }

    pub fn liked_tracks_page(
        &self,
        offset: usize,
        limit: usize,
    ) -> Result<SpotifyPage<SpotifyTrack>, WebPlayerError> {
        validate_page(offset, limit)?;
        let root = self.query(
            "fetchLibraryTracks",
            FETCH_LIBRARY_TRACKS_HASH,
            json!({"offset": offset, "limit": limit}),
        )?;
        let tracks = object_at(&root, &["data", "me", "library", "tracks"])
            .ok_or(WebPlayerError::Schema("data.me.library.tracks"))?;
        parse_liked_tracks_response(tracks, offset, limit)
    }

    pub fn playlists_page(
        &self,
        offset: usize,
        limit: usize,
    ) -> Result<SpotifyPage<SpotifyPlaylist>, WebPlayerError> {
        validate_page(offset, limit)?;
        let variables = json!({
            "filters": ["Playlists"],
            "order": null,
            "textFilter": "",
            "features": ["LIKED_SONGS", "YOUR_EPISODES_V2", "PRERELEASES", "EVENTS"],
            "limit": limit,
            "offset": offset,
            "flatten": true,
            "expandedFolders": [],
            "folderUri": null,
            "includeFoldersWhenFlattening": false,
        });
        let root = self.query("libraryV3", LIBRARY_V3_HASH, variables)?;
        let library = object_at(&root, &["data", "me", "libraryV3"])
            .ok_or(WebPlayerError::Schema("data.me.libraryV3"))?;
        parse_playlists_response(library, offset, limit)
    }

    pub fn playlist_tracks_page(
        &self,
        playlist_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<SpotifyPage<SpotifyTrack>, WebPlayerError> {
        validate_page(offset, limit)?;
        let playlist_id = playlist_id.trim();
        if playlist_id.is_empty()
            || playlist_id.len() > 128
            || !playlist_id.bytes().all(valid_id_byte)
        {
            return Err(WebPlayerError::Schema("playlist ID"));
        }
        let root = self.query(
            "fetchPlaylist",
            FETCH_PLAYLIST_HASH,
            json!({
                "uri": format!("spotify:playlist:{playlist_id}"),
                "offset": offset,
                "limit": limit,
                "enableWatchFeedEntrypoint": false,
            }),
        )?;
        let content = object_at(&root, &["data", "playlistV2", "content"])
            .ok_or(WebPlayerError::Schema("data.playlistV2.content"))?;
        parse_playlist_tracks_response(content, offset, limit)
    }

    // fetch playlist metadata and tracks
    pub fn playlist_page(
        &self,
        playlist_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<SpotifyPlaylistPage, WebPlayerError> {
        validate_page(offset, limit)?;
        let playlist_id = playlist_id.trim();
        if playlist_id.is_empty()
            || playlist_id.len() > 128
            || !playlist_id.bytes().all(valid_id_byte)
        {
            return Err(WebPlayerError::Schema("playlist ID"));
        }
        let root = self.query(
            "fetchPlaylist",
            FETCH_PLAYLIST_HASH,
            json!({
                "uri": format!("spotify:playlist:{playlist_id}"),
                "offset": offset,
                "limit": limit,
                "enableWatchFeedEntrypoint": false,
            }),
        )?;
        let playlist_data = object_at(&root, &["data", "playlistV2"])
            .ok_or(WebPlayerError::Schema("data.playlistV2"))?;
        let playlist = parse_playlist_data(playlist_data, playlist_id)?;
        let content = playlist_data
            .get("content")
            .ok_or(WebPlayerError::Schema("data.playlistV2.content"))?;
        let tracks = parse_playlist_tracks_response(content, offset, limit)?;
        Ok(SpotifyPlaylistPage { playlist, tracks })
    }

    fn query(
        &self,
        operation: &'static str,
        hash: &str,
        variables: Value,
    ) -> Result<Value, WebPlayerError> {
        let now = unix_now();
        let rate_limit_until = RATE_LIMIT_UNTIL_UNIX.load(Ordering::SeqCst);
        if rate_limit_until > now {
            return Err(WebPlayerError::RateLimited {
                retry_after_seconds: Some(rate_limit_until - now),
            });
        }
        let body = json!({
            "variables": variables,
            "operationName": operation,
            "extensions": {"persistedQuery": {"version": 1, "sha256Hash": hash}},
        });
        let mut request = self
            .client
            .post(PATHFINDER_URL)
            .header(AUTHORIZATION, format!("Bearer {}", self.access_token))
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(ORIGIN, PATHFINDER_ORIGIN)
            .header(REFERER, PATHFINDER_REFERER)
            .header("app-platform", "WebPlayer")
            .json(&body);
        if let Some(client_token) = self.client_token.as_deref() {
            request = request.header("Client-Token", client_token);
        }
        if let Some(app_version) = self.app_version.as_deref() {
            request = request.header("Spotify-App-Version", app_version);
        }

        let mut response = request
            .send()
            .map_err(|error| WebPlayerError::Request(error.to_string()))?;
        classify_status(&response, operation)?;
        let bytes = read_bounded(&mut response)?;
        let root: Value = serde_json::from_slice(&bytes).map_err(|_| WebPlayerError::Decode)?;
        validate_graphql_response(&root, operation)?;
        Ok(root)
    }
}

fn parse_profile_response(root: &Value) -> Result<SpotifyProfile, WebPlayerError> {
    let profile = object_at(root, &["data", "me", "profile"])
        .ok_or(WebPlayerError::Schema("data.me.profile"))?;
    let uri = required_string(profile, "uri", "data.me.profile.uri")?;
    let id = spotify_id(&uri).ok_or(WebPlayerError::Schema("profile URI"))?;
    let image_url = profile
        .get("avatar")
        .and_then(|avatar| avatar.get("sources"))
        .and_then(Value::as_array)
        .and_then(|sources| sources.iter().find_map(|source| source.get("url")))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(SpotifyProfile {
        id,
        display_name: profile
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        image_url,
        uri,
    })
}

fn parse_liked_tracks_response(
    tracks: &Value,
    offset: usize,
    limit: usize,
) -> Result<SpotifyPage<SpotifyTrack>, WebPlayerError> {
    let raw_items = required_array(tracks, "items", "data.me.library.tracks.items")?;
    Ok(SpotifyPage {
        raw_count: raw_items.len(),
        items: parse_track_items(raw_items),
        total: total_count(tracks, "data.me.library.tracks.totalCount")?,
        offset,
        limit,
    })
}

fn parse_playlists_response(
    library: &Value,
    offset: usize,
    limit: usize,
) -> Result<SpotifyPage<SpotifyPlaylist>, WebPlayerError> {
    let raw_items = required_array(library, "items", "data.me.libraryV3.items")?;
    let items = raw_items.iter().filter_map(parse_playlist).collect();
    let page_limit = library
        .get("pagingInfo")
        .and_then(|paging| paging.get("limit"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(limit);
    let page_offset = library
        .get("pagingInfo")
        .and_then(|paging| paging.get("offset"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(offset);
    Ok(SpotifyPage {
        raw_count: raw_items.len(),
        items,
        total: total_count(library, "data.me.libraryV3.totalCount")?,
        offset: page_offset,
        limit: page_limit,
    })
}

fn parse_playlist_tracks_response(
    content: &Value,
    offset: usize,
    limit: usize,
) -> Result<SpotifyPage<SpotifyTrack>, WebPlayerError> {
    let raw_items = required_array(content, "items", "data.playlistV2.content.items")?;
    Ok(SpotifyPage {
        raw_count: raw_items.len(),
        items: parse_playlist_track_items(raw_items),
        total: total_count(content, "data.playlistV2.content.totalCount")?,
        offset,
        limit,
    })
}

fn validate_graphql_response(root: &Value, operation: &'static str) -> Result<(), WebPlayerError> {
    if let Some(errors) = root.get("errors").and_then(Value::as_array) {
        if errors.iter().any(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(|message| {
                    message
                        .to_ascii_lowercase()
                        .contains("persistedquerynotfound")
                })
        }) {
            return Err(WebPlayerError::HashStale { operation });
        }
        if !errors.is_empty() {
            return Err(WebPlayerError::GraphQl { operation });
        }
    }
    if root.get("data").is_none() {
        return Err(WebPlayerError::Schema("data"));
    }
    Ok(())
}

fn native_http_client() -> Result<Client, WebPlayerError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(Policy::none())
        .user_agent(WEB_PLAYER_USER_AGENT)
        .build()
        .map_err(|_| WebPlayerError::Bootstrap("HTTP client"))
}

fn fetch_app_version(client: &Client) -> Result<String, WebPlayerError> {
    let mut response = client
        .get(WEB_PLAYER_URL)
        .header(ACCEPT, "text/html,application/xhtml+xml")
        .send()
        .map_err(|_| WebPlayerError::Bootstrap("public homepage request"))?;
    classify_bootstrap_status(&response, "public homepage response")?;
    let body = read_bounded(&mut response)
        .map_err(|_| WebPlayerError::Bootstrap("public homepage body"))?;
    parse_app_version_html(&body)
}

fn parse_app_version_html(body: &[u8]) -> Result<String, WebPlayerError> {
    let html = std::str::from_utf8(body)
        .map_err(|_| WebPlayerError::Bootstrap("appServerConfig encoding"))?;
    let marker = r#"<script id="appServerConfig" type="text/plain">"#;
    let encoded = html
        .split_once(marker)
        .and_then(|(_, remainder)| remainder.split_once("</script>"))
        .map(|(encoded, _)| encoded.trim())
        .filter(|encoded| !encoded.is_empty())
        .ok_or(WebPlayerError::Bootstrap("appServerConfig"))?;
    let decoded = BASE64
        .decode(encoded)
        .map_err(|_| WebPlayerError::Bootstrap("appServerConfig decoding"))?;
    let config: Value = serde_json::from_slice(&decoded)
        .map_err(|_| WebPlayerError::Bootstrap("appServerConfig JSON"))?;
    required_string(&config, "clientVersion", "appServerConfig.clientVersion")
}

fn fetch_client_token(
    client: &Client,
    app_version: &str,
    client_id: &str,
    device_id: &str,
) -> Result<String, WebPlayerError> {
    let body = json!({
        "client_data": {
            "client_version": app_version,
            "client_id": client_id,
            "js_sdk_data": {
                "device_brand": "unknown",
                "device_model": "unknown",
                "os": "windows",
                "os_version": "NT 10.0",
                "device_id": device_id,
                "device_type": "computer",
            },
        },
    });
    let mut response = client
        .post(CLIENT_TOKEN_URL)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .map_err(|_| WebPlayerError::Bootstrap("client token request"))?;
    classify_bootstrap_status(&response, "client token response")?;
    let bytes =
        read_bounded(&mut response).map_err(|_| WebPlayerError::Bootstrap("client token body"))?;
    parse_client_token_response(&bytes)
}

fn parse_client_token_response(body: &[u8]) -> Result<String, WebPlayerError> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| WebPlayerError::Bootstrap("client token JSON"))?;
    if value.get("response_type").and_then(Value::as_str) != Some("RESPONSE_GRANTED_TOKEN_RESPONSE")
    {
        return Err(WebPlayerError::Bootstrap("client token response type"));
    }
    object_at(&value, &["granted_token"])
        .and_then(|token| token.get("token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .ok_or(WebPlayerError::Bootstrap("granted client token"))
}

fn generated_device_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut device_id = String::with_capacity(32);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(device_id, "{byte:02x}");
    }
    device_id
}

fn classify_bootstrap_status(
    response: &Response,
    stage: &'static str,
) -> Result<(), WebPlayerError> {
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return Err(WebPlayerError::Authentication { status });
    }
    if status == 429 {
        let retry_after_seconds = response
            .headers()
            .get("Retry-After")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok());
        let cooldown = retry_after_seconds.unwrap_or(2).max(1);
        RATE_LIMIT_UNTIL_UNIX.fetch_max(unix_now().saturating_add(cooldown), Ordering::SeqCst);
        return Err(WebPlayerError::RateLimited {
            retry_after_seconds,
        });
    }
    if !response.status().is_success() {
        return Err(WebPlayerError::Bootstrap(stage));
    }
    Ok(())
}

fn classify_status(response: &Response, operation: &'static str) -> Result<(), WebPlayerError> {
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return Err(WebPlayerError::Authentication { status });
    }
    if status == 412 {
        return Err(WebPlayerError::HashStale { operation });
    }
    if status == 429 {
        let retry_after_seconds = response
            .headers()
            .get("Retry-After")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok());
        let cooldown = retry_after_seconds.unwrap_or(2).max(1);
        let until = unix_now().saturating_add(cooldown);
        RATE_LIMIT_UNTIL_UNIX.fetch_max(until, Ordering::SeqCst);
        return Err(WebPlayerError::RateLimited {
            retry_after_seconds,
        });
    }
    if !response.status().is_success() {
        return Err(WebPlayerError::Request(format!("HTTP {status}")));
    }
    Ok(())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn read_bounded(response: &mut Response) -> Result<Vec<u8>, WebPlayerError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(WebPlayerError::ResponseTooLarge);
    }
    let mut body = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|error| WebPlayerError::Request(error.to_string()))?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(WebPlayerError::ResponseTooLarge);
    }
    Ok(body)
}

fn validate_page(offset: usize, limit: usize) -> Result<(), WebPlayerError> {
    if limit == 0 || limit > MAX_PAGE_LIMIT || offset > MAX_OFFSET {
        return Err(WebPlayerError::InvalidPage { offset, limit });
    }
    Ok(())
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn object_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
}

fn required_string(value: &Value, key: &str, path: &'static str) -> Result<String, WebPlayerError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .ok_or(WebPlayerError::Schema(path))
}

fn required_array<'a>(
    value: &'a Value,
    key: &str,
    path: &'static str,
) -> Result<&'a Vec<Value>, WebPlayerError> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or(WebPlayerError::Schema(path))
}

fn total_count(value: &Value, path: &'static str) -> Result<usize, WebPlayerError> {
    value
        .get("totalCount")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(WebPlayerError::Schema(path))
}

fn parse_playlist(item: &Value) -> Option<SpotifyPlaylist> {
    let wrapper = item.get("item")?;
    let type_name = wrapper
        .get("__typename")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !type_name.to_ascii_lowercase().contains("playlist") {
        return None;
    }
    let data = wrapper.get("data")?;
    let uri = wrapper
        .get("_uri")
        .or_else(|| wrapper.get("uri"))
        .or_else(|| data.get("uri"))
        .and_then(Value::as_str)?
        .to_string();
    let id = spotify_id(&uri)?;
    // exclude duplicate virtual collections
    if !uri.starts_with("spotify:playlist:") {
        return None;
    }
    parse_playlist_data(data, &id).ok()
}

fn parse_playlist_data(data: &Value, id: &str) -> Result<SpotifyPlaylist, WebPlayerError> {
    let image_url = data
        .get("images")
        .and_then(|images| images.get("items"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("sources"))
        .and_then(Value::as_array)
        .and_then(|sources| sources.iter().find_map(|source| source.get("url")))
        .and_then(Value::as_str)
        .map(str::to_string);
    let owner_name = data
        .get("ownerV2")
        .and_then(|owner| owner.get("data"))
        .and_then(|owner| owner.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let is_collaborative = data
        .get("members")
        .and_then(|members| members.get("items"))
        .and_then(Value::as_array)
        .is_some_and(|members| members.len() > 1);
    Ok(SpotifyPlaylist {
        id: id.to_string(),
        name: required_string(data, "name", "playlist.name")?,
        description: data
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        track_count: data
            .get("content")
            .and_then(|content| total_count(content, "playlist.content.totalCount").ok())
            .unwrap_or_default(),
        image_url,
        owner_name,
        is_liked_songs: false,
        is_collaborative,
        is_owner: false,
        snapshot_id: data
            .get("revisionId")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_track_items(items: &[Value]) -> Vec<SpotifyTrack> {
    items
        .iter()
        .filter_map(|item| item.get("track").and_then(parse_track_wrapper))
        .collect()
}

fn parse_playlist_track_items(items: &[Value]) -> Vec<SpotifyTrack> {
    items
        .iter()
        .filter_map(|item| item.get("itemV2").and_then(parse_track_wrapper))
        .collect()
}

fn parse_track_wrapper(wrapper: &Value) -> Option<SpotifyTrack> {
    let data = wrapper.get("data")?;
    let uri = wrapper
        .get("_uri")
        .or_else(|| wrapper.get("uri"))
        .or_else(|| data.get("uri"))
        .and_then(Value::as_str)?
        .to_string();
    let id = spotify_id(&uri)?;
    let title = data.get("name").and_then(Value::as_str)?.to_string();
    let artists = data
        .get("artists")
        .and_then(|artists| artists.get("items"))
        .and_then(Value::as_array)
        .map(|artists| {
            artists
                .iter()
                .filter_map(|artist| {
                    artist
                        .get("profile")
                        .and_then(|profile| profile.get("name"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    let album = data
        .get("albumOfTrack")
        .and_then(|album| album.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let duration_ms = data
        .get("duration")
        .and_then(|duration| duration.get("totalMilliseconds"))
        .and_then(Value::as_u64)
        .or_else(|| data.get("durationMs").and_then(Value::as_u64))
        .unwrap_or_default();
    let is_explicit = data
        .get("contentRating")
        .and_then(|rating| rating.get("label"))
        .and_then(Value::as_str)
        .is_some_and(|label| label.eq_ignore_ascii_case("EXPLICIT"));
    Some(SpotifyTrack {
        id,
        title,
        artists,
        album,
        duration_ms,
        is_explicit,
        preview_url: None,
        uri,
    })
}

fn spotify_id(uri: &str) -> Option<String> {
    let id = uri.rsplit(':').next()?.trim();
    (!id.is_empty()).then_some(id.to_string())
}

fn valid_id_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track_wrapper(uri: &str, title: &str) -> Value {
        serde_json::json!({
            "_uri": uri,
            "data": {
                "name": title,
                "artists": {"items": [{"profile": {"name": "Artist"}}]},
                "albumOfTrack": {"name": "Album"},
                "duration": {"totalMilliseconds": 1234},
                "contentRating": {"label": "EXPLICIT"}
            }
        })
    }

    #[test]
    fn parses_profile_and_bootstrap_metadata() {
        let profile = serde_json::json!({
            "data": {"me": {"profile": {
                "uri": "spotify:user:alice",
                "name": "Alice",
                "avatar": {"sources": [{"url": "https://img.example/alice"}]}
            }}}
        });
        let parsed = parse_profile_response(&profile).expect("profile fixture should parse");
        assert_eq!(parsed.id, "alice");
        assert_eq!(parsed.display_name.as_deref(), Some("Alice"));
        assert_eq!(
            parsed.image_url.as_deref(),
            Some("https://img.example/alice")
        );

        let encoded = BASE64.encode(serde_json::json!({"clientVersion": "9.9.9"}).to_string());
        let html = format!("<script id=\"appServerConfig\" type=\"text/plain\">{encoded}</script>");
        assert_eq!(parse_app_version_html(html.as_bytes()).unwrap(), "9.9.9");
        assert!(matches!(
            parse_app_version_html(b"<html></html>"),
            Err(WebPlayerError::Bootstrap("appServerConfig"))
        ));
    }

    #[test]
    fn liked_tracks_keep_raw_count_when_an_item_is_unavailable() {
        let tracks = serde_json::json!({
            "items": [
                {"track": track_wrapper("spotify:track:one", "One")},
                {"track": {"data": {"name": "Unavailable"}}}
            ],
            "totalCount": 42
        });
        let page =
            parse_liked_tracks_response(&tracks, 20, 50).expect("liked fixture should parse");
        assert_eq!(page.raw_count, 2);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "one");
        assert!(page.items[0].is_explicit);
        assert_eq!(page.total, 42);
        assert_eq!((page.offset, page.limit), (20, 50));
    }

    #[test]
    fn parses_playlist_library_metadata_and_page_shape() {
        let library = serde_json::json!({
            "items": [{"item": {
                "__typename": "CollaborativePlaylistResponseWrapper",
                "_uri": "spotify:playlist:mix123",
                "data": {
                    "name": "Mix",
                    "description": "A mix",
                    "images": {"items": [{"sources": [{"url": "https://img.example/mix"}]}]},
                    "ownerV2": {"data": {"name": "Owner"}},
                    "members": {"items": [{}, {}]},
                    "content": {"totalCount": 7},
                    "revisionId": "revision-1"
                }
            }}],
            "pagingInfo": {"limit": 25, "offset": 50},
            "totalCount": 100
        });
        let page =
            parse_playlists_response(&library, 0, 25).expect("playlist fixture should parse");
        assert_eq!(page.raw_count, 1);
        assert_eq!(page.total, 100);
        assert_eq!((page.offset, page.limit), (50, 25));
        let playlist = &page.items[0];
        assert_eq!(playlist.id, "mix123");
        assert_eq!(playlist.track_count, 7);
        assert!(playlist.is_collaborative);
        assert_eq!(playlist.owner_name.as_deref(), Some("Owner"));

        let content = serde_json::json!({
            "items": [{"uid": "entry-1", "itemV2": track_wrapper("spotify:track:one", "One")}],
            "totalCount": 1
        });
        let tracks =
            parse_playlist_tracks_response(&content, 0, 100).expect("track page should parse");
        assert_eq!(tracks.raw_count, 1);
        assert_eq!(tracks.items[0].title, "One");
    }

    #[test]
    fn rejects_graphql_errors_and_missing_required_page_fields() {
        assert!(matches!(
            validate_graphql_response(
                &serde_json::json!({"data": null, "errors": [{"message": "PersistedQueryNotFound"}]}),
                "fetchPlaylist"
            ),
            Err(WebPlayerError::HashStale {
                operation: "fetchPlaylist"
            })
        ));
        assert!(matches!(
            validate_graphql_response(
                &serde_json::json!({"data": {}, "errors": [{"message": "unauthorized field"}]}),
                "profileAttributes"
            ),
            Err(WebPlayerError::GraphQl {
                operation: "profileAttributes"
            })
        ));
        assert!(matches!(
            parse_playlist_tracks_response(&serde_json::json!({"items": []}), 0, 10),
            Err(WebPlayerError::Schema("data.playlistV2.content.totalCount"))
        ));
        assert!(matches!(
            WebPlayerClient::new("token", None, Some("9.9.9".to_string())),
            Err(WebPlayerError::MissingClientToken)
        ));
    }

    #[test]
    fn parses_granted_client_token_without_exposing_response_body() {
        let response = serde_json::json!({
            "response_type": "RESPONSE_GRANTED_TOKEN_RESPONSE",
            "granted_token": {"token": " client-token "}
        });
        assert_eq!(
            parse_client_token_response(response.to_string().as_bytes()).unwrap(),
            "client-token"
        );
        assert!(matches!(
            parse_client_token_response(br#"{"response_type":"OTHER"}"#),
            Err(WebPlayerError::Bootstrap("client token response type"))
        ));
        assert_eq!(
            WebPlayerError::GraphQl {
                operation: "profileAttributes"
            }
            .to_string(),
            "Spotify Web Player GraphQL request failed for profileAttributes"
        );
    }
}
