use crate::{presence::TrackMetadata, settings, settings::SharedSettings};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, WebviewWindow};
use windows::{
    core::Result as WindowsResult,
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
        UI::{
            Shell::{
                DefSubclassProc, SetWindowSubclass, ITaskbarList3, TaskbarList, THBF_ENABLED,
                THBF_HIDDEN, THBN_CLICKED, THB_FLAGS, THB_ICON, THB_TOOLTIP, THUMBBUTTON,
            },
            WindowsAndMessaging::{CreateIcon, HICON, WM_COMMAND},
        },
    },
};

const SUBCLASS_ID: usize = 0x5954_4D54;
const PREVIOUS_BUTTON: u32 = 0x5001;
const PLAY_PAUSE_BUTTON: u32 = 0x5002;
const NEXT_BUTTON: u32 = 0x5003;

static APP: OnceLock<AppHandle> = OnceLock::new();
static SETTINGS: OnceLock<SharedSettings> = OnceLock::new();

pub fn install(window: &WebviewWindow, settings: SharedSettings) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let _ = APP.set(window.app_handle().clone());
    let _ = SETTINGS.set(settings);

    unsafe {
        let _ = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0);
    }
    update_buttons(hwnd, None);
}

pub fn update(window: &WebviewWindow, track: Option<&TrackMetadata>) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    update_buttons(hwnd, track);
}

pub fn refresh(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    update_buttons(hwnd, None);
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> LRESULT {
    if message == WM_COMMAND {
        let notification = ((wparam.0 >> 16) & 0xffff) as u32;
        let button_id = (wparam.0 & 0xffff) as u32;
        if notification == THBN_CLICKED {
            if let Some(app) = APP.get() {
                match button_id {
                    PREVIOUS_BUTTON => media_action(app, "previous"),
                    PLAY_PAUSE_BUTTON => media_action(app, "play_pause"),
                    NEXT_BUTTON => media_action(app, "next"),
                    _ => {}
                }
            }
            return LRESULT(0);
        }
    }

    DefSubclassProc(hwnd, message, wparam, lparam)
}

fn media_action(app: &AppHandle, action: &str) {
    let script = match action {
        "previous" => {
            "(() => { const button = document.querySelector('ytmusic-player-bar #previous-button, ytmusic-player-bar #previous-song-button, ytmusic-player-bar .previous-button, ytmusic-player-bar [aria-label^=\"Previous\"]'); if (button) button.click(); else { const media = document.querySelector('video, audio'); if (media) media.currentTime = 0; } })();"
        }
        "play_pause" => {
            "(() => { const media = document.querySelector('video, audio'); if (media) media.paused ? media.play() : media.pause(); else document.querySelector('ytmusic-player-bar #play-pause-button, ytmusic-player-bar .play-pause-button')?.click(); })();"
        }
        "next" => {
            "(() => { const button = document.querySelector('ytmusic-player-bar #next-button, ytmusic-player-bar #next-song-button, ytmusic-player-bar .next-button, ytmusic-player-bar [aria-label^=\"Next\"]'); if (button) button.click(); else { const media = document.querySelector('video, audio'); if (media && Number.isFinite(media.duration)) media.currentTime = media.duration; } })();"
        }
        _ => return,
    };

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(script);
    }
}

