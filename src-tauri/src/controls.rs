use crate::{
    adblock::{self, AdBlockController},
    platform,
    presence::{PresenceController, TrackMetadata},
    settings::{self, SharedSettings},
    updates,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{
    menu::{
        CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder,
        PredefinedMenuItem, SubmenuBuilder,
    },
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const PREVIOUS_ID: &str = "previous";
const PLAY_PAUSE_ID: &str = "play_pause";
const NEXT_ID: &str = "next";
const RELOAD_ID: &str = "reload";
const ZOOM_IN_ID: &str = "zoom_in";
const ZOOM_OUT_ID: &str = "zoom_out";
const ZOOM_RESET_ID: &str = "zoom_reset";
const DISCORD_RPC_ID: &str = "discord_rpc";
const DISCORD_STATUS_ID: &str = "discord_status";
const AD_BLOCK_ID: &str = "ad_block";
const AD_BLOCK_STATUS_ID: &str = "ad_block_status";
const CLOSE_TO_TRAY_ID: &str = "close_to_tray";
const STARTUP_ID: &str = "startup";
const START_MINIMIZED_ID: &str = "start_minimized";
const CLEAR_CACHE_ID: &str = "clear_cache";
const RESET_SESSION_ID: &str = "reset_session";
const CHECK_UPDATES_ID: &str = "check_updates";
const TRAY_SHOW_ID: &str = "tray_show";
const TRAY_QUIT_ID: &str = "tray_quit";
const SYNCED_LYRICS_ID: &str = "feature_synced_lyrics";
const LASTFM_SCROBBLING_ID: &str = "feature_lastfm_scrobbling";
const LISTENBRAINZ_SCROBBLING_ID: &str = "feature_listenbrainz_scrobbling";
const NOTIFICATIONS_ID: &str = "feature_notifications";
const WINDOWS_MEDIA_CONTROLS_ID: &str = "feature_windows_media_controls";
const CUSTOM_OUTPUT_DEVICE_ID: &str = "feature_custom_output_device";
const EQUALIZER_ID: &str = "feature_equalizer";
const PRECISE_VOLUME_ID: &str = "feature_precise_volume";
const EXPONENTIAL_VOLUME_ID: &str = "feature_exponential_volume";
const NAVIGATION_CONTROLS_ID: &str = "feature_navigation_controls";
const PLAYBACK_SPEED_ID: &str = "feature_playback_speed";
const SKIP_DISLIKED_ID: &str = "feature_skip_disliked";
const ALBUM_COLOR_THEME_ID: &str = "feature_album_color_theme";
const LOCAL_SHORTCUTS: [(&str, &str); 5] = [
    ("Ctrl+R", RELOAD_ID),
    ("Ctrl+=", ZOOM_IN_ID),
    ("Ctrl+-", ZOOM_OUT_ID),
    ("Ctrl+0", ZOOM_RESET_ID),
    ("Ctrl+Shift+Delete", RESET_SESSION_ID),
];
const MAX_NOW_PLAYING_CHARS: usize = 72;
const MAX_TRAY_TOOLTIP_CHARS: usize = 120;

#[derive(Clone)]
pub struct AppState {
    pub settings: SharedSettings,
    pub presence: PresenceController,
    pub adblock: AdBlockController,
    pub quitting: Arc<AtomicBool>,
}

#[derive(Clone)]
struct ShellUi {
    tray: TrayIcon<tauri::Wry>,
    now_playing: MenuItem<tauri::Wry>,
    play_pause: MenuItem<tauri::Wry>,
    discord: CheckMenuItem<tauri::Wry>,
    ad_block: CheckMenuItem<tauri::Wry>,
    close_to_tray: CheckMenuItem<tauri::Wry>,
    startup: CheckMenuItem<tauri::Wry>,
    start_minimized: CheckMenuItem<tauri::Wry>,
    feature_items: HashMap<&'static str, CheckMenuItem<tauri::Wry>>,
}

pub fn install(app: &mut App, state: AppState) -> tauri::Result<()> {
    let initial = settings::snapshot(&state.settings);
    let shell = build_tray(app, &initial)?;
    set_local_shortcuts(app.handle(), true, &state);

    for (shortcut, action) in [
        ("Ctrl+Alt+A", PREVIOUS_ID),
        ("Ctrl+Alt+S", PLAY_PAUSE_ID),
        ("Ctrl+Alt+D", NEXT_ID),
    ] {
        if let Err(error) =
            app.global_shortcut()
                .on_shortcut(shortcut, move |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        media_action(app, action);
                    }
                })
        {
            platform::error(
                "Global Shortcut",
                &format!("{shortcut} could not be registered: {error}"),
            );
        }
    }

    let state_for_menu = state.clone();
    let shell_for_menu = shell.clone();
    app.on_menu_event(move |app, event| {
        handle_menu_event(app, event.id().0.as_str(), &state_for_menu, &shell_for_menu);
    });

    app.on_tray_icon_event(|tray, event| {
        if matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            }
        ) {
            toggle_main_window(tray.app_handle());
        }
    });

    app.manage(shell);
    Ok(())
}

