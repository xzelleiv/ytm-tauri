//! Builds the Tauri window, injects page probes, and gates navigation/title messages.

mod adblock;
mod controls;
mod feature_bridge;
mod platform;
mod presence;
mod settings;
mod updates;
mod url_policy;

use adblock::AdBlockController;
use controls::AppState;
use presence::{PresenceController, PresenceMessage};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{Manager, Theme, Url, WebviewUrl, WindowEvent};
use url_policy::{is_allowed_navigation_url, is_youtube_music_url};

const YOUTUBE_MUSIC_URL: &str = "https://music.youtube.com";
const AD_BLOCK_SCRIPT: &str = include_str!("adblock_probe.js");
const FEATURE_PROBE_SCRIPT: &str = include_str!("feature_probe.js");
const SYNCED_LYRICS_SCRIPT: &str = include_str!("synced_lyrics_probe.js");
const TRACK_PROBE_SCRIPT: &str = include_str!("track_probe.js");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NewWindowAction {
    NavigateInMainWebview,
    OpenExternal,
    Deny,
}

// Hidden diagnostics hook: run with YT_MUSIC_ADBLOCK_SELF_TEST=1 and the window
// title should briefly become ADBLOCK_SELF_TEST:PASS when native blocking works.
const AD_BLOCK_SELF_TEST_SCRIPT: &str = r#"
(() => {
  if (!window.__ytMusicTauriAdBlockSelfTest) {
    window.__ytMusicTauriAdBlockSelfTest = true;
    fetch("https://googleads.g.doubleclick.net/pagead/id", { cache: "no-store" })
      .then((response) => {
        document.title = response.status === 204
          ? "ADBLOCK_SELF_TEST:PASS"
          : `ADBLOCK_SELF_TEST:FAIL:${response.status}`;
      })
      .catch((error) => {
        document.title = `ADBLOCK_SELF_TEST:FAIL:${error && error.name ? error.name : "ERROR"}`;
      });
  }
})();
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = settings::load();
    settings::update(&settings, |value| {
        value.launch_at_startup = platform::startup_enabled()
    });
    let initial = settings::snapshot(&settings);
    let presence = PresenceController::new(initial.discord_rpc);
    let adblock = AdBlockController::new(initial.ad_block);
    let presence_for_navigation = presence.clone();
    let presence_for_window = presence.clone();
    let adblock_for_webview = adblock.clone();
    let state = AppState {
        settings,
        presence,
        adblock,
        quitting: Arc::new(AtomicBool::new(false)),
    };
    let state_for_events = state.clone();
    let start_minimized = std::env::args().any(|argument| argument == "--minimized");

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                controls::show_main_window(app);
            }));
    }

    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .on_window_event(move |window, event| match event {
            WindowEvent::Focused(focused) if window.label() == "main" => {
                controls::set_local_shortcuts(window.app_handle(), *focused, &state_for_events);
            }
            WindowEvent::CloseRequested { api, .. }
                if settings::snapshot(&state_for_events.settings).close_to_tray
                    && !state_for_events.quitting.load(Ordering::Relaxed) =>
            {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                state_for_events.presence.clear();
            }
            _ => {}
        })
        .setup(move |app| {
            let music_url = YOUTUBE_MUSIC_URL
                .parse()
                .expect("static YouTube Music URL must be valid");
            let blank_url = "about:blank"
                .parse()
                .expect("static about:blank URL must be valid");
            let app_for_new_window = app.handle().clone();

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(blank_url))
                .title("YouTube Music")
                .theme(Some(Theme::Dark))
                .inner_size(1280.0, 840.0)
                .min_inner_size(900.0, 620.0)
                .center()
                .zoom_hotkeys_enabled(false)
                .initialization_script(initialization_script(&initial))
                .on_navigation(move |url| {
                    let allowed = is_allowed_navigation_url(url);

                    if !is_youtube_music_url(url) {
                        presence_for_navigation.clear();
                    }
                    if !allowed && url.scheme() == "https" {
                        platform::open_url(url.as_str());
                    }

                    allowed
                })
                .on_new_window(move |url, _features| {
                    match new_window_action(&url) {
                        NewWindowAction::NavigateInMainWebview => {
                            if let Some(window) = app_for_new_window.get_webview_window("main") {
                                let _ = window.navigate(url);
                            }
                        }
                        NewWindowAction::OpenExternal => {
                            platform::open_url(url.as_str());
                        }
                        NewWindowAction::Deny => {}
                    }

                    NewWindowResponse::Deny
                })
                .on_document_title_changed(move |window, title| {
                    if feature_bridge::is_feature_title_message(&title) {
                        if window.url().ok().as_ref().is_some_and(is_youtube_music_url) {
                            feature_bridge::handle_title(&window, &title);
                        }
                        return;
                    }

                    // track_probe.js sends JSON through document.title so the remote
                    // YouTube page never gets direct access to Tauri commands.
                    if presence::is_presence_title_message(&title) {
                        if let Some(message) = presence::parse_presence_title(&title) {
                            if should_accept_presence_message(window.url().ok().as_ref(), &message)
                            {
                                match message {
                                    PresenceMessage::Track(track) => {
                                        let window_title = track.window_title();
                                        let _ = window.set_title(&window_title);
                                        controls::update_now_playing(
                                            window.app_handle(),
                                            Some(&track),
                                        );
                                        presence_for_window.update(track);
                                    }
                                    PresenceMessage::Clear => {
                                        let _ = window.set_title("YouTube Music");
                                        controls::update_now_playing(window.app_handle(), None);
                                        presence_for_window.clear();
                                    }
                                }
                            }
                        }
                        return;
                    }

                    if !title.trim().is_empty() {
                        let _ = window.set_title(&title);
                    }
                })
                .build()?;
            controls::install(app, state)?;
            let _ = window.set_zoom(initial.zoom.clamp(0.5, 2.0));
            let _ = window.with_webview(move |webview| adblock_for_webview.install(webview));
            window.navigate(music_url)?;
            if start_minimized {
                let _ = window.hide();
            }
            updates::check_in_background(true);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running YouTube Music");
}