fn update_buttons(hwnd: HWND, track: Option<&TrackMetadata>) {
    let enabled = SETTINGS
        .get()
        .map(settings::snapshot)
        .map_or(false, |value| value.windows_media_controls);
    let playing = track.map_or(false, |value| value.playing);

    let Ok(taskbar) = taskbar() else {
        return;
    };
    let Ok(previous_icon) = media_icon(IconKind::Previous) else {
        return;
    };
    let Ok(play_pause_icon) = media_icon(if playing {
        IconKind::Pause
    } else {
        IconKind::Play
    }) else {
        return;
    };
    let Ok(next_icon) = media_icon(IconKind::Next) else {
        return;
    };

    let buttons = [
        button(PREVIOUS_BUTTON, previous_icon, "Previous", enabled),
        button(
            PLAY_PAUSE_BUTTON,
            play_pause_icon,
            if playing { "Pause" } else { "Play" },
            enabled,
        ),
        button(NEXT_BUTTON, next_icon, "Next", enabled),
    ];

    unsafe {
        if taskbar.ThumbBarUpdateButtons(hwnd, &buttons).is_err() {
            let _ = taskbar.ThumbBarAddButtons(hwnd, &buttons);
        }
    }
}

fn taskbar() -> WindowsResult<ITaskbarList3> {
    unsafe {
        let taskbar: ITaskbarList3 =
            CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)?;
        taskbar.HrInit()?;
        Ok(taskbar)
    }
}

fn button(id: u32, icon: HICON, tooltip: &str, enabled: bool) -> THUMBBUTTON {
    let mut button = THUMBBUTTON {
        dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
        iId: id,
        hIcon: icon,
        dwFlags: if enabled { THBF_ENABLED } else { THBF_HIDDEN },
        ..Default::default()
    };
    write_tooltip(&mut button.szTip, tooltip);
    button
}

fn write_tooltip(target: &mut [u16; 260], value: &str) {
    for (slot, value) in target.iter_mut().zip(value.encode_utf16().take(259)) {
        *slot = value;
    }
}

#[derive(Clone, Copy)]
enum IconKind {
    Previous,
    Play,
    Pause,
    Next,
}

fn media_icon(kind: IconKind) -> WindowsResult<HICON> {
    let and_mask = [0xff; 32];
    let mut xor_mask = [0u8; 32];

    for y in 0..16 {
        for x in 0..16 {
            if icon_pixel(kind, x, y) {
                set_bit(&mut xor_mask, x, y);
            }
        }
    }

    unsafe { CreateIcon(None, 16, 16, 1, 1, &and_mask, &xor_mask) }
}

fn set_bit(mask: &mut [u8; 32], x: usize, y: usize) {
    let row = y * 2;
    mask[row + x / 8] |= 0x80 >> (x % 8);
}

fn icon_pixel(kind: IconKind, x: usize, y: usize) -> bool {
    match kind {
        IconKind::Play => {
            let distance = y.abs_diff(7).min(y.abs_diff(8));
            x >= 5 && x <= 11 && x - 5 <= 6 - distance
        }
        IconKind::Pause => (4..=6).contains(&x) || (9..=11).contains(&x),
        IconKind::Previous => {
            x == 3
                || triangle_pixel(4, 9, x, y, true)
                || triangle_pixel(8, 13, x, y, true)
        }
        IconKind::Next => {
            x == 12
                || triangle_pixel(2, 7, x, y, false)
                || triangle_pixel(6, 11, x, y, false)
        }
    }
}

fn triangle_pixel(start: usize, end: usize, x: usize, y: usize, reverse: bool) -> bool {
    if x < start || x > end || !(3..=12).contains(&y) {
        return false;
    }
    let height = y.abs_diff(7).min(y.abs_diff(8));
    let width = end - start;
    if reverse {
        end - x >= height.min(width)
    } else {
        x - start >= height.min(width)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltip_is_null_terminated() {
        let mut buffer = [0u16; 260];
        write_tooltip(&mut buffer, "Play");
        assert_eq!(&buffer[..5], &[80, 108, 97, 121, 0]);
    }

    #[test]
    fn generated_icons_have_pixels() {
        for kind in [IconKind::Previous, IconKind::Play, IconKind::Pause, IconKind::Next] {
            let pixels = (0..16)
                .flat_map(|y| (0..16).map(move |x| icon_pixel(kind, x, y)))
                .filter(|value| *value)
                .count();
            assert!(pixels > 8);
        }
    }
}