pub fn set_local_shortcuts(app: &AppHandle, focused: bool, state: &AppState) {
    for (shortcut, action) in LOCAL_SHORTCUTS {
        if focused {
            if app.global_shortcut().is_registered(shortcut) {
                continue;
            }
            let state = state.clone();
            if let Err(error) =
                app.global_shortcut()
                    .on_shortcut(shortcut, move |app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            handle_local_shortcut(app, action, &state);
                        }
                    })
            {
                platform::error(
                    "Shortcut",
                    &format!("{shortcut} could not be registered: {error}"),
                );
            }
        } else if app.global_shortcut().is_registered(shortcut) {
            let _ = app.global_shortcut().unregister(shortcut);
        }
    }
}

fn build_tray(app: &App, initial: &settings::Settings) -> tauri::Result<ShellUi> {
    let now_playing = MenuItemBuilder::with_id("now_playing", "Nothing playing")
        .enabled(false)
        .build(app)?;
    let show = MenuItemBuilder::with_id(TRAY_SHOW_ID, "Show YouTube Music").build(app)?;

    let previous = MenuItemBuilder::with_id(PREVIOUS_ID, "Previous").build(app)?;
    let play_pause = MenuItemBuilder::with_id(PLAY_PAUSE_ID, "Play/Pause").build(app)?;
    let next = MenuItemBuilder::with_id(NEXT_ID, "Next").build(app)?;
    let playback = SubmenuBuilder::new(app, "Playback")
        .item(&previous)
        .item(&play_pause)
        .item(&next)
        .build()?;

    let reload = MenuItemBuilder::with_id(RELOAD_ID, "Reload").build(app)?;
    let zoom_in = MenuItemBuilder::with_id(ZOOM_IN_ID, "Zoom In").build(app)?;
    let zoom_out = MenuItemBuilder::with_id(ZOOM_OUT_ID, "Zoom Out").build(app)?;
    let zoom_reset = MenuItemBuilder::with_id(ZOOM_RESET_ID, "Actual Size").build(app)?;
    let view_separator = PredefinedMenuItem::separator(app)?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&reload)
        .item(&view_separator)
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .build()?;

    let discord = CheckMenuItemBuilder::with_id(DISCORD_RPC_ID, "Discord RPC")
        .checked(initial.discord_rpc)
        .build(app)?;
    let discord_status =
        MenuItemBuilder::with_id(DISCORD_STATUS_ID, "Discord RPC Status").build(app)?;
    let ad_block = CheckMenuItemBuilder::with_id(AD_BLOCK_ID, "Ad Blocking")
        .checked(initial.ad_block)
        .build(app)?;
    let ad_block_status =
        MenuItemBuilder::with_id(AD_BLOCK_STATUS_ID, "Ad-block Status").build(app)?;
    let close_to_tray = CheckMenuItemBuilder::with_id(CLOSE_TO_TRAY_ID, "Close to Tray")
        .checked(initial.close_to_tray)
        .build(app)?;
    let startup = CheckMenuItemBuilder::with_id(STARTUP_ID, "Launch at Startup")
        .checked(initial.launch_at_startup)
        .build(app)?;
    let start_minimized = CheckMenuItemBuilder::with_id(START_MINIMIZED_ID, "Start Minimized")
        .checked(initial.start_minimized)
        .enabled(initial.launch_at_startup)
        .build(app)?;
    let settings_separator_one = PredefinedMenuItem::separator(app)?;
    let settings_separator_two = PredefinedMenuItem::separator(app)?;
    let settings_menu = SubmenuBuilder::new(app, "Settings")
        .item(&discord)
        .item(&discord_status)
        .item(&settings_separator_one)
        .item(&ad_block)
        .item(&ad_block_status)
        .item(&settings_separator_two)
        .item(&close_to_tray)
        .item(&startup)
        .item(&start_minimized)
        .build()?;

    let synced_lyrics = feature_item(app, SYNCED_LYRICS_ID, "Synced Lyrics", initial.synced_lyrics)?;
    let lastfm = feature_item(
        app,
        LASTFM_SCROBBLING_ID,
        "Last.fm",
        initial.lastfm_scrobbling,
    )?;
    let listenbrainz = feature_item(
        app,
        LISTENBRAINZ_SCROBBLING_ID,
        "ListenBrainz",
        initial.listenbrainz_scrobbling,
    )?;
    let notifications = feature_item(app, NOTIFICATIONS_ID, "Notifications", initial.notifications)?;
    let windows_media = feature_item(
        app,
        WINDOWS_MEDIA_CONTROLS_ID,
        "Windows Media Controls",
        initial.windows_media_controls,
    )?;
    let output = feature_item(
        app,
        CUSTOM_OUTPUT_DEVICE_ID,
        "Custom Output Device",
        initial.custom_output_device,
    )?;
    let equalizer = feature_item(app, EQUALIZER_ID, "Equalizer", initial.equalizer)?;
    let precise_volume = feature_item(
        app,
        PRECISE_VOLUME_ID,
        "Precise Volume",
        initial.precise_volume,
    )?;
    let exponential_volume = feature_item(
        app,
        EXPONENTIAL_VOLUME_ID,
        "Exponential Volume",
        initial.exponential_volume,
    )?;
    let playback_speed = feature_item(
        app,
        PLAYBACK_SPEED_ID,
        "Playback Speed",
        initial.playback_speed,
    )?;
    let navigation = feature_item(
        app,
        NAVIGATION_CONTROLS_ID,
        "Navigation Controls",
        initial.navigation_controls,
    )?;
    let album_theme = feature_item(
        app,
        ALBUM_COLOR_THEME_ID,
        "Album Color Theme",
        initial.album_color_theme,
    )?;
    let skip_disliked = feature_item(
        app,
        SKIP_DISLIKED_ID,
        "Skip Disliked Songs",
        initial.skip_disliked,
    )?;

    let scrobbling = SubmenuBuilder::new(app, "Scrobbling")
        .item(&lastfm)
        .item(&listenbrainz)
        .build()?;
    let desktop = SubmenuBuilder::new(app, "Desktop")
        .item(&notifications)
        .item(&windows_media)
        .build()?;
    let audio = SubmenuBuilder::new(app, "Audio")
        .item(&output)
        .item(&equalizer)
        .item(&precise_volume)
        .item(&exponential_volume)
        .item(&playback_speed)
        .build()?;
    let interface = SubmenuBuilder::new(app, "Interface")
        .item(&navigation)
        .item(&album_theme)
        .build()?;
    let playback_features = SubmenuBuilder::new(app, "Playback")
        .item(&skip_disliked)
        .build()?;
    let features = SubmenuBuilder::new(app, "Features")
        .item(&synced_lyrics)
        .item(&scrobbling)
        .item(&desktop)
        .item(&audio)
        .item(&interface)
        .item(&playback_features)
        .build()?;

    let feature_items = HashMap::from([
        (SYNCED_LYRICS_ID, synced_lyrics),
        (LASTFM_SCROBBLING_ID, lastfm),
        (LISTENBRAINZ_SCROBBLING_ID, listenbrainz),
        (NOTIFICATIONS_ID, notifications),
        (WINDOWS_MEDIA_CONTROLS_ID, windows_media),
        (CUSTOM_OUTPUT_DEVICE_ID, output),
        (EQUALIZER_ID, equalizer),
        (PRECISE_VOLUME_ID, precise_volume),
        (EXPONENTIAL_VOLUME_ID, exponential_volume),
        (PLAYBACK_SPEED_ID, playback_speed),
        (NAVIGATION_CONTROLS_ID, navigation),
        (ALBUM_COLOR_THEME_ID, album_theme),
        (SKIP_DISLIKED_ID, skip_disliked),
    ]);

    let clear_cache =
        MenuItemBuilder::with_id(CLEAR_CACHE_ID, "Clear Cache and Reload").build(app)?;
    let reset_session = MenuItemBuilder::with_id(RESET_SESSION_ID, "Reset Session").build(app)?;
    let check_updates =
        MenuItemBuilder::with_id(CHECK_UPDATES_ID, "Check for Updates").build(app)?;
    let tools_separator = PredefinedMenuItem::separator(app)?;
    let tools = SubmenuBuilder::new(app, "Tools")
        .item(&clear_cache)
        .item(&reset_session)
        .item(&tools_separator)
        .item(&check_updates)
        .build()?;

    let quit = MenuItemBuilder::with_id(TRAY_QUIT_ID, "Quit").build(app)?;
    let separator_one = PredefinedMenuItem::separator(app)?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let menu = MenuBuilder::new(app)
        .item(&now_playing)
        .item(&show)
        .item(&separator_one)
        .item(&playback)
        .item(&view)
        .item(&settings_menu)
        .item(&features)
        .item(&tools)
        .item(&separator_two)
        .item(&quit)
        .build()?;

    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("YouTube Music");
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    let tray = tray.build(app)?;

    Ok(ShellUi {
        tray,
        now_playing,
        play_pause,
        discord,
        ad_block,
        close_to_tray,
        startup,
        start_minimized,
        feature_items,
    })
}

