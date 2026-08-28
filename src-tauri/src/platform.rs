#[cfg(windows)]
use windows::{
    core::{HSTRING, PCWSTR},
    Win32::UI::{
        Shell::ShellExecuteW,
        WindowsAndMessaging::{
            MessageBoxW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONQUESTION, MB_OK, MB_YESNO,
            SW_SHOWNORMAL,
        },
    },
};

#[cfg(windows)]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const APP_NAME: &str = "YouTube Music";
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

#[cfg(not(windows))]
pub fn set_startup_enabled(_enabled: bool, _minimized: bool) -> std::io::Result<()> {
    Ok(())
}
