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
const LYRICS_TIMECODES_ID: &str = "feature_lyrics_timecodes";
const LYRICS_PRECISE_TIMING_ID: &str = "feature_lyrics_precise_timing";
const LYRICS_ROMANIZATION_ID: &str = "feature_lyrics_romanization";
const LYRICS_AUTO_SYNC_ID: &str = "feature_lyrics_auto_sync";
const LYRICS_EFFECT_CINEMATIC_ID: &str = "feature_lyrics_effect_cinematic";
const LYRICS_EFFECT_STUDIO_ID: &str = "feature_lyrics_effect_studio";
const LYRICS_EFFECT_LUMINESCENT_ID: &str = "feature_lyrics_effect_luminescent";
const LYRICS_EFFECT_FANCY_ID: &str = "feature_lyrics_effect_fancy";
const LYRICS_EFFECT_SCALE_ID: &str = "feature_lyrics_effect_scale";
const LYRICS_EFFECT_OFFSET_ID: &str = "feature_lyrics_effect_offset";
const LYRICS_EFFECT_FOCUS_ID: &str = "feature_lyrics_effect_focus";
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
const SPONSORBLOCK_ID: &str = "feature_sponsorblock";
const BLUR_NAV_BAR_ID: &str = "feature_blur_nav_bar";
const DISABLE_AUTOPLAY_ID: &str = "feature_disable_autoplay";
const VIDEO_TOGGLE_ID: &str = "feature_video_toggle";
const AMBIENT_MODE_ID: &str = "feature_ambient_mode";
const CROSSFADE_ID: &str = "feature_crossfade";
const DEVTOOLS_ID: &str = "tools_devtools";
const LOCAL_SHORTCUTS: [(&str, &str); 7] = [
    ("Ctrl+R", RELOAD_ID),
    ("Ctrl+=", ZOOM_IN_ID),
    ("Ctrl+-", ZOOM_OUT_ID),
    ("Ctrl+0", ZOOM_RESET_ID),
    ("Ctrl+Shift+Delete", RESET_SESSION_ID),
    ("F12", DEVTOOLS_ID),
    ("Ctrl+Shift+I", DEVTOOLS_ID),
];
const MAX_NOW_PLAYING_CHARS: usize = 72;
const MAX_TRAY_TOOLTIP_CHARS: usize = 120;

