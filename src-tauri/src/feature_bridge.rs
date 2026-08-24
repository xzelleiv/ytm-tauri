use crate::{controls, settings, updates, AppState};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, thread, time::Duration};
use tauri::{Manager, Url, WebviewWindow};

const PREFIX: &str = "YTMFEATURE:";
const MAX_REQUEST_BODY: usize = 256 * 1024;
const MAX_RESPONSE_BODY: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct FeatureRequest {
    pub id: u64,
    pub kind: String,
    #[serde(default)]
    pub url: String,
    #[serde(default = "default_method")]
    pub method: String,
    pub body: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub key: Option<String>,
    pub value: Option<serde_json::Value>,
    pub action: Option<String>,
}

#[derive(Serialize)]
pub struct FeatureResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<settings::Settings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn default_method() -> String {
    "GET".to_string()
}

pub fn is_feature_title_message(title: &str) -> bool {
    title.starts_with(PREFIX)
}

pub fn handle_title(window: &WebviewWindow, title: &str, state: &AppState) {
    let Some(request) = parse_request(title) else {
        return;
    };

    match request.kind.as_str() {
        "get_settings" => {
            let current = sanitize_settings(settings::snapshot(&state.settings));
            let response = FeatureResponse {
                ok: true,
                status: Some(200),
                body: None,
                headers: HashMap::new(),
                settings: Some(current),
                error: None,
            };
            send_response(window, request.id, &response);
        }
        "set_setting" => {
            let mut updated_settings = None;
            if let (Some(key), Some(value)) = (&request.key, &request.value) {
                settings::update(&state.settings, |s| {
                    apply_setting_update(s, key, value);
                });
                let snap = settings::snapshot(&state.settings);
                if key == "discord_rpc" {
                    state.presence.set_enabled(snap.discord_rpc);
                } else if key == "spotify_spoof" {
                    state.presence.set_spotify_spoof(snap.spotify_spoof);
                } else if key == "ad_block" {
                    state.adblock.set_enabled(snap.ad_block);
                } else if key == "launch_at_startup" || key == "start_minimized" {
                    let _ = crate::platform::set_startup_enabled(
                        snap.launch_at_startup,
                        snap.start_minimized,
                    );
                }
                updated_settings = Some(sanitize_settings(snap));
            }
            let response = FeatureResponse {
                ok: updated_settings.is_some(),
                status: Some(if updated_settings.is_some() { 200 } else { 400 }),
                body: None,
                headers: HashMap::new(),
                settings: updated_settings,
                error: None,
            };
            send_response(window, request.id, &response);
        }
        "action" => {
            if let Some(action) = &request.action {
                handle_action(window, action, state);
            }
            let response = FeatureResponse {
                ok: true,
                status: Some(200),
                body: None,
                headers: HashMap::new(),
                settings: Some(sanitize_settings(settings::snapshot(&state.settings))),
                error: None,
            };
            send_response(window, request.id, &response);
        }
        "http" => {
            let window = window.clone();
            thread::spawn(move || {
                let response = execute_request(&request);
                send_response(&window, request.id, &response);
            });
        }
        _ => {}
    }
}

fn send_response(window: &WebviewWindow, id: u64, response: &FeatureResponse) {
    let Ok(payload) = serde_json::to_string(response) else {
        return;
    };
    let script = format!("window.__ytmFeatures?.receive?.({id}, {payload});");
    let _ = window.eval(&script);
}

fn handle_action(window: &WebviewWindow, action: &str, state: &AppState) {
    let app = window.app_handle();
    match action {
        "check_updates" => {
            updates::check(app, &state.settings, updates::CheckMode::Manual);
        }
        "clear_cache" => {
            controls::clear_cache(app);
        }
        "reset_session" => {
            controls::reset_session(app, state);
        }
        "zoom_in" => {
            controls::set_zoom(app, state, 0.1);
        }
        "zoom_out" => {
            controls::set_zoom(app, state, -0.1);
        }
        "zoom_reset" => {
            controls::reset_zoom(app, state);
        }
        "open_devtools" => {
            window.open_devtools();
        }
        "open_github" => {
            crate::platform::open_url("https://github.com/xzelleiv/ytm-tauri");
        }
        "force_close" | "exit_app" | "quit_app" => {
            std::process::exit(0);
        }
        _ => {}
    }
}

fn sanitize_settings(mut s: settings::Settings) -> settings::Settings {
    s.lastfm_session_key = None;
    s.listenbrainz_token = None;
    s
}

