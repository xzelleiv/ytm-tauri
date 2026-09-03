#[cfg(windows)]
use windows::{
    core::{GUID, HSTRING, PCWSTR},
    Win32::{
        Foundation::PROPERTYKEY,
        System::Com::StructuredStorage::PROPVARIANT,
        UI::{
            Shell::{
                PropertiesSystem::{
                    IPropertyStore, PSCoerceToCanonicalValue, SHGetPropertyStoreForWindow,
                },
                ShellExecuteW,
            },
            WindowsAndMessaging::{
                MessageBoxW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONQUESTION, MB_OK,
                MB_YESNO, SW_SHOWNORMAL,
            },
        },
    },
};

#[cfg(windows)]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const APP_NAME: &str = "YouTube Music";
const APP_USER_MODEL_ID: &str = "app.ytmusic.desktop";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
pub fn open_url(url: &str) -> bool {
    if !url.starts_with("https://")
        && !url.starts_with("http://127.0.0.1:")
        && !url.starts_with("http://localhost:")
    {
        return false;
    }

    let operation = HSTRING::from("open");
    let target = HSTRING::from(url);
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(target.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };

    result.0 as isize > 32
}

#[cfg(not(windows))]
pub fn open_url(_url: &str) -> bool {
    false
}

#[cfg(windows)]
pub fn info(title: &str, message: &str) {
    message_box(title, message, MB_OK | MB_ICONINFORMATION);
}

#[cfg(not(windows))]
pub fn info(_title: &str, _message: &str) {}

#[cfg(windows)]
pub fn error(title: &str, message: &str) {
    message_box(title, message, MB_OK | MB_ICONERROR);
}

#[cfg(not(windows))]
pub fn error(_title: &str, _message: &str) {}

#[cfg(windows)]
pub fn confirm(title: &str, message: &str) -> bool {
    message_box(title, message, MB_YESNO | MB_ICONQUESTION) == IDYES.0
}

#[cfg(not(windows))]
pub fn confirm(_title: &str, _message: &str) -> bool {
    false
}

#[cfg(windows)]
fn message_box(
    title: &str,
    message: &str,
    style: windows::Win32::UI::WindowsAndMessaging::MESSAGEBOX_STYLE,
) -> i32 {
    let title = HSTRING::from(title);
    let message = HSTRING::from(message);

    unsafe {
        MessageBoxW(
            None,
            PCWSTR(message.as_ptr()),
            PCWSTR(title.as_ptr()),
            style,
        )
        .0
    }
}

#[cfg(windows)]
pub fn startup_enabled() -> bool {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(RUN_KEY)
        .ok()
        .and_then(|key| key.get_value::<String, _>(APP_NAME).ok())
        .is_some()
}

#[cfg(not(windows))]
pub fn startup_enabled() -> bool {
    false
}

#[cfg(windows)]
pub fn set_startup_enabled(enabled: bool, minimized: bool) -> std::io::Result<()> {
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY)?;

    if enabled {
        let executable = std::env::current_exe()?;
        let minimized = if minimized { " --minimized" } else { "" };
        key.set_value(
            APP_NAME,
            &format!("\"{}\"{minimized}", executable.display()),
        )
    } else {
        match key.delete_value(APP_NAME) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[cfg(windows)]
pub fn register_app_identity() -> std::io::Result<()> {
    let classes = RegKey::predef(HKEY_CURRENT_USER);
    let key_path = format!(r"Software\Classes\AppUserModelId\{APP_USER_MODEL_ID}");
    let (key, _) = classes.create_subkey(key_path)?;
    let executable = std::env::current_exe()?;

    key.set_value("DisplayName", &APP_NAME)?;
    let registered_icon = key
        .get_value::<String, _>("IconUri")
        .ok()
        .filter(|path| std::path::Path::new(path).is_file());
    if registered_icon.is_none() {
        key.set_value("IconUri", &executable.to_string_lossy().as_ref())?;
    }
    key.set_value("ShowInSettings", &1_u32)
}

#[cfg(windows)]
pub fn set_window_app_identity(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let property_key = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };
    let mut value = PROPVARIANT::from(APP_USER_MODEL_ID);

    unsafe {
        PSCoerceToCanonicalValue(&property_key, &mut value).map_err(|error| error.to_string())?;
        let store: IPropertyStore =
            SHGetPropertyStoreForWindow(hwnd).map_err(|error| error.to_string())?;
        store
            .SetValue(&property_key, &value)
            .map_err(|error| error.to_string())?;
        store.Commit().map_err(|error| error.to_string())
    }
}

#[cfg(not(windows))]
pub fn register_app_identity() -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(windows))]
pub fn set_window_app_identity(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub fn set_startup_enabled(_enabled: bool, _minimized: bool) -> std::io::Result<()> {
    Ok(())
}
