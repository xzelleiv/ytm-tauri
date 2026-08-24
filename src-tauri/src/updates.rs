use std::{
    io::Read,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::{platform, settings, settings::SharedSettings};

const GITHUB_API_LATEST_RELEASE: &str =
    "https://api.github.com/repos/xzelleiv/ytm-tauri/releases/latest";
const MAX_RESPONSE_BYTES: usize = 65536; // 64 kib
const STARTUP_CHECK_INTERVAL_SECS: u64 = 6 * 3600; // 6 hours

static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckMode {
    Startup,
    Manual,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
}

pub enum UpdateResult {
    Available { version: String, url: String },
    Current,
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

    thread::spawn(move || {
        struct InFlightGuard;
        impl Drop for InFlightGuard {
            fn drop(&mut self) {
                IN_FLIGHT.store(false, Ordering::SeqCst);
            }
        }
        let _guard = InFlightGuard;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if mode == CheckMode::Startup {
            let snap = settings::snapshot(&settings_handle);
            if let Some(last_check) = snap.last_update_check {
                if now >= last_check && now.saturating_sub(last_check) < STARTUP_CHECK_INTERVAL_SECS
                {
                    return;
                }
            }
        }

        // record check time
        settings::update(&settings_handle, |s| {
            s.last_update_check = Some(now);
        });

        match fetch_latest_release() {
            Ok(UpdateResult::Available { version, url }) => {
                let snap = settings::snapshot(&settings_handle);
                if mode == CheckMode::Startup {
                    if snap.last_notified_version.as_deref() == Some(&version) {
                        return;
                    }
                    let res = app_handle
                        .notification()
                        .builder()
                        .title("YouTube Music Update Available")
                        .body(format!("Version v{version} is available."))
                        .show();
                    if res.is_ok() {
                        settings::update(&settings_handle, |s| {
                            s.last_notified_version = Some(version);
                        });
                    }
                } else {
                    let install = platform::confirm(
                        "YouTube Music Update",
                        &format!("Version {version} is available. Open the download page?"),
                    );
                    if install {
                        platform::open_url(&url);
                    }
                    settings::update(&settings_handle, |s| {
                        s.last_notified_version = Some(version);
                    });
                }
            }
            Ok(UpdateResult::Current) => {
                if mode == CheckMode::Manual {
                    platform::info(
                        "YouTube Music Update",
                        &format!("Version {} is up to date.", env!("CARGO_PKG_VERSION")),
                    );
                }
            }
            Err(error) => {
                if mode == CheckMode::Manual {
                    platform::error("YouTube Music Update", &error);
                }
            }
        }
    });
}

fn fetch_latest_release() -> Result<UpdateResult, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("ytm-tauri/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|err| format!("Could not create HTTP client: {err}"))?;

    let mut response = client
        .get(GITHUB_API_LATEST_RELEASE)
        .header("Accept", "application/vnd.github+json")
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|err| format!("Could not check GitHub releases: {err}"))?;

    let mut buffer = Vec::new();
    response
        .by_ref()
        .take(MAX_RESPONSE_BYTES as u64)
        .read_to_end(&mut buffer)
        .map_err(|err| format!("Failed to read release response: {err}"))?;

    parse_release_json(&buffer, env!("CARGO_PKG_VERSION"))
}

pub fn parse_release_json(bytes: &[u8], current_ver: &str) -> Result<UpdateResult, String> {
    let release: GitHubRelease =
        serde_json::from_slice(bytes).map_err(|err| format!("Invalid release response: {err}"))?;

    let latest_version = parse_tag_version(&release.tag_name)
        .ok_or_else(|| format!("Invalid tag format: {}", release.tag_name))?;

    let current_version = semver::Version::parse(current_ver)
        .map_err(|_| "The installed version is invalid.".to_string())?;

    if latest_version > current_version {
        let derived_url = derive_release_url(&latest_version);
        Ok(UpdateResult::Available {
            version: latest_version.to_string(),
            url: derived_url,
        })
    } else {
        Ok(UpdateResult::Current)
    }
}

pub fn parse_tag_version(tag: &str) -> Option<semver::Version> {
    let clean = tag.trim().trim_start_matches(['v', 'V']);
    semver::Version::parse(clean).ok()
}

pub fn derive_release_url(version: &semver::Version) -> String {
    format!("https://github.com/xzelleiv/ytm-tauri/releases/tag/v{version}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tag_versions_correctly() {
        assert_eq!(
            parse_tag_version("v1.2.3"),
            Some(semver::Version::new(1, 2, 3))
        );
        assert_eq!(
            parse_tag_version("V0.2.0"),
            Some(semver::Version::new(0, 2, 0))
        );
        assert_eq!(
            parse_tag_version("1.0.0"),
            Some(semver::Version::new(1, 0, 0))
        );
        assert_eq!(parse_tag_version("invalid-tag"), None);
    }

    #[test]
    fn derives_release_url_strictly_from_version() {
        let v = semver::Version::new(0, 2, 1);
        assert_eq!(
            derive_release_url(&v),
            "https://github.com/xzelleiv/ytm-tauri/releases/tag/v0.2.1"
        );
    }

    #[test]
    fn parses_github_release_payload() {
        let payload = br#"{"tag_name":"v1.0.0","name":"v1.0.0","draft":false,"prerelease":false}"#;
        match parse_release_json(payload, "0.9.0").unwrap() {
            UpdateResult::Available { version, url } => {
                assert_eq!(version, "1.0.0");
                assert_eq!(
                    url,
                    "https://github.com/xzelleiv/ytm-tauri/releases/tag/v1.0.0"
                );
            }
            UpdateResult::Current => panic!("Expected update available"),
        }

        match parse_release_json(payload, "1.0.0").unwrap() {
            UpdateResult::Current => {}
            UpdateResult::Available { .. } => panic!("Expected up to date"),
        }
    }
}
