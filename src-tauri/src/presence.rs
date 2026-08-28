//! presence.rs
//! Converts trusted YouTube Music track metadata into Discord Rich Presence updates.

use crate::url_policy::{valid_artwork_url, valid_track_url};
use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Button, StatusDisplayType, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::Deserialize;
use std::{
    fs,
    path::PathBuf,
    sync::{
        mpsc::{self, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const TITLE_PREFIX: &str = "YTMRPC:";
const CLIENT_ID_ENV: &str = "YT_MUSIC_DISCORD_CLIENT_ID";
const BUNDLED_CLIENT_ID: &str = include_str!("../discord-client-id.txt");
const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Clone)]
pub struct PresenceController {
    tx: Sender<PresenceCommand>,
    status: Arc<Mutex<PresenceStatus>>,
}

#[derive(Clone, Default)]
struct PresenceStatus {
    enabled: bool,
    client_configured: bool,
    connected: bool,
    activity_active: bool,
}

struct PresenceState {
    enabled: bool,
    spotify_spoof: bool,
    client_id: Option<String>,
    client: Option<DiscordIpcClient>,
    current_track: Option<TrackMetadata>,
    published_track: Option<TrackMetadata>,
}

enum PresenceCommand {
    Message(PresenceMessage),
    SetEnabled(bool),
    SetSpotifySpoof(bool),
}

impl PresenceController {
    pub fn new(enabled: bool, spotify_spoof: bool) -> Self {
        let (tx, rx) = mpsc::channel::<PresenceCommand>();
        let status = Arc::new(Mutex::new(PresenceStatus {
            enabled,
            ..PresenceStatus::default()
        }));
        let status_for_worker = status.clone();

        thread::spawn(move || {
            let client_id = read_client_id();
            let mut state = PresenceState {
                enabled,
                spotify_spoof,
                client_id,
                client: None,
                current_track: None,
                published_track: None,
            };
            if state.enabled {
                connect_presence_state(&mut state);
            }

            loop {
                sync_status(&state, &status_for_worker);

                match rx.recv_timeout(RECONNECT_INTERVAL) {
                    Ok(command) => update_presence_state(&mut state, command),
                    Err(RecvTimeoutError::Timeout) => retry_presence_connection(&mut state),
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        Self { tx, status }
    }

    pub fn update(&self, track: TrackMetadata) {
        if track.title.trim().is_empty() {
            return;
        }

        let _ = self
            .tx
            .send(PresenceCommand::Message(PresenceMessage::Track(track)));
    }

    pub fn clear(&self) {
        let _ = self
            .tx
            .send(PresenceCommand::Message(PresenceMessage::Clear));
    }

    pub fn set_enabled(&self, enabled: bool) {
        let _ = self.tx.send(PresenceCommand::SetEnabled(enabled));
    }

    pub fn set_spotify_spoof(&self, spotify_spoof: bool) {
        let _ = self
            .tx
            .send(PresenceCommand::SetSpotifySpoof(spotify_spoof));
    }

    pub fn status(&self) -> String {
        let Ok(status) = self.status.lock() else {
            return "Status unavailable".to_string();
        };

        if !status.enabled {
            "Disabled".to_string()
        } else if !status.client_configured {
            "Unavailable: Discord application ID is missing".to_string()
        } else if !status.connected {
            "Enabled: waiting for Discord".to_string()
        } else if status.activity_active {
            "Connected: activity published".to_string()
        } else {
            "Connected: idle".to_string()
        }
    }
}

fn sync_status(state: &PresenceState, status: &Arc<Mutex<PresenceStatus>>) {
    if let Ok(mut status) = status.lock() {
        status.enabled = state.enabled;
        status.client_configured = state.client_id.is_some();
        status.connected = state.client.is_some();
        status.activity_active = state.published_track.is_some();
    }
}

fn update_presence_state(state: &mut PresenceState, command: PresenceCommand) {
    match command {
        PresenceCommand::Message(PresenceMessage::Track(track)) => {
            state.current_track = Some(track.clone());
            if state.enabled {
                update_track_presence_state(state, track);
            }
        }
        PresenceCommand::Message(PresenceMessage::Clear) => {
            state.current_track = None;
            clear_presence_state(state);
        }
        PresenceCommand::SetEnabled(enabled) => {
            if state.enabled == enabled {
                return;
            }

            state.enabled = enabled;
            if enabled {
                if let Some(track) = state.current_track.clone() {
                    update_track_presence_state(state, track);
                } else {
                    connect_presence_state(state);
                }
            } else {
                clear_presence_state(state);
            }
        }
        PresenceCommand::SetSpotifySpoof(spoof) => {
            if state.spotify_spoof == spoof {
                return;
            }

            state.spotify_spoof = spoof;
            state.published_track = None;
            if state.enabled {
                if let Some(track) = state.current_track.clone() {
                    update_track_presence_state(state, track);
                }
            }
        }
    }
}

fn update_track_presence_state(state: &mut PresenceState, track: TrackMetadata) {
    if state.published_track.as_ref() == Some(&track) {
        return;
    }

    if state.client_id.is_none() {
        state.published_track = Some(track);
        return;
    }

    if !connect_presence_state(state) {
        return;
    }

    let mut activity = Activity::new()
        .activity_type(ActivityType::Listening)
        .name(if state.spotify_spoof {
            "Spotify"
        } else {
            "YouTube Music"
        })
        .details(track.title.clone());

    if let Some(presence_state) = track.presence_state() {
        activity = activity
            .state(presence_state)
            .status_display_type(StatusDisplayType::State);
    }

    let activity = apply_activity_urls(activity, &track, state.spotify_spoof);
    let activity = apply_activity_assets(activity, &track, state.spotify_spoof);
    let activity = apply_activity_timestamps(activity, &track);
    let activity = apply_activity_buttons(activity, &track, state.spotify_spoof);

    let result = state
        .client
        .as_mut()
        .map(|client| client.set_activity(activity));

    if matches!(result, Some(Err(_))) {
        state.client = None;
        state.published_track = None;
    } else {
        state.published_track = Some(track);
    }
}

fn connect_presence_state(state: &mut PresenceState) -> bool {
    if state.client.is_some() {
        return true;
    }

    let Some(client_id) = state.client_id.clone() else {
        return false;
    };

    let mut client = DiscordIpcClient::new(client_id);
    if client.connect().is_err() {
        return false;
    }

    state.client = Some(client);
    true
}

fn retry_presence_connection(state: &mut PresenceState) {
    if !state.enabled || state.client.is_some() || state.client_id.is_none() {
        return;
    }

    if let Some(track) = state.current_track.clone() {
        update_track_presence_state(state, track);
    } else {
        connect_presence_state(state);
    }
}

fn clear_presence_state(state: &mut PresenceState) {
    if state.published_track.take().is_none() {
        return;
    }

    if let Some(client) = state.client.as_mut() {
        if client.clear_activity().is_err() {
            state.client = None;
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PresenceMessage {
    Track(TrackMetadata),
    Clear,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TypedPresenceMessage {
    Track { track: TrackMetadata },
    Clear,
}

impl From<TypedPresenceMessage> for PresenceMessage {
    fn from(message: TypedPresenceMessage) -> Self {
        match message {
            TypedPresenceMessage::Track { track } => PresenceMessage::Track(track),
            TypedPresenceMessage::Clear => PresenceMessage::Clear,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct TrackMetadata {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub playing: bool,
    pub url: Option<String>,
    pub cover_url: Option<String>,
    pub elapsed_seconds: Option<u64>,
    pub duration_seconds: Option<u64>,
}

impl TrackMetadata {
    pub fn window_title(&self) -> String {
        match self.artist.as_deref().filter(|artist| !artist.is_empty()) {
            Some(artist) => format!("{} - {} - YouTube Music", self.title, artist),
            None => format!("{} - YouTube Music", self.title),
        }
    }

    fn presence_state(&self) -> Option<String> {
        let mut parts = Vec::new();

        if let Some(artist) = clean_presence_part(self.artist.as_deref()) {
            parts.push(artist.to_string());
        }

        if !self.playing {
            parts.push("Paused".to_string());
        }

        if parts.is_empty() {
            None
        } else {
            Some(parts.join(" - "))
        }
    }
}

pub fn parse_presence_title(title: &str) -> Option<PresenceMessage> {
    // Only consume titles emitted by track_probe.js; normal YouTube titles still
    // pass through to the window unchanged.
    let payload = title.strip_prefix(TITLE_PREFIX)?;

    serde_json::from_str::<TypedPresenceMessage>(payload)
        .map(PresenceMessage::from)
        .or_else(|_| serde_json::from_str::<TrackMetadata>(payload).map(PresenceMessage::Track))
        .ok()
}

pub fn is_presence_title_message(title: &str) -> bool {
    title.starts_with(TITLE_PREFIX)
}

fn read_client_id() -> Option<String> {
    std::env::var(CLIENT_ID_ENV)
        .ok()
        .map(normalize_client_id)
        .filter(|id| !id.is_empty())
        .or_else(read_client_id_file)
        .or_else(read_bundled_client_id)
}

fn read_client_id_file() -> Option<String> {
    let path = client_id_file_path()?;
    let value = fs::read_to_string(path).ok()?;
    let id = normalize_client_id(value);
    (!id.is_empty()).then_some(id)
}

fn read_bundled_client_id() -> Option<String> {
    let id = normalize_client_id(BUNDLED_CLIENT_ID);
    (!id.is_empty()).then_some(id)
}

fn client_id_file_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(PathBuf::from).map(|dir| {
            dir.join("app.ytmusic.desktop")
                .join("discord-client-id.txt")
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from).map(|dir| {
            dir.join(".config")
                .join("app.ytmusic.desktop")
                .join("discord-client-id.txt")
        })
    }
}

fn normalize_client_id(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .trim()
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect()
}

fn apply_activity_urls<'a>(
    activity: Activity<'a>,
    track: &'a TrackMetadata,
    spotify_spoof: bool,
) -> Activity<'a> {
    if spotify_spoof {
        return activity;
    }

    let Some(url) = valid_track_url(track.url.as_deref()) else {
        return activity;
    };

    activity.details_url(url).state_url(url)
}

fn apply_activity_assets<'a>(
    activity: Activity<'a>,
    track: &'a TrackMetadata,
    spotify_spoof: bool,
) -> Activity<'a> {
    let mut assets = Assets::new();

    if let Some(cover_url) = valid_artwork_url(track.cover_url.as_deref()) {
        assets = assets.large_image(cover_url).large_text(track.asset_text());

        if !spotify_spoof {
            if let Some(track_url) = valid_track_url(track.url.as_deref()) {
                assets = assets.large_url(track_url);
            }
        }
    }

    if spotify_spoof {
        assets = assets.small_image("spotify").small_text("Spotify");
    }

    activity.assets(assets)
}

fn apply_activity_timestamps<'a>(activity: Activity<'a>, track: &TrackMetadata) -> Activity<'a> {
    // Discord keeps counting from start/end timestamps, so the JS side only needs
    // to refresh progress occasionally instead of every second.
    if !track.playing {
        return activity;
    }

    let (Some(elapsed), Some(duration)) = (track.elapsed_seconds, track.duration_seconds) else {
        return activity;
    };

    if duration == 0 || elapsed >= duration {
        return activity;
    }

    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return activity;
    };

    let now_ms = now.as_millis() as i64;
    let start = now_ms.saturating_sub((elapsed as i64) * 1000);
    let end = start.saturating_add((duration as i64) * 1000);

    activity.timestamps(Timestamps::new().start(start).end(end))
}

fn apply_activity_buttons<'a>(
    activity: Activity<'a>,
    track: &'a TrackMetadata,
    spotify_spoof: bool,
) -> Activity<'a> {
    if spotify_spoof {
        activity.buttons(vec![Button::new(
            "Play on Spotify",
            "https://github.com/xzelleiv/ytm-tauri",
        )])
    } else if let Some(url) = valid_track_url(track.url.as_deref()) {
        activity.buttons(vec![Button::new("Listen on YouTube Music", url)])
    } else {
        activity
    }
}

fn clean_presence_part(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    if value.is_empty() || is_metric_label(value) || is_generic_source_label(value) {
        None
    } else {
        Some(value)
    }
}

fn is_metric_label(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "view",
        "views",
        "play",
        "plays",
        "subscriber",
        "subscribers",
        "like",
        "likes",
    ]
    .iter()
    .any(|word| lower.split_whitespace().any(|part| part == *word))
}

fn is_generic_source_label(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "youtube music" | "music.youtube.com" | "youtube"
    )
}

