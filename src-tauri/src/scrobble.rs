use crate::{presence::TrackMetadata, settings, settings::SharedSettings};
use reqwest::blocking::Client;
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::mpsc::{self, Sender},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const LASTFM_API_ROOT: &str = "https://ws.audioscrobbler.com/2.0/";
const LISTENBRAINZ_API_ROOT: &str = "https://api.listenbrainz.org/1/submit-listens";
const CLIENT_NAME: &str = "ytm-tauri";

#[derive(Clone)]
pub struct ScrobbleController {
    tx: Sender<Command>,
}

enum Command {
    Track(TrackMetadata),
    Clear,
}

struct CurrentTrack {
    key: String,
    track: TrackMetadata,
    started_at: u64,
    listened: Duration,
    last_update: Instant,
    was_playing: bool,
    lastfm_now_playing: bool,
    listenbrainz_now_playing: bool,
    lastfm_scrobbled: bool,
    listenbrainz_scrobbled: bool,
}

impl ScrobbleController {
    pub fn new(settings: SharedSettings) -> Self {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let client = Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .ok();
            let mut current: Option<CurrentTrack> = None;

            for command in rx {
                match command {
                    Command::Track(track) => {
                        if let Some(client) = client.as_ref() {
                            update_track(client, &settings, &mut current, track);
                        }
                    }
                    Command::Clear => current = None,
                }
            }
        });
        Self { tx }
    }

    pub fn update(&self, track: TrackMetadata) {
        let _ = self.tx.send(Command::Track(track));
    }

    pub fn clear(&self) {
        let _ = self.tx.send(Command::Clear);
    }
}

fn update_track(
    client: &Client,
    settings: &SharedSettings,
    current: &mut Option<CurrentTrack>,
    track: TrackMetadata,
) {
    let key = track_key(&track);
    let now = Instant::now();
    let is_new = current.as_ref().is_none_or(|value| value.key != key);

    if is_new {
        let elapsed = track.elapsed_seconds.unwrap_or(0);
        let started_at = unix_now().saturating_sub(elapsed);
        *current = Some(CurrentTrack {
            key,
            track: track.clone(),
            started_at,
            listened: Duration::ZERO,
            last_update: now,
            was_playing: track.playing,
            lastfm_now_playing: false,
            listenbrainz_now_playing: false,
            lastfm_scrobbled: false,
            listenbrainz_scrobbled: false,
        });
    }

    let Some(state) = current.as_mut() else {
        return;
    };

    if !is_new && state.was_playing {
        state.listened += now.saturating_duration_since(state.last_update);
    }
    state.last_update = now;
    state.was_playing = track.playing;
    state.track = track;

    let config = settings::snapshot(settings);
    if state.track.playing {
        if config.lastfm_scrobbling && !state.lastfm_now_playing {
            state.lastfm_now_playing = send_lastfm_now_playing(client, &config, &state.track);
        }
        if config.listenbrainz_scrobbling && !state.listenbrainz_now_playing {
            state.listenbrainz_now_playing = send_listenbrainz(
                client,
                &config,
                &state.track,
                None,
                "playing_now",
            );
        }
    }

    if !should_scrobble(&state.track, state.listened) {
        return;
    }

    if config.lastfm_scrobbling && !state.lastfm_scrobbled {
        state.lastfm_scrobbled =
            send_lastfm_scrobble(client, &config, &state.track, state.started_at);
    }
    if config.listenbrainz_scrobbling && !state.listenbrainz_scrobbled {
        state.listenbrainz_scrobbled = send_listenbrainz(
            client,
            &config,
            &state.track,
            Some(state.started_at),
            "single",
        );
    }
}

fn should_scrobble(track: &TrackMetadata, listened: Duration) -> bool {
    let Some(duration) = track.duration_seconds else {
        return false;
    };
    if duration <= 30 {
        return false;
    }
    let threshold = (duration / 2).min(240);
    listened.as_secs() >= threshold
}

fn send_lastfm_now_playing(client: &Client, settings: &settings::Settings, track: &TrackMetadata) -> bool {
    let Some((api_key, secret, session_key)) = lastfm_credentials(settings) else {
        return false;
    };
    let Some(artist) = track.artist.as_deref().filter(|value| !value.trim().is_empty()) else {
        return false;
    };

    let mut params = BTreeMap::from([
        ("api_key".to_string(), api_key),
        ("artist".to_string(), artist.to_string()),
        ("method".to_string(), "track.updateNowPlaying".to_string()),
        ("sk".to_string(), session_key),
        ("track".to_string(), track.title.clone()),
    ]);
    add_optional_lastfm_metadata(&mut params, track);
    send_lastfm(client, params, &secret)
}

fn send_lastfm_scrobble(
    client: &Client,
    settings: &settings::Settings,
    track: &TrackMetadata,
    started_at: u64,
) -> bool {
    let Some((api_key, secret, session_key)) = lastfm_credentials(settings) else {
        return false;
    };
    let Some(artist) = track.artist.as_deref().filter(|value| !value.trim().is_empty()) else {
        return false;
    };

    let mut params = BTreeMap::from([
        ("api_key".to_string(), api_key),
        ("artist".to_string(), artist.to_string()),
        ("method".to_string(), "track.scrobble".to_string()),
        ("sk".to_string(), session_key),
        ("timestamp".to_string(), started_at.to_string()),
        ("track".to_string(), track.title.clone()),
    ]);
    add_optional_lastfm_metadata(&mut params, track);
    send_lastfm(client, params, &secret)
}