#[derive(Clone)]
pub struct AppState {
    pub settings: SharedSettings,
    pub presence: PresenceController,
    pub adblock: AdBlockController,
    pub spotify: crate::spotify::SpotifyController,
    pub transfer: crate::transfer::TransferController,
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
        let _ = app
            .global_shortcut()
            .on_shortcut(shortcut, move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    media_action(app, action);
                }
            });
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
            let _ = app
                .global_shortcut()
                .on_shortcut(shortcut, move |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        handle_local_shortcut(app, action, &state);
                    }
                });
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

    let synced_lyrics = feature_item(
        app,
        SYNCED_LYRICS_ID,
        "Enable Synced Lyrics",
        initial.synced_lyrics,
    )?;
    let lyrics_timecodes = feature_item(
        app,
        LYRICS_TIMECODES_ID,
        "Show Timecodes",
        initial.lyrics_show_timecodes,
    )?;
    let lyrics_precise = feature_item(
        app,
        LYRICS_PRECISE_TIMING_ID,
        "Precise Timing (100ms)",
        initial.lyrics_precise_timing,
    )?;
    let lyrics_romanization = feature_item(
        app,
        LYRICS_ROMANIZATION_ID,
        "Romanization (Romaji)",
        initial.lyrics_romanization,
    )?;
    let lyrics_auto_sync = feature_item(
        app,
        LYRICS_AUTO_SYNC_ID,
        "Auto Sync Lyrics after 3 Seconds",
        initial.lyrics_auto_sync,
    )?;
    let effect_cinematic = feature_item(
        app,
        LYRICS_EFFECT_CINEMATIC_ID,
        "Cinematic (Depth & Blur)",
        initial.lyrics_line_effect == "cinematic",
    )?;
    let effect_studio = feature_item(
        app,
        LYRICS_EFFECT_STUDIO_ID,
        "Studio (High-Contrast)",
        initial.lyrics_line_effect == "studio",
    )?;
    let effect_luminescent = feature_item(
        app,
        LYRICS_EFFECT_LUMINESCENT_ID,
        "Luminescent (Ambient Shimmer)",
        initial.lyrics_line_effect == "luminescent",
    )?;
    let effect_fancy = feature_item(
        app,
        LYRICS_EFFECT_FANCY_ID,
        "Fancy (Glow & Wobble)",
        initial.lyrics_line_effect == "fancy",
    )?;
    let effect_scale = feature_item(
        app,
        LYRICS_EFFECT_SCALE_ID,
        "Scale (Active Focus)",
        initial.lyrics_line_effect == "scale",
    )?;
    let effect_offset = feature_item(
        app,
        LYRICS_EFFECT_OFFSET_ID,
        "Offset (Indented)",
        initial.lyrics_line_effect == "offset",
    )?;
    let effect_focus = feature_item(
        app,
        LYRICS_EFFECT_FOCUS_ID,
        "Focus (Clean Opacity)",
        initial.lyrics_line_effect == "focus",
    )?;
    let effect_menu = SubmenuBuilder::new(app, "Line Animation Effect")
        .item(&effect_cinematic)
        .item(&effect_studio)
        .item(&effect_luminescent)
        .item(&effect_fancy)
        .item(&effect_scale)
        .item(&effect_offset)
        .item(&effect_focus)
        .build()?;

    let lyrics_sep = PredefinedMenuItem::separator(app)?;
    let lyrics_menu = SubmenuBuilder::new(app, "Synced Lyrics")
        .item(&synced_lyrics)
        .item(&lyrics_sep)
        .item(&lyrics_timecodes)
        .item(&lyrics_precise)
        .item(&lyrics_romanization)
        .item(&lyrics_auto_sync)
        .item(&effect_menu)
        .build()?;

    let lastfm = feature_item(
        app,
        LASTFM_SCROBBLING_ID,
        "Last.fm Scrobbler",
        initial.lastfm_scrobbling,
    )?;
    let listenbrainz = feature_item(
        app,
        LISTENBRAINZ_SCROBBLING_ID,
        "ListenBrainz Scrobbler",
        initial.listenbrainz_scrobbling,
    )?;
    let scrobbling = SubmenuBuilder::new(app, "Scrobbling")
        .item(&lastfm)
        .item(&listenbrainz)
        .build()?;

    let notifications = feature_item(
        app,
        NOTIFICATIONS_ID,
        "Track Notifications",
        initial.notifications,
    )?;
    let windows_media = feature_item(
        app,
        WINDOWS_MEDIA_CONTROLS_ID,
        "Taskbar Media Controls",
        initial.windows_media_controls,
    )?;
    let desktop = SubmenuBuilder::new(app, "Desktop Integration")
        .item(&windows_media)
        .item(&notifications)
        .build()?;

    let equalizer = feature_item(app, EQUALIZER_ID, "10-Band Equalizer", initial.equalizer)?;
    let precise_volume = feature_item(
        app,
        PRECISE_VOLUME_ID,
        "Precise Volume Steps",
        initial.precise_volume,
    )?;
    let exponential_volume = feature_item(
        app,
        EXPONENTIAL_VOLUME_ID,
        "Exponential Volume Curve",
        initial.exponential_volume,
    )?;
    let output = feature_item(
        app,
        CUSTOM_OUTPUT_DEVICE_ID,
        "Custom Output Device",
        initial.custom_output_device,
    )?;
    let audio_sep = PredefinedMenuItem::separator(app)?;
    let audio = SubmenuBuilder::new(app, "Audio & Sound")
        .item(&equalizer)
        .item(&audio_sep)
        .item(&precise_volume)
        .item(&exponential_volume)
        .item(&output)
        .build()?;

    let sponsorblock = feature_item(
        app,
        SPONSORBLOCK_ID,
        "SponsorBlock (Skip Intros/Non-Music)",
        initial.sponsorblock,
    )?;
    let disable_autoplay = feature_item(
        app,
        DISABLE_AUTOPLAY_ID,
        "Disable Autoplay After Queue",
        initial.disable_autoplay,
    )?;
    let video_toggle = feature_item(
        app,
        VIDEO_TOGGLE_ID,
        "Audio-Only Mode (HQ Album Art)",
        initial.video_toggle,
    )?;
    let skip_disliked = feature_item(
        app,
        SKIP_DISLIKED_ID,
        "Skip Disliked Songs",
        initial.skip_disliked,
    )?;
    let playback_speed = feature_item(
        app,
        PLAYBACK_SPEED_ID,
        "Playback Speed Slider",
        initial.playback_speed,
    )?;
    let crossfade = feature_item(
        app,
        CROSSFADE_ID,
        "Smooth Track Crossfade",
        initial.crossfade,
    )?;
    let smart_playback = SubmenuBuilder::new(app, "Smart Playback")
        .item(&sponsorblock)
        .item(&crossfade)
        .item(&skip_disliked)
        .item(&disable_autoplay)
        .item(&video_toggle)
        .item(&playback_speed)
        .build()?;

    let ambient_mode = feature_item(
        app,
        AMBIENT_MODE_ID,
        "Ambient Glow Aura",
        initial.ambient_mode,
    )?;
    let blur_nav_bar = feature_item(
        app,
        BLUR_NAV_BAR_ID,
        "Blur Navigation Bar",
        initial.blur_nav_bar,
    )?;
    let navigation = feature_item(
        app,
        NAVIGATION_CONTROLS_ID,
        "In-App Navigation Buttons",
        initial.navigation_controls,
    )?;
    let appearance = SubmenuBuilder::new(app, "Appearance & UI")
        .item(&ambient_mode)
        .item(&blur_nav_bar)
        .item(&navigation)
        .build()?;

    let features = SubmenuBuilder::new(app, "Features")
        .item(&lyrics_menu)
        .item(&smart_playback)
        .item(&audio)
        .item(&appearance)
        .item(&scrobbling)
        .item(&desktop)
        .build()?;

    let feature_items = HashMap::from([
        (SYNCED_LYRICS_ID, synced_lyrics),
        (LYRICS_TIMECODES_ID, lyrics_timecodes),
        (LYRICS_PRECISE_TIMING_ID, lyrics_precise),
        (LYRICS_ROMANIZATION_ID, lyrics_romanization),
        (LYRICS_AUTO_SYNC_ID, lyrics_auto_sync),
        (LYRICS_EFFECT_CINEMATIC_ID, effect_cinematic),
        (LYRICS_EFFECT_STUDIO_ID, effect_studio),
        (LYRICS_EFFECT_LUMINESCENT_ID, effect_luminescent),
        (LYRICS_EFFECT_FANCY_ID, effect_fancy),
        (LYRICS_EFFECT_SCALE_ID, effect_scale),
        (LYRICS_EFFECT_OFFSET_ID, effect_offset),
        (LYRICS_EFFECT_FOCUS_ID, effect_focus),
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
        (SKIP_DISLIKED_ID, skip_disliked),
        (SPONSORBLOCK_ID, sponsorblock),
        (BLUR_NAV_BAR_ID, blur_nav_bar),
        (DISABLE_AUTOPLAY_ID, disable_autoplay),
        (VIDEO_TOGGLE_ID, video_toggle),
        (AMBIENT_MODE_ID, ambient_mode),
        (CROSSFADE_ID, crossfade),
    ]);

    let clear_cache =
        MenuItemBuilder::with_id(CLEAR_CACHE_ID, "Clear Cache and Reload").build(app)?;
    let reset_session = MenuItemBuilder::with_id(RESET_SESSION_ID, "Reset Session").build(app)?;
    let devtools = MenuItemBuilder::with_id(DEVTOOLS_ID, "Developer Tools (F12)").build(app)?;
    let check_updates =
        MenuItemBuilder::with_id(CHECK_UPDATES_ID, "Check for Updates").build(app)?;
    let tools_separator = PredefinedMenuItem::separator(app)?;
    let tools = SubmenuBuilder::new(app, "Tools")
        .item(&clear_cache)
        .item(&reset_session)
        .item(&devtools)
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
            let mut enabled = false;
            settings::update(&state.settings, |value| {
                value.discord_rpc = !value.discord_rpc;
                enabled = value.discord_rpc;
            });
            let _ = shell.discord.set_checked(enabled);
            state.presence.set_enabled(enabled);
        }
        DISCORD_STATUS_ID => platform::info("Discord RPC", &state.presence.status()),
        AD_BLOCK_ID => {
            let mut enabled = false;
            settings::update(&state.settings, |value| {
                value.ad_block = !value.ad_block;
                enabled = value.ad_block;
            });
            let _ = shell.ad_block.set_checked(enabled);
            state.adblock.set_enabled(enabled);
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
            let mut enabled = false;
            settings::update(&state.settings, |value| {
                value.close_to_tray = !value.close_to_tray;
                enabled = value.close_to_tray;
            });
            let _ = shell.close_to_tray.set_checked(enabled);
        }
        STARTUP_ID => set_startup(state, shell),
        START_MINIMIZED_ID => set_start_minimized(state, shell),
        CLEAR_CACHE_ID => clear_cache(app),
        RESET_SESSION_ID => reset_session(app, state),
        DEVTOOLS_ID => {
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }
        }
        CHECK_UPDATES_ID => updates::check(app, &state.settings, updates::CheckMode::Manual),
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

    let mut is_now_enabled = false;
    settings::update(&state.settings, |value| match id {
        SYNCED_LYRICS_ID => {
            value.synced_lyrics = !value.synced_lyrics;
            is_now_enabled = value.synced_lyrics;
        }
        LYRICS_TIMECODES_ID => {
            value.lyrics_show_timecodes = !value.lyrics_show_timecodes;
            is_now_enabled = value.lyrics_show_timecodes;
        }
        LYRICS_PRECISE_TIMING_ID => {
            value.lyrics_precise_timing = !value.lyrics_precise_timing;
            is_now_enabled = value.lyrics_precise_timing;
        }
        LYRICS_ROMANIZATION_ID => {
            value.lyrics_romanization = !value.lyrics_romanization;
            is_now_enabled = value.lyrics_romanization;
        }
        LYRICS_AUTO_SYNC_ID => {
            value.lyrics_auto_sync = !value.lyrics_auto_sync;
            is_now_enabled = value.lyrics_auto_sync;
        }
        LYRICS_EFFECT_CINEMATIC_ID => {
            value.lyrics_line_effect = "cinematic".to_string();
            is_now_enabled = true;
        }
        LYRICS_EFFECT_STUDIO_ID => {
            value.lyrics_line_effect = "studio".to_string();
            is_now_enabled = true;
        }
        LYRICS_EFFECT_LUMINESCENT_ID => {
            value.lyrics_line_effect = "luminescent".to_string();
            is_now_enabled = true;
        }
        LYRICS_EFFECT_FANCY_ID => {
            value.lyrics_line_effect = "fancy".to_string();
            is_now_enabled = true;
        }
        LYRICS_EFFECT_SCALE_ID => {
            value.lyrics_line_effect = "scale".to_string();
            is_now_enabled = true;
        }
        LYRICS_EFFECT_OFFSET_ID => {
            value.lyrics_line_effect = "offset".to_string();
            is_now_enabled = true;
        }
        LYRICS_EFFECT_FOCUS_ID => {
            value.lyrics_line_effect = "focus".to_string();
            is_now_enabled = true;
        }
        LASTFM_SCROBBLING_ID => {
            value.lastfm_scrobbling = !value.lastfm_scrobbling;
            is_now_enabled = value.lastfm_scrobbling;
        }
        LISTENBRAINZ_SCROBBLING_ID => {
            value.listenbrainz_scrobbling = !value.listenbrainz_scrobbling;
            is_now_enabled = value.listenbrainz_scrobbling;
        }
        NOTIFICATIONS_ID => {
            value.notifications = !value.notifications;
            is_now_enabled = value.notifications;
        }
        WINDOWS_MEDIA_CONTROLS_ID => {
            value.windows_media_controls = !value.windows_media_controls;
            is_now_enabled = value.windows_media_controls;
        }
        CUSTOM_OUTPUT_DEVICE_ID => {
            value.custom_output_device = !value.custom_output_device;
            is_now_enabled = value.custom_output_device;
        }
        EQUALIZER_ID => {
            value.equalizer = !value.equalizer;
            is_now_enabled = value.equalizer;
        }
        PRECISE_VOLUME_ID => {
            value.precise_volume = !value.precise_volume;
            is_now_enabled = value.precise_volume;
        }
        EXPONENTIAL_VOLUME_ID => {
            value.exponential_volume = !value.exponential_volume;
            is_now_enabled = value.exponential_volume;
        }
        NAVIGATION_CONTROLS_ID => {
            value.navigation_controls = !value.navigation_controls;
            is_now_enabled = value.navigation_controls;
        }
        PLAYBACK_SPEED_ID => {
            value.playback_speed = !value.playback_speed;
            is_now_enabled = value.playback_speed;
        }
        SKIP_DISLIKED_ID => {
            value.skip_disliked = !value.skip_disliked;
            is_now_enabled = value.skip_disliked;
        }
        SPONSORBLOCK_ID => {
            value.sponsorblock = !value.sponsorblock;
            is_now_enabled = value.sponsorblock;
        }
        BLUR_NAV_BAR_ID => {
            value.blur_nav_bar = !value.blur_nav_bar;
            is_now_enabled = value.blur_nav_bar;
        }
        DISABLE_AUTOPLAY_ID => {
            value.disable_autoplay = !value.disable_autoplay;
            is_now_enabled = value.disable_autoplay;
        }
        VIDEO_TOGGLE_ID => {
            value.video_toggle = !value.video_toggle;
            is_now_enabled = value.video_toggle;
        }
        AMBIENT_MODE_ID => {
            value.ambient_mode = !value.ambient_mode;
            is_now_enabled = value.ambient_mode;
        }
        CROSSFADE_ID => {
            value.crossfade = !value.crossfade;
            is_now_enabled = value.crossfade;
        }
        _ => {}
    });

    if id.starts_with("feature_lyrics_effect_") {
        sync_tray_effects(app, state);
    } else {
        let _ = item.set_checked(is_now_enabled);
    }
    if id == WINDOWS_MEDIA_CONTROLS_ID {
        crate::windows_media::refresh(app);
    }
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