fn feature_item(
    app: &App,
    id: &'static str,
    label: &str,
    checked: bool,
) -> tauri::Result<CheckMenuItem<tauri::Wry>> {
    CheckMenuItemBuilder::with_id(id, label)
        .checked(checked)
        .build(app)
}

fn handle_menu_event(app: &AppHandle, id: &str, state: &AppState, shell: &ShellUi) {
    if handle_feature_event(app, id, state, shell) {
        return;
    }

    match id {
        PREVIOUS_ID | PLAY_PAUSE_ID | NEXT_ID => media_action(app, id),
        RELOAD_ID => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.reload();
            }
        }
        ZOOM_IN_ID => set_zoom(app, state, 0.1),
        ZOOM_OUT_ID => set_zoom(app, state, -0.1),
        ZOOM_RESET_ID => reset_zoom(app, state),
        DISCORD_RPC_ID => {
            let enabled = shell.discord.is_checked().unwrap_or(true);
            settings::update(&state.settings, |value| value.discord_rpc = enabled);
            state.presence.set_enabled(enabled);
        }
        DISCORD_STATUS_ID => platform::info("Discord RPC", &state.presence.status()),
        AD_BLOCK_ID => {
            let enabled = shell.ad_block.is_checked().unwrap_or(true);
            state.adblock.set_enabled(enabled);
            settings::update(&state.settings, |value| value.ad_block = enabled);
            eval_main(
                app,
                &format!("window.__ytMusicTauriAdBlockEnabled = {enabled}; location.reload();"),
            );
        }
        AD_BLOCK_STATUS_ID => platform::info(
            "Ad Blocking",
            &format!(
                "{}\nBlocked requests this session: {}",
                if settings::snapshot(&state.settings).ad_block {
                    "Enabled"
                } else {
                    "Disabled"
                },
                state.adblock.blocked_requests()
            ),
        ),
        CLOSE_TO_TRAY_ID => {
            let enabled = shell.close_to_tray.is_checked().unwrap_or(false);
            settings::update(&state.settings, |value| value.close_to_tray = enabled);
        }
        STARTUP_ID => set_startup(state, shell),
        START_MINIMIZED_ID => set_start_minimized(state, shell),
        CLEAR_CACHE_ID => clear_cache(app),
        RESET_SESSION_ID => reset_session(app, state),
        CHECK_UPDATES_ID => updates::check_in_background(false),
        TRAY_SHOW_ID => show_main_window(app),
        TRAY_QUIT_ID => {
            state.quitting.store(true, Ordering::Relaxed);
            state.presence.clear();
            app.exit(0);
        }
        _ => {}
    }
}

