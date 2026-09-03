//! url_policy.rs
//! Central allow-list for WebView navigation and Discord Rich Presence URLs.

use tauri::Url;

const MAX_DISCORD_URL_LEN: usize = 512;

// Google-owned regional domains mirrored from Chromium's kGoogleConfigs.
// Keep this list sorted so binary_search remains valid.
const GOOGLE_REGIONAL_DOMAINS: &[&str] = &[
    "google.ac",
    "google.ad",
    "google.ae",
    "google.af",
    "google.ag",
    "google.al",
    "google.am",
    "google.as",
    "google.at",
    "google.az",
    "google.ba",
    "google.be",
    "google.bf",
    "google.bg",
    "google.bi",
    "google.bj",
    "google.bs",
    "google.bt",
    "google.by",
    "google.ca",
    "google.cc",
    "google.cd",
    "google.cf",
    "google.cg",
    "google.ch",
    "google.ci",
    "google.cl",
    "google.cm",
    "google.cn",
    "google.co.ao",
    "google.co.bw",
    "google.co.ck",
    "google.co.cr",
    "google.co.hu",
    "google.co.id",
    "google.co.il",
    "google.co.im",
    "google.co.in",
    "google.co.je",
    "google.co.jp",
    "google.co.ke",
    "google.co.kr",
    "google.co.ls",
    "google.co.ma",
    "google.co.mz",
    "google.co.nz",
    "google.co.th",
    "google.co.tz",
    "google.co.ug",
    "google.co.uk",
    "google.co.uz",
    "google.co.ve",
    "google.co.vi",
    "google.co.za",
    "google.co.zm",
    "google.co.zw",
    "google.com.af",
    "google.com.ag",
    "google.com.ai",
    "google.com.ar",
    "google.com.au",
    "google.com.bd",
    "google.com.bh",
    "google.com.bn",
    "google.com.bo",
    "google.com.br",
    "google.com.by",
    "google.com.bz",
    "google.com.cn",
    "google.com.co",
    "google.com.cu",
    "google.com.cy",
    "google.com.do",
    "google.com.ec",
    "google.com.eg",
    "google.com.et",
    "google.com.fj",
    "google.com.ge",
    "google.com.gh",
    "google.com.gi",
    "google.com.gr",
    "google.com.gt",
    "google.com.hk",
    "google.com.iq",
    "google.com.jm",
    "google.com.jo",
    "google.com.kh",
    "google.com.kw",
    "google.com.lb",
    "google.com.ly",
    "google.com.mm",
    "google.com.mt",
    "google.com.mx",
    "google.com.my",
    "google.com.na",
    "google.com.nf",
    "google.com.ng",
    "google.com.ni",
    "google.com.np",
    "google.com.nr",
    "google.com.om",
    "google.com.pa",
    "google.com.pe",
    "google.com.pg",
    "google.com.ph",
    "google.com.pk",
    "google.com.pl",
    "google.com.pr",
    "google.com.py",
    "google.com.qa",
    "google.com.ru",
    "google.com.sa",
    "google.com.sb",
    "google.com.sg",
    "google.com.sl",
    "google.com.sv",
    "google.com.tj",
    "google.com.tn",
    "google.com.tr",
    "google.com.tw",
    "google.com.ua",
    "google.com.uy",
    "google.com.vc",
    "google.com.ve",
    "google.com.vn",
    "google.cv",
    "google.cz",
    "google.de",
    "google.dj",
    "google.dk",
    "google.dm",
    "google.dz",
    "google.ee",
    "google.es",
    "google.fi",
    "google.fm",
    "google.fr",
    "google.ga",
    "google.ge",
    "google.gg",
    "google.gl",
    "google.gm",
    "google.gp",
    "google.gr",
    "google.gy",
    "google.hk",
    "google.hn",
    "google.hr",
    "google.ht",
    "google.hu",
    "google.ie",
    "google.im",
    "google.iq",
    "google.ir",
    "google.is",
    "google.it",
    "google.it.ao",
    "google.je",
    "google.jo",
    "google.jp",
    "google.kg",
    "google.ki",
    "google.kz",
    "google.la",
    "google.li",
    "google.lk",
    "google.lt",
    "google.lu",
    "google.lv",
    "google.md",
    "google.me",
    "google.mg",
    "google.mk",
    "google.ml",
    "google.mn",
    "google.ms",
    "google.mu",
    "google.mv",
    "google.mw",
    "google.ne",
    "google.ne.jp",
    "google.ng",
    "google.nl",
    "google.no",
    "google.nr",
    "google.nu",
    "google.off.ai",
    "google.pk",
    "google.pl",
    "google.pn",
    "google.ps",
    "google.pt",
    "google.ro",
    "google.rs",
    "google.ru",
    "google.rw",
    "google.sc",
    "google.se",
    "google.sh",
    "google.si",
    "google.sk",
    "google.sm",
    "google.sn",
    "google.so",
    "google.sr",
    "google.st",
    "google.td",
    "google.tg",
    "google.tk",
    "google.tl",
    "google.tm",
    "google.tn",
    "google.to",
    "google.tt",
    "google.us",
    "google.uz",
    "google.vg",
    "google.vu",
    "google.ws",
];

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

