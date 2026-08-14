use crate::{presence::TrackMetadata, settings, settings::SharedSettings};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

#[derive(Clone)]
pub struct NotificationController {
    settings: SharedSettings,
    last_track: Arc<Mutex<Option<String>>>,
}

impl NotificationController {
    pub fn new(settings: SharedSettings) -> Self {
        Self {
            settings,
            last_track: Arc::new(Mutex::new(None)),
        }
    }

    pub fn update(&self, app: &AppHandle, track: &TrackMetadata) {
        if !settings::snapshot(&self.settings).notifications || !track.playing {
            return;
        }

        let key = track_key(track);
        let Ok(mut last_track) = self.last_track.lock() else {
            return;
        };
        if last_track.as_deref() == Some(&key) {
            return;
        }
        *last_track = Some(key);
        drop(last_track);

        let body = notification_body(track);
        let mut builder = app.notification().builder().title(&track.title);
        if !body.is_empty() {
            builder = builder.body(body);
        }
        let _ = builder.show();
    }

    pub fn clear(&self) {
        if let Ok(mut value) = self.last_track.lock() {
            *value = None;
        }
    }
}

fn track_key(track: &TrackMetadata) -> String {
    format!(
        "{}\u{0}{}\u{0}{}",
        track.title,
        track.artist.as_deref().unwrap_or_default(),
        track.album.as_deref().unwrap_or_default()
    )
}

fn notification_body(track: &TrackMetadata) -> String {
    match (
        track.artist.as_deref().filter(|value| !value.trim().is_empty()),
        track.album.as_deref().filter(|value| !value.trim().is_empty()),
    ) {
        (Some(artist), Some(album)) => format!("{artist} · {album}"),
        (Some(artist), None) => artist.to_string(),
        (None, Some(album)) => album.to_string(),
        (None, None) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(artist: Option<&str>, album: Option<&str>) -> TrackMetadata {
        TrackMetadata {
            title: "Song".to_string(),
            artist: artist.map(str::to_string),
            album: album.map(str::to_string),
            playing: true,
            url: None,
            cover_url: None,
            elapsed_seconds: None,
            duration_seconds: None,
        }
    }

    #[test]
    fn body_uses_artist_and_album() {
        assert_eq!(notification_body(&track(Some("Artist"), Some("Album"))), "Artist · Album");
        assert_eq!(notification_body(&track(Some("Artist"), None)), "Artist");
        assert_eq!(notification_body(&track(None, None)), "");
    }
}