fn initialization_script(settings: &settings::Settings) -> String {
    let ad_block = format!(
        "window.__ytMusicTauriAdBlockEnabled = {};",
        settings.ad_block
    );
    let features = format!(
        "window.__ytmFeatureConfig = {};",
        page_feature_config(settings)
    );

    if std::env::var_os("YT_MUSIC_ADBLOCK_SELF_TEST").is_some() {
        format!(
            "{ad_block}\n{features}\n{AD_BLOCK_SCRIPT}\n{FEATURE_PROBE_SCRIPT}\n{SYNCED_LYRICS_SCRIPT}\n{AD_BLOCK_SELF_TEST_SCRIPT}\n{TRACK_PROBE_SCRIPT}"
        )
    } else {
        format!(
            "{ad_block}\n{features}\n{AD_BLOCK_SCRIPT}\n{FEATURE_PROBE_SCRIPT}\n{SYNCED_LYRICS_SCRIPT}\n{TRACK_PROBE_SCRIPT}"
        )
    }
}

pub fn page_feature_config(settings: &settings::Settings) -> String {
    serde_json::json!({
        "synced_lyrics": settings.synced_lyrics,
        "lyrics_precise_timing": settings.lyrics_precise_timing,
        "lyrics_show_inexact": settings.lyrics_show_inexact,
        "lyrics_show_timecodes": settings.lyrics_show_timecodes,
        "lyrics_romanization": settings.lyrics_romanization,
        "lyrics_line_effect": settings.lyrics_line_effect,
        "custom_output_device": settings.custom_output_device,
        "output_device": settings.output_device,
        "equalizer": settings.equalizer,
        "equalizer_preset": settings.equalizer_preset,
        "precise_volume": settings.precise_volume,
        "exponential_volume": settings.exponential_volume,
        "volume_step": settings.volume_step,
        "navigation_controls": settings.navigation_controls,
        "playback_speed": settings.playback_speed,
        "playback_rate": settings.playback_rate,
        "skip_disliked": settings.skip_disliked,
        "album_color_theme": settings.album_color_theme,
    })
    .to_string()
}