pub fn is_auth_intermediate_url(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if !host_matches_domain(host, "youtube.com") && !host_matches_domain(host, "google.com") {
        return false;
    }
    let path = url.path();
    path.contains("/accounts/SetSID")
        || path.contains("/CheckCookie")
        || path.contains("/signin_passive")
        || url
            .query()
            .is_some_and(|q| q.contains("action_handle_signin=true"))
}

pub fn is_auth_recovery_url(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    if url.host_str() != Some("music.youtube.com") {
        return false;
    }
    let path = url.path();
    path.contains("/oops") || path.contains("/error")
}


pub fn is_allowed_spotify_auth_url(url: &Url) -> bool {
    match url.scheme() {
        "about" => url.as_str() == "about:blank",
        "https" => url
            .host_str()
            .is_some_and(|host| host_matches_domain(host, "spotify.com")),
        _ => false,
    }
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
        || is_regional_google_accounts_host(host)
        || host_matches_domain(host, "googleapis.com")
        || host_matches_domain(host, "gstatic.com")
        || host_matches_domain(host, "googleusercontent.com")
        || host_matches_domain(host, "spotify.com")
        || host_matches_domain(host, "scdn.co")
        || host_matches_domain(host, "spotifycdn.com")
}

fn is_regional_google_accounts_host(host: &str) -> bool {
    let Some(domain) = host.strip_prefix("accounts.") else {
        return false;
    };

    GOOGLE_REGIONAL_DOMAINS.binary_search(&domain).is_ok()
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
            "https://accounts.google.com.ph/accounts/SetSID"
        )));
        assert!(is_allowed_navigation_url(&parse_url(
            "https://accounts.google.co.uk/signin"
        )));
        assert!(is_allowed_navigation_url(&parse_url(
            "https://accounts.google.de/signin"
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
        assert!(!is_allowed_navigation_url(&parse_url(
            "https://accounts.google.example.ph/"
        )));
        assert!(!is_allowed_navigation_url(&parse_url(
            "https://accounts.google.com.example/"
        )));
        assert!(!is_allowed_navigation_url(&parse_url(
            "https://accounts.google.zz/"
        )));
        assert!(!is_allowed_navigation_url(&parse_url(
            "https://www.google.de/"
        )));
    }

    #[test]
    fn regional_google_domains_stay_sorted() {
        assert!(GOOGLE_REGIONAL_DOMAINS
            .windows(2)
            .all(|domains| domains[0] < domains[1]));
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
    fn spotify_auth_navigation_is_https_and_domain_scoped() {
        assert!(is_allowed_spotify_auth_url(&parse_url("about:blank")));
        assert!(is_allowed_spotify_auth_url(&parse_url(
            "https://open.spotify.com/"
        )));
        assert!(is_allowed_spotify_auth_url(&parse_url(
            "https://accounts.spotify.com/authorize"
        )));

        assert!(!is_allowed_spotify_auth_url(&parse_url(
            "http://accounts.spotify.com/authorize"
        )));
        assert!(!is_allowed_spotify_auth_url(&parse_url(
            "https://spotify.com.example.com/"
        )));
        assert!(!is_allowed_spotify_auth_url(&parse_url(
            "https://example.com/?next=spotify.com"
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

    #[test]
    fn detects_auth_intermediate_urls() {
        assert!(is_auth_intermediate_url(&parse_url(
            "https://accounts.youtube.com/accounts/SetSID?ss_c=1"
        )));
        assert!(is_auth_intermediate_url(&parse_url(
            "https://accounts.google.com/CheckCookie?continue=https://youtube.com"
        )));
        assert!(is_auth_intermediate_url(&parse_url(
            "https://www.youtube.com/signin_passive"
        )));
        assert!(is_auth_intermediate_url(&parse_url(
            "https://music.youtube.com/?action_handle_signin=true"
        )));

        assert!(!is_auth_intermediate_url(&parse_url(
            "https://music.youtube.com/watch?v=123"
        )));
        assert!(!is_auth_intermediate_url(&parse_url(
            "https://accounts.google.com/signin/v2/identifier"
        )));
    }

    #[test]
    fn detects_auth_recovery_urls() {
        assert!(is_auth_recovery_url(&parse_url(
            "https://music.youtube.com/oops"
        )));
        assert!(is_auth_recovery_url(&parse_url(
            "https://music.youtube.com/error"
        )));
        assert!(!is_auth_recovery_url(&parse_url(
            "https://music.youtube.com/"
        )));
        assert!(!is_auth_recovery_url(&parse_url(
            "https://youtube.com/oops"
        )));
    }
}

