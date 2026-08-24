use crate::{presence::TrackMetadata, settings, settings::SharedSettings};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

pub trait NotificationSink: Send + Sync {
    fn show(&self, title: &str, body: &str) -> Result<(), String>;
}

pub struct TauriNotificationSink {
    app: AppHandle,
}

impl TauriNotificationSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl NotificationSink for TauriNotificationSink {
    fn show(&self, title: &str, body: &str) -> Result<(), String> {
        let mut builder = self.app.notification().builder().title(title);
        if !body.is_empty() {
            builder = builder.body(body);
        }
        builder.show().map_err(|err| err.to_string())
    }
}

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
        let sink = TauriNotificationSink::new(app.clone());
        self.update_with_sink(&sink, track);
    }

    pub fn update_with_sink(&self, sink: &dyn NotificationSink, track: &TrackMetadata) {
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

        let body = notification_body(track);
        match sink.show(&track.title, &body) {
            Ok(()) => {
                *last_track = Some(key);
            }
            Err(err) => {
                eprintln!("Failed to show notification: {err}");
            }
        }
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
        track
            .artist
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        track
            .album
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
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

    struct MockNotificationSink {
        should_fail: bool,
        delivered: Arc<Mutex<Vec<(String, String)>>>,
    }

    impl NotificationSink for MockNotificationSink {
        fn show(&self, title: &str, body: &str) -> Result<(), String> {
            if self.should_fail {
                Err("simulated toast delivery error".to_string())
            } else {
                self.delivered
                    .lock()
                    .unwrap()
                    .push((title.to_string(), body.to_string()));
                Ok(())
            }
        }
    }

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
        assert_eq!(
            notification_body(&track(Some("Artist"), Some("Album"))),
            "Artist · Album"
        );
        assert_eq!(notification_body(&track(Some("Artist"), None)), "Artist");
        assert_eq!(notification_body(&track(None, None)), "");
    }

    #[test]
    fn deduplicates_after_successful_delivery() {
        let settings_obj = settings::Settings {
            notifications: true,
            ..Default::default()
        };
        let settings = Arc::new(Mutex::new(settings_obj));
        let controller = NotificationController::new(settings);

        let delivered = Arc::new(Mutex::new(Vec::new()));
        let sink = MockNotificationSink {
            should_fail: false,
            delivered: delivered.clone(),
        };

        let t = track(Some("Artist"), Some("Album"));
        controller.update_with_sink(&sink, &t);
        assert_eq!(delivered.lock().unwrap().len(), 1);

        // deduplicate repeat
        controller.update_with_sink(&sink, &t);
        assert_eq!(delivered.lock().unwrap().len(), 1);
    }

    #[test]
    fn preserves_retry_after_failed_delivery() {
        let settings_obj = settings::Settings {
            notifications: true,
            ..Default::default()
        };
        let settings = Arc::new(Mutex::new(settings_obj));
        let controller = NotificationController::new(settings);

        let delivered = Arc::new(Mutex::new(Vec::new()));
        let failing_sink = MockNotificationSink {
            should_fail: true,
            delivered: delivered.clone(),
        };

        let t = track(Some("Artist"), Some("Album"));
        controller.update_with_sink(&failing_sink, &t);
        assert_eq!(delivered.lock().unwrap().len(), 0);

        // retry on error
        let working_sink = MockNotificationSink {
            should_fail: false,
            delivered: delivered.clone(),
        };
        controller.update_with_sink(&working_sink, &t);
        assert_eq!(delivered.lock().unwrap().len(), 1);
    }
}