pub fn sync_tray_effects(app: &AppHandle, state: &AppState) {
    let Some(shell) = app.try_state::<ShellUi>() else {
        return;
    };
    let current_effect = settings::snapshot(&state.settings).lyrics_line_effect;
    for (id, val) in [
        (LYRICS_EFFECT_CINEMATIC_ID, "cinematic"),
        (LYRICS_EFFECT_STUDIO_ID, "studio"),
        (LYRICS_EFFECT_LUMINESCENT_ID, "luminescent"),
        (LYRICS_EFFECT_FANCY_ID, "fancy"),
        (LYRICS_EFFECT_SCALE_ID, "scale"),
        (LYRICS_EFFECT_OFFSET_ID, "offset"),
        (LYRICS_EFFECT_FOCUS_ID, "focus"),
    ] {
        if let Some(it) = shell.feature_items.get(id) {
            let _ = it.set_checked(current_effect == val);
        }
    }
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
        DEVTOOLS_ID => {
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }
        }
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

pub fn set_zoom(app: &AppHandle, state: &AppState, delta: f64) {
    let current = settings::snapshot(&state.settings).zoom;
    apply_zoom(app, state, (current + delta).clamp(0.5, 2.0));
}

pub fn reset_zoom(app: &AppHandle, state: &AppState) {
    apply_zoom(app, state, 1.0);
}

fn apply_zoom(app: &AppHandle, state: &AppState, zoom: f64) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_zoom(zoom);
        settings::update(&state.settings, |value| value.zoom = zoom);
    }
}

pub fn clear_cache(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let reload = window.clone();
        let _ = window.with_webview(move |webview| {
            adblock::clear_cache(webview, move || {
                let _ = reload.reload();
            });
        });
    }
}

pub fn reset_session(app: &AppHandle, state: &AppState) {
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
