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
    pub lyrics_auto_sync: bool,
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
    pub equalizer_custom_gains: String,
    pub precise_volume: bool,
    pub exponential_volume: bool,
    pub volume_step: f64,
    pub navigation_controls: bool,
    pub playback_speed: bool,
    pub playback_rate: f64,
    pub skip_disliked: bool,
    pub sponsorblock: bool,
    pub blur_nav_bar: bool,
    pub disable_autoplay: bool,
    pub video_toggle: bool,
    pub ambient_mode: bool,
    pub crossfade: bool,
    pub crossfade_seconds: f64,
    pub crossfade_curve: String,
    pub spotify_spoof: bool,
    pub last_notified_version: Option<String>,
    pub last_update_check: Option<u64>,
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
            synced_lyrics: true,
            lyrics_precise_timing: true,
            lyrics_show_inexact: true,
            lyrics_show_timecodes: false,
            lyrics_romanization: false,
            lyrics_auto_sync: true,
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
            equalizer_preset: "bass-booster".to_string(),
            equalizer_custom_gains: "0,0,0,0,0,0,0,0,0,0".to_string(),
            precise_volume: false,
            exponential_volume: false,
            volume_step: 1.0,
            navigation_controls: false,
            playback_speed: false,
            playback_rate: 1.0,
            skip_disliked: false,
            sponsorblock: true,
            blur_nav_bar: true,
            disable_autoplay: false,
            video_toggle: false,
            ambient_mode: true,
            crossfade: false,
            crossfade_seconds: 4.0,
            crossfade_curve: "equal-power".to_string(),
            spotify_spoof: false,
            last_notified_version: None,
            last_update_check: None,
        }
    }
}

impl Settings {
    fn normalize(&mut self) {
        self.zoom = finite_clamp(self.zoom, 0.5, 2.0, 1.0);
        self.volume_step = finite_clamp(self.volume_step, 0.1, 10.0, 1.0);
        self.playback_rate = finite_clamp(self.playback_rate, 0.25, 3.0, 1.0);
        if !matches!(
            self.lyrics_line_effect.as_str(),
            "fancy"
                | "scale"
                | "offset"
                | "focus"
                | "cinematic"
                | "studio"
                | "luminescent"
        ) {
            self.lyrics_line_effect = "fancy".to_string();
        }
        if !matches!(
            self.equalizer_preset.as_str(),
            "flat"
                | "bass-booster"
                | "bass-reducer"
                | "treble-booster"
                | "treble-reducer"
                | "vocal-booster"
                | "rock"
                | "pop"
                | "electronic"
                | "hip-hop"
                | "acoustic"
                | "classical"
                | "deep"
                | "custom"
        ) {
            self.equalizer_preset = "bass-booster".to_string();
        }
        if self.equalizer_custom_gains.is_empty() || self.equalizer_custom_gains.len() > 256 {
            self.equalizer_custom_gains = "0,0,0,0,0,0,0,0,0,0".to_string();
        }
        self.crossfade_seconds = finite_clamp(self.crossfade_seconds, 1.0, 15.0, 4.0);
        if !matches!(
            self.crossfade_curve.as_str(),
            "equal-power" | "logarithmic" | "linear"
        ) {
            self.crossfade_curve = "equal-power".to_string();
        }
        if self.output_device.len() > 512 {
            self.output_device = "default".to_string();
        }
    }
}

fn finite_clamp(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

pub type SharedSettings = Arc<Mutex<Settings>>;

pub fn load() -> SharedSettings {
    let mut settings: Settings = settings_path()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();
    settings.normalize();

    Arc::new(Mutex::new(settings))
}

pub fn snapshot(settings: &SharedSettings) -> Settings {
    settings
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default()
}

pub fn update(settings: &SharedSettings, change: impl FnOnce(&mut Settings)) {
    let _ = update_if(settings, |value| {
        change(value);
        true
    });
}

pub fn update_if(settings: &SharedSettings, change: impl FnOnce(&mut Settings) -> bool) -> bool {
    let Ok(mut value) = settings.lock() else {
        return false;
    };

    if !change(&mut value) {
        return false;
    }
    value.normalize();

    let Some(path) = settings_path() else {
        return true;
    };
    let Some(parent) = path.parent() else {
        return true;
    };
    let Ok(json) = serde_json::to_string_pretty(&*value) else {
        return true;
    };

    let _ = fs::create_dir_all(parent);
    let _ = fs::write(path, json);
    true
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
        assert!(settings.synced_lyrics);
        assert!(settings.lyrics_precise_timing);
        assert!(settings.lyrics_show_inexact);
        assert_eq!(settings.lyrics_line_effect, "fancy");
        assert_eq!(settings.output_device, "default");
        assert_eq!(settings.equalizer_preset, "bass-booster");
        assert_eq!(settings.equalizer_custom_gains, "0,0,0,0,0,0,0,0,0,0");
        assert_eq!(settings.crossfade_seconds, 4.0);
        assert_eq!(settings.crossfade_curve, "equal-power");
        assert_eq!(settings.playback_rate, 1.0);
    }

    #[test]
    fn normalization_bounds_corrupt_or_unsupported_values() {
        let mut settings = Settings {
            zoom: -4.0,
            volume_step: 100.0,
            playback_rate: 0.01,
            lyrics_line_effect: "unknown".to_string(),
            equalizer_preset: "unknown".to_string(),
            equalizer_custom_gains: "".to_string(),
            crossfade_seconds: 99.0,
            crossfade_curve: "unknown".to_string(),
            ..Settings::default()
        };

        settings.normalize();

        assert_eq!(settings.zoom, 0.5);
        assert_eq!(settings.volume_step, 10.0);
        assert_eq!(settings.playback_rate, 0.25);
        assert_eq!(settings.lyrics_line_effect, "fancy");
        assert_eq!(settings.equalizer_preset, "bass-booster");
        assert_eq!(settings.equalizer_custom_gains, "0,0,0,0,0,0,0,0,0,0");
        assert_eq!(settings.crossfade_seconds, 15.0);
        assert_eq!(settings.crossfade_curve, "equal-power");
    }

    #[test]
    fn normalization_preserves_new_lyrics_effects() {
        for effect in ["cinematic", "studio", "luminescent"] {
            let mut settings = Settings {
                lyrics_line_effect: effect.to_string(),
                ..Settings::default()
            };
            settings.normalize();
            assert_eq!(settings.lyrics_line_effect, effect);
        }
    }
}