pub fn apply_setting_update(
    settings: &mut settings::Settings,
    key: &str,
    value: &serde_json::Value,
) -> bool {
    match key {
        "discord_rpc" => {
            if let Some(v) = value.as_bool() {
                settings.discord_rpc = v;
                return true;
            }
        }
        "ad_block" => {
            if let Some(v) = value.as_bool() {
                settings.ad_block = v;
                return true;
            }
        }
        "close_to_tray" => {
            if let Some(v) = value.as_bool() {
                settings.close_to_tray = v;
                return true;
            }
        }
        "launch_at_startup" => {
            if let Some(v) = value.as_bool() {
                settings.launch_at_startup = v;
                return true;
            }
        }
        "start_minimized" => {
            if let Some(v) = value.as_bool() {
                settings.start_minimized = v;
                return true;
            }
        }
        "zoom" => {
            if let Some(v) = value.as_f64() {
                settings.zoom = v;
                return true;
            }
        }
        "synced_lyrics" => {
            if let Some(v) = value.as_bool() {
                settings.synced_lyrics = v;
                return true;
            }
        }
        "lyrics_precise_timing" => {
            if let Some(v) = value.as_bool() {
                settings.lyrics_precise_timing = v;
                return true;
            }
        }
        "lyrics_show_inexact" => {
            if let Some(v) = value.as_bool() {
                settings.lyrics_show_inexact = v;
                return true;
            }
        }
        "lyrics_show_timecodes" => {
            if let Some(v) = value.as_bool() {
                settings.lyrics_show_timecodes = v;
                return true;
            }
        }
        "lyrics_romanization" => {
            if let Some(v) = value.as_bool() {
                settings.lyrics_romanization = v;
                return true;
            }
        }
        "lyrics_auto_sync" => {
            if let Some(v) = value.as_bool() {
                settings.lyrics_auto_sync = v;
                return true;
            }
        }
        "lyrics_line_effect" => {
            if let Some(v) = value.as_str() {
                settings.lyrics_line_effect = v.to_string();
                return true;
            }
        }
        "lastfm_scrobbling" => {
            if let Some(v) = value.as_bool() {
                settings.lastfm_scrobbling = v;
                return true;
            }
        }
        "lastfm_session_key" => {
            settings.lastfm_session_key = value.as_str().map(|s| s.to_string());
            return true;
        }
        "listenbrainz_scrobbling" => {
            if let Some(v) = value.as_bool() {
                settings.listenbrainz_scrobbling = v;
                return true;
            }
        }
        "listenbrainz_token" => {
            settings.listenbrainz_token = value.as_str().map(|s| s.to_string());
            return true;
        }
        "notifications" => {
            if let Some(v) = value.as_bool() {
                settings.notifications = v;
                return true;
            }
        }
        "windows_media_controls" => {
            if let Some(v) = value.as_bool() {
                settings.windows_media_controls = v;
                return true;
            }
        }
        "custom_output_device" => {
            if let Some(v) = value.as_bool() {
                settings.custom_output_device = v;
                return true;
            }
        }
        "output_device" => {
            if let Some(v) = value.as_str() {
                settings.output_device = v.to_string();
                return true;
            }
        }
        "equalizer" => {
            if let Some(v) = value.as_bool() {
                settings.equalizer = v;
                return true;
            }
        }
        "equalizer_preset" => {
            if let Some(v) = value.as_str() {
                settings.equalizer_preset = v.to_string();
                return true;
            }
        }
        "precise_volume" => {
            if let Some(v) = value.as_bool() {
                settings.precise_volume = v;
                return true;
            }
        }
        "exponential_volume" => {
            if let Some(v) = value.as_bool() {
                settings.exponential_volume = v;
                return true;
            }
        }
        "volume_step" => {
            if let Some(v) = value.as_f64() {
                settings.volume_step = v;
                return true;
            }
        }
        "navigation_controls" => {
            if let Some(v) = value.as_bool() {
                settings.navigation_controls = v;
                return true;
            }
        }
        "playback_speed" => {
            if let Some(v) = value.as_bool() {
                settings.playback_speed = v;
                return true;
            }
        }
        "playback_rate" => {
            if let Some(v) = value.as_f64() {
                settings.playback_rate = v;
                return true;
            }
        }
        "skip_disliked" => {
            if let Some(v) = value.as_bool() {
                settings.skip_disliked = v;
                return true;
            }
        }
        "sponsorblock" => {
            if let Some(v) = value.as_bool() {
                settings.sponsorblock = v;
                return true;
            }
        }
        "blur_nav_bar" => {
            if let Some(v) = value.as_bool() {
                settings.blur_nav_bar = v;
                return true;
            }
        }
        "disable_autoplay" => {
            if let Some(v) = value.as_bool() {
                settings.disable_autoplay = v;
                return true;
            }
        }
        "video_toggle" => {
            if let Some(v) = value.as_bool() {
                settings.video_toggle = v;
                return true;
            }
        }
        "ambient_mode" => {
            if let Some(v) = value.as_bool() {
                settings.ambient_mode = v;
                return true;
            }
        }
        "crossfade" => {
            if let Some(v) = value.as_bool() {
                settings.crossfade = v;
                return true;
            }
        }
        "spotify_spoof" => {
            if let Some(v) = value.as_bool() {
                settings.spotify_spoof = v;
                return true;
            }
        }
        _ => {}
    }
    false
}