fn add_optional_lastfm_metadata(params: &mut BTreeMap<String, String>, track: &TrackMetadata) {
    if let Some(album) = track.album.as_deref().filter(|value| !value.trim().is_empty()) {
        params.insert("album".to_string(), album.to_string());
    }
    if let Some(duration) = track.duration_seconds {
        params.insert("duration".to_string(), duration.to_string());
    }
}

fn send_lastfm(client: &Client, mut params: BTreeMap<String, String>, secret: &str) -> bool {
    let signature = lastfm_signature(&params, secret);
    params.insert("api_sig".to_string(), signature);
    params.insert("format".to_string(), "json".to_string());

    client
        .post(LASTFM_API_ROOT)
        .form(&params)
        .send()
        .ok()
        .and_then(|response| response.json::<serde_json::Value>().ok())
        .is_some_and(|body| body.get("error").is_none())
}

fn send_listenbrainz(
    client: &Client,
    settings: &settings::Settings,
    track: &TrackMetadata,
    listened_at: Option<u64>,
    listen_type: &str,
) -> bool {
    let token = settings
        .listenbrainz_token
        .clone()
        .or_else(|| std::env::var("YTM_LISTENBRAINZ_TOKEN").ok())
        .filter(|value| !value.trim().is_empty());
    let Some(token) = token else {
        return false;
    };
    let Some(artist) = track.artist.as_deref().filter(|value| !value.trim().is_empty()) else {
        return false;
    };

    let mut listen = json!({
        "track_metadata": {
            "artist_name": artist,
            "track_name": track.title,
            "additional_info": {
                "media_player": CLIENT_NAME,
                "submission_client": CLIENT_NAME,
                "submission_client_version": env!("CARGO_PKG_VERSION"),
                "duration_ms": track.duration_seconds.map(|value| value * 1000),
            }
        }
    });
    if let Some(album) = track.album.as_deref().filter(|value| !value.trim().is_empty()) {
        listen["track_metadata"]["release_name"] = json!(album);
    }
    if let Some(timestamp) = listened_at {
        listen["listened_at"] = json!(timestamp);
    }

    client
        .post(LISTENBRAINZ_API_ROOT)
        .header("Authorization", format!("Token {token}"))
        .json(&json!({ "listen_type": listen_type, "payload": [listen] }))
        .send()
        .is_ok_and(|response| response.status().is_success())
}

fn lastfm_credentials(settings: &settings::Settings) -> Option<(String, String, String)> {
    let api_key = std::env::var("YTM_LASTFM_API_KEY").ok()?;
    let secret = std::env::var("YTM_LASTFM_API_SECRET").ok()?;
    let session_key = settings
        .lastfm_session_key
        .clone()
        .or_else(|| std::env::var("YTM_LASTFM_SESSION_KEY").ok())?;
    if api_key.trim().is_empty() || secret.trim().is_empty() || session_key.trim().is_empty() {
        return None;
    }
    Some((api_key, secret, session_key))
}

fn lastfm_signature(params: &BTreeMap<String, String>, secret: &str) -> String {
    let mut input = String::new();
    for (name, value) in params {
        if name != "format" && name != "callback" && name != "api_sig" {
            input.push_str(name);
            input.push_str(value);
        }
    }
    input.push_str(secret);
    format!("{:x}", md5::compute(input.as_bytes()))
}

fn track_key(track: &TrackMetadata) -> String {
    format!(
        "{}\u{0}{}\u{0}{}",
        track.title,
        track.artist.as_deref().unwrap_or_default(),
        track.duration_seconds.unwrap_or_default()
    )
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(duration: u64) -> TrackMetadata {
        TrackMetadata {
            title: "Song".to_string(),
            artist: Some("Artist".to_string()),
            album: Some("Album".to_string()),
            playing: true,
            url: None,
            cover_url: None,
            elapsed_seconds: Some(0),
            duration_seconds: Some(duration),
        }
    }

    #[test]
    fn scrobble_threshold_matches_service_rules() {
        assert!(!should_scrobble(&track(30), Duration::from_secs(30)));
        assert!(!should_scrobble(&track(200), Duration::from_secs(99)));
        assert!(should_scrobble(&track(200), Duration::from_secs(100)));
        assert!(!should_scrobble(&track(900), Duration::from_secs(239)));
        assert!(should_scrobble(&track(900), Duration::from_secs(240)));
    }

    #[test]
    fn lastfm_signature_sorts_parameters() {
        let params = BTreeMap::from([
            ("track".to_string(), "Song".to_string()),
            ("artist".to_string(), "Artist".to_string()),
        ]);
        let expected = format!(
            "{:x}",
            md5::compute(b"artistArtisttrackSongsecret")
        );
        assert_eq!(lastfm_signature(&params, "secret"), expected);
    }
}
