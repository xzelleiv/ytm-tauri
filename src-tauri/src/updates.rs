use std::{thread, time::Duration};

use crate::platform;

const LATEST_RELEASE_URL: &str = "https://github.com/xzelleiv/ytm-tauri/releases/latest";
const RELEASE_URL_PREFIX: &str = "https://github.com/xzelleiv/ytm-tauri/releases/tag/v";

enum UpdateResult {
    Available { version: String, url: String },
    Current,
}

pub fn check_in_background(silent_when_current: bool) {
    thread::spawn(move || match check() {
        Ok(UpdateResult::Available { version, url }) => {
            let install = platform::confirm(
                "YouTube Music Update",
                &format!("Version {version} is available. Open the download page?"),
            );
            if install {
                platform::open_url(&url);
            }
        }
        Ok(UpdateResult::Current) if !silent_when_current => {
            platform::info(
                "YouTube Music Update",
                &format!("Version {} is up to date.", env!("CARGO_PKG_VERSION")),
            );
        }
        Ok(UpdateResult::Current) => {}
        Err(error) if !silent_when_current => {
            platform::error("YouTube Music Update", &error);
        }
        Err(_) => {}
    });
}

fn check() -> Result<UpdateResult, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("yt-music-unofficial/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Could not start update check: {error}"))?;
    let response = client
        .head(LATEST_RELEASE_URL)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Could not check GitHub releases: {error}"))?;
    let release_url = response.url().as_str();
    let latest = release_version(release_url)
        .ok_or_else(|| "GitHub returned an invalid release URL.".to_string())?;
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|_| "The installed version is invalid.".to_string())?;

    if latest > current {
        Ok(UpdateResult::Available {
            version: latest.to_string(),
            url: release_url.to_string(),
        })
    } else {
        Ok(UpdateResult::Current)
    }
}

fn release_version(url: &str) -> Option<semver::Version> {
    url.strip_prefix(RELEASE_URL_PREFIX)
        .and_then(|version| semver::Version::parse(version).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_version_comes_from_repository_redirect() {
        assert_eq!(
            release_version("https://github.com/xzelleiv/ytm-tauri/releases/tag/v0.1.5"),
            Some(semver::Version::new(0, 1, 5))
        );
        assert_eq!(
            release_version("https://example.com/releases/tag/v9.9.9"),
            None
        );
    }
}
