use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

use crate::{platform, settings, settings::SharedSettings};

const STARTUP_CHECK_INTERVAL_SECS: u64 = 6 * 3600;

static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckMode {
    Startup,
    Manual,
}

pub fn check(app: &AppHandle, settings: &SharedSettings, mode: CheckMode) {
    if IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        if mode == CheckMode::Manual {
            platform::info(
                "YouTube Music Update",
                "An update check is already in progress.",
            );
        }
        return;
    }

    let app_handle = app.clone();
    let settings_handle = settings.clone();
    tauri::async_runtime::spawn(async move {
        let _guard = InFlightGuard;
        run_check(&app_handle, &settings_handle, mode).await;
    });
}

async fn run_check(app: &AppHandle, settings_handle: &SharedSettings, mode: CheckMode) {
    let now = unix_now();
    if mode == CheckMode::Startup {
        let last_check = settings::snapshot(settings_handle).last_update_check;
        if !startup_check_due(last_check, now) {
            return;
        }
    }

    settings::update(settings_handle, |settings| {
        settings.last_update_check = Some(now);
    });

    let updater = match app
        .updater_builder()
        .timeout(Duration::from_secs(120))
        .build()
    {
        Ok(updater) => updater,
        Err(error) => {
            report_error(mode, &format!("Could not initialize the updater: {error}"));
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            settings::update(settings_handle, |settings| {
                settings.last_notified_version = Some(version.clone());
            });

            let install = platform::confirm(
                "YouTube Music Update",
                &format!(
                    "Version {version} is available.\n\nDownload the signed update, install it, and restart YouTube Music now?"
                ),
            );
            if !install {
                return;
            }

            let _ = app
                .notification()
                .builder()
                .title("Updating YouTube Music")
                .body(format!("Downloading signed version {version}."))
                .show();

            if let Err(error) = update.download_and_install(|_, _| {}, || {}).await {
                platform::error(
                    "YouTube Music Update",
                    &format!("The signed update could not be installed: {error}"),
                );
            }
        }
        Ok(None) => {
            if mode == CheckMode::Manual {
                platform::info(
                    "YouTube Music Update",
                    &format!("Version {} is up to date.", env!("CARGO_PKG_VERSION")),
                );
            }
        }
        Err(error) => report_error(mode, &format!("Could not check for updates: {error}")),
    }
}

fn report_error(mode: CheckMode, message: &str) {
    if mode == CheckMode::Manual {
        platform::error("YouTube Music Update", message);
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn startup_check_due(last_check: Option<u64>, now: u64) -> bool {
    last_check.map_or(true, |last| {
        now < last || now.saturating_sub(last) >= STARTUP_CHECK_INTERVAL_SECS
    })
}

struct InFlightGuard;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_checks_are_rate_limited_without_hiding_clock_rollback() {
        let now = 100_000;

        assert!(startup_check_due(None, now));
        assert!(!startup_check_due(Some(now - 1_000), now));
        assert!(startup_check_due(
            Some(now - STARTUP_CHECK_INTERVAL_SECS),
            now
        ));
        assert!(startup_check_due(Some(now + 10_000), now));
    }
}