fn handle_feature_event(app: &AppHandle, id: &str, state: &AppState, shell: &ShellUi) -> bool {
    let Some(item) = shell.feature_items.get(id) else {
        return false;
    };
    let enabled = item.is_checked().unwrap_or(false);

    settings::update(&state.settings, |value| match id {
        SYNCED_LYRICS_ID => value.synced_lyrics = enabled,
        LASTFM_SCROBBLING_ID => value.lastfm_scrobbling = enabled,
        LISTENBRAINZ_SCROBBLING_ID => value.listenbrainz_scrobbling = enabled,
        NOTIFICATIONS_ID => value.notifications = enabled,
        WINDOWS_MEDIA_CONTROLS_ID => value.windows_media_controls = enabled,
        CUSTOM_OUTPUT_DEVICE_ID => value.custom_output_device = enabled,
        EQUALIZER_ID => value.equalizer = enabled,
        PRECISE_VOLUME_ID => value.precise_volume = enabled,
        EXPONENTIAL_VOLUME_ID => value.exponential_volume = enabled,
        NAVIGATION_CONTROLS_ID => value.navigation_controls = enabled,
        PLAYBACK_SPEED_ID => value.playback_speed = enabled,
        SKIP_DISLIKED_ID => value.skip_disliked = enabled,
        ALBUM_COLOR_THEME_ID => value.album_color_theme = enabled,
        _ => {}
    });
    sync_page_features(app, state);
    true
}