fn parse_request(title: &str) -> Option<FeatureRequest> {
    let raw = title.strip_prefix(PREFIX)?;
    let request: FeatureRequest = serde_json::from_str(raw).ok()?;

    match request.kind.as_str() {
        "get_settings" => Some(request),
        "set_setting" => {
            if request.key.is_some() && request.value.is_some() {
                Some(request)
            } else {
                None
            }
        }
        "action" => {
            if request.action.is_some() {
                Some(request)
            } else {
                None
            }
        }
        "http" => {
            if !matches!(request.method.as_str(), "GET" | "POST") {
                return None;
            }
            if request
                .body
                .as_ref()
                .is_some_and(|body| body.len() > MAX_REQUEST_BODY)
            {
                return None;
            }
            let url = Url::parse(&request.url).ok()?;
            if url.scheme() != "https" || !url.host_str().is_some_and(is_allowed_host) {
                return None;
            }
            Some(request)
        }
        _ => None,
    }
}

fn execute_request(request: &FeatureRequest) -> FeatureResponse {
    let client = match reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .user_agent(concat!(
            "ytm-tauri/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/xzelleiv/ytm-tauri)"
        ))
        .build()
    {
        Ok(client) => client,
        Err(error) => return error_response(error.to_string()),
    };

    let mut builder = match request.method.as_str() {
        "POST" => client.post(&request.url),
        _ => client.get(&request.url),
    };

    for (name, value) in &request.headers {
        if is_allowed_header(name) {
            builder = builder.header(name, value);
        }
    }
    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }

    let response = match builder.send() {
        Ok(response) => response,
        Err(error) => return error_response(error.to_string()),
    };
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();
    let body = match response.text() {
        Ok(body) if body.len() <= MAX_RESPONSE_BODY => body,
        Ok(_) => return error_response("response too large".to_string()),
        Err(error) => return error_response(error.to_string()),
    };

    FeatureResponse {
        ok: (200..300).contains(&status),
        status: Some(status),
        body: Some(body),
        headers,
        settings: None,
        error: None,
    }
}

fn error_response(error: String) -> FeatureResponse {
    FeatureResponse {
        ok: false,
        status: None,
        body: None,
        headers: HashMap::new(),
        settings: None,
        error: Some(error),
    }
}

fn is_allowed_host(host: &str) -> bool {
    matches!(
        host,
        "lrclib.net"
            | "genius.com"
            | "www.genius.com"
            | "megalobiz.com"
            | "www.megalobiz.com"
            | "apic-desktop.musixmatch.com"
            | "ytmbrowseproxy.zvz.be"
            | "b-ytmbrowseproxy.zvz.be"
            | "sponsor.ajay.app"
    )
}

fn is_allowed_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept" | "content-type" | "cookie" | "authority" | "lrclib-client" | "x-user-agent"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_provider_hosts_are_allowed() {
        assert!(is_allowed_host("lrclib.net"));
        assert!(is_allowed_host("genius.com"));
        assert!(is_allowed_host("apic-desktop.musixmatch.com"));
        assert!(!is_allowed_host("example.com"));
        assert!(!is_allowed_host("lrclib.net.example.com"));
    }

    #[test]
    fn bridge_rejects_unknown_urls_and_methods() {
        let external = r#"YTMFEATURE:{"id":1,"kind":"http","url":"https://example.com/"}"#;
        let method = r#"YTMFEATURE:{"id":1,"kind":"http","url":"https://lrclib.net/api/search","method":"DELETE"}"#;

        assert!(parse_request(external).is_none());
        assert!(parse_request(method).is_none());
    }

    #[test]
    fn bridge_accepts_known_provider_requests() {
        let request =
            r#"YTMFEATURE:{"id":7,"kind":"http","url":"https://lrclib.net/api/search?q=test"}"#;
        let parsed = parse_request(request).expect("request");

        assert_eq!(parsed.id, 7);
        assert_eq!(parsed.method, "GET");
    }

    #[test]
    fn bridge_accepts_settings_requests() {
        let get = r#"YTMFEATURE:{"id":2,"kind":"get_settings"}"#;
        let parsed = parse_request(get).expect("get settings");
        assert_eq!(parsed.kind, "get_settings");

        let set = r#"YTMFEATURE:{"id":3,"kind":"set_setting","key":"synced_lyrics","value":true}"#;
        let parsed = parse_request(set).expect("set setting");
        assert_eq!(parsed.kind, "set_setting");
        assert_eq!(parsed.key.as_deref(), Some("synced_lyrics"));
    }
}
