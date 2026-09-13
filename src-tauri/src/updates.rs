use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

use crate::{platform, settings, settings::SharedSettings};

const STARTUP_CHECK_INTERVAL_SECS: u64 = 6 * 3600;

static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

static STATUS: Mutex<Option<UpdateStatus>> = Mutex::new(None);

#[derive(Clone, Serialize)]
pub struct UpdateStatus {
    pub revision: u64,
    pub stage: String,
    pub version: String,
    pub message: String,
    pub downloaded: u64,
    pub total: Option<u64>,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            revision: 0,
            stage: "idle".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            message: "Check for a newer version of YouTube Music.".into(),
            downloaded: 0,
            total: None,
        }
    }
}

pub fn status() -> UpdateStatus {
    STATUS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
        .unwrap_or_default()
}

fn publish_status(
    app: &AppHandle,
    stage: &str,
    version: &str,
    message: &str,
    downloaded: u64,
    total: Option<u64>,
) {
    let mut current = STATUS.lock().unwrap_or_else(|error| error.into_inner());
    let next = UpdateStatus {
        revision: current.as_ref().map_or(1, |value| value.revision + 1),
        stage: stage.into(),
        version: version.into(),
        message: message.into(),
        downloaded,
        total: total.filter(|value| *value > 0),
    };
    let payload = serde_json::to_string(&next).ok();
    *current = Some(next);
    drop(current);
    if let (Some(window), Some(payload)) = (app.get_webview_window("main"), payload) {
        let _ = window.eval(&format!("window.__ytmUpdateStatus?.receive?.({payload});"));
    }
}

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

    publish_status(
        app,
        "checking",
        env!("CARGO_PKG_VERSION"),
        "Checking for updates…",
        0,
        None,
    );

    let updater = match app
        .updater_builder()
        .timeout(Duration::from_secs(120))
        .build()
    {
        Ok(updater) => updater,
        Err(error) => {
            report_error(
                app,
                mode,
                &format!("Could not initialize the updater: {error}"),
            );
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let last_notified = settings::snapshot(settings_handle).last_notified_version;
            if !should_prompt_update(mode, last_notified.as_deref(), &version) {
                publish_status(
                    app,
                    "available",
                    &version,
                    "An update is available when you are ready to install it.",
                    0,
                    None,
                );
                return;
            }

            settings::update(settings_handle, |settings| {
                settings.last_notified_version = Some(version.clone());
            });

            publish_status(
                app,
                "available",
                &version,
                "An update is available. Confirm when you are ready to install it.",
                0,
                None,
            );
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

            publish_status(app, "downloading", &version, "Downloading update…", 0, None);
            let mut downloaded = 0u64;
            let mut last_progress = Instant::now();
            if let Err(error) = update
                .download_and_install(
                    |chunk, total| {
                        downloaded = downloaded.saturating_add(chunk as u64);
                        if last_progress.elapsed() >= Duration::from_millis(200)
                            || total.is_some_and(|total| downloaded >= total)
                        {
                            publish_status(
                                app,
                                "downloading",
                                &version,
                                "Downloading update…",
                                downloaded,
                                total,
                            );
                            last_progress = Instant::now();
                        }
                    },
                    || {
                        publish_status(
                            app,
                            "installing",
                            &version,
                            "Verifying and installing update. The app will close to finish.",
                            0,
                            None,
                        );
                    },
                )
                .await
            {
                publish_status(app, "error", &version, "The update could not be installed. Check your connection and try again.", 0, None);
                platform::error(
                    "YouTube Music Update",
                    &format!("The signed update could not be installed: {error}"),
                );
            }
        }
        Ok(None) => {
            publish_status(
                app,
                "current",
                env!("CARGO_PKG_VERSION"),
                "You are using the latest version.",
                0,
                None,
            );
            if mode == CheckMode::Manual {
                platform::info(
                    "YouTube Music Update",
                    &format!("Version {} is up to date.", env!("CARGO_PKG_VERSION")),
                );
            }
        }
        Err(error) => report_error(app, mode, &format!("Could not check for updates: {error}")),
    }
}

fn report_error(app: &AppHandle, mode: CheckMode, message: &str) {
    publish_status(
        app,
        "error",
        env!("CARGO_PKG_VERSION"),
        "Could not check for updates. Check your connection and try again.",
        0,
        None,
    );
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

fn should_prompt_update(mode: CheckMode, last_notified: Option<&str>, new_version: &str) -> bool {
    match mode {
        CheckMode::Manual => true,
        CheckMode::Startup => last_notified != Some(new_version),
    }
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

    #[test]
    fn update_prompts_respect_notification_history() {
        assert!(!should_prompt_update(
            CheckMode::Startup,
            Some("0.2.5"),
            "0.2.5"
        ));
        assert!(should_prompt_update(
            CheckMode::Startup,
            Some("0.2.4"),
            "0.2.5"
        ));
        assert!(should_prompt_update(CheckMode::Startup, None, "0.2.5"));
        assert!(should_prompt_update(
            CheckMode::Manual,
            Some("0.2.5"),
            "0.2.5"
        ));
    }
}
