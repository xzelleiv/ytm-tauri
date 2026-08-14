use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct Settings {
    pub discord_rpc: bool,
    pub ad_block: bool,
    pub close_to_tray: bool,
    pub launch_at_startup: bool,
    pub start_minimized: bool,
    pub zoom: f64,
    pub synced_lyrics: bool,
    pub lyrics_precise_timing: bool,
    pub lyrics_show_inexact: bool,
    pub lyrics_show_timecodes: bool,
    pub lyrics_romanization: bool,
    pub lyrics_line_effect: String,
    pub lastfm_scrobbling: bool,
    pub lastfm_session_key: Option<String>,
    pub listenbrainz_scrobbling: bool,
    pub listenbrainz_token: Option<String>,
    pub notifications: bool,
    pub windows_media_controls: bool,
    pub custom_output_device: bool,
    pub output_device: String,
    pub equalizer: bool,
    pub equalizer_preset: String,
    pub precise_volume: bool,
    pub exponential_volume: bool,
    pub volume_step: f64,
    pub navigation_controls: bool,
    pub playback_speed: bool,
    pub playback_rate: f64,
    pub skip_disliked: bool,
    pub album_color_theme: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            discord_rpc: true,
            ad_block: true,
            close_to_tray: false,
            launch_at_startup: false,
            start_minimized: false,
            zoom: 1.0,
            synced_lyrics: false,
            lyrics_precise_timing: true,
            lyrics_show_inexact: true,
            lyrics_show_timecodes: false,
            lyrics_romanization: true,
            lyrics_line_effect: "fancy".to_string(),
            lastfm_scrobbling: false,
            lastfm_session_key: None,
            listenbrainz_scrobbling: false,
            listenbrainz_token: None,
            notifications: false,
            windows_media_controls: false,
            custom_output_device: false,
            output_device: "default".to_string(),
            equalizer: false,
            equalizer_preset: "flat".to_string(),
            precise_volume: false,
            exponential_volume: false,
            volume_step: 1.0,
            navigation_controls: false,
            playback_speed: false,
            playback_rate: 1.0,
            skip_disliked: false,
            album_color_theme: false,
        }
    }
}

pub type SharedSettings = Arc<Mutex<Settings>>;

pub fn load() -> SharedSettings {
    let settings = settings_path()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();

    Arc::new(Mutex::new(settings))
}

pub fn snapshot(settings: &SharedSettings) -> Settings {
    settings
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default()
}

pub fn update(settings: &SharedSettings, change: impl FnOnce(&mut Settings)) {
    let Ok(mut value) = settings.lock() else {
        return;
    };

    change(&mut value);

    let Some(path) = settings_path() else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    let Ok(json) = serde_json::to_string_pretty(&*value) else {
        return;
    };

    let _ = fs::create_dir_all(parent);
    let _ = fs::write(path, json);
}

fn settings_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|dir| dir.join("app.ytmusic.desktop").join("settings.json"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from).map(|dir| {
            dir.join(".config")
                .join("app.ytmusic.desktop")
                .join("settings.json")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_use_defaults() {
        let settings: Settings =
            serde_json::from_str(r#"{"discord_rpc":false}"#).expect("settings");

        assert!(!settings.discord_rpc);
        assert!(settings.ad_block);
        assert_eq!(settings.zoom, 1.0);
        assert!(!settings.synced_lyrics);
        assert!(settings.lyrics_precise_timing);
        assert!(settings.lyrics_show_inexact);
        assert_eq!(settings.lyrics_line_effect, "fancy");
        assert_eq!(settings.output_device, "default");
        assert_eq!(settings.equalizer_preset, "flat");
        assert_eq!(settings.playback_rate, 1.0);
    }
}