fn should_accept_presence_message(current_url: Option<&Url>, message: &PresenceMessage) -> bool {
    match message {
        PresenceMessage::Track(_) => current_url.is_some_and(is_youtube_music_url),
        PresenceMessage::Clear => current_url.is_some_and(is_allowed_navigation_url),
    }
}

fn new_window_action(url: &Url) -> NewWindowAction {
    if url.scheme() == "https" && is_allowed_navigation_url(url) {
        NewWindowAction::NavigateInMainWebview
    } else if url.as_str() == "about:blank" {
        NewWindowAction::Deny
    } else {
        NewWindowAction::OpenExternal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_url(value: &str) -> Url {
        Url::parse(value).expect("test URL must parse")
    }

    #[test]
    fn accepts_track_titles_only_from_youtube_music() {
        let title = r#"YTMRPC:{"title":"Song","artist":null,"album":null,"playing":true,"url":null,"cover_url":null,"elapsed_seconds":null,"duration_seconds":null}"#;
        let message = presence::parse_presence_title(title).expect("presence message");
        let music_url = parse_url("https://music.youtube.com/watch?v=x");
        let account_url = parse_url("https://accounts.google.com/signin");

        assert!(should_accept_presence_message(Some(&music_url), &message));
        assert!(!should_accept_presence_message(
            Some(&account_url),
            &message
        ));
        assert!(!should_accept_presence_message(None, &message));
    }

    #[test]
    fn accepts_clear_titles_from_allowed_pages() {
        let message =
            presence::parse_presence_title(r#"YTMRPC:{"type":"clear"}"#).expect("clear message");
        let music_url = parse_url("https://music.youtube.com/watch?v=x");
        let account_url = parse_url("https://accounts.google.com/signin");
        let external_url = parse_url("https://example.com/");

        assert!(should_accept_presence_message(Some(&music_url), &message));
        assert!(should_accept_presence_message(Some(&account_url), &message));
        assert!(!should_accept_presence_message(
            Some(&external_url),
            &message
        ));
        assert!(!should_accept_presence_message(None, &message));
    }

    #[test]
    fn ignores_non_track_titles_for_track_bridge() {
        assert!(presence::parse_presence_title("YouTube Music").is_none());
    }

    #[test]
    fn routes_allowed_new_windows_back_into_main_webview() {
        let music_url = parse_url("https://music.youtube.com/");
        let account_url = parse_url("https://accounts.google.com/signin");
        let external_url = parse_url("https://example.com/");
        let blank_url = parse_url("about:blank");

        assert_eq!(
            new_window_action(&music_url),
            NewWindowAction::NavigateInMainWebview
        );
        assert_eq!(
            new_window_action(&account_url),
            NewWindowAction::NavigateInMainWebview
        );
        assert_eq!(
            new_window_action(&external_url),
            NewWindowAction::OpenExternal
        );
        assert_eq!(new_window_action(&blank_url), NewWindowAction::Deny);
    }

    #[test]
    fn page_config_excludes_native_secrets() {
        let settings = settings::Settings {
            lastfm_session_key: Some("lastfm-secret".to_string()),
            listenbrainz_token: Some("listenbrainz-secret".to_string()),
            ..Default::default()
        };
        let config = page_feature_config(&settings);

        assert!(!config.contains("lastfm-secret"));
        assert!(!config.contains("listenbrainz-secret"));
    }
}