fn sync_page_features(app: &AppHandle, state: &AppState) {
    let config = crate::page_feature_config(&settings::snapshot(&state.settings));
    eval_main(
        app,
        &format!(
            "window.__ytmFeatureConfig = {config}; window.__ytmFeatures?.configure(window.__ytmFeatureConfig);"
        ),
    );
}

fn handle_local_shortcut(app: &AppHandle, action: &str, state: &AppState) {
    match action {
        RELOAD_ID => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.reload();
            }
        }
        ZOOM_IN_ID => set_zoom(app, state, 0.1),
        ZOOM_OUT_ID => set_zoom(app, state, -0.1),
        ZOOM_RESET_ID => reset_zoom(app, state),
        RESET_SESSION_ID => reset_session(app, state),
        _ => {}
    }
}

fn set_startup(state: &AppState, shell: &ShellUi) {
    let enabled = shell.startup.is_checked().unwrap_or(false);
    let minimized = shell.start_minimized.is_checked().unwrap_or(false);

    match platform::set_startup_enabled(enabled, minimized) {
        Ok(()) => {
            let _ = shell.start_minimized.set_enabled(enabled);
            settings::update(&state.settings, |value| {
                value.launch_at_startup = enabled;
                value.start_minimized = minimized;
            });
        }
        Err(error) => {
            let _ = shell.startup.set_checked(!enabled);
            platform::error("Launch at Startup", &error.to_string());
        }
    }
}

fn set_start_minimized(state: &AppState, shell: &ShellUi) {
    let minimized = shell.start_minimized.is_checked().unwrap_or(false);
    let enabled = shell.startup.is_checked().unwrap_or(false);

    if let Err(error) = platform::set_startup_enabled(enabled, minimized) {
        let _ = shell.start_minimized.set_checked(!minimized);
        platform::error("Launch at Startup", &error.to_string());
        return;
    }

    settings::update(&state.settings, |value| value.start_minimized = minimized);
}

fn set_zoom(app: &AppHandle, state: &AppState, delta: f64) {
    let current = settings::snapshot(&state.settings).zoom;
    apply_zoom(app, state, (current + delta).clamp(0.5, 2.0));
}

fn reset_zoom(app: &AppHandle, state: &AppState) {
    apply_zoom(app, state, 1.0);
}

fn apply_zoom(app: &AppHandle, state: &AppState, zoom: f64) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_zoom(zoom);
        settings::update(&state.settings, |value| value.zoom = zoom);
    }
}

fn clear_cache(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let reload = window.clone();
        let _ = window.with_webview(move |webview| {
            adblock::clear_cache(webview, move || {
                let _ = reload.reload();
            });
        });
    }
}