impl TrackMetadata {
    fn asset_text(&self) -> String {
        self.album
            .as_deref()
            .and_then(|album| clean_presence_part(Some(album)))
            .unwrap_or("YouTube Music")
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_probe_title() {
        let title = r#"YTMRPC:{"title":"Song","artist":"Artist","album":"Album","playing":true,"url":"https://music.youtube.com/watch?v=x","cover_url":"https://lh3.googleusercontent.com/image","elapsed_seconds":17,"duration_seconds":134}"#;
        let parsed = parse_presence_title(title).expect("presence message");
        let PresenceMessage::Track(parsed) = parsed else {
            panic!("expected track message");
        };

        assert_eq!(parsed.title, "Song");
        assert_eq!(parsed.artist.as_deref(), Some("Artist"));
        assert!(parsed.playing);
        assert_eq!(parsed.elapsed_seconds, Some(17));
        assert_eq!(parsed.duration_seconds, Some(134));
    }

    #[test]
    fn parses_typed_probe_title() {
        let title = r#"YTMRPC:{"type":"track","track":{"title":"Song","artist":"Artist","album":"Album","playing":true,"url":"https://music.youtube.com/watch?v=x","cover_url":"https://lh3.googleusercontent.com/image","elapsed_seconds":17,"duration_seconds":134}}"#;
        let parsed = parse_presence_title(title).expect("presence message");

        match parsed {
            PresenceMessage::Track(track) => {
                assert_eq!(track.title, "Song");
                assert_eq!(track.artist.as_deref(), Some("Artist"));
                assert!(track.playing);
            }
            PresenceMessage::Clear => panic!("expected track message"),
        }
    }

    #[test]
    fn parses_clear_probe_title() {
        let parsed = parse_presence_title(r#"YTMRPC:{"type":"clear"}"#).expect("clear message");

        assert_eq!(parsed, PresenceMessage::Clear);
    }

    #[test]
    fn ignores_normal_titles() {
        assert!(parse_presence_title("YouTube Music").is_none());
    }

    #[test]
    fn drops_view_count_from_presence() {
        let track = TrackMetadata {
            title: "Song".to_string(),
            artist: Some("Artist".to_string()),
            album: Some("1.7m views".to_string()),
            playing: true,
            url: None,
            cover_url: None,
            elapsed_seconds: None,
            duration_seconds: None,
        };

        assert_eq!(track.presence_state().as_deref(), Some("Artist"));
        assert_eq!(track.asset_text(), "YouTube Music");
    }

    #[test]
    fn presence_state_uses_artist_only() {
        let track = TrackMetadata {
            title: "Song".to_string(),
            artist: Some("Artist".to_string()),
            album: Some("Album".to_string()),
            playing: true,
            url: None,
            cover_url: None,
            elapsed_seconds: None,
            duration_seconds: None,
        };

        assert_eq!(track.presence_state().as_deref(), Some("Artist"));
    }

    #[test]
    fn omits_redundant_youtube_music_state() {
        let track = TrackMetadata {
            title: "Song".to_string(),
            artist: Some("YouTube Music".to_string()),
            album: None,
            playing: true,
            url: None,
            cover_url: None,
            elapsed_seconds: None,
            duration_seconds: None,
        };

        assert_eq!(track.presence_state(), None);
    }

    #[test]
    fn disabled_presence_caches_track_and_restores_it_when_enabled() {
        let mut state = PresenceState {
            enabled: true,
            spotify_spoof: false,
            client_id: None,
            client: None,
            current_track: None,
            published_track: None,
        };
        let track = TrackMetadata {
            title: "Song".to_string(),
            artist: Some("Artist".to_string()),
            album: Some("Album".to_string()),
            playing: true,
            url: None,
            cover_url: None,
            elapsed_seconds: None,
            duration_seconds: None,
        };

        update_presence_state(&mut state, PresenceCommand::SetEnabled(false));
        update_presence_state(
            &mut state,
            PresenceCommand::Message(PresenceMessage::Track(track.clone())),
        );

        assert_eq!(state.current_track.as_ref(), Some(&track));
        assert_eq!(state.published_track, None);

        update_presence_state(&mut state, PresenceCommand::SetEnabled(true));

        assert_eq!(state.published_track.as_ref(), Some(&track));
    }

    #[test]
    fn disabled_status_is_reported() {
        let controller = PresenceController::new(false, false);

        assert_eq!(controller.status(), "Disabled");
    }
}
