//! url_policy.rs
//! Central allow-list for WebView navigation and Discord Rich Presence URLs.

use tauri::Url;

const MAX_DISCORD_URL_LEN: usize = 512;

pub fn is_allowed_navigation_url(url: &Url) -> bool {
    match url.scheme() {
        "about" => url.as_str() == "about:blank",
        "https" => url.host_str().is_some_and(is_allowed_navigation_host),
        _ => false,
    }
}

pub fn is_youtube_music_url(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("music.youtube.com")
}

pub fn valid_track_url(value: Option<&str>) -> Option<&str> {
    valid_discord_url(value, is_allowed_track_host)
}

pub fn valid_artwork_url(value: Option<&str>) -> Option<&str> {
    valid_discord_url(value, is_allowed_artwork_host)
}

fn valid_discord_url(value: Option<&str>, is_allowed_host: fn(&str) -> bool) -> Option<&str> {
    let value = value?.trim();
    if value.len() > MAX_DISCORD_URL_LEN {
        return None;
    }

    let Ok(url) = Url::parse(value) else {
        return None;
    };

    if url.scheme() == "https" && url.host_str().is_some_and(is_allowed_host) {
        Some(value)
    } else {
        None
    }
}

fn is_allowed_navigation_host(host: &str) -> bool {
    host_matches_domain(host, "youtube.com")
        || host_matches_domain(host, "google.com")
        || host_matches_domain(host, "google.co.id")
        || host_matches_domain(host, "google.com.sg")
        || host_matches_domain(host, "googleapis.com")
        || host_matches_domain(host, "gstatic.com")
        || host_matches_domain(host, "googleusercontent.com")
}

fn is_allowed_track_host(host: &str) -> bool {
    matches!(
        host,
        "music.youtube.com" | "youtube.com" | "www.youtube.com" | "m.youtube.com"
    )
}

fn is_allowed_artwork_host(host: &str) -> bool {
    host_matches_domain(host, "ytimg.com") || host_matches_domain(host, "googleusercontent.com")
}

fn host_matches_domain(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_url(value: &str) -> Url {
        Url::parse(value).expect("test URL must parse")
    }

    #[test]
    fn navigation_is_limited_to_expected_hosts() {
        assert!(is_allowed_navigation_url(&parse_url("about:blank")));
        assert!(is_allowed_navigation_url(&parse_url(
            "https://music.youtube.com/"
        )));
        assert!(is_allowed_navigation_url(&parse_url(
            "https://accounts.google.com/signin"
        )));
        assert!(is_allowed_navigation_url(&parse_url(
            "https://accounts.google.co.id/signin"
        )));
        assert!(is_allowed_navigation_url(&parse_url(
            "https://accounts.google.com.sg/accounts/SetSID"
        )));
        assert!(is_allowed_navigation_url(&parse_url(
            "https://accounts.youtube.com/"
        )));
        assert!(is_allowed_navigation_url(&parse_url(
            "https://consent.youtube.com/"
        )));
        assert!(is_allowed_navigation_url(&parse_url(
            "https://myaccount.google.com/"
        )));
        assert!(is_allowed_navigation_url(&parse_url(
            "https://www.youtube.com/"
        )));

        assert!(!is_allowed_navigation_url(&parse_url(
            "http://music.youtube.com/"
        )));
        assert!(!is_allowed_navigation_url(&parse_url(
            "data:text/html,spoof"
        )));
        assert!(!is_allowed_navigation_url(&parse_url(
            "blob:https://music.youtube.com/id"
        )));
        assert!(!is_allowed_navigation_url(&parse_url(
            "https://example.com/"
        )));
        assert!(!is_allowed_navigation_url(&parse_url(
            "https://music.youtube.com.example.com/"
        )));
        assert!(!is_allowed_navigation_url(&parse_url(
            "https://accounts.google.com.sg.example.com/"
        )));
    }

    #[test]
    fn youtube_music_origin_requires_https_and_exact_host() {
        assert!(is_youtube_music_url(&parse_url(
            "https://music.youtube.com/"
        )));
        assert!(!is_youtube_music_url(&parse_url(
            "http://music.youtube.com/"
        )));
        assert!(!is_youtube_music_url(&parse_url(
            "https://music.youtube.com.example.com/"
        )));
    }

    #[test]
    fn track_urls_are_limited_to_youtube_hosts() {
        assert_eq!(
            valid_track_url(Some("https://music.youtube.com/watch?v=x")),
            Some("https://music.youtube.com/watch?v=x")
        );
        assert_eq!(
            valid_track_url(Some("https://www.youtube.com/watch?v=x")),
            Some("https://www.youtube.com/watch?v=x")
        );

        assert_eq!(
            valid_track_url(Some("http://music.youtube.com/watch?v=x")),
            None
        );
        assert_eq!(valid_track_url(Some("https://example.com/watch?v=x")), None);
        assert_eq!(
            valid_track_url(Some("https://music.youtube.com.example.com/watch?v=x")),
            None
        );
        assert_eq!(
            valid_track_url(Some("https://notyoutube.com/watch?v=x")),
            None
        );
    }

    #[test]
    fn artwork_urls_are_limited_to_youtube_art_hosts() {
        assert_eq!(
            valid_artwork_url(Some("https://i.ytimg.com/vi/id/default.jpg")),
            Some("https://i.ytimg.com/vi/id/default.jpg")
        );
        assert_eq!(
            valid_artwork_url(Some("https://lh3.googleusercontent.com/image")),
            Some("https://lh3.googleusercontent.com/image")
        );

        assert_eq!(valid_artwork_url(Some("https://example.com/image")), None);
        assert_eq!(valid_artwork_url(Some("https://notytimg.com/image")), None);
        assert_eq!(
            valid_artwork_url(Some("https://lh3.googleusercontent.com.example.com/image")),
            None
        );
    }

    #[test]
    fn discord_urls_have_a_length_cap() {
        let path = "a".repeat(MAX_DISCORD_URL_LEN);
        let too_long = format!("https://music.youtube.com/{path}");

        assert_eq!(valid_track_url(Some(&too_long)), None);
    }
}