fn reset_session(app: &AppHandle, state: &AppState) {
    if !platform::confirm(
        "Reset YouTube Music Session",
        "This signs out of YouTube Music and clears all site data. Continue?",
    ) {
        return;
    }

    state.presence.clear();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.clear_all_browsing_data();
        let _ = window.navigate(
            "https://music.youtube.com"
                .parse()
                .expect("static YouTube Music URL"),
        );
    }
}

fn eval_main(app: &AppHandle, script: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(script);
    }
}

fn media_action(app: &AppHandle, action: &str) {
    let script = match action {
        PREVIOUS_ID => {
            "(() => { const button = document.querySelector('ytmusic-player-bar #previous-button, ytmusic-player-bar #previous-song-button, ytmusic-player-bar .previous-button, ytmusic-player-bar [aria-label^=\"Previous\"]'); if (button) button.click(); else { const media = document.querySelector('video, audio'); if (media) media.currentTime = 0; } })();"
        }
        PLAY_PAUSE_ID => {
            "(() => { const media = document.querySelector('video, audio'); if (media) media.paused ? media.play() : media.pause(); else document.querySelector('ytmusic-player-bar #play-pause-button, ytmusic-player-bar .play-pause-button')?.click(); })();"
        }
        NEXT_ID => {
            "(() => { const button = document.querySelector('ytmusic-player-bar #next-button, ytmusic-player-bar #next-song-button, ytmusic-player-bar .next-button, ytmusic-player-bar [aria-label^=\"Next\"]'); if (button) button.click(); else { const media = document.querySelector('video, audio'); if (media && Number.isFinite(media.duration)) media.currentTime = media.duration; } })();"
        }
        _ => return,
    };
    eval_main(app, script);
}

pub fn update_now_playing(app: &AppHandle, track: Option<&TrackMetadata>) {
    let Some(shell) = app.try_state::<ShellUi>() else {
        return;
    };

    match track {
        Some(track) => {
            let label = now_playing_label(track);
            let tooltip = tray_tooltip(track);
            let _ = shell.now_playing.set_text(label);
            let _ = shell
                .play_pause
                .set_text(if track.playing { "Pause" } else { "Play" });
            let _ = shell.tray.set_tooltip(Some(tooltip));
        }
        None => {
            let _ = shell.now_playing.set_text("Nothing playing");
            let _ = shell.play_pause.set_text("Play/Pause");
            let _ = shell.tray.set_tooltip(Some("YouTube Music"));
        }
    }
}

fn now_playing_label(track: &TrackMetadata) -> String {
    let label = match track
        .artist
        .as_deref()
        .filter(|artist| !artist.trim().is_empty())
    {
        Some(artist) => format!("{} - {artist}", track.title),
        None => track.title.clone(),
    };
    truncate_chars(&label, MAX_NOW_PLAYING_CHARS)
}

fn tray_tooltip(track: &TrackMetadata) -> String {
    truncate_chars(
        &format!("YouTube Music\n{}", now_playing_label(track)),
        MAX_TRAY_TOOLTIP_CHARS,
    )
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    let mut shortened: String = value.chars().take(max_chars.saturating_sub(3)).collect();
    shortened.push_str("...");
    shortened
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(title: &str, artist: Option<&str>, playing: bool) -> TrackMetadata {
        TrackMetadata {
            title: title.to_string(),
            artist: artist.map(str::to_string),
            album: None,
            playing,
            url: None,
            cover_url: None,
            elapsed_seconds: None,
            duration_seconds: None,
        }
    }

    #[test]
    fn now_playing_includes_artist_when_available() {
        assert_eq!(
            now_playing_label(&track("Young Dumb & Broke", Some("Khalid"), true)),
            "Young Dumb & Broke - Khalid"
        );
        assert_eq!(
            now_playing_label(&track("Instrumental", None, false)),
            "Instrumental"
        );
    }

    #[test]
    fn tray_text_is_bounded() {
        let long = "x".repeat(200);
        let track = track(&long, Some("Artist"), true);

        assert!(now_playing_label(&track).chars().count() <= MAX_NOW_PLAYING_CHARS);
        assert!(tray_tooltip(&track).chars().count() <= MAX_TRAY_TOOLTIP_CHARS);
    }
}
